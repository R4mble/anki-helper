import activeWin from 'active-win';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import dayjs from 'dayjs';
import open from 'open';
import fs from 'fs';
import { execSync } from 'child_process';
import os from 'os';

// === 配置区域 ===
const CONFIG = {
    checkInterval: 2000, // 每2秒检查一次
    dayStartHour: 10,    // 每天10点开始新周期
    idleThreshold: 60,   // 60秒无操作视为离开
    
    // 目标设定 (单位: 分钟)
    goals: {
        'Anki': 4 * 60, 
    },

    // 限制设定 (单位: 分钟)
    limits: {
        'Douyin': { maxContinuous: 30, action: 'alert' },
        'X': { maxContinuous: 30, action: 'alert' },
        'Bilibili': { maxContinuous: 45, action: 'alert' }
    },

    // 识别规则
    appRules: {
        'YouTube': { urls: ['youtube.com', 'youtu.be'], titles: ['youtube', '油管'] },
        'Gemini': { urls: ['gemini.google.com', 'aistudio.google.com'], titles: ['gemini', 'google ai'] },
        'X': { urls: ['twitter.com', 'x.com'], titles: ['twitter', ' / x'] },
        'Douyin': { urls: ['douyin.com', 'tiktok.com'], titles: ['douyin', '抖音'] },
        'Bilibili': { urls: ['bilibili.com'], titles: ['bilibili', '哔哩哔哩'] },
        'Github': { urls: ['github.com'], titles: ['github'] },
        'ChatGPT': { urls: ['chatgpt.com', 'openai.com'], titles: ['chatgpt', 'openai'] },
        'Yomitan': { titles: ['yomitan'] }, 
        'Momo': { urls: ['momo'] }, 
        'GoogleTranslate': { titles: ['Google Translate'] }, 
        'localhost': { urls: ['localhost', '127.0.0.1'], titles: ['localhost'] }
    },
    browsers: ['Google Chrome', 'Microsoft Edge', 'Safari', 'Firefox', 'Arc', 'Brave Browser', 'Chrome']
};

// === 数据存储 ===
const DATA_FILE = './usage_data.json';
let currentSession = {
    app: null,
    startTime: Date.now(),
    duration: 0
};

// === Web 服务器设置 ===
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.get('/', (req, res) => { res.send(getHtmlPage()); });

// === 核心工具函数 ===

function getIdleTime() {
    const platform = os.platform();
    try {
        if (platform === 'darwin') {
            const cmd = "ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print $NF/1000000000; exit}'";
            return parseInt(execSync(cmd).toString().trim(), 10);
        } else if (platform === 'win32') {
            const psCmd = `
            $code = '[DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii); public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }';
            $type = Add-Type -MemberDefinition $code -Name Win32Utils -Namespace User32 -PassThru;
            $lii = New-Object User32.LASTINPUTINFO;
            $lii.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($lii);
            [User32.Win32Utils]::GetLastInputInfo([ref]$lii) | Out-Null;
            [Math]::Floor(([Environment]::TickCount - $lii.dwTime) / 1000)
            `;
            const oneLiner = `powershell -NoProfile -Command "${psCmd.replace(/\n/g, ' ')}"`;
            return parseInt(execSync(oneLiner).toString().trim(), 10);
        }
    } catch (e) {
        return 0;
    }
    return 0;
}

function getLogicalDate() {
    const now = dayjs();
    if (now.hour() < CONFIG.dayStartHour) {
        return now.subtract(1, 'day').format('YYYY-MM-DD');
    }
    return now.format('YYYY-MM-DD');
}

function loadData() {
    if (!fs.existsSync(DATA_FILE)) return {};
    try { return JSON.parse(fs.readFileSync(DATA_FILE)); } catch { return {}; }
}

