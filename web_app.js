const express = require('express');
const path = require('path');
const os = require('os');
const fs = require('fs-extra');
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const ffmpeg = require('fluent-ffmpeg');
const schedule = require('node-schedule');

const APP_DIR = process.pkg ? path.dirname(process.execPath) : __dirname;
const BUNDLED_DEFAULT_SETTINGS_FILE = path.join(__dirname, 'app_default_setting.json');
const PORT = Number(process.env.PORT || 3333);
const HOST = process.env.HOST || '0.0.0.0';
const DEFAULT_SETTINGS_FILE = path.join(APP_DIR, 'app_default_setting.json');
const SETTINGS_FILE = path.join(APP_DIR, 'app_settings.json');
const BACKUP_DIR = path.join(APP_DIR, 'backup');
const RUNTIME_DIR = path.join(APP_DIR, '.runtime');
const WORD_FREQ_FILE = path.join(__dirname, 'public', '20000.txt');
const DEFAULT_SETTINGS_TEMPLATE = {
    ankiConnectUrl: 'http://127.0.0.1:8765',
    mediaDir:
        os.platform() === 'win32'
            ? 'C:\\Users\\user\\AppData\\Roaming\\Anki2\\账户 1\\collection.media'
            : '/Users/user/Library/Application Support/Anki2/账户 1/collection.media',
    mediaDirMac: '/Users/user/Library/Application Support/Anki2/账户 1/collection.media',
    mediaDirWindows: 'C:\\Users\\user\\AppData\\Roaming\\Anki2\\账户 1\\collection.media',
    targetField: process.env.ANKI_TARGET_FIELD || '例句发音',
    defaultTrimStartSeconds: 0.5,
    defaultTrimEndSeconds: 0,
    defaultAmplifyFactor: 4.0,
    defaultSyncCron: '30 19 * * *',
    syncEnabled: true,
    latestCardImageField: '例句图片',
    latestCardAudioField: '例句发音',
    clipboardMonitorEnabled: false,
    subtitleSearchDir: '',
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
let clipboardMonitorRunning = false;
let clipboardMonitorTimer = null;
let clipboardLastImageHash = '';
let clipboardMonitorBusy = false;
let wordFreqCache = null;

function parseNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseSubtitleTimeToSeconds(raw) {
    const text = String(raw || '').trim().replace(',', '.');
    const matched = /^(\d{1,2}):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(text);
    if (!matched) return null;
    const hours = Number(matched[1]);
    const minutes = Number(matched[2]);
    const seconds = Number(matched[3]);
    if ([hours, minutes, seconds].some((v) => Number.isNaN(v))) return null;
    return hours * 3600 + minutes * 60 + seconds;
}

function cleanSubtitleText(input) {
    return String(input || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\{[^}]*\}/g, ' ')
        .replace(/\\N/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

async function loadWordFrequencyList() {
    if (wordFreqCache) return wordFreqCache;
    const raw = await fs.readFile(WORD_FREQ_FILE, 'utf8');
    const rows = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            const matched = /^(\d+)\s+(.+)$/.exec(line);
            if (!matched) return null;
            return { rank: Number(matched[1]), word: matched[2].trim() };
        })
        .filter((row) => row && Number.isFinite(row.rank) && row.word);
    wordFreqCache = rows;
    return rows;
}

async function listFilesRecursive(rootDir, extsLowerSet) {
    const result = [];
    const queue = [rootDir];
    while (queue.length > 0) {
        const current = queue.shift();
        const items = await fs.readdir(current, { withFileTypes: true });
        for (const item of items) {
            const fullPath = path.join(current, item.name);
            if (item.isDirectory()) {
                queue.push(fullPath);
                continue;
            }
            if (!item.isFile()) continue;
            const ext = path.extname(item.name).toLowerCase();
            if (extsLowerSet.has(ext)) {
                result.push(fullPath);
            }
        }
    }
    return result;
}

async function parseSrtFile(filePath) {
    const raw = await fs.readFile(filePath, 'utf8');
    const blocks = raw.split(/\r?\n\r?\n/);
    const rows = [];
    for (const block of blocks) {
        const lines = block
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
        if (lines.length < 2) continue;
        const timeLine = lines.find((line) => line.includes('-->'));
        if (!timeLine) continue;
        const pieces = timeLine.split('-->');
        if (pieces.length !== 2) continue;
        const start = parseSubtitleTimeToSeconds(pieces[0]);
        const end = parseSubtitleTimeToSeconds(pieces[1]);
        if (start === null || end === null || end <= start) continue;
        const textLines = lines.filter((line) => !line.includes('-->') && !/^\d+$/.test(line));
        const text = cleanSubtitleText(textLines.join(' '));
        if (!text) continue;
        rows.push({ start, end, text });
    }
    return rows;
}

