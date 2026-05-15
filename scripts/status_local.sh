#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${DOCKPILOT_HOST:-127.0.0.1}"
PORT="${DOCKPILOT_PORT:-8088}"
DATA_DIR="${DOCKPILOT_DATA:-$ROOT/data}"
PID_FILE="$DATA_DIR/dockpilot.pid"
LOG_FILE="$DATA_DIR/dockpilot.log"

if [[ -f "$PID_FILE" ]]; then
  PID="$(cat "$PID_FILE" || true)"
  if [[ -n "${PID:-}" ]] && kill -0 "$PID" 2>/dev/null; then
    echo "DockPilot is running."
    echo "URL: http://$HOST:$PORT"
    echo "PID: $PID"
    echo "Log: $LOG_FILE"
    exit 0
  fi
fi

echo "DockPilot is not running from this local deployment."
if command -v lsof >/dev/null 2>&1; then
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN || true
fi
