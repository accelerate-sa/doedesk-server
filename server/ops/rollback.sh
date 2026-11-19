#!/usr/bin/env bash
# Puts the previous release back and restarts the API on it.
#
#   server/ops/rollback.sh <ssh host> [release folder name]
#
# Code only. The database is not changed: migrations are written so that the previous code runs on
# the newer schema. If a migration has to be undone, restore the copy the deploy made first
# (/var/lib/doedesk/before-migration/<release>.sqlite), as the runbook, "Restore", describes.
set -euo pipefail
host="${1:?usage: rollback.sh <ssh host> [release]}"
${DOEDESK_SSH:-ssh} "$host" sudo bash -s -- "${2:-}" <<'REMOTE'
set -euo pipefail
releases=/opt/doedesk/api/releases
current=/opt/doedesk/api/current
now="$(basename "$(readlink -f "$current")")"
target="${1:-$(ls -1 "$releases" | sort | grep -v -x "$now" | tail -1)}"
[ -n "$target" ] && [ -d "$releases/$target" ] || { echo "rollback: no other release to go back to" >&2; exit 1; }
ln -sfn "$releases/$target" "$current"
systemctl restart doedesk-api.service
for _ in $(seq 1 30); do
  if curl --silent --max-time 3 http://127.0.0.1:8787/internal/health | grep -q '"ok":true'; then echo "rollback: $target is live (was $now)"; exit 0; fi
  sleep 1
done
echo "rollback: the API is not well on $target" >&2
exit 1
REMOTE
