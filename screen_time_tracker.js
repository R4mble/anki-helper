const { Server } = require('socket.io');
const { execSync, execFile } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

const APP_DIR = process.pkg ? path.dirname(process.execPath) : __dirname;
const DATA_FILE = path.join(APP_DIR, 'screen_time_data.json');

const CONFIG = {
    checkInterval: 2000,
    dayStartHour: 10,
    idleThreshold: 60,

    goals: {
        'Anki': 4 * 60,
    },

    limits: {
        'Douyin': { maxContinuous: 30, action: 'alert' },
        'X': { maxContinuous: 30, action: 'alert' },
        'Bilibili': { maxContinuous: 45, action: 'alert' },
    },

    ankiReminder: {
        enabled: true,
        idleMinutes: 5,
        appName: 'Anki',
    },

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
        'dingtalk': { urls: ['dingtalk.com'], titles: ['dingtalk', '钉钉'] },
        'GoogleTranslate': { titles: ['Google Translate'] },
        'localhost': { urls: ['localhost', '127.0.0.1'], titles: ['localhost'] },
    },
    browsers: ['Google Chrome', 'Microsoft Edge', 'Safari', 'Firefox', 'Arc', 'Brave Browser', 'Chrome'],
};

let activeWinFn = null;
let io = null;
let currentSession = { app: null, startTime: Date.now(), duration: 0 };
let trackerError = null;
let lastAnkiActiveTime = Date.now();
let ankiReminderFired = false;

async function loadActiveWin() {
    if (activeWinFn) return activeWinFn;
    const mod = await import('active-win');
    activeWinFn = mod.default;
    return activeWinFn;
}

function getIdleTime() {
    try {
        if (os.platform() === 'darwin') {
            const cmd = "ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print $NF/1000000000; exit}'";
            return parseInt(execSync(cmd).toString().trim(), 10);
        }
    } catch (e) {
        return 0;
    }
    return 0;
}

function getLogicalDate() {
    const now = new Date();
    if (now.getHours() < CONFIG.dayStartHour) {
        const yesterday = new Date(now);
        yesterday.setDate(yesterday.getDate() - 1);
        return formatDate(yesterday);
    }
    return formatDate(now);
}

function formatDate(d) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function loadData() {
    if (!fs.existsSync(DATA_FILE)) return {};
    try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return {}; }
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
        console.log(`[screen-time] ⚠️ 警告: ${appName} 已连续使用 ${continuousMinutes.toFixed(1)} 分钟！`);
        io.emit('screen_time_alert', {
            message: `你已经连续刷 ${appName} 超过 ${limit.maxContinuous} 分钟了！立即停止！`,
        });
    }
}

function activateAnki() {
    if (os.platform() !== 'darwin') return;
    try {
        execSync('osascript -e \'tell application "Anki" to activate\'');
    } catch (e) {
        console.error('[screen-time] 激活 Anki 失败:', e.message);
    }
}

