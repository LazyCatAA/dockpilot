#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${DOCKPILOT_DATA:-$ROOT/data}"
PID_FILE="$DATA_DIR/dockpilot.pid"

if [[ ! -f "$PID_FILE" ]]; then
  echo "DockPilot is not running from this local deployment."
  exit 0
fi

PID="$(cat "$PID_FILE" || true)"
if [[ -z "${PID:-}" ]]; then
  rm -f "$PID_FILE"
  echo "DockPilot is not running."
  exit 0
fi

if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  for _ in {1..30}; do
    if ! kill -0 "$PID" 2>/dev/null; then
      break
    fi
    sleep 0.1
  done
fi

rm -f "$PID_FILE"
echo "DockPilot stopped."
