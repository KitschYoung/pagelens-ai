#!/bin/bash
set -u

printf '\033]0;PageLens Log Bridge Stop\007'

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$ROOT_DIR/.pagelens_log_bridge.pid"
HOST="127.0.0.1"
PORT="8766"

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

PIDS=()

if [[ -f "$PID_FILE" ]]; then
    PID_FROM_FILE="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ -n "$PID_FROM_FILE" ]] && kill -0 "$PID_FROM_FILE" >/dev/null 2>&1; then
        PIDS+=("$PID_FROM_FILE")
    fi
fi

if command -v lsof >/dev/null 2>&1; then
    while IFS= read -r PID_FROM_PORT; do
        [[ -z "$PID_FROM_PORT" ]] && continue
        COMMAND_LINE="$(ps -p "$PID_FROM_PORT" -o command= 2>/dev/null || true)"
        if [[ "$COMMAND_LINE" == *"session_log_bridge.py"* ]]; then
            PIDS+=("$PID_FROM_PORT")
        fi
    done < <(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)
fi

if [[ "${#PIDS[@]}" -eq 0 ]]; then
    rm -f "$PID_FILE"
    notify "日志桥接未运行"
    exit 0
fi

UNIQUE_PIDS="$(printf "%s\n" "${PIDS[@]}" | sort -u)"
while IFS= read -r PID; do
    [[ -z "$PID" ]] && continue
    kill "$PID" >/dev/null 2>&1 || true
done <<< "$UNIQUE_PIDS"

sleep 0.5

while IFS= read -r PID; do
    [[ -z "$PID" ]] && continue
    if kill -0 "$PID" >/dev/null 2>&1; then
        kill -9 "$PID" >/dev/null 2>&1 || true
    fi
done <<< "$UNIQUE_PIDS"

rm -f "$PID_FILE"
notify "日志桥接已停止"
exit 0
