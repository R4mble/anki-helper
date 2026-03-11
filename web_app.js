const express = require('express');
const path = require('path');
const os = require('os');
const fs = require('fs-extra');
const { execFile, spawn } = require('child_process');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const schedule = require('node-schedule');

const PORT = Number(process.env.PORT || 3333);
const HOST = process.env.HOST || '0.0.0.0';
const DEFAULT_SETTINGS_FILE = path.join(__dirname, 'app_default_setting.json');
const SETTINGS_FILE = path.join(__dirname, 'app_settings.json');
const BACKUP_DIR = path.join(__dirname, 'backup');
const RUNTIME_DIR = path.join(__dirname, '.runtime');
const DEFAULT_SETTINGS_TEMPLATE = {
    ankiConnectUrl: 'http://127.0.0.1:8765',
    mediaDir: '',
    targetField: process.env.ANKI_TARGET_FIELD || '例句发音',
    defaultTrimStartSeconds: 0.5,
    defaultTrimEndSeconds: 0,
    defaultAmplifyFactor: 4.0,
    defaultSyncCron: '30 19 * * *',
    syncEnabled: true,
};

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let syncJob = null;
let syncJobCron = DEFAULT_SETTINGS_TEMPLATE.defaultSyncCron;
let syncEnabled = false;
let settings = null;
let defaultSettings = null;
let silenceLoopRunning = false;
let silenceLoopTimer = null;
let silenceLoopDurationSeconds = 1;
let silenceLoopGapMs = 150;

function parseNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function sanitizeSettings(input) {
    const merged = { ...(defaultSettings || DEFAULT_SETTINGS_TEMPLATE), ...(input || {}) };
    return {
        ankiConnectUrl: String(merged.ankiConnectUrl || 'http://127.0.0.1:8765').trim(),
        mediaDir: String(merged.mediaDir || '').trim(),
        targetField: String(merged.targetField || '例句发音').trim(),
        defaultTrimStartSeconds: Math.max(0, parseNumber(merged.defaultTrimStartSeconds, 0.5)),
        defaultTrimEndSeconds: Math.max(0, parseNumber(merged.defaultTrimEndSeconds, 0)),
        defaultAmplifyFactor: Math.max(0.1, parseNumber(merged.defaultAmplifyFactor, 4)),
        defaultSyncCron: String(merged.defaultSyncCron || '30 19 * * *').trim(),
        syncEnabled: Boolean(merged.syncEnabled),
    };
}

async function loadDefaultSettings() {
    if (!(await fs.pathExists(DEFAULT_SETTINGS_FILE))) {
        await fs.writeJson(DEFAULT_SETTINGS_FILE, DEFAULT_SETTINGS_TEMPLATE, { spaces: 2 });
        return { ...DEFAULT_SETTINGS_TEMPLATE };
    }
    try {
        const fromDisk = await fs.readJson(DEFAULT_SETTINGS_FILE);
        return { ...DEFAULT_SETTINGS_TEMPLATE, ...(fromDisk || {}) };
    } catch (error) {
        throw new Error(`读取默认配置失败: ${error.message}`);
    }
}

async function loadSettings() {
    defaultSettings = await loadDefaultSettings();
    if (!(await fs.pathExists(SETTINGS_FILE))) {
        return sanitizeSettings(defaultSettings);
    }
    try {
        const appSettings = await fs.readJson(SETTINGS_FILE);
        // app_settings.json 存在时作为唯一生效配置；缺失字段仅做兼容兜底并回写为完整配置。
        const fullSettings = sanitizeSettings(appSettings || {});
        await fs.writeJson(SETTINGS_FILE, fullSettings, { spaces: 2 });
        return fullSettings;
    } catch (error) {
        throw new Error(`读取配置文件失败: ${error.message}`);
    }
}

async function saveSettings(nextSettings) {
    if (!defaultSettings) {
        defaultSettings = await loadDefaultSettings();
    }
    settings = sanitizeSettings(nextSettings);
    // 一旦保存，创建/覆盖 app_settings.json 的全量配置，并以其为准。
    await fs.writeJson(SETTINGS_FILE, settings, { spaces: 2 });
    return settings;
}

function createSilentWavBuffer(durationSeconds, sampleRate = 44100) {
    const channels = 1;
    const bytesPerSample = 2;
    const totalSamples = Math.max(1, Math.floor(durationSeconds * sampleRate));
    const dataSize = totalSamples * channels * bytesPerSample;
    const buffer = Buffer.alloc(44 + dataSize);

    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8);
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(channels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
    buffer.writeUInt16LE(channels * bytesPerSample, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);

    return buffer;
}

