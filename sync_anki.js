const schedule = require('node-schedule');
const axios = require('axios');

// 配置
const ANKI_CONNECT_URL = 'http://127.0.0.1:8765';
const SYNC_TIME = '30 19 * * *'; // 每天 19:30:00 (秒 分 时 日 月 星期)

console.log(`[启动] Anki 自动同步服务已启动，将在每天 19:30 执行同步。`);

// 定义同步函数
async function syncAnki() {
    console.log(`[${new Date().toLocaleString()}] 开始尝试同步...`);

    try {
        // 1. 检查 AnkiConnect 是否连通，并发送同步指令
        // version 6 是 AnkiConnect 目前的 API 版本
        const response = await axios.post(ANKI_CONNECT_URL, {
            action: 'sync',
            version: 6
        });

        // 2. 处理结果
        if (!response.data.error) {
            console.log('✅ 同步命令已发送，Anki 正在同步中。');
        } else {
            console.error('❌ Anki 返回错误:', response.data.error);
        }

    } catch (error) {
        if (error.code === 'ECONNREFUSED') {
            console.error('❌ 无法连接到 Anki。请确认 Anki 已打开且安装了 AnkiConnect 插件。');
        } else {
            console.error('❌ 请求失败:', error.message);
        }
    }
}

// 设置定时任务
schedule.scheduleJob(SYNC_TIME, () => {
    syncAnki();
});

// 可选：启动时立即测试运行一次（如果不需要可注释掉）
syncAnki();