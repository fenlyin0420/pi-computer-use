# pi-computer-use

> **English** — A Pi extension that gives the agent computer-use on a dedicated
> Xvfb virtual desktop (default `:99`): screenshots, mouse, keyboard, window
> and app control — fully isolated from your real desktop.
>
> Chinese documentation below.

给 Pi 增加 computer-use 能力：在一个**独立的 Xvfb 虚拟桌面**（默认 `:99`）上截图、点鼠标、
打字、按热键、管理窗口、启动应用 —— 完全不与真实桌面抢占鼠标、键盘、窗口焦点。

## 原理

```
Xvfb :99 (1920x1080x24)
 ├─ openbox          窗口管理器
 └─ firefox-esr      默认浏览器（独立 profile，fallback: firefox → google-chrome）
```

- 截图：ImageMagick `import -window root`
- 鼠标/键盘：`xdotool`
- 窗口管理：`wmctrl`
- 所有命令都只带 `DISPLAY=:99`，与你的 `:1` 真实桌面完全隔离

## 依赖

`xvfb` `openbox` `x11-apps`(xdotool) `imagemagick`(import) `wmctrl` `firefox-esr`
（Ubuntu 24.04 的 snap firefox 有沙盒限制、自定义 profile 下会报
"already running, but not responding"，所以默认用经典版 firefox-esr；
可用 `PI_COMPUTER_USE_BROWSER` 覆盖，例如 `google-chrome`。）

## 安装

```bash
cd pi-computer-use && npm install
pi install /path/to/pi-computer-use
```

## 工具

| 工具 | 说明 |
|---|---|
| `computer_screen` | 截图（全屏或区域），返回图像 + 文件路径 |
| `computer_click` | 左/右/中键单击、双击、三击 |
| `computer_drag` | 拖拽（按-移动-释放） |
| `computer_type` | 向焦点窗口输入文本 |
| `computer_key` | 按键/热键：`Return`、`ctrl+s`、`alt+Tab` … |
| `computer_scroll` | 在 (x,y) 处上/下/左/右滚动 |
| `computer_window` | list / focus / close / maximize / minimize / move / resize |
| `computer_app` | 在虚拟桌面上启动任意 GUI 应用或 URL（后台） |
| `computer_desktop` | 启动 / 停止 / 查看虚拟桌面本身 |

用法约定：**观察→操作→再观察** 的循环 —— 操作前截图看坐标，关键操作后再截图确认。

## 手动控制

```bash
bin/desktop.sh start | stop | status | shot [file]
pi /computer status        # pi 里的斜杠命令（等同 computer_desktop status）
```

状态文件（pid、日志、浏览器 profile、截图）都在 `~/.pi/computer-use/`。

## 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PI_COMPUTER_USE_DISPLAY` | `99` | 虚拟显示号 |
| `PI_COMPUTER_USE_BROWSER` | firefox-esr | 虚拟桌面默认浏览器 |