async function ensureSilentWav(durationSeconds) {
    await fs.ensureDir(RUNTIME_DIR);
    const safeMs = Math.max(100, Math.min(5000, Math.round(durationSeconds * 1000)));
    const filePath = path.join(RUNTIME_DIR, `silence_${safeMs}ms.wav`);
    if (!(await fs.pathExists(filePath))) {
        const wavBuffer = createSilentWavBuffer(safeMs / 1000);
        await fs.writeFile(filePath, wavBuffer);
    }
    return filePath;
}

function playOnWindows(wavPath) {
    return new Promise((resolve, reject) => {
        const escaped = wavPath.replace(/'/g, "''");
        const psScript = `(New-Object Media.SoundPlayer '${escaped}').PlaySync();`;
        const child = spawn('powershell', ['-NoProfile', '-Command', psScript], {
            windowsHide: true,
        });
        child.on('error', (err) => reject(err));
        child.on('exit', (code) => {
            if (code === 0) return resolve();
            return reject(new Error(`PowerShell 播放失败，退出码 ${code}`));
        });
    });
}

function playOnMac(wavPath) {
    return new Promise((resolve, reject) => {
        execFile('afplay', [wavPath], (err) => {
            if (err) return reject(err);
            return resolve();
        });
    });
}

function playOnLinux(wavPath) {
    return new Promise((resolve, reject) => {
        execFile('aplay', [wavPath], (err) => {
            if (err) return reject(err);
            return resolve();
        });
    });
}

async function playSilentAudio(durationSeconds) {
    const wavPath = await ensureSilentWav(durationSeconds);
    const platform = os.platform();
    if (platform === 'darwin') {
        await playOnMac(wavPath);
        return;
    }
    if (platform === 'win32') {
        await playOnWindows(wavPath);
        return;
    }
    await playOnLinux(wavPath);
}

function stopSilentAudioLoop() {
    silenceLoopRunning = false;
    if (silenceLoopTimer) {
        clearTimeout(silenceLoopTimer);
        silenceLoopTimer = null;
    }
}

function runSilentAudioLoopOnce() {
    if (!silenceLoopRunning) return;
    playSilentAudio(silenceLoopDurationSeconds)
        .catch((error) => {
            console.error(`静音循环播放失败: ${error.message}`);
        })
        .finally(() => {
            if (!silenceLoopRunning) return;
            silenceLoopTimer = setTimeout(runSilentAudioLoopOnce, silenceLoopGapMs);
        });
}

function startSilentAudioLoop(durationSeconds, gapMs) {
    silenceLoopDurationSeconds = durationSeconds;
    silenceLoopGapMs = gapMs;
    if (silenceLoopRunning) {
        return;
    }
    silenceLoopRunning = true;
    runSilentAudioLoopOnce();
}

function getLocalNetworkIp() {
    const interfaces = os.networkInterfaces();
    for (const values of Object.values(interfaces)) {
        if (!values) continue;
        for (const item of values) {
            if (item.family === 'IPv4' && !item.internal) return item.address;
        }
    }
    return '127.0.0.1';
}

async function invoke(action, params = {}) {
    try {
        const response = await axios.post(settings.ankiConnectUrl, {
            action,
            version: 6,
            params,
        });
        if (response.data.error) {
            throw new Error(response.data.error);
        }
        return response.data.result;
    } catch (error) {
        const msg =
            error.code === 'ECONNREFUSED'
                ? '无法连接 AnkiConnect，请确认 Anki 已启动并安装 AnkiConnect。'
                : `AnkiConnect 请求失败: ${error.message}`;
        throw new Error(msg);
    }
}

function extractFilename(inputStr) {
    const match = String(inputStr || '').match(/\[sound:(.*?)\]/);
    return match && match[1] ? match[1].trim() : String(inputStr || '').trim();
}

function getAudioDuration(filePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) return reject(err);
            return resolve(metadata?.format?.duration || 0);
        });
    });
}

async function getCurrentCard() {
    const card = await invoke('guiCurrentCard');
    if (!card) {
        throw new Error('当前没有正在复习/浏览的卡片。');
    }
    return card;
}

