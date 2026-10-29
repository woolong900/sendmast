#!/usr/bin/env bash
# Conservative disk maintenance for the SendMast production host.
# Docker volumes and application data are deliberately never removed.

set -euo pipefail

LOCK_FILE="${LOCK_FILE:-/run/lock/sendmast-disk-cleanup.lock}"
WARN_PERCENT="${WARN_PERCENT:-80}"
EMERGENCY_PERCENT="${EMERGENCY_PERCENT:-90}"
LOG_LIMIT_MB="${LOG_LIMIT_MB:-500}"

log() {
  printf '%s %s\n' "$(date --iso-8601=seconds)" "$*"
}

root_usage_percent() {
  df -P / | awk 'NR == 2 { gsub(/%/, "", $5); print $5 }'
}

if [[ "${EUID}" -ne 0 ]]; then
  echo "This script must run as root." >&2
  exit 1
fi

for command in docker df flock find; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required command not found: $command" >&2
    exit 1
  fi
done

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "Another cleanup is already running; exiting."
  exit 0
fi

before_usage="$(root_usage_percent)"
before_free="$(df -hP / | awk 'NR == 2 { print $4 }')"
log "Cleanup started: root usage=${before_usage}%, free=${before_free}."

# Routine cleanup only targets resources that Docker has already determined are
# unused. Keep two weeks of unused images to preserve a practical rollback
# window, while build cache and stopped containers may be removed after a week.
docker builder prune -af --filter "until=168h" >/dev/null
docker container prune -f --filter "until=168h" >/dev/null
docker image prune -af --filter "until=336h" >/dev/null

current_usage="$(root_usage_percent)"
if (( current_usage >= WARN_PERCENT )); then
  log "Root usage is ${current_usage}%; applying high-usage cleanup."

  if command -v journalctl >/dev/null 2>&1; then
    journalctl --vacuum-time=14d
    journalctl --vacuum-size=1G
  fi

  if command -v apt-get >/dev/null 2>&1; then
    apt-get clean
  fi
fi

current_usage="$(root_usage_percent)"
if (( current_usage >= EMERGENCY_PERCENT )); then
  log "Root usage is ${current_usage}%; clearing oversized Docker JSON logs."

  # This is a recovery backstop for containers that do not have log rotation.
  # It does not touch databases, Docker volumes, uploads, or application data.
  find /var/lib/docker/containers \
    -type f \
    -name '*-json.log' \
    -size "+${LOG_LIMIT_MB}M" \
    -print \
    -exec truncate -s 0 {} \;
fi

after_usage="$(root_usage_percent)"
after_free="$(df -hP / | awk 'NR == 2 { print $4 }')"
log "Cleanup finished: root usage=${after_usage}%, free=${after_free}."

if (( after_usage >= EMERGENCY_PERCENT )); then
  log "ERROR: root usage remains above the emergency threshold."
  exit 1
fi
