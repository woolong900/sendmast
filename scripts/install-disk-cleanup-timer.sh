#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="${UNIT_DIR:-/etc/systemd/system}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "This installer must run as root." >&2
  exit 1
fi

install -m 0755 "$ROOT/scripts/cleanup-disk.sh" /usr/local/sbin/sendmast-disk-cleanup
install -m 0644 "$ROOT/ops/systemd/sendmast-disk-cleanup.service" "$UNIT_DIR/sendmast-disk-cleanup.service"
install -m 0644 "$ROOT/ops/systemd/sendmast-disk-cleanup.timer" "$UNIT_DIR/sendmast-disk-cleanup.timer"

# Use the installed copy so maintenance still works during a repository update.
sed -i 's|ExecStart=/root/sendmast/scripts/cleanup-disk.sh|ExecStart=/usr/local/sbin/sendmast-disk-cleanup|' \
  "$UNIT_DIR/sendmast-disk-cleanup.service"

systemctl daemon-reload
systemctl enable --now sendmast-disk-cleanup.timer

echo "Installed sendmast-disk-cleanup.timer"
systemctl list-timers sendmast-disk-cleanup.timer --no-pager
