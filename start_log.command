#!/bin/bash
set -u

printf '\033]0;PageLens Log Bridge Start\007'

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
BRIDGE_SCRIPT="$ROOT_DIR/tools/session_log_bridge.py"
PID_FILE="$ROOT_DIR/.pagelens_log_bridge.pid"
LOG_FILE="$ROOT_DIR/.pagelens_log_bridge.log"
HOST="127.0.0.1"
PORT="8766"
HEALTH_URL="http://$HOST:$PORT/health"

close_terminal_window() {
    if [[ "${PAGELENS_KEEP_TERMINAL_OPEN:-}" == "1" ]]; then
        return
    fi

    (
        sleep 0.3
        osascript >/dev/null 2>&1 <<'APPLESCRIPT'
tell application "Terminal"
    repeat with w in windows
        if name of w contains "PageLens Log Bridge" then
            close w
            exit repeat
        end if
    end repeat
end tell
APPLESCRIPT
    ) &
}
trap close_terminal_window EXIT

notify() {
    osascript -e "display notification \"$1\" with title \"PageLens 日志桥接\"" >/dev/null 2>&1 || true
}

if [[ ! -f "$BRIDGE_SCRIPT" ]]; then
    notify "启动失败：找不到 tools/session_log_bridge.py"
    exit 1
fi

if command -v curl >/dev/null 2>&1 && curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    notify "日志桥接已在运行"
    exit 0
fi

if [[ -f "$PID_FILE" ]]; then
    OLD_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ -n "$OLD_PID" ]] && kill -0 "$OLD_PID" >/dev/null 2>&1; then
        notify "日志桥接进程已存在"
        exit 0
    fi
    rm -f "$PID_FILE"
fi

cd "$ROOT_DIR" || exit 1
nohup python3 "$BRIDGE_SCRIPT" --host "$HOST" --port "$PORT" >>"$LOG_FILE" 2>&1 &
BRIDGE_PID="$!"
echo "$BRIDGE_PID" > "$PID_FILE"

for _ in {1..30}; do
    if command -v curl >/dev/null 2>&1 && curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
        notify "日志桥接已启动：$HEALTH_URL"
        exit 0
    fi
    sleep 0.2
done

notify "启动失败：请查看 .pagelens_log_bridge.log"
exit 1
