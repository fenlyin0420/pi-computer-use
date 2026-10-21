#!/usr/bin/env bash
# pi-computer-use: supervisor for the dedicated Xvfb virtual desktop.
#
#   desktop.sh start    start Xvfb + openbox + browser (if not running)
#   desktop.sh stop     stop what this script started
#   desktop.sh status   show state
#   desktop.sh shot [f] screenshot to [f] (default <state>/shots/<ts>_shot.png)
#
# State layout matches the extension: <state-root>/display-<n>/ with JSON pid
# files ({pid, comm, start}), so desktop.sh and pi agree on what is running.
#
# Env: PI_COMPUTER_USE_DISPLAY (default 99), PI_COMPUTER_USE_SCREEN (default
#      1920x1080x24), PI_COMPUTER_USE_STATE_DIR (default ~/.pi/computer-use),
#      PI_COMPUTER_USE_BROWSER, PI_COMPUTER_USE_NO_BROWSER=1,
#      PI_COMPUTER_USE_WALLPAPER, PI_COMPUTER_USE_{XVFB,OPENBOX,XDOTOOL,WMCTRL,FEH,IMPORT}
set -euo pipefail

DISPLAY_ID="${PI_COMPUTER_USE_DISPLAY:-99}"
DISPLAY_ID="${DISPLAY_ID#:}"
DISPLAY=":$DISPLAY_ID"
STATE_ROOT="${PI_COMPUTER_USE_STATE_DIR:-$HOME/.pi/computer-use}"
STATE="$STATE_ROOT/display-$DISPLAY_ID"
LOGS="$STATE/logs"
SHOTS="$STATE/shots"
PROFILE="$STATE/browser-profile"
SCREEN="${PI_COMPUTER_USE_SCREEN:-1920x1080x24}"
mkdir -p "$LOGS" "$SHOTS"

bin() { # bin <env-suffix> <default>...
  local suffix="$1"; shift
  local var="PI_COMPUTER_USE_${suffix}"
  local override="${!var:-}"
  if [[ -n "$override" ]]; then
    local first="${override%% *}"
    command -v "$first" >/dev/null 2>&1 && { echo "$override"; return 0; }
    return 1
  fi
  local candidate
  for candidate in "$@"; do command -v "$candidate" >/dev/null 2>&1 && { echo "$candidate"; return 0; }; done
  return 1
}

XVFB="$(bin XVFB Xvfb)" || XVFB=""
OPENBOX="$(bin OPENBOX openbox)" || OPENBOX=""
XDOTOOL="$(bin XDOTOOL xdotool)" || XDOTOOL=""
WMCTRL="$(bin WMCTRL wmctrl)" || WMCTRL=""
FEH="$(bin FEH feh)" || FEH=""
IMPORT="$(bin IMPORT import)" || { command -v magick >/dev/null 2>&1 && IMPORT="magick import"; } || IMPORT=""

pick_browser() {
  [[ "${PI_COMPUTER_USE_NO_BROWSER:-}" == "1" ]] && return 1
  case "${PI_COMPUTER_USE_BROWSER:-}" in
    "" ) ;;
    none|off|0) return 1 ;;
    * ) command -v "${PI_COMPUTER_USE_BROWSER%% *}" >/dev/null 2>&1 && { echo "$PI_COMPUTER_USE_BROWSER"; return 0; }; return 1 ;;
  esac
  local candidate
  for candidate in firefox-esr firefox google-chrome google-chrome-stable chromium chromium-browser microsoft-edge brave-browser; do
    command -v "$candidate" >/dev/null 2>&1 && { echo "$candidate"; return 0; }
  done
  return 1
}

pid_of() { # pid_of <pidfile>
  local raw
  raw="$(cat "$1" 2>/dev/null)" || return 1
  [[ -z "$raw" ]] && return 1
  if [[ "$raw" =~ ^[0-9]+$ ]]; then echo "$raw"
  else sed -n 's/.*"pid":[[:space:]]*\([0-9]\+\).*/\1/p' <<<"$raw"
  fi
}

comm_of_pidfile() {
  local raw
  raw="$(cat "$1" 2>/dev/null)" || return 1
  sed -n 's/.*"comm":[[:space:]]*"\([^"]*\)".*/\1/p' <<<"$raw"
}

comm_of_pid() { cat "/proc/$1/comm" 2>/dev/null || true; }
start_of_pid() { awk '{print $22}' "/proc/$1/stat" 2>/dev/null || true; }

