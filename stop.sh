#!/usr/bin/env bash
# X Demo -- stop script
# usage: bash stop.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

PID_FILE=".data/server.pid"
TIMEOUT=5

# -- read PID --
if [ ! -f "$PID_FILE" ]; then
  echo "PID file not found ($PID_FILE), service may not be running"
  _pid=$(pgrep -f "node server.js" 2>/dev/null | head -1 || true)
  if [ -n "$_pid" ]; then
    echo "  Found node server.js (PID=$_pid), stopping..."
    kill "$_pid" 2>/dev/null || true
    sleep 1
    if kill -0 "$_pid" 2>/dev/null; then
      kill -9 "$_pid" 2>/dev/null || true
    fi
    echo "Stopped"
  else
    echo "  No running service found"
  fi
  exit 0
fi

_pid=$(tr -cd '0-9' < "$PID_FILE" 2>/dev/null || true)

if [ -z "$_pid" ] || ! kill -0 "$_pid" 2>/dev/null; then
  echo "Process not running, cleaning up PID file"
  rm -f "$PID_FILE"
  exit 0
fi

# -- graceful stop --
echo "Stopping service (PID=$_pid)..."
kill "$_pid" 2>/dev/null

for i in $(seq 1 "$TIMEOUT"); do
  if ! kill -0 "$_pid" 2>/dev/null; then
    rm -f "$PID_FILE"
    echo "Service stopped"
    exit 0
  fi
  sleep 1
done

# force kill
echo "Graceful stop timed out, force killing..."
kill -9 "$_pid" 2>/dev/null || true
rm -f "$PID_FILE"
echo "Service force stopped"
