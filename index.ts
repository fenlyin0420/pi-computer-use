/**
 * pi-computer-use
 *
 * Computer-use for Pi on a dedicated Xvfb virtual desktop (default display :99).
 *
 * The virtual desktop is isolated: Xvfb + openbox + (optionally) a browser live
 * on their own X display, so nothing here steals the mouse, keyboard or window
 * focus from your real desktop.
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
 * State (pids, logs, browser profile, screenshots) lives in
 * `<PI_COMPUTER_USE_STATE_DIR>/display-<n>/`, default `~/.pi/computer-use/display-99/`.
 *
 * Environment:
 *   PI_COMPUTER_USE_DISPLAY      display number (default 99)
 *   PI_COMPUTER_USE_SCREEN       WxH[xDEPTH] (default 1920x1080x24)
 *   PI_COMPUTER_USE_STATE_DIR    state root (default ~/.pi/computer-use)
 *   PI_COMPUTER_USE_BROWSER      browser binary, or "none" to disable autostart
 *   PI_COMPUTER_USE_NO_BROWSER   "1" disables browser autostart
 *   PI_COMPUTER_USE_WALLPAPER    wallpaper image (default none; needs feh)
 *   PI_COMPUTER_USE_SHOTS_KEEP   screenshots kept on disk (default 100)
 *   PI_COMPUTER_USE_XVFB / _OPENBOX / _XDOTOOL / _WMCTRL / _FEH / _IMPORT
 *                                binary overrides (absolute paths or PATH names)
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const rawDisplay = (process.env.PI_COMPUTER_USE_DISPLAY ?? "99").trim().replace(/^:/, "");
const DISPLAY_VALID = /^\d+$/.test(rawDisplay);
const DISPLAY_ID = DISPLAY_VALID ? rawDisplay : "99";
const DISPLAY = `:${DISPLAY_ID}`;

const SCREEN_RE = /^(\d+)x(\d+)(?:x(\d+))?$/;
const rawScreen = (process.env.PI_COMPUTER_USE_SCREEN ?? "1920x1080x24").trim();
const screenMatch = SCREEN_RE.exec(rawScreen);
const SCREEN = {
	w: Number(screenMatch?.[1] ?? 1920),
	h: Number(screenMatch?.[2] ?? 1080),
	depth: Number(screenMatch?.[3] ?? 24),
};
const SCREEN_ERROR = screenMatch
	? undefined
	: `PI_COMPUTER_USE_SCREEN="${rawScreen}" is not WxH or WxHxDEPTH`;

const STATE_ROOT =
	process.env.PI_COMPUTER_USE_STATE_DIR?.trim() || path.join(os.homedir(), ".pi", "computer-use");
const STATE_DIR = path.join(STATE_ROOT, `display-${DISPLAY_ID}`);
const LOG_DIR = path.join(STATE_DIR, "logs");
const SHOTS_DIR = path.join(STATE_DIR, "shots");
const BROWSER_PROFILE = path.join(STATE_DIR, "browser-profile");
const LOCK_FILE = path.join(STATE_DIR, "desktop.lock");
const MANAGED_FILE = path.join(STATE_DIR, "managed.json");

const XVFB_PID = path.join(STATE_DIR, "xvfb.pid");
const OPENBOX_PID = path.join(STATE_DIR, "openbox.pid");
const BROWSER_PID = path.join(STATE_DIR, "browser.pid");
const FEH_PID = path.join(STATE_DIR, "feh.pid");

const SCREEN_HINT =
	`Virtual desktop is ${SCREEN.w}x${SCREEN.h}; use those coordinates. ` +
	"Work in an observe-act-verify loop: screenshot before acting, and again after important actions.";

const INSTALL_HINT =
	"Ubuntu/Debian: sudo apt install xvfb openbox xdotool wmctrl imagemagick; " +
	"Fedora: sudo dnf install xorg-x11-server-Xvfb openbox xdotool wmctrl ImageMagick; " +
	"Arch: sudo pacman -S xorg-server-xvfb openbox xdotool wmctrl imagemagick";

// ---------------------------------------------------------------------------
// Binary resolution (env override first, then PATH; absolute paths are used so
// a stripped-down service PATH cannot change behaviour between calls)
// ---------------------------------------------------------------------------

const binCache = new Map<string, string>();

function which(bin: string): string | undefined {
	if (bin.includes("/")) return existsSync(bin) ? bin : undefined;
	try {
		const r = spawnSync("which", [bin], { encoding: "utf8", timeout: 5000 });
		const out = (r.stdout ?? "").toString().trim().split("\n")[0];
		return r.status === 0 && out ? out : undefined;
	} catch {
		return undefined;
	}
}

function resolveBin(envName: string, candidates: string[]): string | undefined {
	const override = process.env[`PI_COMPUTER_USE_${envName}`]?.trim();
	const key = override ? `env:${envName}:${override}` : `def:${candidates.join(",")}`;
	const cached = binCache.get(key);
	if (cached) return cached;
	const found = override ? which(override) : candidates.map(which).find((x): x is string => Boolean(x));
	if (found) binCache.set(key, found);
	return found;
}

const xvfbBin = () => resolveBin("XVFB", ["Xvfb"]);
const openboxBin = () => resolveBin("OPENBOX", ["openbox"]);
const xdotoolBin = () => resolveBin("XDOTOOL", ["xdotool"]);
const wmctrlBin = () => resolveBin("WMCTRL", ["wmctrl"]);
const fehBin = () => resolveBin("FEH", ["feh"]);

interface ImportCommand {
	cmd: string;
	prefix: string[];
}

let importCache: ImportCommand | undefined;

/** ImageMagick 6 ships `import`; ImageMagick 7 may only ship `magick import`. */
function importCommand(): ImportCommand | undefined {
	if (importCache) return importCache;
	const override = process.env.PI_COMPUTER_USE_IMPORT?.trim();
	if (override) {
		const [head, ...rest] = override.split(/\s+/);
		const resolved = which(head);
		if (resolved) importCache = { cmd: resolved, prefix: rest };
		return importCache;
	}
	const legacy = which("import");
	if (legacy) {
		importCache = { cmd: legacy, prefix: [] };
		return importCache;
	}
	const magick = which("magick");
	if (magick) {
		importCache = { cmd: magick, prefix: ["import"] };
		return importCache;
	}
	return undefined;
}

