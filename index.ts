/**
 * pi-computer-use
 *
 * Computer-use for Pi on a dedicated Xvfb virtual desktop (default display :99).
 *
 * The virtual desktop is fully isolated: Xvfb + openbox + (optionally) Firefox
 * live on their own X display, so nothing here ever steals the mouse, keyboard
 * or window focus from your real desktop.
 *
 * Tools:
 *   computer_screen    screenshot of the virtual desktop (full screen or region)
 *   computer_click     mouse click / right-click / multi-click at (x, y)
 *   computer_drag      press-move-release drag from (x1, y1) to (x2, y2)
 *   computer_type      type text into the focused window
 *   computer_key       key / hotkey, e.g. "ctrl+s", "Return", "alt+Tab"
 *   computer_scroll    scroll at a position
 *   computer_window    list / focus / close / maximize / minimize / move / resize windows
 *   computer_app       launch any GUI app (or URL) inside the virtual desktop
 *   computer_desktop   start / stop / status of the virtual desktop itself
 *
 * State (pids, logs, firefox profile, screenshots): ~/.pi/computer-use/
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const DISPLAY_ID = process.env.PI_COMPUTER_USE_DISPLAY || "99";
const DISPLAY = `:${DISPLAY_ID}`;
const SCREEN_W = 1920;
const SCREEN_H = 1080;

const STATE_DIR = path.join(os.homedir(), ".pi", "computer-use");
const LOG_DIR = path.join(STATE_DIR, "logs");
const Xvfb_PID_FILE = path.join(STATE_DIR, "xvfb.pid");
const OPENBOX_PID_FILE = path.join(STATE_DIR, "openbox.pid");
const BROWSER_PID_FILE = path.join(STATE_DIR, "browser.pid");
const WALLPAPER_PID_FILE = path.join(STATE_DIR, "feh.pid");
const SHOT_PATH = path.join(STATE_DIR, "shot.png");
const BROWSER_PROFILE = path.join(STATE_DIR, "browser-profile");

/**
 * Pick the browser for the virtual desktop. Snap Firefox is confined and
 * misbehaves with custom profiles ("already running, not responding"), so
 * prefer the classic firefox-esr, then snap firefox, then Chrome.
 * Override with env PI_COMPUTER_USE_BROWSER.
 */
function pickBrowser(): string {
  const forced = process.env.PI_COMPUTER_USE_BROWSER?.trim();
  if (forced) return forced;
  const candidates = ["firefox-esr", "firefox", "google-chrome"];
  for (const c of candidates) {
    if (spawnSync("which", [c]).status === 0) return c;
  }
  return "firefox-esr";
}

function browserLaunchArgs(browser: string): string[] {
  if (browser === "google-chrome" || browser.startsWith("chromium")) {
    return ["--user-data-dir", BROWSER_PROFILE, "--no-first-run", "--no-default-browser-check"];
  }
  return ["-no-remote", "-profile", BROWSER_PROFILE];
}

const WORKFLOW_HINT =
  "Virtual desktop is 1920x1080; use those coordinates. " +
  "Work in an observe-act-verify loop: screenshot before acting, and again after important actions.";

// ---------------------------------------------------------------------------
// X helpers (all run against the virtual display, never the real one)
// ---------------------------------------------------------------------------

function xrun(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number } = {},
): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 15000,
    env: { ...process.env, DISPLAY },
  });
  return {
    code: r.status ?? -1,
    stdout: (r.stdout ?? "").toString().trim(),
    stderr: (r.stderr ?? "").toString().trim(),
  };
}

