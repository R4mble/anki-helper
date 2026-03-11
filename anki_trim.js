const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');

// ================= 配置区域 =================

const DEFAULT_SETTINGS_FILE = path.join(__dirname, 'app_default_setting.json');
const SETTINGS_FILE = path.join(__dirname, 'app_settings.json');

function loadRuntimeConfig() {
    const fallback = {
        ankiConnectUrl: 'http://127.0.0.1:8765',
        mediaDir: '/Users/user/Library/Application Support/Anki2/99/collection.media',
        targetField: '例句发音',
    };
    try {
        const source = fs.existsSync(SETTINGS_FILE) ? SETTINGS_FILE : DEFAULT_SETTINGS_FILE;
        if (!fs.existsSync(source)) return fallback;
        const data = fs.readJsonSync(source);
        return {
            ankiConnectUrl: String(data.ankiConnectUrl || fallback.ankiConnectUrl),
            mediaDir: String(data.mediaDir || fallback.mediaDir),
            targetField: String(data.targetField || fallback.targetField),
        };
    } catch (error) {
        console.warn(`读取配置失败，使用默认配置: ${error.message}`);
        return fallback;
    }
}

const RUNTIME_CONFIG = loadRuntimeConfig();
const ANKI_MEDIA_PATH = RUNTIME_CONFIG.mediaDir;
const ANKI_CONNECT_URL = RUNTIME_CONFIG.ankiConnectUrl;
const TARGET_FIELD = RUNTIME_CONFIG.targetField; 

const startTime = 0.5;         // 删除开头的秒数 (设为数字，例如 0.3)
const trimEndDuration = 0;   // 【新增】删除结尾的秒数 (设为 0 则不删结尾，例如 0.5)

const mode = 'trim'; // restore

// 备份文件夹路径
const BACKUP_DIR = path.join(__dirname, 'backup');


// ===========================================

// 提取文件名的工具函数
function extractFilename(inputStr) {
    const match = inputStr.match(/\[sound:(.*?)\]/) || [null, inputStr];
    return match[1] ? match[1].trim() : inputStr.trim();
}

/**
 * 【新增】获取音频总时长的辅助函数
 */
function getAudioDuration(filePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) {
                reject(err);
            } else {
                resolve(metadata.format.duration);
            }
        });
    });
}

/**
 * 通过 AnkiConnect 获取当前卡片的音频文件名
 */
async function getAudioFromCurrentCard() {
    try {
        const response = await axios.post(ANKI_CONNECT_URL, {
            action: 'guiCurrentCard',
            version: 6
        });

        const result = response.data.result;
        
        if (!result) {
            throw new Error('无法获取当前卡片信息。请确认 Anki 已打开并处于复习界面。');
        }

        const fields = result.fields;
        
        if (!fields[TARGET_FIELD]) {
            throw new Error(`当前卡片中找不到名为 "${TARGET_FIELD}" 的字段。请检查配置或卡片模板。`);
        }

        const fieldValue = fields[TARGET_FIELD].value;
        const filename = extractFilename(fieldValue);

        if (!filename.match(/\.(mp3|wav|m4a|ogg)$/i)) {
            throw new Error(`字段 "${TARGET_FIELD}" 中似乎没有包含有效的音频文件: ${fieldValue}`);
        }

        console.log(`🔎 从当前卡片检测到音频: ${filename}`);
        return filename;

    } catch (error) {
        if (error.code === 'ECONNREFUSED') {
            console.error('❌ 连接失败：请确保 Anki 已打开并且安装了 AnkiConnect 插件。');
        } else {
            console.error(`❌ 获取卡片信息失败: ${error.message}`);
        }
        return null;
    }
}

/**
 * 剪切音频并替换
 */
async function trimAudio(filename) {
    if (!filename) return;

    filename = extractFilename(filename);

    const sourcePath = path.join(ANKI_MEDIA_PATH, filename);
    const backupPath = path.join(BACKUP_DIR, filename);
    const tempPath = path.join(__dirname, `temp_${filename}`);

    if (!fs.existsSync(sourcePath)) {
        console.error(`❌ 错误：在 Anki 媒体库中找不到文件: ${filename}`);
        return;
    }

    try {
        // 备份
        await fs.ensureDir(BACKUP_DIR);
        if (!fs.existsSync(backupPath)) {
            await fs.copy(sourcePath, backupPath);
            console.log(`✅ 已备份原文件至: ${backupPath}`);
        }

        // 剪切逻辑
        let keepDuration = null; 

        // 如果配置了去掉结尾，则需要先获取原音频总时长
        if (trimEndDuration > 0) {
            try {
                const totalDuration = await getAudioDuration(sourcePath);
                // 需要保留的时长 = 总时长 - 开头切掉的 - 结尾切掉的
                keepDuration = totalDuration - Number(startTime) - Number(trimEndDuration);
                
                if (keepDuration <= 0) {
                    console.error(`❌ 错误：音频总时长(${totalDuration}s) 减去头尾后小于等于 0，请检查 startTime 或 trimEndDuration 设置！`);
                    return;
                }
            } catch (probeErr) {
                console.error(`❌ 获取音频长度失败，请确认你的系统安装了 ffprobe（通常和 ffmpeg 打包在一起）: ${probeErr.message}`);
                return;
            }
        }

        console.log(`✂️ 正在处理音频 (去除前 ${startTime}s${trimEndDuration > 0 ? `，去除后 ${trimEndDuration}s` : ''})...`);
        
        await new Promise((resolve, reject) => {
            let command = ffmpeg(sourcePath).setStartTime(startTime);
            
            // 只有当计算出保留时长时，才添加 setDuration 约束
            if (keepDuration !== null) {
                command.setDuration(keepDuration);
            }

            command.output(tempPath)
                .on('end', () => resolve())
                .on('error', (err) => reject(err))
                .run();
        });

        // 替换
        await fs.move(tempPath, sourcePath, { overwrite: true });
        console.log(`🎉 成功！Anki 文件已替换。请点击 Anki 上的重播按钮听效果。`);

    } catch (err) {
        console.error('❌ 处理错误:', err);
        if (fs.existsSync(tempPath)) fs.removeSync(tempPath);
    }
}

/**
 * 恢复原始音频
 */
async function restoreAudio(filename) {
    if (!filename) return;
    filename = extractFilename(filename);

    const targetPath = path.join(ANKI_MEDIA_PATH, filename);
    const backupPath = path.join(BACKUP_DIR, filename);

    if (!fs.existsSync(backupPath)) {
        console.error(`❌ 错误：在备份文件夹中找不到文件: ${filename}`);
        return;
    }

    try {
        await fs.copy(backupPath, targetPath, { overwrite: true });
        console.log(`✅ 已将 "${filename}" 恢复为原始版本。`);
    } catch (err) {
        console.error('❌ 恢复失败:', err);
    }
}

// ================= 命令行入口 =================

(async () => {
    const args = process.argv.slice(2);
    const command = args[0]; 
    let inputFilename = args[1]; 

    if (!inputFilename) {
        console.log(`📡 正在连接 Anki 获取当前卡片信息...`);
        inputFilename = await getAudioFromCurrentCard();
        if (!inputFilename) return; 
    }

    if ('trim' === mode) {
        await trimAudio(inputFilename);
    } else {
        await restoreAudio(inputFilename);
    }
})();