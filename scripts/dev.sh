#!/usr/bin/env bash
# SendMast dev start/stop helper (macOS, bash 3.2 compatible).
# Manages the workspace apps in dev (watch) mode. Does NOT touch docker infra.
#
# Usage:
#   ./scripts/dev.sh start [app ...]    Start all apps, or only the given ones.
#   ./scripts/dev.sh stop  [app ...]    Stop all (or given) apps.
#   ./scripts/dev.sh restart [app ...]
#   ./scripts/dev.sh status
#   ./scripts/dev.sh logs <app>         tail -f the given app's log.
#   ./scripts/dev.sh list               Print known app names.
#
# App names: web api worker-sender worker-events worker-import

set -u
set -o pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${REPO_ROOT}/.dev-logs"
mkdir -p "${LOG_DIR}"

APPS="web api worker-sender worker-events worker-import"

app_filter() {
  case "$1" in
    web)            echo "@sendmast/web" ;;
    api)            echo "@sendmast/api" ;;
    worker-sender)  echo "@sendmast/worker-sender" ;;
    worker-events)  echo "@sendmast/worker-events" ;;
    worker-import)  echo "@sendmast/worker-import" ;;
    *)              return 1 ;;
  esac
}

app_port() {
  case "$1" in
    web) echo "5173" ;;
    api) echo "4000" ;;
    *)   echo "" ;;
  esac
}

# ---------- helpers ----------

c_red()    { printf '\033[31m%s\033[0m' "$*"; }
c_green()  { printf '\033[32m%s\033[0m' "$*"; }
c_yellow() { printf '\033[33m%s\033[0m' "$*"; }
c_dim()    { printf '\033[2m%s\033[0m' "$*"; }

is_known_app() {
  local a="$1"
  for x in $APPS; do [ "$x" = "$a" ] && return 0; done
  return 1
}

pid_file() { echo "${LOG_DIR}/$1.pid"; }
log_file() { echo "${LOG_DIR}/$1.log"; }

read_pid() {
  local f
  f="$(pid_file "$1")"
  [ -f "$f" ] || return 1
  local pid
  pid="$(cat "$f" 2>/dev/null || true)"
  [ -n "$pid" ] || return 1
  echo "$pid"
}

is_running() {
  local pid="${1:-}"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

# Recursively kill a process and all its descendants.
# tsx/nest/vite watch mode forks child processes; killing only the parent
# leaves orphan node processes hogging the ports.
kill_tree() {
  local pid="$1"
  local sig="${2:-TERM}"
  [ -z "$pid" ] && return 0
  local children
  children="$(pgrep -P "$pid" 2>/dev/null || true)"
  for c in $children; do
    kill_tree "$c" "$sig"
  done
  kill -"$sig" "$pid" 2>/dev/null || true
}

# Validate args in the current shell (must NOT be called from a subshell,
# because `exit` would only kill the subshell). Empty -> ok.
validate_apps() {
  for a in "$@"; do
    if ! is_known_app "$a"; then
      echo "$(c_red "unknown app:") $a" >&2
      echo "known: $APPS" >&2
      exit 2
    fi
  done
}

# Echoes one app per line. Empty args -> all known apps.
# Assumes args are already validated.
resolve_targets() {
  if [ $# -eq 0 ]; then
    for a in $APPS; do echo "$a"; done
    return
  fi
  for a in "$@"; do echo "$a"; done
}

# ---------- commands ----------

start_one() {
  local app="$1"
  local pid
  if pid="$(read_pid "$app")" && is_running "$pid"; then
    echo "  $(c_yellow "skip")    $app (already running, pid $pid)"
    return 0
  fi
  rm -f "$(pid_file "$app")"
  : > "$(log_file "$app")"

  local filter
  filter="$(app_filter "$app")"

  # nohup + & detaches from this shell. Child writes directly to the log file.
  (
    cd "${REPO_ROOT}"
    nohup pnpm --filter "$filter" dev \
      >> "$(log_file "$app")" 2>&1 &
    echo $! > "$(pid_file "$app")"
  )
  local new_pid
  new_pid="$(read_pid "$app" 2>/dev/null || echo "?")"
  echo "  $(c_green "start")   $app (pid $new_pid, log .dev-logs/${app}.log)"
}

stop_one() {
  local app="$1"
  local pid
  if ! pid="$(read_pid "$app")"; then
    echo "  $(c_dim "stopped") $app (no pid file)"
    return 0
  fi
  if ! is_running "$pid"; then
    echo "  $(c_dim "stopped") $app (stale pid $pid)"
    rm -f "$(pid_file "$app")"
    return 0
  fi
  kill_tree "$pid" TERM
  # Wait up to 8s for graceful exit.
  local i=0
  while [ $i -lt 8 ]; do
    is_running "$pid" || break
    sleep 1
    i=$((i + 1))
  done
  if is_running "$pid"; then
    kill_tree "$pid" KILL
    sleep 1
  fi
  rm -f "$(pid_file "$app")"
  echo "  $(c_green "stop")    $app (pid $pid)"
}

cmd_start() {
  validate_apps "$@"
  local apps=""
  while IFS= read -r a; do apps="$apps $a"; done < <(resolve_targets "$@")
  echo "starting:$apps"
  for a in $apps; do start_one "$a"; done
  echo
  echo "$(c_dim "tip:") ./scripts/dev.sh logs <app>   # tail logs"
  echo "$(c_dim "tip:") ./scripts/dev.sh status        # check state"
}

cmd_stop() {
  validate_apps "$@"
  local apps=""
  while IFS= read -r a; do apps="$apps $a"; done < <(resolve_targets "$@")
  echo "stopping:$apps"
  for a in $apps; do stop_one "$a"; done
}

cmd_restart() {
  cmd_stop "$@"
  echo
  cmd_start "$@"
}

cmd_status() {
  printf "%-16s %-19s %-8s %s\n" "APP" "STATE" "PID" "PORT/LOG"
  for a in $APPS; do
    local pid state port suffix
    port="$(app_port "$a")"
    if pid="$(read_pid "$a")" && is_running "$pid"; then
      state="$(c_green running)"
    else
      state="$(c_dim stopped)"
      pid="-"
    fi
    if [ -n "$port" ]; then
      suffix=":$port  .dev-logs/${a}.log"
    else
      suffix=".dev-logs/${a}.log"
    fi
    printf "%-16s %-28s %-8s %s\n" "$a" "$state" "$pid" "$suffix"
  done
}

cmd_logs() {
  if [ $# -ne 1 ]; then
    echo "usage: $0 logs <app>" >&2
    exit 2
  fi
  is_known_app "$1" || { echo "unknown app: $1" >&2; exit 2; }
  local f
  f="$(log_file "$1")"
  [ -f "$f" ] || { echo "no log yet: $f" >&2; exit 1; }
  exec tail -n 100 -f "$f"
}

cmd_list() {
  for a in $APPS; do echo "$a"; done
}

usage() {
  sed -n '2,14p' "$0"
}

main() {
  local cmd="${1:-}"
  [ $# -gt 0 ] && shift || true
  case "$cmd" in
    start)   cmd_start   "$@" ;;
    stop)    cmd_stop    "$@" ;;
    restart) cmd_restart "$@" ;;
    status)  cmd_status        ;;
    logs)    cmd_logs    "$@" ;;
    list)    cmd_list          ;;
    ""|-h|--help|help) usage   ;;
    *) echo "unknown command: $cmd" >&2; usage >&2; exit 2 ;;
  esac
}

main "$@"