function displayUp(): boolean {
  return xrun("xdotool", ["getmouselocation"]).code === 0;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(file: string): number | undefined {
  try {
    const v = parseInt(readFileSync(file, "utf8").trim(), 10);
    return Number.isFinite(v) && v > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

function spawnDetached(
  name: string,
  args: string[],
  pidFile: string,
  logName: string,
): ChildProcess | undefined {
  mkdirSync(LOG_DIR, { recursive: true });
  const log = path.join(LOG_DIR, logName);
  const out = openSync(log, "a");
  const child = spawn(name, args, {
    detached: true,
    stdio: ["ignore", out, out] as ("ignore" | number)[],
    env: { ...process.env, DISPLAY },
  });
  child.unref();
  if (child.pid) writeFileSync(pidFile, String(child.pid));
  return child;
}

function ensureDir() {
  mkdirSync(STATE_DIR, { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });
}

function seedFirefoxProfile() {
  if (existsSync(path.join(BROWSER_PROFILE, "user.js"))) return;
  mkdirSync(BROWSER_PROFILE, { recursive: true });
  const prefs = [
    'user_pref("browser.startup.homepage_override.mstone", "ignore");',
    'user_pref("browser.startup.homepage_override.migration", true);',
    'user_pref("startup.homepage_override.url", "about:blank");',
    'user_pref("startup.homepage_welcome_panel.shown", true);',
    'user_pref("startup.homepage_welcome_panel.additional_browses", true);',
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("datareporting.policy.dataCollectionEnabled", false);',
    'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);',
    'user_pref("toolkit.telemetry.unified", false);',
    'user_pref("toolkit.telemetry.enabled", false);',
    'user_pref("browser.tabs.warnAboutClosedTabs", false);',
    'user_pref("browser.link.open_external_overflow_in_new_tab", true);',
  ];
  writeFileSync(path.join(BROWSER_PROFILE, "user.js"), prefs.join("\n") + "\n");
}

function startApp(pidFile: string, name: string, args: string[], logName: string): boolean {
  const pid = readPid(pidFile);
  if (pid && isAlive(pid)) return true;
  const child = spawnDetached(name, args, pidFile, logName);
  return child !== undefined;
}

/**
 * Make sure the whole virtual desktop is running. Returns an error string
 * when something failed, or undefined on success.
 */
function ensureDesktop(): string | undefined {
  ensureDir();
  if (!displayUp()) {
    const child = spawnDetached(
      "Xvfb",
      [DISPLAY, "-screen", "0", `${SCREEN_W}x${SCREEN_H}x24`, "-nolisten", "tcp", "-ac"],
      Xvfb_PID_FILE,
      "xvfb.log",
    );
    if (!child) return "failed to spawn Xvfb";
    // Wait for the display to come up (up to ~6s).
    const deadline = Date.now() + 6000;
    while (!displayUp() && Date.now() < deadline) {
      const rest = Math.max(0, deadline - Date.now());
      spawnSync("sleep", ["0.25"], { timeout: rest });
    }
    if (!displayUp()) return `Xvfb did not start on ${DISPLAY}; see ${path.join(LOG_DIR, "xvfb.log")}`;

    if (!startApp(OPENBOX_PID_FILE, "openbox", [], "openbox.log")) {
      return "failed to start openbox (window manager)";
    }
    // Give the window manager a moment to attach.
    spawnSync("sleep", ["0.5"]);

    // Set wallpaper (non-fatal)
    const wallpaper = path.join(os.homedir(), "images", "149929367_p0_master1200.jpg");
    if (existsSync(wallpaper)) {
      startApp(WALLPAPER_PID_FILE, "feh", ["--bg-scale", wallpaper], "feh.log");
    }
  }

  const browser = pickBrowser();
  if (!readPid(BROWSER_PID_FILE) || !isAlive(readPid(BROWSER_PID_FILE)!)) {
    if (browser.startsWith("firefox")) seedFirefoxProfile();
    mkdirSync(BROWSER_PROFILE, { recursive: true });
    if (!startApp(BROWSER_PID_FILE, browser, browserLaunchArgs(browser), "browser.log")) {
      return `failed to start browser (${browser}, non-fatal — start it later with computer_app)`;
    }
  }
  return undefined;
}

function desktopStatus(): string {
  const parts: string[] = [];
  parts.push(`display=${DISPLAY} ${displayUp() ? "UP" : "DOWN"}`);
  for (const [file, name] of [
    [Xvfb_PID_FILE, "xvfb"],
    [OPENBOX_PID_FILE, "openbox"],
    [BROWSER_PID_FILE, "browser"],
  ] as const) {
    const pid = readPid(file);
    parts.push(`${name}=${pid && isAlive(pid) ? "pid " + pid : "off"}`);
  }
  return parts.join(" ");
}

function stopDesktop(): string {
  let stopped = 0;
  for (const file of [BROWSER_PID_FILE, OPENBOX_PID_FILE, Xvfb_PID_FILE]) {
    const pid = readPid(file);
    if (pid && isAlive(pid)) {
      try {
        process.kill(pid, "SIGTERM");
        stopped++;
      } catch {
        /* ignore */
      }
      try {
        writeFileSync(file, "");
      } catch {
        /* ignore */
      }
    }
  }
  // Kill by pgrep as a fallback in case pids were lost.
  xrun("pkill", ["-f", `Xvfb ${DISPLAY} `]);
  return stopped > 0 ? `stopped ${stopped} process(es)` : "nothing to stop";
}

type TextContent = { type: "text"; text: string };
type ImageContent = { type: "image"; data: string; mimeType: string };

function screenshot(region?: { x: number; y: number; w: number; h: number }):
  | { content: (TextContent | ImageContent)[]; path: string; size: number }
  | { error: string } {
  if (!displayUp()) return { error: "virtual display is down; run computer_desktop action=start first" };
  const args = ["-window", "root"];
  if (region) args.splice(0, 0, "-crop", `${region.w}x${region.h}+${region.x}+${region.y}`, "+repage");
  args.push(SHOT_PATH);
  const r = xrun("import", args, { timeoutMs: 20000 });
  if (r.code !== 0) return { error: `screenshot failed: ${r.stderr || r.stdout}` };
  const data = readFileSync(SHOT_PATH).toString("base64");
  const size = Math.round(data.length / 1024);
  const label = region
    ? `region x=${region.x} y=${region.y} w=${region.w} h=${region.h}`
    : `full screen ${SCREEN_W}x${SCREEN_H}`;
  return {
    content: [
      { type: "text", text: `Virtual desktop screenshot (${label}).` },
      { type: "image", data, mimeType: "image/png" },
    ],
    path: SHOT_PATH,
    size,
  };
}

type ToolReturn = {
  content: (TextContent | ImageContent)[];
  details: Record<string, unknown>;
};

function textResult(text: string): ToolReturn {
  return { content: [{ type: "text" as const, text }], details: { display: DISPLAY } };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function computerUseExtension(pi: ExtensionAPI) {
  const guard = (fn: () => { error?: string; content?: (TextContent | ImageContent)[]; details?: Record<string, unknown> }): ToolReturn => {
    const r = fn();
    if (r.error) {
      return { content: [{ type: "text" as const, text: `Error: ${r.error}` }], details: { display: DISPLAY } };
    }
    return {
      content: r.content ?? [],
      details: r.details ?? { display: DISPLAY },
    };
  };

  pi.registerTool({
    name: "computer_screen",
    label: "Computer Screen",
    description:
      `Screenshot of the dedicated virtual desktop (a separate Xvfb display ${DISPLAY}, isolated from the real desktop). ` +
      "Returns the image plus its file path. Use an optional region to zoom into an area. " +
      WORKFLOW_HINT,
    promptSnippet: "Screenshot of the isolated virtual desktop (computer use)",
    parameters: Type.Object({
      region: Type.Optional(
        Type.Object(
          {
            x: Type.Number({ description: "Left edge (px)" }),
            y: Type.Number({ description: "Top edge (px)" }),
            w: Type.Number({ description: "Width (px)" }),
            h: Type.Number({ description: "Height (px)" }),
          },
          { description: "Optional rectangular region to capture instead of the full screen" },
        ),
      ),
    }),
    async execute() {
      const err = ensureDesktop();
      if (err) return textResult(`Error: ${err}`);
      return guard(() => {
        const shot = screenshot();
        if ("error" in shot) return { error: shot.error };
        return { content: shot.content, details: { display: DISPLAY, path: shot.path, kb: shot.size } };
      });
    },
  });

  pi.registerTool({
    name: "computer_click",
    label: "Computer Click",
    description:
      `Click at (x, y) on the virtual desktop ${DISPLAY}. Supports right/middle button and double/triple click. ` +
      WORKFLOW_HINT,
    promptSnippet: "Click on the virtual desktop",
    parameters: Type.Object({
      x: Type.Number({ description: "X coordinate (0-1919)" }),
      y: Type.Number({ description: "Y coordinate (0-1079)" }),
      button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")], { description: "Mouse button (default left)" })),
      clicks: Type.Optional(Type.Number({ description: "1=single (default), 2=double, 3=triple" })),
    }),
    async execute(_id, p) {
      const err = ensureDesktop();
      if (err) return textResult(`Error: ${err}`);
      const btn = p.button === "right" ? "3" : p.button === "middle" ? "2" : "1";
      const base = ["mousemove", String(Math.round(p.x)), String(Math.round(p.y)), "click"];
      let r = xrun("xdotool", p.clicks && p.clicks > 1 ? [...base, "--clicks", String(p.clicks), btn] : [...base, btn]);
      if (r.code !== 0 && (r.stderr || "").includes("unrecognized option")) {
        // older xdotool uses --repeat instead of --clicks
        r = xrun("xdotool", [...base, "--repeat", String(p.clicks), btn]);
      }
      return guard(() => (r.code === 0 ? { content: [{ type: "text", text: `clicked (${p.x},${p.y})${p.button ? " " + p.button : ""}${p.clicks ? " x" + p.clicks : ""}` }] } : { error: `click failed: ${r.stderr || r.stdout}` }));
    },
  });

  pi.registerTool({
    name: "computer_drag",
    label: "Computer Drag",
    description:
      `Drag from (x1,y1) to (x2,y2) on the virtual desktop ${DISPLAY} with a mouse button. Use for moving items, sliders, text selection.`,
    promptSnippet: "Drag on the virtual desktop",
    parameters: Type.Object({
      x1: Type.Number({ description: "Start X" }),
      y1: Type.Number({ description: "Start Y" }),
      x2: Type.Number({ description: "End X" }),
      y2: Type.Number({ description: "End Y" }),
      button: Type.Optional(Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")], { description: "Mouse button (default left)" })),
    }),
    async execute(_id, p) {
      const err = ensureDesktop();
      if (err) return textResult(`Error: ${err}`);
      const b = p.button ?? "left";
      let last = xrun("xdotool", ["mousemove", String(Math.round(p.x1)), String(Math.round(p.y1))]);
      if (last.code !== 0) return textResult(`Error: ${last.stderr || last.stdout}`);
      last = xrun("xdotool", ["mousedown", b === "left" ? "1" : b === "right" ? "3" : "2"]);
      if (last.code !== 0) return textResult(`Error: ${last.stderr || last.stdout}`);
      last = xrun("xdotool", ["mousemove", String(Math.round(p.x2)), String(Math.round(p.y2))]);
      xrun("xdotool", ["mouseup", b === "left" ? "1" : b === "right" ? "3" : "2"]);
      return guard(() => (last.code === 0 ? { content: [{ type: "text", text: `dragged (${p.x1},${p.y1}) -> (${p.x2},${p.y2})` }] } : { error: `drag failed: ${last.stderr || last.stdout}` }));
    },
  });

  pi.registerTool({
    name: "computer_type",
    label: "Computer Type",
    description:
      `Type text into the currently focused window on the virtual desktop ${DISPLAY}. Multi-line is typed with Enter between lines. Make sure the target input has focus (click it first).`,
    promptSnippet: "Type text on the virtual desktop",
    parameters: Type.Object({
      text: Type.String({ description: "Text to type" }),
      delay_ms: Type.Optional(Type.Number({ description: "Delay between keystrokes in ms (default 20)" })),
    }),
    async execute(_id, p) {
      const err = ensureDesktop();
      if (err) return textResult(`Error: ${err}`);
      const r = xrun("xdotool", ["type", "--clearmodifiers", `--delay ${p.delay_ms ?? 20}`, p.text], { timeoutMs: 30000 });
      return guard(() => (r.code === 0 ? { content: [{ type: "text", text: `typed ${p.text.length} char(s)` }] } : { error: `type failed: ${r.stderr || r.stdout}` }));
    },
  });

  pi.registerTool({
    name: "computer_key",
    label: "Computer Key",
    description:
      `Press a key or hotkey on the virtual desktop ${DISPLAY}, e.g. "Return", "Tab", "ctrl+s", "alt+Tab", "ctrl+shift+t".`,
    promptSnippet: "Key / hotkey on the virtual desktop",
    parameters: Type.Object({
      keys: Type.String({ description: 'Key sequence, e.g. "ctrl+s" or "Return"' }),
    }),
    async execute(_id, p) {
      const err = ensureDesktop();
      if (err) return textResult(`Error: ${err}`);
      const r = xrun("xdotool", ["key", "--clearmodifiers", p.keys]);
      return guard(() => (r.code === 0 ? { content: [{ type: "text", text: `pressed ${p.keys}` }] } : { error: `key failed: ${r.stderr || r.stdout}` }));
    },
  });

  pi.registerTool({
    name: "computer_scroll",
    label: "Computer Scroll",
    description:
      `Scroll at position (x, y) on the virtual desktop ${DISPLAY}.`,
    promptSnippet: "Scroll on the virtual desktop",
    parameters: Type.Object({
      x: Type.Number({ description: "X coordinate" }),
      y: Type.Number({ description: "Y coordinate" }),
      direction: Type.Union([Type.Literal("up"), Type.Literal("down"), Type.Literal("left"), Type.Literal("right")], { description: "Scroll direction" }),
      amount: Type.Optional(Type.Number({ description: "Pixels to scroll (default 240)" })),
    }),
    async execute(_id, p) {
      const err = ensureDesktop();
      if (err) return textResult(`Error: ${err}`);
      const n = Math.round(p.amount ?? 240);
      xrun("xdotool", ["mousemove", String(Math.round(p.x)), String(Math.round(p.y))]);
      let dx = 0;
      let dy = 0;
      if (p.direction === "up") dy = n;
      if (p.direction === "down") dy = -n;
      if (p.direction === "left") dx = n;
      if (p.direction === "right") dx = -n;
      const r = xrun("xdotool", ["mousemove", "--relative", String(dx), String(dy)]);
      return guard(() => (r.code === 0 ? { content: [{ type: "text", text: `scrolled ${p.direction} ${n}px` }] } : { error: `scroll failed: ${r.stderr || r.stdout}` }));
    },
  });

  pi.registerTool({
    name: "computer_window",
    label: "Computer Window",
    description:
      `Window manager for the virtual desktop ${DISPLAY} (via wmctrl). action=list shows all windows with titles; focus/close/maximize/minimize/move/resize target a window by title substring or window id.`,
    promptSnippet: "Window management on the virtual desktop",
    parameters: Type.Object({
      action: Type.Union(
        [Type.Literal("list"), Type.Literal("focus"), Type.Literal("close"), Type.Literal("maximize"), Type.Literal("minimize"), Type.Literal("move"), Type.Literal("resize")],
        { description: "Window action" },
      ),
      target: Type.Optional(Type.String({ description: "Window title substring or numeric window id (required for everything except list)" })),
      x: Type.Optional(Type.Number({ description: "move: new X" })),
      y: Type.Optional(Type.Number({ description: "move: new Y" })),
      w: Type.Optional(Type.Number({ description: "resize: new width" })),
      h: Type.Optional(Type.Number({ description: "resize: new height" })),
    }),
    async execute(_id, p) {
      const err = ensureDesktop();
      if (err) return textResult(`Error: ${err}`);
      if (p.action === "list") {
        const r = xrun("wmctrl", ["-l"]);
        return guard(() => (r.code === 0 ? { content: [{ type: "text", text: r.stdout || "(no windows)" }] } : { error: `wmctrl list failed: ${r.stderr || r.stdout}` }));
      }
      if (!p.target) return textResult("Error: target is required for this action");
      const base = ["-r", p.target];
      let args: string[];
      switch (p.action) {
        case "focus":
          args = ["-a", p.target];
          break;
        case "close":
          args = ["-ic", p.target];
          break;
        case "maximize":
          args = [...base, "-b", "add,maximized_vert,maximized_horz"];
          break;
        case "minimize":
          args = [...base, "-b", "add,hidden"];
          break;
        case "move":
          if (p.x == null || p.y == null) return textResult("Error: move needs x and y");
          args = [...base, "-e", `0,${Math.round(p.x)},${Math.round(p.y)},-1,-1`];
          break;
        case "resize":
          if (p.w == null || p.h == null) return textResult("Error: resize needs w and h");
          args = [...base, "-e", `0,-1,-1,${Math.round(p.w)},${Math.round(p.h)}`];
          break;
        default:
          return textResult(`Error: unknown action ${String(p.action)}`);
      }
      const r = xrun("wmctrl", args);
      return guard(() => (r.code === 0 ? { content: [{ type: "text", text: `window ${p.action} ok (${p.target})` }] } : { error: `wmctrl ${p.action} failed: ${r.stderr || r.stdout}` }));
    },
  });

  pi.registerTool({
    name: "computer_app",
    label: "Computer App",
    description:
      `Launch an app (or open a URL) inside the virtual desktop ${DISPLAY}, e.g. "firefox-esr https://example.com", "xterm", "gimp". Runs detached in the background; returns the pid. The default browser profile lives at ~/.pi/computer-use/browser-profile.`,
    promptSnippet: "Launch an app / URL on the virtual desktop",
    parameters: Type.Object({
      command: Type.String({ description: 'Command line to run, e.g. "firefox https://example.com"' }),
    }),
    async execute(_id, p) {
      const err = ensureDesktop();
      if (err) return textResult(`Error: ${err}`);
      ensureDir();
      const logPath = path.join(LOG_DIR, "app.log");
      const out = openSync(logPath, "a");
      const child = spawn(p.command, {
        shell: true,
        detached: true,
        stdio: ["ignore", out, out] as ("ignore" | number)[],
        env: { ...process.env, DISPLAY },
      });
      child.unref();
      return textResult(`launched "${p.command}" (pid ${child.pid ?? "?"}, logs at ${logPath})`);
    },
  });

  pi.registerTool({
    name: "computer_desktop",
    label: "Computer Desktop",
    description:
      `Control the virtual desktop itself on display ${DISPLAY}: start (auto by default), stop, or status. Stopping kills the browser, openbox and Xvfb.`,
    promptSnippet: "Start/stop/status the virtual desktop",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("start"), Type.Literal("stop"), Type.Literal("status")], { description: "Desktop action" }),
    }),
    async execute(_id, p) {
      if (p.action === "status") {
        return textResult(desktopStatus());
      }
      if (p.action === "stop") {
        const r = stopDesktop();
        return textResult(`${r} — ${desktopStatus()}`);
      }
      const err = ensureDesktop();
      return textResult(err ? `start failed: ${err}` : `started — ${desktopStatus()}`);
    },
  });

  // Convenience slash command for manual control.
  pi.registerCommand("computer", {
    description: "Virtual desktop: /computer status|start|stop|shot",
    handler: async (args, ctx) => {
      const [cmd] = String(args ?? "status").trim().split(/\s+/);
      let out: string;
      if (cmd === "stop") out = `${stopDesktop()} — ${desktopStatus()}`;
      else if (cmd === "start") {
        const err = ensureDesktop();
        out = err ? `start failed: ${err}` : `started — ${desktopStatus()}`;
      } else if (cmd === "shot") {
        const s = screenshot();
        out = "error" in s ? s.error : `saved to ${s.path} (${s.size} KB base64)`;
      } else out = desktopStatus();
      ctx.ui.notify(out, out.startsWith("error") ? "error" : "info");
    },
  });
}
