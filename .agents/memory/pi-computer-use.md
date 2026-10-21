---
name: pi-computer-use
description: Pi 的 computer-use 扩展：Xvfb 独立虚拟桌面（openbox + 浏览器），9 个 computer_* 工具；状态按 display 隔离、只管理自己启动的进程、外部命令一律异步并挂 error 监听
metadata:
  type: project-fact
---

# pi-computer-use

位置：`~/.pi/agent/git/github.com/fenlyin0420/pi-computer-use`（pi 包源
`git:github.com/fenlyin0420/pi-computer-use`；仓库 public，改完要 commit + push，
否则 `pi update --extensions` 会用远端覆盖本地改动）。

- 架构：`Xvfb`（默认 `:99`，`PI_COMPUTER_USE_SCREEN` 默认 `1920x1080x24`）+ `openbox` +
  默认浏览器（firefox-esr → firefox → Chromium 系 → 无）；截图 `import`（ImageMagick 7
  只有 `magick import` 时自动加前缀）、输入 `xdotool`、窗口 `wmctrl`。全部只带 `DISPLAY`，
  不碰真实桌面。
- 状态目录按 display 隔离：`<PI_COMPUTER_USE_STATE_DIR>/display-<n>/`，默认
  `~/.pi/computer-use/display-99/`；pid 文件是 JSON `{pid,comm,start}`（starttime 用于
  防 pid 复用），`bin/desktop.sh` 与扩展共用同一布局，可互相接管。
- 只管理自己启动的进程：`managed.json` 标记；别人的 display 上不自动开浏览器、不启动
  第二个 WM（用 `wmctrl -m` 探测），`stop` 只杀 identity 校验通过的 pid，
  foreign display 明确“left running”。
- 崩溃类教训（最重要）：`spawn` 找不到二进制是**异步** `error` 事件，不挂
  `child.on("error")` 会直接崩掉宿主 pi 进程；`xexec` 的 stdin/stdout/stderr 也要挂
  error（子进程早退会 EPIPE，同样崩）。工具里不要 `spawnSync`（会卡住 TUI），用异步
  spawn + timeout + AbortSignal，并把失败以 `isError: true` 返回。
- 环境变量：`PI_COMPUTER_USE_DISPLAY`、`_SCREEN`(WxH[xD])、`_STATE_DIR`、
  `_BROWSER`(none/off 关闭)、`_NO_BROWSER=1`、`_WALLPAPER`、`_SHOTS_KEEP`、
  `_XVFB/_OPENBOX/_XDOTOOL/_WMCTRL/_FEH/_IMPORT`（二进制覆盖）。
- xdotool 3.20160805.1 实测：`type` 会丢掉 `\n`（要 split 后逐行 + `key Return`）；
  用 `--file -` 从 stdin 喂文本可避开 `"--delay 20"` 当单 token 之类的选项解析错误；
  没有 `--relative`（是 `mousemove_relative`），滚轮必须 `click 4/5/6/7`；
  `click` 没有 `--clicks`（用 `--repeat`）。
- wmctrl：数字或 `0x` 开头的窗口 id 要加 `-i`（`-ia`/`-ic`/`-i -r`），标题用
  `-a`/`-c`/`-r`；混用会报 "Cannot convert argument to number"。
- 手工验证方法：`node --experimental-strip-types` 直接 import `index.ts`，传假 pi
  `{registerTool, registerCommand, on}`，在临时 display（`:96` 之类）+ 临时 state dir
  上跑工具；浏览器当输入 sink：`file://` 页面里 `<textarea autofocus
  oninput="document.title=encodeURIComponent(this.value)">`，用窗口标题回读。
- 依赖：xvfb、openbox、xdotool、wmctrl、imagemagick（`import`）、firefox-esr（Ubuntu
  24.04 的 snap firefox 自定义 profile 会 “already running, but not responding”，
  优先 firefox-esr）。