write_pid() { # write_pid <pidfile> <pid|"">
  if [[ -z "${2:-}" ]]; then : >"$1"; return 0; fi
  printf '{"pid":%s,"comm":"%s","start":"%s"}\n' "$2" "$(comm_of_pid "$2")" "$(start_of_pid "$2")" >"$1"
}

recorded_start() {
  sed -n 's/.*"start":[[:space:]]*"\([^"]*\)".*/\1/p' <<<"$(cat "$1" 2>/dev/null)"
}

alive_ours() { # alive_ours <pidfile> <expected-comm>
  local pid comm expected recorded start
  pid="$(pid_of "$1")" || return 1
  [[ -z "$pid" ]] && return 1
  expected="$2"
  comm="$(comm_of_pid "$pid")"
  [[ -z "$comm" ]] && return 1
  [[ "$comm" == "$expected" ]] || return 1
  recorded="$(recorded_start "$1")"
  [[ -z "$recorded" ]] && return 0
  start="$(start_of_pid "$pid")"
  [[ "$start" == "$recorded" ]]
}

alive_any() { # alive_any <pidfile>: pid must match the comm/start recorded at spawn
  local pid comm recorded start
  pid="$(pid_of "$1")" || return 1
  [[ -z "$pid" ]] && return 1
  comm="$(comm_of_pid "$pid")"
  recorded="$(comm_of_pidfile "$1")"
  [[ -z "$comm" || -z "$recorded" || "$comm" != "$recorded" ]] && return 1
  start="$(recorded_start "$1")"
  [[ -n "$start" && "$(start_of_pid "$pid")" != "$start" ]] && return 1
  return 0
}

up() { [[ -n "$XDOTOOL" ]] && DISPLAY="$DISPLAY" "$XDOTOOL" getmouselocation >/dev/null 2>&1; }

browser_args() {
  case "$1" in
    firefox*) echo "-no-remote -profile $PROFILE" ;;
    *) echo "--user-data-dir $PROFILE --no-first-run --no-default-browser-check" ;;
  esac
}

seed_profile() {
  [[ -f "$PROFILE/user.js" ]] && return 0
  mkdir -p "$PROFILE"
  cat >"$PROFILE/user.js" <<'EOF'
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("browser.startup.homepage_override.migration", true);
user_pref("startup.homepage_override.url", "about:blank");
user_pref("startup.homepage_welcome_panel.shown", true);
user_pref("startup.homepage_welcome_panel.additional_browses", true);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("datareporting.policy.dataCollectionEnabled", false);
user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);
user_pref("toolkit.telemetry.unified", false);
user_pref("toolkit.telemetry.enabled", false);
user_pref("browser.tabs.warnAboutClosedTabs", false);
user_pref("browser.link.open_external_overflow_in_new_tab", true);
EOF
}

