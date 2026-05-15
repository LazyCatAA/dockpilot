#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${DOCKPILOT_HOST:-127.0.0.1}"
PORT="${DOCKPILOT_PORT:-8088}"
DATA_DIR="${DOCKPILOT_DATA:-$ROOT/data}"
PID_FILE="$DATA_DIR/dockpilot.pid"
LOG_FILE="$DATA_DIR/dockpilot.log"

mkdir -p "$DATA_DIR"

if [[ -f "$PID_FILE" ]]; then
  PID="$(cat "$PID_FILE" || true)"
  if [[ -n "${PID:-}" ]] && kill -0 "$PID" 2>/dev/null; then
    echo "DockPilot is already running: http://$HOST:$PORT"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $PORT is already in use. Stop the existing process first."
  exit 1
fi

(
  cd "$ROOT"
  DOCKPILOT_DATA="$DATA_DIR" python3 -m dockpilot.server --host "$HOST" --port "$PORT" >>"$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
)

sleep 0.5
PID="$(cat "$PID_FILE")"
if ! kill -0 "$PID" 2>/dev/null; then
  echo "DockPilot failed to start. See log: $LOG_FILE"
  exit 1
fi

echo "DockPilot started: http://$HOST:$PORT"
echo "PID: $PID"
echo "Log: $LOG_FILE"