async function parseVttFile(filePath) {
    const raw = await fs.readFile(filePath, 'utf8');
    const blocks = raw.split(/\r?\n\r?\n/);
    const rows = [];
    for (const block of blocks) {
        const lines = block
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
        if (lines.length < 2) continue;
        const timeLine = lines.find((line) => line.includes('-->'));
        if (!timeLine) continue;
        const pieces = timeLine.split('-->');
        if (pieces.length !== 2) continue;
        const start = parseSubtitleTimeToSeconds(pieces[0].split(/\s+/)[0]);
        const end = parseSubtitleTimeToSeconds(pieces[1].split(/\s+/)[0]);
        if (start === null || end === null || end <= start) continue;
        const textLines = lines.filter((line) => !line.includes('-->') && !/^NOTE\b/i.test(line));
        const text = cleanSubtitleText(textLines.join(' '));
        if (!text) continue;
        rows.push({ start, end, text });
    }
    return rows;
}

async function parseAssFile(filePath) {
    const raw = await fs.readFile(filePath, 'utf8');
    const lines = raw.split(/\r?\n/);
    const rows = [];
    for (const line of lines) {
        if (!line.startsWith('Dialogue:')) continue;
        const payload = line.slice('Dialogue:'.length).trim();
        const parts = payload.split(',');
        if (parts.length < 10) continue;
        const start = parseSubtitleTimeToSeconds(parts[1]);
        const end = parseSubtitleTimeToSeconds(parts[2]);
        if (start === null || end === null || end <= start) continue;
        const text = cleanSubtitleText(parts.slice(9).join(','));
        if (!text) continue;
        rows.push({ start, end, text });
    }
    return rows;
}

async function parseSubtitleFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.srt') return parseSrtFile(filePath);
    if (ext === '.vtt') return parseVttFile(filePath);
    if (ext === '.ass' || ext === '.ssa') return parseAssFile(filePath);
    return [];
}

function subtitleContainsWord(text, word) {
    const normalizedText = String(text || '').toLowerCase();
    const normalizedWord = String(word || '').toLowerCase().trim();
    if (!normalizedWord) return false;
    if (/^[a-z0-9]+$/i.test(normalizedWord)) {
        const matcher = new RegExp(`\\b${escapeRegExp(normalizedWord)}\\b`, 'i');
        return matcher.test(normalizedText);
    }
    return normalizedText.includes(normalizedWord);
}

async function findMediaFileForSubtitle(subtitlePath) {
    const mediaExts = ['.mp4', '.mkv', '.mov', '.avi', '.webm', '.m4v'];
    const base = path.basename(subtitlePath, path.extname(subtitlePath));
    const dir = path.dirname(subtitlePath);
    for (const ext of mediaExts) {
        const candidate = path.join(dir, `${base}${ext}`);
        if (await fs.pathExists(candidate)) return candidate;
    }
    const siblings = await fs.readdir(dir);
    const fallback = siblings.find((name) => mediaExts.includes(path.extname(name).toLowerCase()));
    return fallback ? path.join(dir, fallback) : null;
}

async function extractScreenshotFromVideo(videoPath, seconds, outPath) {
    await new Promise((resolve, reject) => {
        ffmpeg(videoPath)
            .seekInput(Math.max(0, seconds))
            .outputOptions(['-frames:v 1'])
            .output(outPath)
            .on('end', resolve)
            .on('error', reject)
            .run();
    });
}

async function extractAudioFromVideo(videoPath, startSeconds, durationSeconds, outPath) {
    await new Promise((resolve, reject) => {
        ffmpeg(videoPath)
            .seekInput(Math.max(0, startSeconds))
            .duration(Math.max(0.3, durationSeconds))
            .audioCodec('aac')
            .noVideo()
            .output(outPath)
            .on('end', resolve)
            .on('error', reject)
            .run();
    });
}

async function updateLatestNoteMediaFields({ imageFilename, audioFilename }) {
    const latestNoteId = await getLatestAddedNoteId();
    const fields = {};
    if (imageFilename) {
        fields[settings.latestCardImageField] = `<img src="${imageFilename}">`;
    }
    if (audioFilename) {
        fields[settings.latestCardAudioField] = `[sound:${audioFilename}]`;
    }
    await invoke('updateNoteFields', {
        note: {
            id: latestNoteId,
            fields,
        },
    });
    return latestNoteId;
}