requirements() {
  local missing=()
  [[ -n "$XVFB" ]] || missing+=("Xvfb")
  [[ -n "$OPENBOX" ]] || missing+=("openbox")
  [[ -n "$XDOTOOL" ]] || missing+=("xdotool")
  [[ -n "$WMCTRL" ]] || missing+=("wmctrl")
  [[ -n "$IMPORT" ]] || missing+=("ImageMagick (import)")
  if [[ ${#missing[@]} -gt 0 ]]; then
    printf 'missing required host tools: %s\n' "${missing[*]}" >&2
    echo "Ubuntu/Debian: sudo apt install xvfb openbox xdotool wmctrl imagemagick" >&2
    echo "Fedora: sudo dnf install xorg-x11-server-Xvfb openbox xdotool wmctrl ImageMagick" >&2
    echo "Arch: sudo pacman -S xorg-server-xvfb openbox xdotool wmctrl imagemagick" >&2
    exit 1
  fi
}

start() {
  requirements
  if ! up; then
    # shellcheck disable=SC2086
    DISPLAY="$DISPLAY" "$XVFB" "$DISPLAY" -screen 0 "$SCREEN" -nolisten tcp -ac >>"$LOGS/xvfb.log" 2>&1 &
    write_pid "$STATE/xvfb.pid" "$!"
    printf '{"display":"%s","pid":%s,"at":%s}\n' "$DISPLAY" "$$" "$(date +%s)" >"$STATE/managed.json"
    local i
    for ((i = 0; i < 40; i++)); do up && break; sleep 0.2; done
    up || { echo "Xvfb failed to start; see $LOGS/xvfb.log" >&2; exit 1; }
  fi
  if ! alive_ours "$STATE/openbox.pid" openbox; then
    DISPLAY="$DISPLAY" "$OPENBOX" >>"$LOGS/openbox.log" 2>&1 &
    write_pid "$STATE/openbox.pid" "$!"
    sleep 0.5
  fi
  if [[ -n "${PI_COMPUTER_USE_WALLPAPER:-}" && -f "${PI_COMPUTER_USE_WALLPAPER}" ]]; then
    if [[ -z "$FEH" ]]; then
      echo "PI_COMPUTER_USE_WALLPAPER is set but feh is not installed; skipping wallpaper" >&2
    elif ! alive_ours "$STATE/feh.pid" feh; then
      DISPLAY="$DISPLAY" "$FEH" --bg-scale "$PI_COMPUTER_USE_WALLPAPER" >>"$LOGS/feh.log" 2>&1 &
      write_pid "$STATE/feh.pid" "$!"
    fi
  fi
  local browser
  if browser="$(pick_browser)"; then
    if ! alive_any "$STATE/browser.pid"; then
      [[ "$browser" == firefox* ]] && seed_profile
      mkdir -p "$PROFILE"
      # shellcheck disable=SC2086
      DISPLAY="$DISPLAY" "$browser" $(browser_args "$browser") >>"$LOGS/browser.log" 2>&1 &
      write_pid "$STATE/browser.pid" "$!"
    fi
  fi
  echo "started on $DISPLAY — $(status)"
}

stop() {
  local stopped=0 cleared=0 entry pid comm expected
  for entry in "browser.pid:" "feh.pid:feh" "openbox.pid:openbox" "xvfb.pid:Xvfb"; do
    local file="$STATE/${entry%%:*}" expected="${entry#*:}"
    [[ -f "$file" ]] || continue
    pid="$(pid_of "$file" || true)"
    comm="$(comm_of_pid "${pid:-0}")"
    if [[ -z "$pid" || -z "$comm" ]]; then
      : >"$file"; cleared=$((cleared + 1)); continue
    fi
    if [[ -z "$expected" ]]; then
      # browser: accept whatever comm the recorded pid had
      expected="$(comm_of_pidfile "$file")"
      [[ -z "$expected" ]] && { : >"$file"; cleared=$((cleared + 1)); continue; }
    fi
    if [[ "$comm" != "$expected" ]] || ! alive_ours "$file" "$expected"; then
      : >"$file"; cleared=$((cleared + 1)); continue
    fi
    kill "$pid" 2>/dev/null && stopped=$((stopped + 1))
    : >"$file"
  done
  local managed=no
  [[ -f "$STATE/managed.json" ]] && managed=yes
  rm -f "$STATE/managed.json"
  echo "stopped $stopped process(es), cleared $cleared stale entr(ies), managed=$managed"
  [[ "$managed" == "no" ]] && echo "display $DISPLAY was not started by this script; left running"
  return 0
}

status() {
  printf 'display=%s %s xvfb=%s openbox=%s browser=%s managed=%s\n' \
    "$DISPLAY" \
    "$(up && echo UP || echo DOWN)" \
    "$(alive_ours "$STATE/xvfb.pid" Xvfb && echo "on ($(pid_of "$STATE/xvfb.pid"))" || echo off)" \
    "$(alive_ours "$STATE/openbox.pid" openbox && echo "on ($(pid_of "$STATE/openbox.pid"))" || echo off)" \
    "$(alive_any "$STATE/browser.pid" && echo "on ($(pid_of "$STATE/browser.pid"))" || echo off)" \
    "$([[ -f "$STATE/managed.json" ]] && echo yes || echo no)"
}

shot() {
  local out
  if [[ $# -gt 0 ]]; then
    out="$1"
  else
    local stamp n
    stamp=$(date +%Y%m%d%H%M%S)
    n=1
    out="$SHOTS/${stamp}_shot.png"
    while [[ -e "$out" ]]; do n=$((n + 1)); out="$SHOTS/${stamp}_shot-$n.png"; done
  fi
  requirements
  # shellcheck disable=SC2086
  DISPLAY="$DISPLAY" $IMPORT -window root "$out" && echo "$out"
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  shot) shift; shot "$@" ;;
  *) echo "usage: desktop.sh start|stop|status|shot [file]" >&2; exit 2 ;;
esac