type BrowserKind = "firefox" | "chromium";
interface BrowserRef {
	path: string;
	kind: BrowserKind;
}

function classifyBrowser(bin: string): BrowserKind {
	return /firefox/i.test(bin) ? "firefox" : "chromium";
}

/**
 * Pick the browser for the virtual desktop. Snap Firefox is confined and
 * misbehaves with custom profiles, so prefer the classic firefox-esr, then snap
 * firefox, then the Chromium family. Override with PI_COMPUTER_USE_BROWSER.
 */
function pickBrowser(): BrowserRef | undefined {
	const forced = process.env.PI_COMPUTER_USE_BROWSER?.trim();
	if (forced) {
		if (/^(none|off|0)$/i.test(forced)) return undefined;
		const p = which(forced);
		return p ? { path: p, kind: classifyBrowser(p) } : undefined;
	}
	for (const name of ["firefox-esr", "firefox"]) {
		const p = which(name);
		if (p) return { path: p, kind: "firefox" };
	}
	for (const name of [
		"google-chrome",
		"google-chrome-stable",
		"chromium",
		"chromium-browser",
		"microsoft-edge",
		"brave-browser",
	]) {
		const p = which(name);
		if (p) return { path: p, kind: "chromium" };
	}
	return undefined;
}

function browserArgs(browser: BrowserRef): string[] {
	if (browser.kind === "chromium") {
		return ["--user-data-dir", BROWSER_PROFILE, "--no-first-run", "--no-default-browser-check"];
	}
	return ["-no-remote", "-profile", BROWSER_PROFILE];
}

function browserAutostartDisabled(): boolean {
	if (process.env.PI_COMPUTER_USE_NO_BROWSER === "1") return true;
	return /^(none|off|0)$/i.test(process.env.PI_COMPUTER_USE_BROWSER?.trim() ?? "");
}

// ---------------------------------------------------------------------------
// Process identity: pid files store pid + comm + starttime, so a recycled pid is
// never mistaken for our process (and never signalled by computer_desktop stop)
// ---------------------------------------------------------------------------

interface PidRecord {
	pid: number;
	comm?: string;
	start?: string;
}

function procIdentity(pid: number): { comm: string; start: string } | undefined {
	try {
		const comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const tail = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		// Field 22 of /proc/<pid>/stat (starttime) is index 19 after comm/state.
		return { comm, start: tail[19] ?? "" };
	} catch {
		return undefined;
	}
}

function readPidRecord(file: string): PidRecord | undefined {
	try {
		const raw = readFileSync(file, "utf8").trim();
		if (!raw) return undefined;
		if (/^\d+$/.test(raw)) return { pid: Number(raw) };
		const parsed = JSON.parse(raw) as Partial<PidRecord>;
		if (typeof parsed.pid !== "number" || parsed.pid <= 0) return undefined;
		return { pid: parsed.pid, comm: parsed.comm, start: parsed.start };
	} catch {
		return undefined;
	}
}

function writePidRecord(file: string, pid: number | undefined): void {
	try {
		if (!pid) {
			unlinkSync(file);
			return;
		}
		const identity = procIdentity(pid);
		writeFileSync(file, JSON.stringify({ pid, comm: identity?.comm, start: identity?.start }));
	} catch {
		/* ignore */
	}
}

function isTrackedProcess(record: PidRecord | undefined, expectedComm?: string): boolean {
	if (!record) return false;
	const identity = procIdentity(record.pid);
	if (!identity) return false;
	if (expectedComm && identity.comm !== expectedComm) return false;
	if (record.comm && record.comm !== identity.comm) return false;
	if (record.start && record.start !== identity.start) return false;
	return true;
}

/** Upgrade a legacy plain-number pid file to the identity format when it is alive. */
function adoptPidRecord(file: string, expectedComm?: string): PidRecord | undefined {
	const record = readPidRecord(file);
	if (!record) return undefined;
	if (record.comm && record.start) return record;
	if (!isTrackedProcess(record, expectedComm)) return undefined;
	writePidRecord(file, record.pid);
	return readPidRecord(file);
}

const TRACKED = [
	{ file: BROWSER_PID, name: "browser", comm: undefined },
	{ file: FEH_PID, name: "feh", comm: "feh" },
	{ file: OPENBOX_PID, name: "openbox", comm: "openbox" },
	{ file: XVFB_PID, name: "xvfb", comm: "Xvfb" },
] as const;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Directories, locking, managed marker
// ---------------------------------------------------------------------------

function ensureDir(): void {
	mkdirSync(LOG_DIR, { recursive: true });
	mkdirSync(SHOTS_DIR, { recursive: true });
}

function writeManaged(managed: boolean): void {
	try {
		if (!managed) {
			unlinkSync(MANAGED_FILE);
			return;
		}
		writeFileSync(MANAGED_FILE, JSON.stringify({ display: DISPLAY, pid: process.pid, at: Date.now() }));
	} catch {
		/* ignore */
	}
}

function readManaged(): boolean {
	return existsSync(MANAGED_FILE);
}

