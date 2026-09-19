#!/usr/bin/env bash
# Start/stop the app as a detached background server.
#
# It survives closing the terminal, and its command line carries a distinctive
# marker (--instance=<name>) so a broad `pkill -f "server/index.js"` from some
# other tool or session does not take it down with it.
#
#   ./run.sh start [--port 4000] [--name mine]
#   ./run.sh stop | restart | status | logs [-f]
#
# State lives in .run/ next to this script: <name>.pid, <name>.log, <name>.port

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_DIR="$ROOT/.run"
NAME="app"
PORT=""

cmd="${1:-help}"
[ $# -gt 0 ] && shift || true

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --port=*) PORT="${1#*=}"; shift ;;
    --name) NAME="$2"; shift 2 ;;
    --name=*) NAME="${1#*=}"; shift ;;
    -f|--follow) FOLLOW=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

mkdir -p "$RUN_DIR"
PID_FILE="$RUN_DIR/$NAME.pid"
LOG_FILE="$RUN_DIR/$NAME.log"
PORT_FILE="$RUN_DIR/$NAME.port"
MARKER="--instance=$NAME"

running_pid() {
  [ -f "$PID_FILE" ] || return 1
  local pid; pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [ -n "$pid" ] || return 1
  # Make sure the pid is still ours and not recycled by some other process.
  ps -p "$pid" -o command= 2>/dev/null | grep -q -- "$MARKER" || return 1
  echo "$pid"
}

start() {
  if pid="$(running_pid)"; then
    echo "Already running (pid $pid) on http://localhost:$(cat "$PORT_FILE" 2>/dev/null || echo '?')"
    return 0
  fi

  [ -n "$PORT" ] || PORT="${PORT:-${APP_PORT:-4000}}"

  # Instances in the same directory share data/, which two servers writing at
  # once will corrupt. Separate directories (separate checkouts) are safe.
  for other in "$RUN_DIR"/*.pid; do
    [ -e "$other" ] || continue
    [ "$other" = "$PID_FILE" ] && continue
    other_pid="$(cat "$other" 2>/dev/null || true)"
    if [ -n "$other_pid" ] && ps -p "$other_pid" -o command= 2>/dev/null | grep -q -- '--instance='; then
      echo "Warning: '$(basename "$other" .pid)' is already running from this directory;" >&2
      echo "         both would write the same data/ files. Use a separate checkout instead." >&2
    fi
  done

  if [ ! -d "$ROOT/node_modules" ]; then
    echo "Installing dependencies…"
    (cd "$ROOT" && npm install --no-audit --no-fund)
  fi

  # nohup + background detaches from the terminal; setsid, where it exists,
  # also puts it in its own process group so a group-wide kill misses it.
  # Kept as a plain string, not an array: bash 3.2 (macOS) errors on an empty
  # array expansion under `set -u`.
  local setsid_cmd=""
  command -v setsid >/dev/null 2>&1 && setsid_cmd="setsid"

  echo "--- started $(date) on port $PORT ---" >> "$LOG_FILE"
  (
    cd "$ROOT"
    PORT="$PORT" nohup $setsid_cmd node server/serve.js "$MARKER" >> "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
  )
  echo "$PORT" > "$PORT_FILE"

  # Give it a moment, then confirm it actually came up.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 0.3
    if curl -fsS -o /dev/null "http://localhost:$PORT/api/lists" 2>/dev/null; then
      echo "Running at http://localhost:$PORT  (pid $(cat "$PID_FILE"), logs: $LOG_FILE)"
      return 0
    fi
    running_pid >/dev/null || break
  done

  echo "Failed to start. Last lines of $LOG_FILE:" >&2
  tail -20 "$LOG_FILE" >&2
  rm -f "$PID_FILE"
  return 1
}

stop() {
  if ! pid="$(running_pid)"; then
    echo "Not running."
    rm -f "$PID_FILE"
    return 0
  fi
  kill "$pid" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    running_pid >/dev/null || break
    sleep 0.3
  done
  if running_pid >/dev/null; then
    kill -9 "$pid" 2>/dev/null || true
    sleep 0.3
  fi
  rm -f "$PID_FILE"
  echo "Stopped (pid $pid)."
}

status() {
  if pid="$(running_pid)"; then
    echo "Running: pid $pid, port $(cat "$PORT_FILE" 2>/dev/null || echo '?'), instance '$NAME'"
    echo "  $ROOT"
    echo "  logs: $LOG_FILE"
  else
    echo "Not running (instance '$NAME' in $ROOT)."
    return 1
  fi
}

case "$cmd" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  logs)
    [ -f "$LOG_FILE" ] || { echo "No log yet at $LOG_FILE"; exit 1; }
    if [ "${FOLLOW:-}" = 1 ]; then tail -f "$LOG_FILE"; else tail -50 "$LOG_FILE"; fi
    ;;
  *)
    sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