function showNotification(title, message) {
    if (os.platform() !== 'darwin') return;
    try {
        const safeTitle = title.replace(/"/g, '\\"');
        const safeMsg = message.replace(/"/g, '\\"');
        execSync(`osascript -e 'display notification "${safeMsg}" with title "${safeTitle}" sound name "Glass"'`);
    } catch (e) {
        console.error('[screen-time] 发送通知失败:', e.message);
    }
}

function checkAnkiReminder(appName, isIdle) {
    if (!CONFIG.ankiReminder.enabled) return;

    if (appName === CONFIG.ankiReminder.appName) {
        lastAnkiActiveTime = Date.now();
        ankiReminderFired = false;
        return;
    }

    if (isIdle) return;

    const idleMs = Date.now() - lastAnkiActiveTime;
    const idleMinutes = idleMs / 1000 / 60;

    if (idleMinutes >= CONFIG.ankiReminder.idleMinutes && !ankiReminderFired) {
        ankiReminderFired = true;
        console.log(`[screen-time] 🔔 Anki 已 ${idleMinutes.toFixed(1)} 分钟未使用，激活并提醒`);
        activateAnki();
        showNotification('保持专注！', `Anki 已经 ${Math.floor(idleMinutes)} 分钟没有打开了，回去学习！`);
        io.emit('screen_time_alert', {
            message: `Anki 已经 ${Math.floor(idleMinutes)} 分钟没有打开了！保持专注！`,
        });
    }
}

function extractErrorDetail(error) {
    const stderr = error.stderr
        ? (Buffer.isBuffer(error.stderr) ? error.stderr.toString() : String(error.stderr)).trim()
        : '';
    if (stderr) return stderr;
    const stdout = error.stdout
        ? (Buffer.isBuffer(error.stdout) ? error.stdout.toString() : String(error.stdout)).trim()
        : '';
    if (stdout) return stdout;
    return error.message;
}

async function tick() {
    try {
        const activeWin = await loadActiveWin();
        trackerError = null;

        const idleTime = getIdleTime();

        if (idleTime >= CONFIG.idleThreshold) {
            currentSession = { app: null, startTime: Date.now(), duration: 0 };
            io.emit('screen_time_status', { isIdle: true, idleTime });
            return;
        }

        const window = await activeWin();
        if (!window) {
            checkAnkiReminder(null, false);
            io.emit('screen_time_status', { isIdle: false, noWindow: true });
            return;
        }

        const appName = parseAppName(window);
        const today = getLogicalDate();
        const data = loadData();

        if (!data[today]) data[today] = {};

        if (!data[today][appName]) {
            data[today][appName] = { duration: 0, lastActive: Date.now() };
        }
        if (typeof data[today][appName] === 'number') {
            data[today][appName] = { duration: data[today][appName] * 60, lastActive: Date.now() };
        }

        const secondsToAdd = CONFIG.checkInterval / 1000;
        data[today][appName].duration += secondsToAdd;
        data[today][appName].lastActive = Date.now();

        if (currentSession.app === appName) {
            const sessionDuration = (Date.now() - currentSession.startTime) / 1000 / 60;
            checkLimits(appName, sessionDuration);
        } else {
            currentSession = { app: appName, startTime: Date.now(), duration: 0 };
        }
        const sessionSeconds = Math.max(0, (Date.now() - currentSession.startTime) / 1000);

        checkAnkiReminder(appName, false);

        saveData(data);

        io.emit('screen_time_update', {
            todayStr: today,
            stats: data[today],
            currentApp: appName,
            goals: CONFIG.goals,
            sessionSeconds,
            idleSeconds: Math.floor(idleTime),
        });
    } catch (error) {
        const detail = extractErrorDetail(error);
        trackerError = detail;
        io.emit('screen_time_error', { error: detail });
        console.error('[screen-time] ❌ 错误:', detail);
    }
}

function startTracker() {
    console.log('[screen-time] 🚀 屏幕时间追踪已启动');
    tick();
    setInterval(tick, CONFIG.checkInterval);
}

function getScreenTimeHtml() {
    return `<!DOCTYPE html>
<html>
<head>
    <title>屏幕时间追踪</title>
    <script src="/socket.io/socket.io.js"><\/script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"><\/script>
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
        .error-status { font-weight: bold; color: #ff3b30; }
        .alert-box { display: none; background: #ffdede; color: #c00; padding: 15px; border-radius: 8px; margin-bottom: 20px; border: 1px solid #fcc; text-align: center; font-weight: bold; }
        .error-box { display: none; background: #fff3cd; color: #856404; padding: 15px; border-radius: 8px; margin-bottom: 20px; border: 1px solid #ffc107; font-size: 14px; line-height: 1.6; }
        .error-box code { background: #f8f0d8; padding: 2px 6px; border-radius: 4px; }
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
        <div id="errorBox" class="error-box"></div>
        <div id="alertBox" class="alert-box"></div>
        <div class="header">
            <h1>⏱️ 今日专注 (10点周期)</h1>
            <div class="status">状态: <span id="statusText" class="current-app">连接中...</span></div>
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
        var socket = io();
        var chartInstance = null;

        socket.on('connect', function() {
            document.getElementById('errorBox').style.display = 'none';
            fetch('/api/screen-time/data')
                .then(function(r) { return r.json(); })
                .then(function(data) {
                    if (data.ok && data.stats && Object.keys(data.stats).length > 0) {
                        var normalizedStats = normalizeStats(data.stats);
                        renderGoals(normalizedStats, ${JSON.stringify(CONFIG.goals)});
                        renderTable(normalizedStats);
                        renderChart(normalizedStats);
                        document.getElementById('statusText').innerText = '已连接，等待数据...';
                    }
                    if (data.trackerError) {
                        showError(data.trackerError);
                    }
                });
        });

        socket.on('disconnect', function() {
            var el = document.getElementById('statusText');
            el.innerText = '⚠️ 连接断开，重连中...';
            el.className = 'error-status';
        });

        function showError(msg) {
            var box = document.getElementById('errorBox');
            var el = document.getElementById('statusText');
            if (msg.indexOf('screen recording permission') !== -1 || msg.indexOf('Screen Recording') !== -1) {
                box.innerHTML = '⚠️ <strong>需要屏幕录制权限</strong><br>' +
                    '请前往 <code>系统设置 › 隐私与安全性 › 屏幕录制</code>，' +
                    '为运行此程序的终端（如 Terminal、iTerm、Cursor 等）开启权限，然后重启程序。';
            } else {
                box.innerHTML = '⚠️ 追踪器错误: ' + msg;
            }
            box.style.display = 'block';
            el.innerText = '❌ 追踪异常';
            el.className = 'error-status';
        }

        socket.on('screen_time_error', function(data) {
            showError(data.error);
        });

        socket.on('screen_time_alert', function(data) {
            var box = document.getElementById('alertBox');
            box.style.display = 'block';
            box.innerText = "🚨 " + data.message;
            new Audio('https://www.soundjay.com/buttons/sounds/beep-07.mp3').play().catch(function(){});
        });

        socket.on('screen_time_status', function(data) {
            var el = document.getElementById('statusText');
            if (data.isIdle) {
                el.innerText = '💤 离开中 (已闲置 ' + Math.floor(data.idleTime) + '秒)';
                el.className = 'idle-status';
            } else if (data.noWindow) {
                el.innerText = '🔍 未检测到活跃窗口';
                el.className = 'current-app';
            }
            document.getElementById('errorBox').style.display = 'none';
        });

        socket.on('screen_time_update', function(data) {
            var el = document.getElementById('statusText');
            var sessionText = formatDuration(data.sessionSeconds || 0);
            var idleText = formatDuration(data.idleSeconds || 0);
            el.innerText = "正在使用: " + data.currentApp + " (本次 " + sessionText + "，闲置 " + idleText + ")";
            var group = getGroupInfo(data.currentApp);
            var statusClass = group ? "status-" + group.key : "";
            el.className = ("current-app " + statusClass).trim();
            document.getElementById('alertBox').style.display = 'none';
            document.getElementById('errorBox').style.display = 'none';

            var normalizedStats = normalizeStats(data.stats);
            renderGoals(normalizedStats, data.goals);
            renderTable(normalizedStats);
            renderChart(normalizedStats);
        });

        function normalizeStats(stats) {
            var newStats = {};
            for (var key in stats) {
                var val = stats[key];
                var duration = (typeof val === 'number') ? val : val.duration;
                var lastActive = (typeof val === 'object') ? val.lastActive : 0;
                newStats[key] = { duration: duration, lastActive: lastActive };
            }
            return newStats;
        }

        function formatDuration(totalSeconds) {
            var seconds = Math.floor(totalSeconds);
            if (seconds < 60) return seconds + "秒";
            var minutes = Math.floor(seconds / 60);
            var remSeconds = seconds % 60;
            if (minutes < 60) return minutes + "分" + remSeconds + "秒";
            var hours = Math.floor(minutes / 60);
            var remMinutes = minutes % 60;
            return hours + "小时" + remMinutes + "分";
        }

        function renderGoals(stats, goals) {
            var container = document.getElementById('goalsContainer');
            container.innerHTML = '';
            for (var app in goals) {
                var targetMin = goals[app];
                var seconds = stats[app] ? stats[app].duration : 0;
                var currentMin = seconds / 60;
                var percent = Math.min((currentMin / targetMin) * 100, 100);
                container.innerHTML += '<div class="goal-card">' +
                    '<div style="display:flex; justify-content:space-between">' +
                    '<strong>' + app + '</strong>' +
                    '<span>' + currentMin.toFixed(1) + ' / ' + targetMin + ' 分钟</span>' +
                    '</div>' +
                    '<div class="progress-bar">' +
                    '<div class="progress-fill" style="width: ' + percent + '%"></div>' +
                    '</div></div>';
            }
        }

        var APP_GROUPS = [
            { key: 'study', name: '学习组', className: 'group-study', color: '#2f7bff', apps: ['Anki', 'GoogleTranslate', 'Gemini', 'Yomitan'] },
            { key: 'work', name: '工作组', className: 'group-work', color: '#34c759', apps: ['钉钉', 'Momo', 'IDEA', 'Cursor', 'Code', '终端', 'dingtalk'] },
            { key: 'fun', name: '娱乐组', className: 'group-fun', color: '#ff3b30', apps: ['Lark', 'QQ', 'X', 'Douyin', '微信', 'Telegram'] }
        ];

        function getGroupInfo(appName) {
            for (var i = 0; i < APP_GROUPS.length; i++) {
                if (APP_GROUPS[i].apps.indexOf(appName) !== -1) return APP_GROUPS[i];
            }
            return null;
        }

        function getGroupColor(appName) {
            var group = getGroupInfo(appName);
            return group ? group.color : '#6b7280';
        }

        function renderTable(stats) {
            var tbody = document.getElementById('tableBody');
            var sorted = Object.entries(stats).sort(function(a, b) { return b[1].duration - a[1].duration; });
            tbody.innerHTML = sorted.map(function(entry) {
                var name = entry[0];
                var info = entry[1];
                var seconds = info.duration;
                var minutes = seconds / 60;
                var group = getGroupInfo(name);
                var badge = group ? '<span class="group-badge ' + group.className + '">' + group.name + '</span>' : '';
                var secondsAgo = Math.floor((Date.now() - info.lastActive) / 1000);
                var timeStr = '刚刚';
                if (secondsAgo > 60) timeStr = Math.floor(secondsAgo / 60) + '分钟前';
                if (secondsAgo > 3600) timeStr = Math.floor(secondsAgo / 3600) + '小时前';
                return '<tr><td>' + badge + name + '</td>' +
                    '<td>' + minutes.toFixed(1) + ' min <span class="time-col">(' + (minutes / 60).toFixed(1) + 'h)</span></td>' +
                    '<td class="time-col">' + timeStr + '</td></tr>';
            }).join('');
        }

        function renderChart(stats) {
            var ctx = document.getElementById('usageChart').getContext('2d');
            var minChartSeconds = 5 * 60;
            var sortedForChart = Object.entries(stats)
                .filter(function(entry) { return entry[1].duration >= minChartSeconds; })
                .sort(function(a, b) { return b[1].duration - a[1].duration; });

            var labels = sortedForChart.map(function(x) { return x[0]; });
            var data = sortedForChart.map(function(x) { return (x[1].duration / 60).toFixed(1); });
            var colors = labels.map(function(label) { return getGroupColor(label); });

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
    <\/script>
</body>
</html>`;
}

function init(httpServer, app) {
    io = new Server(httpServer);

    app.get('/screen-time', (req, res) => {
        res.send(getScreenTimeHtml());
    });

    app.get('/api/screen-time/data', (req, res) => {
        const data = loadData();
        const today = getLogicalDate();
        res.json({
            ok: true,
            today,
            stats: data[today] || {},
            allDays: Object.keys(data),
            trackerError,
        });
    });

    app.get('/api/screen-time/history', (req, res) => {
        const data = loadData();
        const date = String(req.query.date || '').trim();
        if (date && data[date]) {
            res.json({ ok: true, date, stats: data[date] });
        } else {
            res.json({ ok: true, dates: Object.keys(data) });
        }
    });

    startTracker();
}

module.exports = { init };
