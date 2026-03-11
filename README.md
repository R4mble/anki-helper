# Anki Helper

## 中文说明

### 项目简介
- `Anki Helper` 是一个本地 Web 工具，用于统一管理 Anki 常用操作。
- 支持音频裁剪、音量放大、音频恢复、手机遥控复习、自动同步、以及“播放静音音频”（用于蓝牙音频节点唤醒场景）。

### 主要功能
- 音频工具（桌面控制台）
  - 当前卡音频放大
  - 当前卡音频恢复（基于项目内 `backup/`）
  - 快捷裁剪：去头/去尾 `0.1s` 到 `0.5s`
  - 播放静音音频（1 秒）
- 手机遥控器
  - 显示问题 / 显示答案
  - Again / Hard / Good / Easy
  - Undo
  - 进入指定牌组复习
- 设置中心
  - AnkiConnect 地址、媒体库路径、默认字段与参数
  - 默认配置 + 覆盖配置机制

### 配置文件
- 默认配置：`app_default_setting.json`
- 用户实际配置：`app_settings.json`
- 规则：
  - 项目初始只有 `app_default_setting.json`
  - 一旦在页面保存设置，会创建完整的 `app_settings.json`
  - 之后以 `app_settings.json` 为准，`app_default_setting.json` 不再变更

### 启动方式
```bash
npm install
npm run start:web
```

- 默认地址：`http://localhost:3333`
- 手机遥控：`http://<你的局域网IP>:3333/?mode=remote`

### 依赖前提
- 已安装并运行 Anki
- 已安装 AnkiConnect 插件（默认端口 `8765`）
- 系统可本地播放音频
  - macOS 使用 `afplay`
  - Windows 使用 PowerShell `Media.SoundPlayer`

---

## English

### Overview
- `Anki Helper` is a local web app that unifies common Anki workflows.
- It supports audio trimming, audio amplification, restore from backup, mobile remote control, scheduled sync, and silent-audio playback (useful for Bluetooth audio route warm-up).

### Features
- Audio Tools (Desktop)
  - Amplify current card audio
  - Restore original audio (from project `backup/`)
  - Quick trim presets: start/end `0.1s` to `0.5s`
  - Play 1-second silent audio
- Mobile Remote
  - Show Question / Show Answer
  - Again / Hard / Good / Easy
  - Undo
  - Jump to a deck for review
- Settings
  - AnkiConnect URL, media path, default field and parameters
  - Default + override configuration model

### Config Files
- Default config: `app_default_setting.json`
- Effective user config: `app_settings.json`
- Behavior:
  - Initially only `app_default_setting.json` exists
  - After the first settings save, a full `app_settings.json` is created
  - Once created, runtime uses `app_settings.json` as the source of truth and keeps `app_default_setting.json` unchanged

### Run
```bash
npm install
npm run start:web
```

- Default URL: `http://localhost:3333`
- Mobile remote URL: `http://<your-lan-ip>:3333/?mode=remote`

### Prerequisites
- Anki is installed and running
- AnkiConnect add-on is installed (default `8765`)
- Local audio playback is available on your OS
