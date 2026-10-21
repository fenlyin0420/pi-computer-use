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
Xvfb :99 (默认 1920x1080x24)
 ├─ openbox       窗口管理器（list/focus/move 等操作依赖它）
 └─ 浏览器        firefox-esr → firefox → Chromium 系（独立 profile；可关闭）
```

- 截图：ImageMagick `import -window root`（ImageMagick 7 只有 `magick import` 时自动适配），
  每次截屏都存新文件（`shots/YYYYMMDDHHMMSS_shot.png`，同一秒内多次截图追加 `-2`、`-3`…，不覆盖）
- 鼠标/键盘：`xdotool`（滚轮用 `click 4/5/6/7`）
- 窗口管理：`wmctrl`
- 所有命令都只带 `DISPLAY=:99`，与真实桌面完全隔离

只管理**自己启动**的桌面：如果 `:99` 上已经有别的工具在跑（Xvfb/systemd 单元/手动启动），
扩展会直接复用，但不会往里塞浏览器、不会启动第二个窗口管理器，`computer_desktop stop`
也不会动别人的进程。

## 依赖

Linux + X11：

| 发行版 | 安装 |
|---|---|
| Ubuntu / Debian | `sudo apt install xvfb openbox xdotool wmctrl imagemagick` |
| Fedora | `sudo dnf install xorg-x11-server-Xvfb openbox xdotool wmctrl ImageMagick` |
| Arch | `sudo pacman -S xorg-server-xvfb openbox xdotool wmctrl imagemagick` |

浏览器可选（`firefox-esr` 推荐；`firefox` / `chromium` / `google-chrome` / `microsoft-edge` /
`brave-browser` 都认）。Ubuntu 24.04 的 snap firefox 有沙盒限制，自定义 profile 下会报
"already running, but not responding"，所以优先用经典版 firefox-esr。

缺依赖时工具会返回一条列出缺失项和安装命令的错误，不会让 Pi 退出。

## 安装

```bash
# git 源（在 pi 里持久化，可用 pi update --extensions 更新）
pi install git:github.com/fenlyin0420/pi-computer-use

# 或本地目录
cd pi-computer-use && npm install
pi install /path/to/pi-computer-use
```

## 工具

| 工具 | 说明 |
|---|---|
| `computer_screen` | 截图（全屏或 `region` 区域），返回图像 + 文件路径（存 `shots/<时间戳>_shot.png`） |
| `computer_click` | 左/右/中键单击、双击、三击 |
| `computer_drag` | 拖拽（分段移动，兼容 HTML5/GTK 拖放） |
| `computer_type` | 向焦点窗口输入文本（换行会按 Enter；`--` 开头、中文、多行都安全） |
| `computer_key` | 按键/热键：`Return`、`ctrl+s`、`alt+Tab` … |
| `computer_scroll` | 在 (x,y) 处上/下/左/右滚动（真实滚轮事件，约 120 单位一格） |
| `computer_window` | list / focus / close / maximize / minimize / move / resize（标题或窗口 id 都行） |
| `computer_app` | 在虚拟桌面上启动任意 GUI 应用或 URL（后台） |
| `computer_desktop` | 启动 / 停止 / 查看虚拟桌面本身 |

用法约定：**观察→操作→再观察** 的循环 —— 操作前截图看坐标，关键操作后再截图确认。

## 手动控制

```bash
bin/desktop.sh start | stop | status | shot [file]
pi /computer status        # pi 里的斜杠命令（等同 computer_desktop status）
```

状态文件（pid、日志、浏览器 profile、截图）都在 `~/.pi/computer-use/display-<n>/`，
例如默认显示号 99 就是 `~/.pi/computer-use/display-99/`；截屏按时间戳留在其 `shots/` 下
（`20261016164900_shot.png`，永不覆盖）。`bin/desktop.sh` 与扩展共用同一份状态，可以互相接管。

## 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PI_COMPUTER_USE_DISPLAY` | `99` | 虚拟显示号（纯数字，可带前导 `:`） |
| `PI_COMPUTER_USE_SCREEN` | `1920x1080x24` | Xvfb 分辨率/色深，`WxH` 或 `WxHxD` |
| `PI_COMPUTER_USE_STATE_DIR` | `~/.pi/computer-use` | 状态根目录，实际用其下 `display-<n>/` |
| `PI_COMPUTER_USE_BROWSER` | 自动探测 | 指定浏览器可执行文件；`none`/`off` 关闭自动启动 |
| `PI_COMPUTER_USE_NO_BROWSER` | 未设置 | 设为 `1` 等价于关闭自动启动 |
| `PI_COMPUTER_USE_WALLPAPER` | 未设置 | 壁纸图片路径（需要 `feh`），不设则不改桌面背景 |
| `PI_COMPUTER_USE_SHOTS_KEEP` | `100` | 截图保留数量，超出按修改时间删旧 |
| `PI_COMPUTER_USE_XVFB`、`PI_COMPUTER_USE_OPENBOX`、`PI_COMPUTER_USE_XDOTOOL`、`PI_COMPUTER_USE_WMCTRL`、`PI_COMPUTER_USE_FEH`、`PI_COMPUTER_USE_IMPORT` | 走 `PATH` | 覆盖对应可执行文件（绝对路径或命令名）；`PI_COMPUTER_USE_IMPORT` 可写 `magick import` |
