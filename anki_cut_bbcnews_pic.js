const sharp = require('sharp');
const fs = require('fs').promises;
const path = require('path');

// ================= 配置区域 =================
const APP_DIR = __dirname;
const SETTINGS_FILE = path.join(APP_DIR, 'app_settings.json');
const DEFAULT_SETTINGS_FILE = path.join(APP_DIR, 'app_default_setting.json');
const DECK_NAME = '#Listening::English::Word';
const FRONT_FIELD = '正面';
const IMAGE_FIELD = '例句图片'; // 包含图片标签的字段
const TARGET_FIELD = '例句图片'; // 替换目标字段
const LIMIT = 1;               // 控制处理的卡片个数

// 精确过滤的图片尺寸
const TARGET_WIDTH = 2248;
const TARGET_HEIGHT = 1366;
// ============================================

async function loadSettings() {
    const fallback = { ankiConnectUrl: 'http://127.0.0.1:8765' };
    try {
        const file = await fs.readFile(SETTINGS_FILE, 'utf8');
        return { ...fallback, ...JSON.parse(file) };
    } catch {
        try {
            const file = await fs.readFile(DEFAULT_SETTINGS_FILE, 'utf8');
            return { ...fallback, ...JSON.parse(file) };
        } catch {
            return fallback;
        }
    }
}

async function invokeAnki(ankiConnectUrl, action, params = {}) {
    try {
        const response = await fetch(ankiConnectUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, version: 6, params }),
        });
        const data = await response.json();
        if (data.error) throw new Error(data.error);
        return data.result;
    } catch (error) {
        console.error(`AnkiConnect 错误 (${action}):`, error.message);
        throw error;
    }
}

function stripHtml(raw) {
    return String(raw)
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

async function main() {
    try {
        const settings = await loadSettings();
        const ankiConnectUrl = settings.ankiConnectUrl;
        const backupDirPath = path.join(APP_DIR, 'backup', 'pic');
        await fs.mkdir(backupDirPath, { recursive: true });

        // 1. 获取 Anki 媒体文件夹路径
        const mediaDirPath = await invokeAnki(ankiConnectUrl, 'getMediaDirPath');
        console.log(`Anki 媒体路径: ${mediaDirPath}`);

        // 2. 查找卡组中的所有笔记 ID
        const noteIds = await invokeAnki(ankiConnectUrl, 'findNotes', { query: `deck:"${DECK_NAME}"` });
        const noteIdsDescByAdded = [...noteIds].sort((a, b) => b - a);
        console.log(`在卡组中找到 ${noteIdsDescByAdded.length} 个笔记（按添加顺序倒序处理）。`);

        if (noteIdsDescByAdded.length === 0) return;

        // 3. 获取笔记的详细信息
        const notesInfo = await invokeAnki(ankiConnectUrl, 'notesInfo', { notes: noteIdsDescByAdded });
        
        let processedCount = 0;

        for (const note of notesInfo) {
            if (processedCount >= LIMIT) {
                console.log(`\n已达到设定的处理上限 (${LIMIT}个)，停止运行。`);
                break;
            }

            const imgHtml = note.fields[IMAGE_FIELD]?.value || '';
            const match = imgHtml.match(/src=["']([^"']+)["']/);
            
            if (!match) continue;

            const imgFilename = match[1];
            const fullImgPath = path.join(mediaDirPath, imgFilename);
            const frontValue = note.fields[FRONT_FIELD].value;

            try {
                // 检查文件是否存在
                await fs.access(fullImgPath);
                
                // 4. 获取图片尺寸并进行过滤
                const metadata = await sharp(fullImgPath).metadata();
                
                if (metadata.width !== TARGET_WIDTH || metadata.height !== TARGET_HEIGHT) {
                    // 尺寸不符，直接跳过
                    continue;
                }

                console.log(`\n匹配到目标图片 (${TARGET_WIDTH}x${TARGET_HEIGHT}): ${imgFilename}`);
                console.log(`正面字段: ${frontValue}`);

                // 5. 设定裁剪区域
                // 针对 1366 高度，从 866 像素处开始向下截取 500 像素，正好保留英中两行字
                const cropTop = 866;
                const cropHeight = 500;

                const ext = path.extname(imgFilename);
                const newFilename = imgFilename;
                const newImgPath = fullImgPath;
                const backupFilename = path.basename(imgFilename, ext) + '_backup' + ext;
                const backupImgPath = path.join(backupDirPath, backupFilename);

                // 6. 先备份原图到 backup/pic
                await fs.copyFile(fullImgPath, backupImgPath);

                // 7. 裁剪后覆盖原图，保持原文件名不变
                const croppedBuffer = await sharp(fullImgPath)
                    .extract({
                        left: 0,
                        top: cropTop,
                        width: TARGET_WIDTH,
                        height: cropHeight
                    })
                    .toBuffer();
                await fs.writeFile(newImgPath, croppedBuffer);

                // 8. 更新 Anki 中的笔记字段
                const newFieldContent = `<img src="${newFilename}">`;
                
                await invokeAnki(ankiConnectUrl, 'updateNoteFields', {
                    note: {
                        id: note.noteId,
                        fields: {
                            [TARGET_FIELD]: newFieldContent
                        }
                    }
                });

                console.log(`成功更新笔记 ID: ${note.noteId} -> ${newFilename}`);
                console.log(`原图已备份: ${backupImgPath}`);
                processedCount++;

            } catch (err) {
                console.error(`处理图片 ${imgFilename} 失败:`, err.message);
            }
        }

        console.log(`\n全部处理完成，共成功修改了 ${processedCount} 个符合尺寸的卡片。`);

    } catch (error) {
        console.error('脚本运行崩溃:', error);
    }
}

main();