function saveData(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function parseAppName(window) {
    let appName = window.owner.name; 
    const title = window.title ? window.title.toLowerCase() : '';
    const url = window.url ? window.url.toLowerCase() : ''; 

    const isBrowser = CONFIG.browsers.some(b => appName.includes(b) || b.includes(appName));

    if (isBrowser) {
        for (const [key, rules] of Object.entries(CONFIG.appRules)) {
            if (url && rules.urls && rules.urls.some(u => url.includes(String(u).toLowerCase()))) return key;
            if (rules.titles && rules.titles.some(t => title.includes(String(t).toLowerCase()))) return key;
        }
        return 'Browser (Other)'; 
    }
    return appName; 
}

function checkLimits(appName, continuousMinutes) {
    const limit = CONFIG.limits[appName];
    if (limit && continuousMinutes >= limit.maxContinuous) {
        console.log(`⚠️ 警告: ${appName} 已连续使用 ${continuousMinutes.toFixed(1)} 分钟！`);
        io.emit('alert', { 
            message: `你已经连续刷 ${appName} 超过 ${limit.maxContinuous} 分钟了！立即停止！` 
        });
        if (Math.random() > 0.8) { 
             open('http://localhost:3000');
        }
    }
}

// === 主循环 ===
async function startTracker() {
    console.log("🚀 屏幕时间追踪已启动 (单位: 秒)...");
    
    setInterval(async () => {
        try {
            const idleTime = getIdleTime();
            
            if (idleTime >= CONFIG.idleThreshold) {
                currentSession = { app: null, startTime: Date.now(), duration: 0 };
                io.emit('update_status', { isIdle: true, idleTime: idleTime });
                return; 
            }

            const window = await activeWin();
            console.log('window', window)
            if (!window) return;

            const appName = parseAppName(window);
            const today = getLogicalDate();
            const data = loadData();

            if (!data[today]) data[today] = {};
            
            // 初始化数据结构 (duration 单位现在是秒)
            if (!data[today][appName]) {
                data[today][appName] = { duration: 0, lastActive: Date.now() };
            }
            // 兼容旧数据的简单处理：如果旧数据是数字，转成对象
            if (typeof data[today][appName] === 'number') {
                data[today][appName] = { duration: data[today][appName] * 60, lastActive: Date.now() };
            }

            // === 修改点：直接增加秒数 ===
            const secondsToAdd = CONFIG.checkInterval / 1000;
            data[today][appName].duration += secondsToAdd;
            data[today][appName].lastActive = Date.now();

            if (currentSession.app === appName) {
                const sessionDuration = (Date.now() - currentSession.startTime) / 1000 / 60; // 这里的session还是保持分钟方便判断
                checkLimits(appName, sessionDuration);
            } else {
                currentSession = { app: appName, startTime: Date.now(), duration: 0 };
            }
            const sessionSeconds = Math.max(0, (Date.now() - currentSession.startTime) / 1000);

            saveData(data);

            io.emit('update', { 
                todayStr: today,
                stats: data[today], 
                currentApp: appName,
                goals: CONFIG.goals,
                sessionSeconds,
                idleSeconds: Math.floor(idleTime)
            });

        } catch (error) {
            console.error("❌ 错误:", error);
        }
    }, CONFIG.checkInterval);
}

httpServer.listen(3000, () => {
    console.log('📊 仪表盘运行在: http://localhost:3000');
    startTracker();
});

// === 前端页面 ===
function getHtmlPage() {
    return `
<!DOCTYPE html>
<html>
<head>
    <title>我的时间追踪</title>
    <script src="/socket.io/socket.io.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 20px; background: #f5f5f7; }
        .container { max-width: 800px; margin: 0 auto; background: white; padding: 30px; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
        .status { font-size: 14px; color: #666; }
        .current-app { font-weight: bold; color: #6b7280; }
        .status-study { color: #2f7bff; }
        .status-work { color: #34c759; }
        .status-fun { color: #ff3b30; }
        .idle-status { font-weight: bold; color: #ff9500; }
        .alert-box { display: none; background: #ffdede; color: #c00; padding: 15px; border-radius: 8px; margin-bottom: 20px; border: 1px solid #fcc; text-align: center; font-weight: bold;}
        .group-badge { display: inline-block; padding: 2px 6px; border-radius: 6px; font-size: 12px; margin-right: 8px; color: #fff; }
        .group-study { background: #2f7bff; }
        .group-work { background: #34c759; }
        .group-fun { background: #ff3b30; }
        .goal-card { background: #f0f9ff; padding: 15px; border-radius: 8px; margin-bottom: 10px; border-left: 5px solid #007aff; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; }
        th, td { text-align: left; padding: 12px; border-bottom: 1px solid #eee; }
        td.time-col { color: #888; font-size: 0.9em; }
        .progress-bar { background: #eee; height: 10px; border-radius: 5px; overflow: hidden; margin-top: 5px; }
        .progress-fill { height: 100%; background: #34c759; transition: width 0.5s; }
    </style>
</head>
<body>
    <div class="container">
        <div id="alertBox" class="alert-box"></div>
        <div class="header">
            <h1>⏱️ 今日专注 (10点周期)</h1>
            <div class="status">状态: <span id="statusText" class="current-app">检测中...</span></div>
        </div>
        <div id="goalsContainer"></div>
        <canvas id="usageChart" height="200"></canvas>
        <h3>📋 活动记录 (按时长排序)</h3>
        <table>
            <thead><tr><th>应用/网站</th><th>时长</th><th>最后活跃</th></tr></thead>
            <tbody id="tableBody"></tbody>
        </table>
    </div>
    <script>
        const socket = io();
        let chartInstance = null;
        
        socket.on('alert', (data) => {
            const box = document.getElementById('alertBox');
            box.style.display = 'block';
            box.innerText = "🚨 " + data.message;
            new Audio('https://www.soundjay.com/buttons/sounds/beep-07.mp3').play().catch(()=>{});
        });

        socket.on('update_status', (data) => {
            if (data.isIdle) {
                const el = document.getElementById('statusText');
                el.innerText = \`💤 离开中 (已闲置 \${Math.floor(data.idleTime)}秒)\`;
                el.className = 'idle-status';
            }
        });

        socket.on('update', (data) => {
            const el = document.getElementById('statusText');
            const sessionText = formatDuration(data.sessionSeconds || 0);
            const idleText = formatDuration(data.idleSeconds || 0);
            el.innerText = "正在使用: " + data.currentApp + " (本次 " + sessionText + "，闲置 " + idleText + ")";
            const group = getGroupInfo(data.currentApp);
            const statusClass = group ? "status-" + group.key : "";
            el.className = ("current-app " + statusClass).trim();
            document.getElementById('alertBox').style.display = 'none';
            
            const normalizedStats = normalizeStats(data.stats);
            renderGoals(normalizedStats, data.goals);
            renderTable(normalizedStats);
            renderChart(normalizedStats);
        });

        function normalizeStats(stats) {
            const newStats = {};
            for (const [key, val] of Object.entries(stats)) {
                // 如果是旧数据结构(数字)，直接用；如果是新结构(对象)，提取duration
                let duration = (typeof val === 'number') ? val : val.duration;
                let lastActive = (typeof val === 'object') ? val.lastActive : 0;
                
                newStats[key] = { duration, lastActive };
            }
            return newStats;
        }

        function formatDuration(totalSeconds) {
            const seconds = Math.floor(totalSeconds);
            if (seconds < 60) return seconds + "秒";
            const minutes = Math.floor(seconds / 60);
            const remSeconds = seconds % 60;
            if (minutes < 60) return minutes + "分" + remSeconds + "秒";
            const hours = Math.floor(minutes / 60);
            const remMinutes = minutes % 60;
            return hours + "小时" + remMinutes + "分";
        }

        function renderGoals(stats, goals) {
            const container = document.getElementById('goalsContainer');
            container.innerHTML = '';
            for (const [app, targetMin] of Object.entries(goals)) {
                const seconds = stats[app] ? stats[app].duration : 0;
                const currentMin = seconds / 60; // 秒 -> 分
                const percent = Math.min((currentMin / targetMin) * 100, 100);
                
                const html = \`
                    <div class="goal-card">
                        <div style="display:flex; justify-content:space-between">
                            <strong>\${app}</strong>
                            <span>\${currentMin.toFixed(1)} / \${targetMin} 分钟</span>
                        </div>
                        <div class="progress-bar">
                            <div class="progress-fill" style="width: \${percent}%"></div>
                        </div>
                    </div>
                \`;
                container.innerHTML += html;
            }
        }

        const APP_GROUPS = [
            { key: 'study', name: '学习组', className: 'group-study', color: '#2f7bff', apps: ['Anki', 'GoogleTranslate', 'Gemini', 'Yomitan'] },
            { key: 'work', name: '工作组', className: 'group-work', color: '#34c759', apps: ['钉钉', 'Momo', 'IDEA', 'Cursor', 'Code', '终端'] },
            { key: 'fun', name: '娱乐组', className: 'group-fun', color: '#ff3b30', apps: ['Lark', 'QQ', 'X', 'Douyin', '微信','Telegram'] }
        ];

        function getGroupInfo(appName) {
            return APP_GROUPS.find(group => group.apps.includes(appName)) || null;
        }

        function getGroupColor(appName) {
            const group = getGroupInfo(appName);
            return group ? group.color : '#6b7280';
        }

        function renderTable(stats) {
            const tbody = document.getElementById('tableBody');
            // 表格按“时长”排序
            const sorted = Object.entries(stats).sort((a, b) => b[1].duration - a[1].duration);
            
            tbody.innerHTML = sorted.map(([name, info]) => {
                const seconds = info.duration;
                const minutes = seconds / 60;
                const group = getGroupInfo(name);
                const badge = group ? \`<span class="group-badge \${group.className}">\${group.name}</span>\` : '';
                
                const secondsAgo = Math.floor((Date.now() - info.lastActive) / 1000);
                let timeStr = '刚刚';
                if (secondsAgo > 60) timeStr = Math.floor(secondsAgo/60) + '分钟前';
                if (secondsAgo > 3600) timeStr = Math.floor(secondsAgo/3600) + '小时前';
                
                return \`
                    <tr>
                        <td>\${badge}\${name}</td>
                        <td>\${minutes.toFixed(1)} min <span class="time-col">(\${(minutes/60).toFixed(1)}h)</span></td>
                        <td class="time-col">\${timeStr}</td>
                    </tr>
                \`;
            }).join('');
        }

        function renderChart(stats) {
            const ctx = document.getElementById('usageChart').getContext('2d');
            
            // === 修改点：图表按时长(duration)降序排列 ===
            const minChartSeconds = 5 * 60;
            const sortedForChart = Object.entries(stats)
                .filter(([, info]) => info.duration >= minChartSeconds)
                .sort((a, b) => b[1].duration - a[1].duration);
            
            const labels = sortedForChart.map(x => x[0]);
            // 把秒转为分钟给图表显示，否则数值太大
            const data = sortedForChart.map(x => (x[1].duration / 60).toFixed(1));
            const colors = labels.map(label => getGroupColor(label));

            if (chartInstance) {
                chartInstance.data.labels = labels;
                chartInstance.data.datasets[0].data = data;
                chartInstance.data.datasets[0].backgroundColor = colors;
                chartInstance.update();
            } else {
                chartInstance = new Chart(ctx, {
                    type: 'bar',
                    data: {
                        labels: labels,
                        datasets: [{ label: '使用时长 (分钟)', data: data, backgroundColor: colors }]
                    }
                });
            }
        }
    </script>
</body>
</html>
    `;
}