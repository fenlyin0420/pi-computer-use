---
name: pi-computer-use
description: Pi 的 computer-use 扩展：Xvfb :99 独立虚拟桌面（openbox + firefox-esr），9 个 computer_* 工具，与真实桌面完全隔离；snap firefox 沙盒坑、firefox-esr 优先
metadata:
  type: project-fact
---

# pi-computer-use（2026-09-28 建立）

位置：`~/Documents/GitHub/pi-computer-use/`（pi 包源 `git:github.com/fenlyin0420/pi-computer-use`，
仓库 public，改完要 push + `pi update --extensions`）。

- 架构：`Xvfb :99 (1920x1080x24)` + `openbox` + 默认浏览器 firefox-esr；
  截图 `import`、鼠标键盘 `xdotool`、窗口 `wmctrl`，全部 `DISPLAY=:99`，
  不碰用户 :1 的鼠标/键盘/焦点。
- 工具：`computer_screen/click/drag/type/key/scroll/window/app/desktop`，
  约定 observe-act-verify 循环；手动控制 `bin/desktop.sh start|stop|status|shot`
  或 pi 里 `/computer status`。
- 状态目录 `~/.pi/computer-use/`（pid、logs、browser-profile、shots/ 截屏）。
  截屏命名 `<YYYYMMDDHHMMSS>_shot.png`，同一秒多次截图加 `-2`/`-3` 后缀且永不覆盖
  （TS 用 `openSync(f,"wx")` 预占名、bash 用 `-e` 存在判断）。
- **坑：Ubuntu 24.04 的 snap firefox** 带沙盒，自定义 profile 下会报
  "already running, but not responding" 且 profile 目录不写任何文件。
  解法：装 `firefox-esr`（mozillateam PPA），扩展里按
  firefox-esr → firefox → google-chrome 顺序挑浏览器，
  `PI_COMPUTER_USE_BROWSER` 可覆盖。
- 依赖：xvfb、openbox、wmctrl、imagemagick（import）、xdotool、firefox-esr。
- 相关：[[remote-pi-multi-workspace]]（都是"多工作区隔离"思路的延伸）。