async function getCurrentCardAudioFilename(fieldName = settings.targetField, cardInput = null) {
    const card = cardInput || (await getCurrentCard());
    const field = card.fields?.[fieldName];
    if (!field || !field.value) {
        throw new Error(`字段 "${fieldName}" 不存在或为空。`);
    }
    const filename = extractFilename(field.value);
    if (!filename.match(/\.(mp3|wav|m4a|ogg|aac|flac)$/i)) {
        throw new Error(`字段 "${fieldName}" 未检测到有效音频文件。`);
    }
    return {
        cardId: card.cardId,
        noteId: card.note,
        filename,
        fieldName,
    };
}

async function ensureBackup(filename) {
    const sourcePath = path.join(settings.mediaDir, filename);
    const backupPath = path.join(BACKUP_DIR, filename);
    await fs.ensureDir(path.dirname(backupPath));
    if (!(await fs.pathExists(backupPath))) {
        await fs.copy(sourcePath, backupPath);
    }
    return backupPath;
}

async function trimAudio(filename, startSeconds, endSeconds) {
    const sourcePath = path.join(settings.mediaDir, filename);
    const tempPath = path.join(settings.mediaDir, `temp_trim_${Date.now()}_${filename}`);
    if (!(await fs.pathExists(sourcePath))) {
        throw new Error(`找不到音频文件: ${sourcePath}`);
    }

    await ensureBackup(filename);

    let keepDuration = null;
    if (endSeconds > 0) {
        const totalDuration = await getAudioDuration(sourcePath);
        keepDuration = totalDuration - startSeconds - endSeconds;
        if (keepDuration <= 0) {
            throw new Error(
                `裁剪参数无效，音频总长 ${totalDuration.toFixed(3)}s，无法去头 ${startSeconds}s 和去尾 ${endSeconds}s。`
            );
        }
    }

    await new Promise((resolve, reject) => {
        let command = ffmpeg(sourcePath).setStartTime(startSeconds);
        if (keepDuration !== null) {
            command = command.setDuration(keepDuration);
        }
        command
            .output(tempPath)
            .on('end', () => resolve())
            .on('error', (err) => reject(err))
            .run();
    });

    await fs.move(tempPath, sourcePath, { overwrite: true });
}

async function amplifyAudio(filename, factor) {
    const sourcePath = path.join(settings.mediaDir, filename);
    const tempPath = path.join(settings.mediaDir, `temp_amp_${Date.now()}_${filename}`);
    if (!(await fs.pathExists(sourcePath))) {
        throw new Error(`找不到音频文件: ${sourcePath}`);
    }
    await ensureBackup(filename);

    await new Promise((resolve, reject) => {
        ffmpeg(sourcePath)
            .audioFilters(`volume=${factor}`)
            .output(tempPath)
            .on('end', () => resolve())
            .on('error', (err) => reject(err))
            .run();
    });

    await fs.move(tempPath, sourcePath, { overwrite: true });
}

async function restoreAudio(filename) {
    const targetPath = path.join(settings.mediaDir, filename);
    const backupPath = path.join(BACKUP_DIR, filename);
    if (!(await fs.pathExists(backupPath))) {
        throw new Error(`找不到备份文件: ${backupPath}`);
    }
    await fs.copy(backupPath, targetPath, { overwrite: true });
}

async function syncNow() {
    await invoke('sync');
}

function stopSyncJob() {
    if (syncJob) {
        syncJob.cancel();
        syncJob = null;
    }
    syncEnabled = false;
}

function startSyncJob(cron) {
    if (!cron || typeof cron !== 'string') {
        throw new Error('Cron 表达式不能为空。');
    }
    stopSyncJob();
    let createdJob = null;
    try {
        createdJob = schedule.scheduleJob(cron, async () => {
            try {
                await syncNow();
                console.log(`[${new Date().toLocaleString()}] 自动同步成功`);
            } catch (error) {
                console.error(`[${new Date().toLocaleString()}] 自动同步失败: ${error.message}`);
            }
        });
    } catch (error) {
        throw new Error(`无效的 Cron 表达式: ${cron}`);
    }
    if (!createdJob) {
        throw new Error(`无效的 Cron 表达式: ${cron}`);
    }
    syncJob = createdJob;
    syncEnabled = true;
    syncJobCron = cron;
}

app.get('/api/health', (req, res) => {
    res.json({
        ok: true,
        config: settings,
        syncScheduler: {
            enabled: syncEnabled,
            cron: syncJobCron,
            nextRunAt: syncJob ? syncJob.nextInvocation()?.toISOString() : null,
        },
    });
});