async function withLock<T>(fn: () => Promise<T> | T): Promise<T> {
	ensureDir();
	const deadline = Date.now() + 15000;
	for (;;) {
		try {
			const fd = openSync(LOCK_FILE, "wx");
			writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
			closeSync(fd);
			try {
				return await fn();
			} finally {
				try {
					unlinkSync(LOCK_FILE);
				} catch {
					/* ignore */
				}
			}
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
			let stale = false;
			try {
				const held = JSON.parse(readFileSync(LOCK_FILE, "utf8")) as { pid?: number; at?: number };
				stale = !held.pid || !procIdentity(held.pid) || Date.now() - (held.at ?? 0) > 60_000;
			} catch {
				stale = true;
			}
			if (stale) {
				try {
					unlinkSync(LOCK_FILE);
				} catch {
					/* ignore */
				}
				continue;
			}
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${LOCK_FILE}`);
			await delay(100);
		}
	}
}

// ---------------------------------------------------------------------------
// X helpers (all run against the virtual display, never the real one)
// ---------------------------------------------------------------------------

interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

interface ExecOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
	input?: string;
}

/** Async process run with timeout and abort support, so the host TUI never blocks. */
async function xexec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
	const timeoutMs = opts.timeoutMs ?? 15000;
	const signal = opts.signal;
	return await new Promise<ExecResult>((resolve) => {
		let settled = false;
		let stdout = "";
		let stderr = "";
		let timer: NodeJS.Timeout | undefined;
		let child: ChildProcess | undefined;

		const finish = (code: number, extra?: string) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			if (extra) stderr = stderr ? `${stderr}\n${extra}` : extra;
			resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
		};
		const onAbort = () => {
			try {
				child?.kill("SIGTERM");
			} catch {
				/* ignore */
			}
			finish(-1, "aborted");
		};

		child = spawn(cmd, args, {
			env: { ...process.env, DISPLAY },
			stdio: ["pipe", "pipe", "pipe"],
		});
		// Streams can fail with EPIPE when the child exits or never reads stdin;
		// an unhandled stream 'error' would take the host process down.
		child.stdin?.on("error", () => {});
		child.stdout?.on("error", () => {});
		child.stderr?.on("error", () => {});
		child.stdout?.on("data", (d: Buffer) => {
			stdout += d.toString();
		});
		child.stderr?.on("data", (d: Buffer) => {
			stderr += d.toString();
		});
		child.on("error", (e) => finish(-1, e.message));
		child.on("close", (code) => finish(code ?? -1));
		timer = setTimeout(() => {
			try {
				child?.kill("SIGKILL");
			} catch {
				/* ignore */
			}
			finish(-1, `timed out after ${timeoutMs}ms`);
		}, timeoutMs);
		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}
		try {
			child.stdin?.end(opts.input ?? "");
		} catch {
			/* ignore */
		}
	});
}

function spawnDetached(binPath: string, args: string[], logName: string): { pid?: number; error?: string } {
	mkdirSync(LOG_DIR, { recursive: true });
	const log = path.join(LOG_DIR, logName);
	let fd: number;
	try {
		fd = openSync(log, "a");
	} catch (e) {
		return { error: `cannot open ${log}: ${(e as Error).message}` };
	}
	try {
		const child = spawn(binPath, args, {
			detached: true,
			stdio: ["ignore", fd, fd],
			env: { ...process.env, DISPLAY },
		});
		// A missing binary emits an async 'error' event; without this listener it
		// would be an uncaught exception and take the whole host process down.
		child.on("error", (e) => {
			try {
				appendFileSync(log, `spawn error: ${e.message}\n`);
			} catch {
				/* ignore */
			}
		});
		child.unref();
		if (!child.pid) return { error: `failed to spawn ${binPath} (see ${log})` };
		return { pid: child.pid };
	} catch (e) {
		return { error: `failed to spawn ${binPath}: ${(e as Error).message}` };
	} finally {
		closeSync(fd);
	}
}

function startApp(
	pidFile: string,
	binPath: string,
	args: string[],
	logName: string,
	expectedComm?: string,
): { ok: boolean; error?: string } {
	if (isTrackedProcess(adoptPidRecord(pidFile, expectedComm) ?? readPidRecord(pidFile), expectedComm)) {
		return { ok: true };
	}
	writePidRecord(pidFile, undefined);
	const spawned = spawnDetached(binPath, args, logName);
	if (!spawned.pid) return { ok: false, error: spawned.error ?? `failed to spawn ${binPath}` };
	writePidRecord(pidFile, spawned.pid);
	return { ok: true };
}

/** Check the configured host tools once; returns a readable message when one is missing. */
function preflight(): string | undefined {
	if (!DISPLAY_VALID) {
		return `PI_COMPUTER_USE_DISPLAY="${process.env.PI_COMPUTER_USE_DISPLAY}" is not a display number`;
	}
	if (SCREEN_ERROR) return SCREEN_ERROR;
	if (process.platform !== "linux") {
		return `computer_use needs X11/Xvfb on Linux; ${process.platform} is not supported (missing: Xvfb, openbox, xdotool, wmctrl, ImageMagick)`;
	}
	const missing: string[] = [];
	if (!xvfbBin()) missing.push("Xvfb");
	if (!xdotoolBin()) missing.push("xdotool");
	if (!wmctrlBin()) missing.push("wmctrl");
	if (!importCommand()) missing.push("ImageMagick (import)");
	if (missing.length > 0) return `missing required host tools: ${missing.join(", ")}. Install them — ${INSTALL_HINT}`;
	return undefined;
}

async function displayUp(signal?: AbortSignal): Promise<boolean> {
	const xdotool = xdotoolBin();
	if (!xdotool) return false;
	return (await xexec(xdotool, ["getmouselocation"], { timeoutMs: 5000, signal })).code === 0;
}

async function displayGeometry(signal?: AbortSignal): Promise<{ w: number; h: number } | undefined> {
	const xdotool = xdotoolBin();
	if (!xdotool) return undefined;
	const r = await xexec(xdotool, ["getdisplaygeometry"], { timeoutMs: 5000, signal });
	if (r.code !== 0) return undefined;
	const [w, h] = r.stdout.split(/\s+/).map(Number);
	return w && h ? { w, h } : undefined;
}

async function windowManagerPresent(signal?: AbortSignal): Promise<boolean> {
	const wmctrl = wmctrlBin();
	if (!wmctrl) return false;
	const r = await xexec(wmctrl, ["-m"], { timeoutMs: 5000, signal });
	return r.code === 0 && /Name:/i.test(r.stdout);
}

function seedFirefoxProfile(): void {
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

interface DesktopState {
	error?: string;
	notes: string[];
}

/**
 * Make sure the whole virtual desktop is running. Browser and wallpaper are
 * best-effort: a missing browser must not block screenshots or input.
 */
async function ensureDesktop(signal?: AbortSignal): Promise<DesktopState> {
	if (signal?.aborted) return { error: "aborted", notes: [] };
	const missing = preflight();
	if (missing) return { error: missing, notes: [] };
	ensureDir();
	try {
		return await withLock(async () => {
			const notes: string[] = [];
			const managedBefore = readManaged();
			if (!(await displayUp(signal))) {
				const started = startApp(
					XVFB_PID,
					xvfbBin()!,
					[DISPLAY, "-screen", "0", `${SCREEN.w}x${SCREEN.h}x${SCREEN.depth}`, "-nolisten", "tcp", "-ac"],
					"xvfb.log",
					"Xvfb",
				);
				if (!started.ok) return { error: `failed to start Xvfb: ${started.error}`, notes };
				writeManaged(true);
				const deadline = Date.now() + 8000;
				while (!(await displayUp(signal)) && Date.now() < deadline) {
					if (signal?.aborted) return { error: "aborted", notes };
					await delay(200);
				}
				if (!(await displayUp(signal))) {
					return { error: `Xvfb did not start on ${DISPLAY}; see ${path.join(LOG_DIR, "xvfb.log")}`, notes };
				}
			} else if (!managedBefore) {
				notes.push(
					`display ${DISPLAY} is already running and was not started by this extension; ` +
						"computer_desktop stop will leave it running",
				);
			}
			const managed = readManaged();

			// The window manager is needed for list/focus/move, and Xvfb may outlive it.
			// Never start a second WM on a display that already has one.
			if (!isTrackedProcess(adoptPidRecord(OPENBOX_PID, "openbox") ?? readPidRecord(OPENBOX_PID), "openbox")) {
				if (await windowManagerPresent(signal)) {
					if (managed) notes.push("a window manager is already running on this display; openbox not started");
				} else {
					const openbox = openboxBin();
					if (!openbox) {
						return {
							error:
								`no window manager on ${DISPLAY} and openbox is not installed; install openbox — ${INSTALL_HINT}`,
							notes,
						};
					}
					const wm = startApp(OPENBOX_PID, openbox, [], "openbox.log", "openbox");
					if (!wm.ok) return { error: `failed to start openbox: ${wm.error}`, notes };
					await delay(500);
				}
			}

			const wallpaper = process.env.PI_COMPUTER_USE_WALLPAPER?.trim();
			if (wallpaper && existsSync(wallpaper)) {
				const feh = fehBin();
				if (!feh) notes.push("PI_COMPUTER_USE_WALLPAPER is set but feh is not installed; skipping wallpaper");
				else if (!isTrackedProcess(adoptPidRecord(FEH_PID, "feh") ?? readPidRecord(FEH_PID), "feh")) {
					startApp(FEH_PID, feh, ["--bg-scale", wallpaper], "feh.log", "feh");
				}
			}

			if (!browserAutostartDisabled()) {
				if (!managed) {
					// Never inject a browser into a desktop another tool owns.
					notes.push("display is owned by another tool; browser autostart skipped (use computer_app if you need one)");
				} else {
					const browser = pickBrowser();
					if (!browser) {
						notes.push(
							"no supported browser found (firefox-esr/firefox/chromium/google-chrome); " +
								"start one with computer_app if needed",
						);
					} else if (!isTrackedProcess(adoptPidRecord(BROWSER_PID) ?? readPidRecord(BROWSER_PID))) {
						writePidRecord(BROWSER_PID, undefined);
						if (browser.kind === "firefox") seedFirefoxProfile();
						mkdirSync(BROWSER_PROFILE, { recursive: true });
						const spawned = spawnDetached(browser.path, browserArgs(browser), "browser.log");
						if (spawned.pid) writePidRecord(BROWSER_PID, spawned.pid);
						else notes.push(`failed to start browser ${browser.path}: ${spawned.error ?? "unknown error"}`);
					}
				}
			}
			return { notes };
		});
	} catch (e) {
		return { error: (e as Error).message, notes: [] };
	}
}

async function desktopStatus(signal?: AbortSignal): Promise<string> {
	ensureDir();
	const up = await displayUp(signal);
	const geometry = up ? await displayGeometry(signal) : undefined;
	const parts = [`display=${DISPLAY} ${up ? "UP" : "DOWN"}${geometry ? ` ${geometry.w}x${geometry.h}` : ""}`];
	parts.push(`managed=${readManaged() ? "yes" : "no"}`);
	for (const entry of [...TRACKED].reverse()) {
		const record = readPidRecord(entry.file);
		if (!record) {
			parts.push(`${entry.name}=off`);
			continue;
		}
		parts.push(
			`${entry.name}=${isTrackedProcess(record, entry.comm) ? `pid ${record.pid}` : `stale pid ${record.pid}`}`,
		);
	}
	return parts.join(" ");
}

/**
 * Stop only processes this extension started and still owns. A display started
 * elsewhere (another session, a systemd unit, bin/desktop.sh) is left alone.
 */
async function stopDesktop(): Promise<string> {
	ensureDir();
	try {
		const parts = await withLock(async () => {
			const stopped: string[] = [];
			const cleared: string[] = [];
			for (const entry of TRACKED) {
				const record = readPidRecord(entry.file);
				if (!record) continue;
				if (!isTrackedProcess(record, entry.comm)) {
					writePidRecord(entry.file, undefined);
					cleared.push(`${entry.name} (stale pid ${record.pid})`);
					continue;
				}
				try {
					process.kill(record.pid, "SIGTERM");
					stopped.push(`${entry.name} (pid ${record.pid})`);
				} catch {
					cleared.push(`${entry.name} (already gone)`);
				}
				writePidRecord(entry.file, undefined);
			}
			const managed = readManaged();
			if (managed) writeManaged(false);
			const out: string[] = [];
			out.push(stopped.length > 0 ? `stopped: ${stopped.join(", ")}` : "no tracked process to stop");
			if (cleared.length > 0) out.push(`cleared stale entries: ${cleared.join(", ")}`);
			if (!managed) out.push(`display ${DISPLAY} was not started by this extension; left running`);
			return out;
		});
		await delay(300);
		return parts.join("; ");
	} catch (e) {
		return `stop failed: ${(e as Error).message}`;
	}
}

interface Region {
	x: number;
	y: number;
	w: number;
	h: number;
}

/**
 * Reserve a fresh screenshot file name `YYYYMMDDHHMMSS_shot.png` inside
 * SHOTS_DIR. Screenshots are never overwritten: the file is created
 * exclusively (wx), so a same-second clash falls back to `_shot-2.png`,
 * `_shot-3.png`, ... even with concurrent captures.
 */
function reserveShotPath(): string {
	mkdirSync(SHOTS_DIR, { recursive: true });
	const now = new Date();
	const p2 = (n: number) => String(n).padStart(2, "0");
	const stamp =
		`${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}` +
		`${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`;
	for (let n = 1; n <= 9999; n++) {
		const name = `${stamp}_shot${n === 1 ? "" : `-${n}`}.png`;
		const file = path.join(SHOTS_DIR, name);
		try {
			closeSync(openSync(file, "wx"));
			return file;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
		}
	}
	throw new Error(`no free screenshot name for ${stamp} in ${SHOTS_DIR}`);
}

function shotsKeepLimit(): number {
	const value = Number(process.env.PI_COMPUTER_USE_SHOTS_KEEP ?? 100);
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function pruneShots(): void {
	const keep = shotsKeepLimit();
	if (!keep) return;
	try {
		const names = readdirSync(SHOTS_DIR).filter((name) => name.endsWith(".png"));
		if (names.length <= keep) return;
		const entries = names.map((name) => {
			try {
				return { name, at: statSync(path.join(SHOTS_DIR, name)).mtimeMs };
			} catch {
				return { name, at: 0 };
			}
		});
		entries.sort((a, b) => b.at - a.at);
		for (const entry of entries.slice(keep)) {
			try {
				unlinkSync(path.join(SHOTS_DIR, entry.name));
			} catch {
				/* ignore */
			}
		}
	} catch {
		/* ignore */
	}
}

type TextContent = { type: "text"; text: string };
type ImageContent = { type: "image"; data: string; mimeType: string };
type ToolContent = TextContent | ImageContent;

interface ToolReturn {
	content: ToolContent[];
	details: Record<string, unknown>;
	isError?: boolean;
}

interface ShotResult {
	content: ToolContent[];
	path: string;
	bytes: number;
	label: string;
}

async function screenshot(region: Region | undefined, signal?: AbortSignal): Promise<ShotResult | { error: string }> {
	if (!(await displayUp(signal))) {
		return { error: "virtual display is down; run computer_desktop action=start first" };
	}
	const imp = importCommand();
	if (!imp) return { error: "ImageMagick import not found" };
	const shotPath = reserveShotPath();
	const args = [...imp.prefix, "-window", "root"];
	if (region) args.push("-crop", `${region.w}x${region.h}+${region.x}+${region.y}`, "+repage");
	args.push(shotPath);
	const r = await xexec(imp.cmd, args, { timeoutMs: 20000, signal });
	if (r.code !== 0) {
		try {
			unlinkSync(shotPath);
		} catch {
			/* ignore */
		}
		return { error: `screenshot failed: ${r.stderr || r.stdout}` };
	}
	const data = readFileSync(shotPath);
	pruneShots();
	const geometry = await displayGeometry(signal);
	const label = region
		? `region x=${region.x} y=${region.y} w=${region.w} h=${region.h}`
		: `full screen ${geometry?.w ?? SCREEN.w}x${geometry?.h ?? SCREEN.h}`;
	return {
		content: [
			{ type: "text", text: `Virtual desktop screenshot (${label}).` },
			{ type: "image", data: data.toString("base64"), mimeType: "image/png" },
		],
		path: shotPath,
		bytes: data.length,
		label,
	};
}

function textResult(text: string, notes: string[] = []): ToolReturn {
	return {
		content: [{ type: "text", text }],
		details: { display: DISPLAY, ...(notes.length > 0 ? { notes } : {}) },
	};
}

function errorResult(text: string, notes: string[] = []): ToolReturn {
	return { content: [{ type: "text", text: `Error: ${text}` }], details: { display: DISPLAY, ...(notes.length > 0 ? { notes } : {}) }, isError: true };
}

function execFailure(prefix: string, r: ExecResult): ToolReturn {
	return errorResult(`${prefix}: ${r.stderr || r.stdout || `exit ${r.code}`}`);
}

function requireBin(get: () => string | undefined, name: string): string | ToolReturn {
	const bin = get();
	if (bin) return bin;
	return errorResult(`${name} is not installed — ${INSTALL_HINT}`);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function computerUseExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "computer_screen",
		label: "Computer Screen",
		description:
			`Screenshot of the dedicated virtual desktop (a separate Xvfb display ${DISPLAY}, isolated from the real desktop). ` +
			"The captured image is shown to the user automatically in the conversation and kept on disk as shots/YYYYMMDDHHMMSS_shot.png (never overwritten). " +
			"Use an optional region to zoom into an area. " +
			SCREEN_HINT,
		promptSnippet: "Screenshot of the isolated virtual desktop (computer use)",
		executionMode: "sequential",
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
		async execute(_id, p, signal) {
			const desktop = await ensureDesktop(signal);
			if (desktop.error) return errorResult(desktop.error, desktop.notes);
			const region = p.region;
			if (region && (!(region.w > 0) || !(region.h > 0) || region.x < 0 || region.y < 0)) {
				return errorResult("region needs x,y >= 0 and w,h > 0", desktop.notes);
			}
			const shot = await screenshot(region, signal);
			if ("error" in shot) return errorResult(shot.error, desktop.notes);
			return {
				content: shot.content,
				details: {
					display: DISPLAY,
					path: shot.path,
					bytes: shot.bytes,
					...(desktop.notes.length > 0 ? { notes: desktop.notes } : {}),
				},
			};
		},
	});

	pi.registerTool({
		name: "computer_click",
		label: "Computer Click",
		description:
			`Click at (x, y) on the virtual desktop ${DISPLAY}. Supports right/middle button and double/triple click. ` +
			SCREEN_HINT,
		promptSnippet: "Click on the virtual desktop",
		executionMode: "sequential",
		parameters: Type.Object({
			x: Type.Number({ description: "X coordinate (0-1919)" }),
			y: Type.Number({ description: "Y coordinate (0-1079)" }),
			button: Type.Optional(
				Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")], {
					description: "Mouse button (default left)",
				}),
			),
			clicks: Type.Optional(Type.Number({ description: "1=single (default), 2=double, 3=triple" })),
		}),
		async execute(_id, p, signal) {
			const desktop = await ensureDesktop(signal);
			if (desktop.error) return errorResult(desktop.error, desktop.notes);
			const xdotool = requireBin(xdotoolBin, "xdotool");
			if (typeof xdotool !== "string") return xdotool;
			const x = Math.round(p.x);
			const y = Math.round(p.y);
			const clicks = Math.max(1, Math.min(10, Math.round(p.clicks ?? 1)));
			const button = p.button === "right" ? "3" : p.button === "middle" ? "2" : "1";
			const move = await xexec(xdotool, ["mousemove", String(x), String(y)], { signal });
			if (move.code !== 0) return execFailure("click failed", move);
			const r = await xexec(xdotool, ["click", "--repeat", String(clicks), button], { signal });
			if (r.code !== 0) return execFailure("click failed", r);
			return textResult(
				`clicked (${x},${y})${p.button ? ` ${p.button}` : ""}${clicks > 1 ? ` x${clicks}` : ""}`,
				desktop.notes,
			);
		},
	});

	pi.registerTool({
		name: "computer_drag",
		label: "Computer Drag",
		description:
			`Drag from (x1,y1) to (x2,y2) on the virtual desktop ${DISPLAY} with a mouse button. ` +
			"Use for moving items, sliders, text selection.",
		promptSnippet: "Drag on the virtual desktop",
		executionMode: "sequential",
		parameters: Type.Object({
			x1: Type.Number({ description: "Start X" }),
			y1: Type.Number({ description: "Start Y" }),
			x2: Type.Number({ description: "End X" }),
			y2: Type.Number({ description: "End Y" }),
			button: Type.Optional(
				Type.Union([Type.Literal("left"), Type.Literal("right"), Type.Literal("middle")], {
					description: "Mouse button (default left)",
				}),
			),
		}),
		async execute(_id, p, signal) {
			const desktop = await ensureDesktop(signal);
			if (desktop.error) return errorResult(desktop.error, desktop.notes);
			const xdotool = requireBin(xdotoolBin, "xdotool");
			if (typeof xdotool !== "string") return xdotool;
			const x1 = Math.round(p.x1);
			const y1 = Math.round(p.y1);
			const x2 = Math.round(p.x2);
			const y2 = Math.round(p.y2);
			const button = p.button === "right" ? "3" : p.button === "middle" ? "2" : "1";
			const steps = 8;
			let last = await xexec(xdotool, ["mousemove", String(x1), String(y1)], { signal });
			if (last.code !== 0) return execFailure("drag failed", last);
			last = await xexec(xdotool, ["mousedown", button], { signal });
			if (last.code !== 0) return execFailure("drag failed", last);
			try {
				for (let i = 1; i <= steps; i++) {
					const x = Math.round(x1 + ((x2 - x1) * i) / steps);
					const y = Math.round(y1 + ((y2 - y1) * i) / steps);
					last = await xexec(xdotool, ["mousemove", String(x), String(y)], { signal });
					if (last.code !== 0) break;
					await delay(10);
				}
			} finally {
				await xexec(xdotool, ["mouseup", button], { signal });
			}
			if (last.code !== 0) return execFailure("drag failed", last);
			return textResult(`dragged (${x1},${y1}) -> (${x2},${y2})`, desktop.notes);
		},
	});

	pi.registerTool({
		name: "computer_type",
		label: "Computer Type",
		description:
			`Type text into the currently focused window on the virtual desktop ${DISPLAY}. ` +
			"Newlines are typed as Enter (one keypress per line). Make sure the target input has focus (click it first).",
		promptSnippet: "Type text on the virtual desktop",
		executionMode: "sequential",
		parameters: Type.Object({
			text: Type.String({ description: "Text to type" }),
			delay_ms: Type.Optional(Type.Number({ description: "Delay between keystrokes in ms (default 20)" })),
		}),
		async execute(_id, p, signal) {
			const desktop = await ensureDesktop(signal);
			if (desktop.error) return errorResult(desktop.error, desktop.notes);
			const xdotool = requireBin(xdotoolBin, "xdotool");
			if (typeof xdotool !== "string") return xdotool;
			const delayMs = Math.max(0, Math.min(1000, Math.round(p.delay_ms ?? 20)));
			// `--file -` takes the text from stdin, so leading dashes and argument
			// length cannot be mistaken for xdotool options. xdotool drops literal
			// newlines, so each line is typed and Return is pressed in between.
			const lines = p.text.split(/\r?\n/);
			let typed = 0;
			for (let i = 0; i < lines.length; i++) {
				if (i > 0) {
					const enter = await xexec(xdotool, ["key", "--clearmodifiers", "Return"], { signal });
					if (enter.code !== 0) return execFailure("type failed", enter);
				}
				const line = lines[i] ?? "";
				if (line.length === 0) continue;
				const r = await xexec(
					xdotool,
					["type", "--clearmodifiers", "--delay", String(delayMs), "--file", "-"],
					{ timeoutMs: 60000, signal, input: line },
				);
				if (r.code !== 0) return execFailure("type failed", r);
				typed += line.length;
			}
			return textResult(`typed ${typed} char(s)`, desktop.notes);
		},
	});

	pi.registerTool({
		name: "computer_key",
		label: "Computer Key",
		description:
			`Press a key or hotkey on the virtual desktop ${DISPLAY}, e.g. "Return", "Tab", "ctrl+s", "alt+Tab", "ctrl+shift+t".`,
		promptSnippet: "Key / hotkey on the virtual desktop",
		executionMode: "sequential",
		parameters: Type.Object({
			keys: Type.String({ description: 'Key sequence, e.g. "ctrl+s" or "Return"' }),
		}),
		async execute(_id, p, signal) {
			const desktop = await ensureDesktop(signal);
			if (desktop.error) return errorResult(desktop.error, desktop.notes);
			const xdotool = requireBin(xdotoolBin, "xdotool");
			if (typeof xdotool !== "string") return xdotool;
			const r = await xexec(xdotool, ["key", "--clearmodifiers", p.keys], { signal });
			if (r.code !== 0) return execFailure("key failed", r);
			return textResult(`pressed ${p.keys}`, desktop.notes);
		},
	});

	pi.registerTool({
		name: "computer_scroll",
		label: "Computer Scroll",
		description:
			`Scroll at position (x, y) on the virtual desktop ${DISPLAY}. ` +
			"Moves the mouse wheel (one notch per ~120 amount); horizontal uses buttons 6/7.",
		promptSnippet: "Scroll on the virtual desktop",
		executionMode: "sequential",
		parameters: Type.Object({
			x: Type.Number({ description: "X coordinate" }),
			y: Type.Number({ description: "Y coordinate" }),
			direction: Type.Union(
				[Type.Literal("up"), Type.Literal("down"), Type.Literal("left"), Type.Literal("right")],
				{ description: "Scroll direction" },
			),
			amount: Type.Optional(Type.Number({ description: "Scroll distance (default 240; ~120 per wheel notch)" })),
		}),
		async execute(_id, p, signal) {
			const desktop = await ensureDesktop(signal);
			if (desktop.error) return errorResult(desktop.error, desktop.notes);
			const xdotool = requireBin(xdotoolBin, "xdotool");
			if (typeof xdotool !== "string") return xdotool;
			const notches = Math.max(1, Math.min(50, Math.round((p.amount ?? 240) / 120)));
			const button = p.direction === "up" ? "4" : p.direction === "down" ? "5" : p.direction === "left" ? "6" : "7";
			const move = await xexec(xdotool, ["mousemove", String(Math.round(p.x)), String(Math.round(p.y))], { signal });
			if (move.code !== 0) return execFailure("scroll failed", move);
			const r = await xexec(xdotool, ["click", "--repeat", String(notches), button], { signal });
			if (r.code !== 0) return execFailure("scroll failed", r);
			return textResult(`scrolled ${p.direction} ${notches} notch(es)`, desktop.notes);
		},
	});

	pi.registerTool({
		name: "computer_window",
		label: "Computer Window",
		description:
			`Window manager for the virtual desktop ${DISPLAY} (via wmctrl). action=list shows all windows with titles; ` +
			"focus/close/maximize/minimize/move/resize target a window by title substring or numeric/0x window id.",
		promptSnippet: "Window management on the virtual desktop",
		executionMode: "sequential",
		parameters: Type.Object({
			action: Type.Union(
				[
					Type.Literal("list"),
					Type.Literal("focus"),
					Type.Literal("close"),
					Type.Literal("maximize"),
					Type.Literal("minimize"),
					Type.Literal("move"),
					Type.Literal("resize"),
				],
				{ description: "Window action" },
			),
			target: Type.Optional(
				Type.String({ description: "Window title substring or numeric/0x window id (required except list)" }),
			),
			x: Type.Optional(Type.Number({ description: "move: new X" })),
			y: Type.Optional(Type.Number({ description: "move: new Y" })),
			w: Type.Optional(Type.Number({ description: "resize: new width" })),
			h: Type.Optional(Type.Number({ description: "resize: new height" })),
		}),
		async execute(_id, p, signal) {
			const desktop = await ensureDesktop(signal);
			if (desktop.error) return errorResult(desktop.error, desktop.notes);
			const wmctrl = requireBin(wmctrlBin, "wmctrl");
			if (typeof wmctrl !== "string") return wmctrl;
			if (p.action === "list") {
				const r = await xexec(wmctrl, ["-l"], { signal });
				if (r.code !== 0) return execFailure("wmctrl list failed", r);
				return textResult(r.stdout || "(no windows)", desktop.notes);
			}
			if (!p.target) return errorResult("target is required for this action", desktop.notes);
			const target = p.target;
			const isId = /^0x[0-9a-f]+$/i.test(target) || /^\d+$/.test(target);
			let args: string[];
			switch (p.action) {
				case "focus":
					args = isId ? ["-ia", target] : ["-a", target];
					break;
				case "close":
					args = isId ? ["-ic", target] : ["-c", target];
					break;
				case "maximize":
				case "minimize": {
					const base = isId ? ["-i", "-r", target] : ["-r", target];
					const state = p.action === "maximize" ? "add,maximized_vert,maximized_horz" : "add,hidden";
					args = [...base, "-b", state];
					break;
				}
				case "move":
					if (p.x == null || p.y == null) return errorResult("move needs x and y", desktop.notes);
					args = [...(isId ? ["-i", "-r", target] : ["-r", target]), "-e", `0,${Math.round(p.x)},${Math.round(p.y)},-1,-1`];
					break;
				case "resize":
					if (p.w == null || p.h == null) return errorResult("resize needs w and h", desktop.notes);
					args = [...(isId ? ["-i", "-r", target] : ["-r", target]), "-e", `0,-1,-1,${Math.round(p.w)},${Math.round(p.h)}`];
					break;
				default:
					return errorResult(`unknown action ${String(p.action)}`, desktop.notes);
			}
			const r = await xexec(wmctrl, args, { signal });
			if (r.code !== 0) return execFailure(`wmctrl ${p.action} failed`, r);
			return textResult(`window ${p.action} ok (${target})`, desktop.notes);
		},
	});

	pi.registerTool({
		name: "computer_app",
		label: "Computer App",
		description:
			`Launch an app (or open a URL) inside the virtual desktop ${DISPLAY}, e.g. "firefox-esr https://example.com", "xterm", "gimp". ` +
			"Runs detached in the background; returns the pid. The browser profile lives in the extension state directory.",
		promptSnippet: "Launch an app / URL on the virtual desktop",
		executionMode: "sequential",
		parameters: Type.Object({
			command: Type.String({ description: 'Command line to run, e.g. "firefox https://example.com"' }),
		}),
		async execute(_id, p, signal) {
			const desktop = await ensureDesktop(signal);
			if (desktop.error) return errorResult(desktop.error, desktop.notes);
			ensureDir();
			const logPath = path.join(LOG_DIR, "app.log");
			let fd: number;
			try {
				fd = openSync(logPath, "a");
			} catch (e) {
				return errorResult(`cannot open ${logPath}: ${(e as Error).message}`, desktop.notes);
			}
			try {
				const child = spawn(p.command, {
					shell: true,
					detached: true,
					stdio: ["ignore", fd, fd],
					env: { ...process.env, DISPLAY },
				});
				child.on("error", (e) => {
					try {
						appendFileSync(logPath, `spawn error: ${e.message}\n`);
					} catch {
						/* ignore */
					}
				});
				child.unref();
				if (!child.pid) return errorResult(`failed to launch "${p.command}"`, desktop.notes);
				return textResult(`launched "${p.command}" (pid ${child.pid}, logs at ${logPath})`, desktop.notes);
			} finally {
				closeSync(fd);
			}
		},
	});

	pi.registerTool({
		name: "computer_desktop",
		label: "Computer Desktop",
		description:
			`Control the virtual desktop itself on display ${DISPLAY}: start (auto by default), stop, or status. ` +
			"stop only terminates processes this extension started; a display owned by another tool is left running.",
		promptSnippet: "Start/stop/status the virtual desktop",
		executionMode: "sequential",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("start"), Type.Literal("stop"), Type.Literal("status")], {
				description: "Desktop action",
			}),
		}),
		async execute(_id, p, signal) {
			if (p.action === "status") return textResult(await desktopStatus(signal));
			if (p.action === "stop") return textResult(`${await stopDesktop()} — ${await desktopStatus(signal)}`);
			const desktop = await ensureDesktop(signal);
			if (desktop.error) return errorResult(`start failed: ${desktop.error}`, desktop.notes);
			return textResult(`started — ${await desktopStatus(signal)}`, desktop.notes);
		},
	});

	pi.on("session_shutdown", async () => {
		if (!readManaged()) return;
		await stopDesktop();
	});

	// Convenience slash command for manual control.
	pi.registerCommand("computer", {
		description: "Virtual desktop: /computer status|start|stop|shot",
		handler: async (args, ctx) => {
			const [cmd] = String(args ?? "status").trim().split(/\s+/);
			let out: string;
			let failed = false;
			if (cmd === "stop") {
				out = `${await stopDesktop()} — ${await desktopStatus()}`;
			} else if (cmd === "start") {
				const desktop = await ensureDesktop();
				failed = Boolean(desktop.error);
				out = desktop.error ? `start failed: ${desktop.error}` : `started — ${await desktopStatus()}`;
			} else if (cmd === "shot") {
				const desktop = await ensureDesktop();
				if (desktop.error) {
					out = desktop.error;
					failed = true;
				} else {
					const shot = await screenshot(undefined);
					failed = "error" in shot;
					out = "error" in shot ? shot.error : `saved to ${shot.path} (${Math.round(shot.bytes / 1024)} KB)`;
				}
			} else {
				out = await desktopStatus();
			}
			if (ctx.hasUI) ctx.ui.notify(out, failed ? "error" : "info");
		},
	});
}
