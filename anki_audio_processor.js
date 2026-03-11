const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ================= 配置区 =================
// 核心控制变量：设置为 true 执行回滚（恢复最原始版本），设置为 false 执行放大音量
const IS_ROLLBACK = false;

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
        const data = JSON.parse(fs.readFileSync(source, 'utf8'));
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
const FIELD_NAME = RUNTIME_CONFIG.targetField;
const MEDIA_DIR = RUNTIME_CONFIG.mediaDir;
const ANKI_CONNECT_URL = RUNTIME_CONFIG.ankiConnectUrl;
// ==========================================

// AnkiConnect API 调用封装
async function invoke(action, params = {}) {
    try {
        const response = await axios.post(ANKI_CONNECT_URL, {
            action,
            version: 6,
            params
        });
        if (response.data.error) throw new Error(response.data.error);
        return response.data.result;
    } catch (error) {
        console.error(`与 AnkiConnect 通信失败: ${error.message}`);
        console.error('请确保 Anki 正在运行且安装了 AnkiConnect 插件。');
        process.exit(1);
    }
}

async function processCurrentCardAudio() {
    try {
        console.log('正在获取当前卡片信息...');
        const currentCard = await invoke('guiCurrentCard');
        
        if (!currentCard) {
            console.log('当前没有正在浏览或复习的卡片。');
            return;
        }

        const fieldData = currentCard.fields[FIELD_NAME];
        if (!fieldData || !fieldData.value) {
            console.log(`未找到字段 [${FIELD_NAME}] 或该字段为空。`);
            return;
        }

        const match = fieldData.value.match(/\[sound:(.+?)\]/);
        if (!match) {
            console.log(`字段 [${FIELD_NAME}] 中未检测到音频标签。`);
            return;
        }

        const audioFileName = match[1];
        const originalFilePath = path.join(MEDIA_DIR, audioFileName);
        const backupFilePath = path.join(MEDIA_DIR, `${audioFileName}.backup`);
        
        // 【修改点 1】将临时文件名改为前缀模式，保留原有的音频后缀名（如 .mp3），确保 FFmpeg 能识别输出格式
        const tempFilePath = path.join(MEDIA_DIR, `temp_${audioFileName}`);

        if (!fs.existsSync(originalFilePath) && !fs.existsSync(backupFilePath)) {
            console.log(`找不到音频文件: ${originalFilePath}`);
            return;
        }

        console.log(`目标音频文件: ${audioFileName}`);

        if (IS_ROLLBACK) {
            // === 回滚逻辑 ===
            if (fs.existsSync(backupFilePath)) {
                fs.copyFileSync(backupFilePath, originalFilePath);
                console.log('✅ 回滚成功：已完美恢复到最初始的音频版本！');
            } else {
                console.log('⚠️ 找不到备份文件，说明该音频还没有被处理过，无需回滚。');
            }
        } else {
            // === 叠加放大音量逻辑 ===
            // 1. 只有在不存在备份时才创建备份，确保备份永远是【最原始的版本】
            if (!fs.existsSync(backupFilePath)) {
                fs.copyFileSync(originalFilePath, backupFilePath);
                console.log('已创建最原始音频的备份。');
            }

            console.log('正在使用 FFmpeg 进行叠加放大...');
            // 2. 基于当前文件输出到临时文件 (volume=2.0)
            // 注意：如果你运行后依然提示 command not found，请把下面的 ffmpeg 换成你的绝对路径，例如 /opt/homebrew/bin/ffmpeg
            const command = `ffmpeg -i "${originalFilePath}" -filter:a "volume=4.0" -y "${tempFilePath}"`;
            
            try {
                // 【修改点 2】去掉 stdio: 'ignore'，改用 pipe 接收输出，让 Node.js 可以捕获 FFmpeg 的真实报错
                execSync(command, { stdio: 'pipe' });
                
                // 3. 用放大后的临时文件替换当前文件
                fs.renameSync(tempFilePath, originalFilePath);
                console.log('✅ 处理完成：当前音量已在原基础上再次放大两倍！');

            } catch (err) {
                // 【修改点 3】将 FFmpeg 的真实错误信息打印出来，方便定位问题
                console.error('❌ FFmpeg 处理失败，详情如下：');
                if (err.stderr) {
                    console.error(err.stderr.toString());
                } else {
                    console.error(err.message);
                }
                
                // 发生错误时清理临时文件
                if (fs.existsSync(tempFilePath)) {
                    fs.unlinkSync(tempFilePath);
                }
            }
        }

    } catch (error) {
        console.error('发生错误:', error);
    }
}

// 运行脚本
processCurrentCardAudio();