async function updateLatestNoteMediaByWord({ word, subtitleDir }) {
    const targetWord = String(word || '').trim();
    if (!targetWord) throw new Error('word 不能为空。');
    const targetDir = String(subtitleDir || settings.subtitleSearchDir || '').trim();
    if (!targetDir) throw new Error('subtitleDir 不能为空。');
    if (!(await fs.pathExists(targetDir))) throw new Error(`目录不存在: ${targetDir}`);

    const subtitleExts = new Set(['.srt', '.vtt', '.ass', '.ssa']);
    const subtitleFiles = await listFilesRecursive(targetDir, subtitleExts);
    if (subtitleFiles.length === 0) {
        throw new Error(`未找到字幕文件（支持 srt/vtt/ass/ssa）: ${targetDir}`);
    }

    let hit = null;
    for (const subtitlePath of subtitleFiles.sort((a, b) => a.localeCompare(b))) {
        const rows = await parseSubtitleFile(subtitlePath);
        const matchedRow = rows.find((row) => subtitleContainsWord(row.text, targetWord));
        if (!matchedRow) continue;
        hit = { subtitlePath, row: matchedRow };
        break;
    }
    if (!hit) throw new Error(`在字幕目录中未匹配到词汇: ${targetWord}`);

    const mediaPath = await findMediaFileForSubtitle(hit.subtitlePath);
    if (!mediaPath) {
        throw new Error(`找到字幕但未找到同目录视频文件: ${path.basename(hit.subtitlePath)}`);
    }

    await fs.ensureDir(RUNTIME_DIR);
    const stamp = Date.now();
    const safeWord = targetWord.toLowerCase().replace(/[^a-z0-9_-]+/gi, '_');
    const screenshotPath = path.join(RUNTIME_DIR, `wf_${safeWord}_${stamp}.png`);
    const audioPath = path.join(RUNTIME_DIR, `wf_${safeWord}_${stamp}.m4a`);
    const middleSecond = hit.row.start + Math.max(0.1, (hit.row.end - hit.row.start) / 2);
    const audioStart = Math.max(0, hit.row.start - 0.15);
    const audioDuration = Math.min(6, Math.max(1.1, hit.row.end - hit.row.start + 0.3));

    await extractScreenshotFromVideo(mediaPath, middleSecond, screenshotPath);
    await extractAudioFromVideo(mediaPath, audioStart, audioDuration, audioPath);

    const imageFilename = await storeMediaWithAnki(
        screenshotPath,
        `wf_${safeWord}_${stamp}.png`
    );
    const audioFilename = await storeMediaWithAnki(
        audioPath,
        `wf_${safeWord}_${stamp}.m4a`
    );
    const noteId = await updateLatestNoteMediaFields({ imageFilename, audioFilename });

    return {
        noteId,
        imageFilename,
        audioFilename,
        subtitlePath: hit.subtitlePath,
        mediaPath,
        subtitleText: hit.row.text,
        subtitleStart: hit.row.start,
        subtitleEnd: hit.row.end,
    };
}

function sanitizeSettings(input) {
    const merged = { ...(defaultSettings || DEFAULT_SETTINGS_TEMPLATE), ...(input || {}) };
    return {
        ankiConnectUrl: String(merged.ankiConnectUrl || 'http://127.0.0.1:8765').trim(),
        mediaDir: String(merged.mediaDir || '').trim(),
        mediaDirMac: String(merged.mediaDirMac || '').trim(),
        mediaDirWindows: String(merged.mediaDirWindows || '').trim(),
        targetField: String(merged.targetField || '例句发音').trim(),
        defaultTrimStartSeconds: Math.max(0, parseNumber(merged.defaultTrimStartSeconds, 0.5)),
        defaultTrimEndSeconds: Math.max(0, parseNumber(merged.defaultTrimEndSeconds, 0)),
        defaultAmplifyFactor: Math.max(0.1, parseNumber(merged.defaultAmplifyFactor, 4)),
        defaultSyncCron: String(merged.defaultSyncCron || '30 19 * * *').trim(),
        syncEnabled: Boolean(merged.syncEnabled),
        latestCardImageField: String(merged.latestCardImageField || '例句图片').trim(),
        latestCardAudioField: String(merged.latestCardAudioField || '例句发音').trim(),
        clipboardMonitorEnabled: Boolean(merged.clipboardMonitorEnabled),
        subtitleSearchDir: String(merged.subtitleSearchDir || '').trim(),
    };
}

