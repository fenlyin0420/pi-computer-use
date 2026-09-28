#!/usr/bin/env bash
# pi-computer-use: supervisor for the dedicated Xvfb virtual desktop.
#
#   desktop.sh start    start Xvfb + openbox + firefox (if not running)
#   desktop.sh stop     stop everything
#   desktop.sh status   show state
#   desktop.sh shot [f] screenshot to [f] (default ~/.pi/computer-use/shot.png)
#
# Env: PI_COMPUTER_USE_DISPLAY (default 99)
set -euo pipefail

DISPLAY_ID="${PI_COMPUTER_USE_DISPLAY:-99}"
DISPLAY=":$DISPLAY_ID"
STATE="$HOME/.pi/computer-use"
LOGS="$STATE/logs"
PROFILE="$STATE/firefox-profile"
mkdir -p "$LOGS"

up() { DISPLAY="$DISPLAY" xdotool getmouselocation >/dev/null 2>&1; }

pid_alive() { [[ -n "${1:-}" ]] && kill -0 "$1" 2>/dev/null; }

# Snap Firefox is confined and misbehaves with custom profiles; prefer the
# classic firefox-esr, then snap firefox, then Chrome. Override: PI_COMPUTER_USE_BROWSER
pick_browser() {
  if [[ -n "${PI_COMPUTER_USE_BROWSER:-}" ]]; then echo "$PI_COMPUTER_USE_BROWSER"; return; fi
  for c in firefox-esr firefox google-chrome; do command -v "$c" >/dev/null && { echo "$c"; return; }; done
  echo firefox-esr
}

browser_args() {
  case "$1" in
    google-chrome|chromium*) echo "--user-data-dir $PROFILE --no-first-run --no-default-browser-check" ;;
    *) echo "-no-remote -profile $PROFILE" ;;
  esac
}

start() {
  if ! up; then
    Xvfb "$DISPLAY" -screen 0 1920x1080x24 -nolisten tcp -ac >>"$LOGS/xvfb.log" 2>&1 &
    echo $! > "$STATE/xvfb.pid"
    for _ in $(seq 1 24); do up && break; sleep 0.25; done
    up || { echo "Xvfb failed to start; see $LOGS/xvfb.log" >&2; exit 1; }
    openbox >>"$LOGS/openbox.log" 2>&1 &
    echo $! > "$STATE/openbox.pid"
    sleep 0.5
  fi
  local browser; browser=$(pick_browser)
  local bpid; bpid=$(cat "$STATE/browser.pid" 2>/dev/null || true)
  if ! pid_alive "$bpid"; then
    if [[ "$browser" == firefox* ]]; then
      [ -f "$PROFILE/user.js" ] || {
        mkdir -p "$PROFILE"
        cat > "$PROFILE/user.js" <<'EOF'
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("browser.startup.homepage_override.migration", true);
user_pref("startup.homepage_override.url", "about:blank");
user_pref("startup.homepage_welcome_panel.shown", true);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("datareporting.policy.dataCollectionEnabled", false);
user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);
user_pref("toolkit.telemetry.unified", false);
user_pref("toolkit.telemetry.enabled", false);
user_pref("browser.tabs.warnAboutClosedTabs", false);
EOF
      }
    fi
    # shellcheck disable=SC2086
    DISPLAY="$DISPLAY" $browser $(browser_args "$browser") >>"$LOGS/browser.log" 2>&1 &
    echo $! > "$STATE/browser.pid"
  fi
  echo "started on $DISPLAY — $(status)"
}

stop() {
  local stopped=0 f
  for f in browser.pid openbox.pid xvfb.pid; do
    local p; p=$(cat "$STATE/$f" 2>/dev/null || true)
    if pid_alive "$p"; then kill "$p" 2>/dev/null && stopped=$((stopped+1)); fi
    : > "$STATE/$f" 2>/dev/null || true
  done
  pkill -f "Xvfb $DISPLAY " 2>/dev/null || true
  echo "stopped $stopped process(es) — $(status)"
}

status() {
  printf 'display=%s %s xvfb=%s openbox=%s browser=%s\n' \
    "$DISPLAY" \
    "$(up && echo UP || echo DOWN)" \
    "$(pid_alive "$(cat "$STATE/xvfb.pid" 2>/dev/null)" && echo on || echo off)" \
    "$(pid_alive "$(cat "$STATE/openbox.pid" 2>/dev/null)" && echo on || echo off)" \
    "$(pid_alive "$(cat "$STATE/browser.pid" 2>/dev/null)" && echo on || echo off)"
}

shot() {
  local out="${1:-$STATE/shot.png}"
  DISPLAY="$DISPLAY" import -window root "$out" && echo "$out"
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  shot) shift; shot "$@" ;;
  *) echo "usage: desktop.sh start|stop|status|shot [file]" >&2; exit 2 ;;
esac