app.get('/api/settings', async (req, res) => {
    try {
        if (!settings) {
            settings = await loadSettings();
        }
        res.json({
            ok: true,
            settings,
            server: {
                port: PORT,
                host: HOST,
            },
            backupDir: BACKUP_DIR,
        });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.post('/api/settings', async (req, res) => {
    try {
        const prev = settings || (await loadSettings());
        const payload = { ...(req.body || {}) };
        delete payload.backupDir;
        const merged = sanitizeSettings({ ...prev, ...payload });
        settings = await saveSettings(merged);

        if (settings.syncEnabled) {
            startSyncJob(settings.defaultSyncCron);
        } else {
            stopSyncJob();
        }

        res.json({
            ok: true,
            message: '配置已保存。',
            settings,
            syncScheduler: {
                enabled: syncEnabled,
                cron: syncJobCron,
                nextRunAt: syncJob ? syncJob.nextInvocation()?.toISOString() : null,
            },
        });
    } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
    }
});

app.get('/api/current-card', async (req, res) => {
    try {
        const card = await getCurrentCard();
        let audio = null;
        try {
            audio = await getCurrentCardAudioFilename(
                req.query.fieldName || settings.targetField,
                card
            );
        } catch (err) {
            audio = { error: err.message };
        }
        res.json({
            ok: true,
            card: {
                cardId: card.cardId,
                noteId: card.note,
                deckName: card.deckName,
                modelName: card.modelName,
                fields: card.fields,
            },
            audio,
        });
    } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
    }
});

app.post('/api/sync', async (req, res) => {
    try {
        await syncNow();
        res.json({ ok: true, message: '同步命令已发送。' });
    } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
    }
});

app.get('/api/sync-scheduler', (req, res) => {
    res.json({
        ok: true,
        enabled: syncEnabled,
        cron: syncJobCron,
        nextRunAt: syncJob ? syncJob.nextInvocation()?.toISOString() : null,
    });
});

app.post('/api/sync-scheduler', (req, res) => {
    try {
        const { enabled, cron } = req.body || {};
        if (enabled) {
            startSyncJob(cron || syncJobCron || settings.defaultSyncCron);
            return res.json({
                ok: true,
                enabled: syncEnabled,
                cron: syncJobCron,
                nextRunAt: syncJob ? syncJob.nextInvocation()?.toISOString() : null,
            });
        }
        stopSyncJob();
        return res.json({ ok: true, enabled: false, cron: syncJobCron, nextRunAt: null });
    } catch (error) {
        return res.status(400).json({ ok: false, error: error.message });
    }
});

app.post('/api/audio/trim-current', async (req, res) => {
    try {
        const startSeconds = Number(
            req.body?.startSeconds ?? settings.defaultTrimStartSeconds
        );
        const endSeconds = Number(req.body?.endSeconds ?? settings.defaultTrimEndSeconds);
        if (Number.isNaN(startSeconds) || startSeconds < 0) {
            throw new Error('startSeconds 必须是 >= 0 的数字。');
        }
        if (Number.isNaN(endSeconds) || endSeconds < 0) {
            throw new Error('endSeconds 必须是 >= 0 的数字。');
        }
        const { filename, fieldName } = await getCurrentCardAudioFilename(
            req.body?.fieldName || settings.targetField
        );
        await trimAudio(filename, startSeconds, endSeconds);
        res.json({
            ok: true,
            message: `已完成裁剪: ${filename}`,
            filename,
            fieldName,
            startSeconds,
            endSeconds,
        });
    } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
    }
});

app.post('/api/audio/amplify-current', async (req, res) => {
    try {
        const factor = Number(req.body?.factor ?? settings.defaultAmplifyFactor);
        if (Number.isNaN(factor) || factor <= 0) {
            throw new Error('factor 必须是 > 0 的数字。');
        }
        const { filename, fieldName } = await getCurrentCardAudioFilename(
            req.body?.fieldName || settings.targetField
        );
        await amplifyAudio(filename, factor);
        res.json({
            ok: true,
            message: `已完成放大: ${filename}`,
            filename,
            fieldName,
            factor,
        });
    } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
    }
});

app.post('/api/audio/restore-current', async (req, res) => {
    try {
        const { filename, fieldName } = await getCurrentCardAudioFilename(
            req.body?.fieldName || settings.targetField
        );
        await restoreAudio(filename);
        res.json({
            ok: true,
            message: `已恢复原始音频: ${filename}`,
            filename,
            fieldName,
        });
    } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
    }
});