async function loadDefaultSettings() {
    if (!(await fs.pathExists(DEFAULT_SETTINGS_FILE))) {
        if (process.pkg && (await fs.pathExists(BUNDLED_DEFAULT_SETTINGS_FILE))) {
            await fs.copy(BUNDLED_DEFAULT_SETTINGS_FILE, DEFAULT_SETTINGS_FILE);
            return fs.readJson(DEFAULT_SETTINGS_FILE);
        }
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

function getClipboardImageCommandByPlatform() {
    if (os.platform() === 'darwin') {
        return {
            cmd: 'pngpaste',
            args: ['-'],
            isBase64Text: false,
        };
    }
    if (os.platform() === 'win32') {
        const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($null -eq $img) { exit 2 }
$ms = New-Object System.IO.MemoryStream
$img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
[System.Convert]::ToBase64String($ms.ToArray())
`;
        return {
            cmd: 'powershell',
            args: ['-NoProfile', '-Command', script.replace(/\n/g, '; ')],
            isBase64Text: true,
        };
    }
    return null;
}

function readClipboardImageBuffer() {
    return new Promise((resolve, reject) => {
        const spec = getClipboardImageCommandByPlatform();
        if (!spec) {
            return reject(new Error('当前系统不支持剪贴板图片监控。'));
        }
        execFile(spec.cmd, spec.args, { encoding: 'buffer', maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) {
                if (err.code === 2) return resolve(null);
                return reject(new Error((stderr || err.message || '').toString().trim() || '读取剪贴板失败'));
            }
            if (!stdout || stdout.length === 0) return resolve(null);
            if (spec.isBase64Text) {
                const text = stdout.toString().trim();
                if (!text) return resolve(null);
                return resolve(Buffer.from(text, 'base64'));
            }
            return resolve(Buffer.from(stdout));
        });
    });
}

function getLatestNoteIdFromList(noteIds) {
    if (!Array.isArray(noteIds) || noteIds.length === 0) return null;
    return noteIds.reduce((max, id) => (id > max ? id : max), noteIds[0]);
}

async function getLatestAddedNoteId() {
    const noteIds = await invoke('findNotes', { query: 'added:1' });
    const latest = getLatestNoteIdFromList(noteIds);
    if (!latest) {
        throw new Error('未找到最近添加的卡片。');
    }
    return latest;
}

async function storeMediaWithAnki(filePath, preferredName) {
    const data = await fs.readFile(filePath);
    const filename =
        preferredName ||
        `${Date.now()}_${path.basename(filePath).replace(/\s+/g, '_')}`;
    await invoke('storeMediaFile', {
        filename,
        data: data.toString('base64'),
    });
    return filename;
}

function appendFieldValue(origin, appended) {
    const current = String(origin || '');
    if (!current) return appended;
    if (current.includes(appended)) return current;
    return `${current}\n${appended}`;
}

async function appendMediaToLatestNote({ imageFilename, audioFilename }) {
    const latestNoteId = await getLatestAddedNoteId();
    const noteInfo = await invoke('notesInfo', { notes: [latestNoteId] });
    const note = Array.isArray(noteInfo) ? noteInfo[0] : null;
    if (!note) throw new Error('无法读取最近添加卡片详情。');

    const fieldsToUpdate = {};
    if (imageFilename) {
        const oldValue = note.fields?.[settings.latestCardImageField]?.value || '';
        fieldsToUpdate[settings.latestCardImageField] = appendFieldValue(
            oldValue,
            `<img src="${imageFilename}">`
        );
    }
    if (audioFilename) {
        const oldValue = note.fields?.[settings.latestCardAudioField]?.value || '';
        fieldsToUpdate[settings.latestCardAudioField] = appendFieldValue(
            oldValue,
            `[sound:${audioFilename}]`
        );
    }
    if (Object.keys(fieldsToUpdate).length === 0) {
        throw new Error('没有可写入的媒体字段。');
    }

    await invoke('updateNoteFields', {
        note: {
            id: latestNoteId,
            fields: fieldsToUpdate,
        },
    });
    return latestNoteId;
}

async function captureScreenshotToFile(targetPath) {
    const platform = os.platform();
    if (platform === 'darwin') {
        await new Promise((resolve, reject) => {
            execFile('screencapture', ['-x', targetPath], (err) => {
                if (err) return reject(err);
                return resolve();
            });
        });
        return;
    }
    if (platform === 'win32') {
        const escaped = targetPath.replace(/\\/g, '\\\\').replace(/'/g, "''");
        const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bmp)
$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bmp.Save('${escaped}', [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bmp.Dispose()
`;
        await new Promise((resolve, reject) => {
            execFile('powershell', ['-NoProfile', '-Command', script.replace(/\n/g, '; ')], (err) => {
                if (err) return reject(err);
                return resolve();
            });
        });
        return;
    }
    throw new Error('当前系统暂不支持截图。');
}

async function captureAudioToFile(targetPath, durationSeconds = 3) {
    const platform = os.platform();
    if (platform === 'darwin') {
        await new Promise((resolve, reject) => {
            execFile(
                'ffmpeg',
                ['-f', 'avfoundation', '-i', ':0', '-t', String(durationSeconds), '-y', targetPath],
                (err) => {
                    if (err) return reject(err);
                    return resolve();
                }
            );
        });
        return;
    }
    if (platform === 'win32') {
        await new Promise((resolve, reject) => {
            execFile(
                'ffmpeg',
                ['-f', 'dshow', '-i', 'audio=default', '-t', String(durationSeconds), '-y', targetPath],
                (err) => {
                    if (err) return reject(err);
                    return resolve();
                }
            );
        });
        return;
    }
    throw new Error('当前系统暂不支持录音。');
}

async function captureAndAttachToLatestNote() {
    await fs.ensureDir(RUNTIME_DIR);
    const stamp = Date.now();
    const screenshotPath = path.join(RUNTIME_DIR, `capture_${stamp}.png`);
    const audioPath = path.join(RUNTIME_DIR, `capture_${stamp}.m4a`);

    await captureScreenshotToFile(screenshotPath);
    await captureAudioToFile(audioPath, 3);

    const imageFilename = await storeMediaWithAnki(screenshotPath, `capture_${stamp}.png`);
    const audioFilename = await storeMediaWithAnki(audioPath, `capture_${stamp}.m4a`);
    const noteId = await appendMediaToLatestNote({ imageFilename, audioFilename });
    return { noteId, imageFilename, audioFilename };
}

async function syncClipboardImageToLatestNote() {
    if (clipboardMonitorBusy) return;
    clipboardMonitorBusy = true;
    try {
        const imageBuffer = await readClipboardImageBuffer();
        if (!imageBuffer || imageBuffer.length === 0) return;
        const hash = crypto.createHash('sha1').update(imageBuffer).digest('hex');
        if (hash === clipboardLastImageHash) return;
        clipboardLastImageHash = hash;

        await fs.ensureDir(RUNTIME_DIR);
        const filePath = path.join(RUNTIME_DIR, `clipboard_${Date.now()}.png`);
        await fs.writeFile(filePath, imageBuffer);
        const imageFilename = await storeMediaWithAnki(filePath, path.basename(filePath));
        await appendMediaToLatestNote({ imageFilename });
        console.log(`剪贴板图片已写入最近卡片: ${imageFilename}`);
    } catch (error) {
        console.error(`剪贴板监控失败: ${error.message}`);
    } finally {
        clipboardMonitorBusy = false;
    }
}

function stopClipboardMonitor() {
    clipboardMonitorRunning = false;
    if (clipboardMonitorTimer) {
        clearInterval(clipboardMonitorTimer);
        clipboardMonitorTimer = null;
    }
}

function startClipboardMonitor(intervalMs = 1500) {
    if (clipboardMonitorRunning) return;
    clipboardMonitorRunning = true;
    clipboardMonitorTimer = setInterval(() => {
        syncClipboardImageToLatestNote();
    }, intervalMs);
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
        const resp = await fetch(settings.ankiConnectUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action,
                version: 6,
                params,
            }),
        });
        const response = await resp.json();
        if (response.error) {
            throw new Error(response.error);
        }
        return response.result;
    } catch (error) {
        const isConnRefused =
            error.code === 'ECONNREFUSED' ||
            (typeof error.message === 'string' && error.message.includes('ECONNREFUSED'));
        const msg =
            isConnRefused
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
        if (settings.clipboardMonitorEnabled) {
            startClipboardMonitor();
        } else {
            stopClipboardMonitor();
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

app.get('/api/word-freq/list', async (req, res) => {
    try {
        const start = Math.max(1, Number(req.query.start || 5000));
        const end = Math.max(start, Number(req.query.end || start + 99));
        const limit = Math.min(500, Math.max(1, end - start + 1));
        const rows = await loadWordFrequencyList();
        const filtered = rows.filter((item) => item.rank >= start && item.rank <= end).slice(0, limit);
        res.json({
            ok: true,
            start,
            end,
            total: filtered.length,
            rows: filtered,
        });
    } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
    }
});

app.post('/api/anki/update-latest-media-by-word', async (req, res) => {
    try {
        const word = String(req.body?.word || '').trim();
        const subtitleDir = String(req.body?.subtitleDir || '').trim();
        if (!word) throw new Error('word 不能为空。');
        if (!subtitleDir) throw new Error('subtitleDir 不能为空。');
        settings = await saveSettings({ ...settings, subtitleSearchDir: subtitleDir });
        const result = await updateLatestNoteMediaByWord({ word, subtitleDir });
        res.json({
            ok: true,
            message: `已更新最近新增卡片媒体（${word}）。`,
            ...result,
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

app.get('/api/clipboard-monitor', (req, res) => {
    res.json({
        ok: true,
        enabled: clipboardMonitorRunning,
    });
});

app.post('/api/clipboard-monitor', async (req, res) => {
    const enabled = Boolean(req.body?.enabled);
    if (enabled) {
        startClipboardMonitor();
    } else {
        stopClipboardMonitor();
    }
    settings = await saveSettings({ ...settings, clipboardMonitorEnabled: enabled });
    res.json({
        ok: true,
        enabled: clipboardMonitorRunning,
        message: enabled ? '剪贴板图片监控已开启。' : '剪贴板图片监控已关闭。',
    });
});

app.post('/api/anki/capture-latest', async (req, res) => {
    try {
        const result = await captureAndAttachToLatestNote();
        res.json({
            ok: true,
            message: '截图和录音已写入最近添加卡片。',
            ...result,
        });
    } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
    }
});

app.post('/api/anki/remove-substring', async (req, res) => {
    try {
        const deck = String(req.body?.deck || '').trim();
        const fieldName = String(req.body?.fieldName || '').trim();
        const substring = String(req.body?.substring || '');
        if (!deck) throw new Error('deck 不能为空。');
        if (!fieldName) throw new Error('fieldName 不能为空。');
        if (!substring) throw new Error('substring 不能为空。');

        const noteIds = await invoke('findNotes', { query: `deck:"${deck}"` });
        if (!noteIds || noteIds.length === 0) {
            return res.json({ ok: true, updatedCount: 0, message: '未找到匹配笔记。' });
        }
        const notes = await invoke('notesInfo', { notes: noteIds });
        let updatedCount = 0;
        for (const note of notes) {
            const oldValue = String(note.fields?.[fieldName]?.value || '');
            if (!oldValue.includes(substring)) continue;
            const newValue = oldValue.split(substring).join('');
            await invoke('updateNoteFields', {
                note: {
                    id: note.noteId,
                    fields: {
                        [fieldName]: newValue,
                    },
                },
            });
            updatedCount += 1;
        }
        res.json({
            ok: true,
            updatedCount,
            message: `已更新 ${updatedCount} 条笔记。`,
        });
    } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
    }
});

app.post('/api/remote/cmd', async (req, res) => {
    try {
        const command = String(req.body?.command || '').trim();
        if (!command) throw new Error('command 不能为空。');

        if (command === '1') {
            await invoke('guiAnswerCard', { ease: 1 });
            return res.json({ ok: true, message: '已执行：重来' });
        }
        if (command === '2') {
            await invoke('guiAnswerCard', { ease: 2 });
            return res.json({ ok: true, message: '已执行：困难' });
        }
        if (command === 'space') {
            await invoke('guiShowAnswer');
            return res.json({ ok: true, message: '已执行：翻面' });
        }
        if (command === 'anki_undo') {
            await invoke('undo');
            return res.json({ ok: true, message: '已执行：撤销' });
        }
        if (command === 'R') {
            const result = await captureAndAttachToLatestNote();
            return res.json({
                ok: true,
                message: '已执行：回放（截图+录音写入最近卡片）',
                ...result,
            });
        }
        throw new Error(`不支持的命令: ${command}`);
    } catch (error) {
        res.status(400).json({ ok: false, error: error.message });
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
    if (settings.clipboardMonitorEnabled) {
        startClipboardMonitor();
    } else {
        stopClipboardMonitor();
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