app.post('/api/audio/play-silence', async (req, res) => {
    try {
        const durationSeconds = Number(req.body?.durationSeconds ?? 1);
        if (Number.isNaN(durationSeconds) || durationSeconds <= 0) {
            throw new Error('durationSeconds 必须是 > 0 的数字。');
        }
        if (durationSeconds > 5) {
            throw new Error('durationSeconds 不能超过 5 秒。');
        }
        await playSilentAudio(durationSeconds);
        res.json({
            ok: true,
            message: `已播放 ${durationSeconds}s 静音音频。`,
            durationSeconds,
        });
    } catch (error) {
        const platform = os.platform();
        const hint =
            platform === 'linux'
                ? 'Linux 需要安装 aplay（例如 alsa-utils）。'
                : '请确认系统具备本地音频播放能力。';
        res.status(400).json({ ok: false, error: `${error.message} ${hint}`.trim() });
    }
});

app.get('/api/audio/silence-loop', (req, res) => {
    res.json({
        ok: true,
        enabled: silenceLoopRunning,
        durationSeconds: silenceLoopDurationSeconds,
        gapMs: silenceLoopGapMs,
    });
});

app.post('/api/audio/silence-loop', async (req, res) => {
    try {
        const enabled = Boolean(req.body?.enabled);
        const durationSeconds = Number(req.body?.durationSeconds ?? 1);
        const gapMs = Number(req.body?.gapMs ?? 150);
        if (Number.isNaN(durationSeconds) || durationSeconds <= 0 || durationSeconds > 5) {
            throw new Error('durationSeconds 必须是 0~5 之间的数字。');
        }
        if (Number.isNaN(gapMs) || gapMs < 0 || gapMs > 5000) {
            throw new Error('gapMs 必须是 0~5000 之间的数字。');
        }

        if (enabled) {
            startSilentAudioLoop(durationSeconds, gapMs);
            return res.json({
                ok: true,
                enabled: true,
                message: '静音循环已开启。',
                durationSeconds: silenceLoopDurationSeconds,
                gapMs: silenceLoopGapMs,
            });
        }

        stopSilentAudioLoop();
        return res.json({
            ok: true,
            enabled: false,
            message: '静音循环已关闭。',
            durationSeconds: silenceLoopDurationSeconds,
            gapMs: silenceLoopGapMs,
        });
    } catch (error) {
        return res.status(400).json({ ok: false, error: error.message });
    }
});

app.post('/api/remote/show-question', async (req, res) => {
    try {
        await invoke('guiShowQuestion');
        res.json({ ok: true, message: '已切换到问题面。' });
    } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
    }
});

app.post('/api/remote/show-answer', async (req, res) => {
    try {
        await invoke('guiShowAnswer');
        res.json({ ok: true, message: '已显示答案。' });
    } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
    }
});

app.post('/api/remote/answer', async (req, res) => {
    try {
        const ease = Number(req.body?.ease);
        if (![1, 2, 3, 4].includes(ease)) {
            throw new Error('ease 必须是 1/2/3/4。');
        }
        await invoke('guiAnswerCard', { ease });
        res.json({ ok: true, message: `已提交评分: ${ease}` });
    } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
    }
});

app.post('/api/remote/undo', async (req, res) => {
    try {
        await invoke('undo');
        res.json({ ok: true, message: '已撤销上一步。' });
    } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
    }
});

app.post('/api/remote/deck-review', async (req, res) => {
    try {
        const deck = req.body?.deck;
        if (!deck || typeof deck !== 'string') {
            throw new Error('deck 不能为空。');
        }
        await invoke('guiDeckReview', { name: deck });
        res.json({ ok: true, message: `已切换到牌组复习: ${deck}` });
    } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
    }
});

async function boot() {
    settings = await loadSettings();
    syncJobCron = settings.defaultSyncCron;
    if (settings.syncEnabled) {
        startSyncJob(settings.defaultSyncCron);
    } else {
        stopSyncJob();
    }

    app.listen(PORT, HOST, () => {
        const localIp = getLocalNetworkIp();
        console.log(`Anki Helper 已启动: http://localhost:${PORT}`);
        console.log(`手机遥控地址: http://${localIp}:${PORT}/?mode=remote`);
        console.log(`AnkiConnect: ${settings.ankiConnectUrl}`);
        console.log(`媒体库目录: ${settings.mediaDir}`);
    });
}

boot().catch((error) => {
    console.error(`启动失败: ${error.message}`);
    process.exit(1);
});
