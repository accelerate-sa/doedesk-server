#!/usr/bin/env bash
# Fetches this month's country data on this computer and builds the country file on the machine.
# For a machine that DB-IP's site will not serve (see geo-update.sh). Run from the repository:
#
#   server/ops/geo-push.sh <ssh host>
#
# Monthly, or whenever the self-check says the country file is growing old. The machine keeps
# working on the old file until then; past 100 days it treats every caller's country as not known.
set -euo pipefail
host="${1:?usage: geo-push.sh <ssh host>}"
scratch="$(mktemp -d)"; trap 'rm -rf "$scratch"' EXIT
this_month="$(date -u +%Y-%m)"
last_month="$(date -u -v-1m +%Y-%m 2>/dev/null || date -u -d "$(date -u +%Y-%m-15) -1 month" +%Y-%m)"
name=""
for month in "$this_month" "$last_month"; do
  if curl --fail --silent --show-error --location --max-time 900 --output "$scratch/dbip-city-lite-$month.csv.gz" "https://download.db-ip.com/free/dbip-city-lite-$month.csv.gz"; then name="dbip-city-lite-$month.csv.gz"; break; fi
done
[ -n "$name" ] || { echo "geo-push: neither $this_month nor $last_month could be downloaded" >&2; exit 1; }
${DOEDESK_SSH:-ssh} "$host" "cat > /tmp/$name" < "$scratch/$name"
${DOEDESK_SSH:-ssh} "$host" "sudo install -o doedesk -g doedesk -m 600 /tmp/$name /var/lib/doedesk/tmp/$name && rm /tmp/$name && sudo systemd-run --quiet --wait --collect --pipe --uid=doedesk --gid=doedesk --property=UMask=0077 --setenv=DOEDESK_GEO_SOURCE=/var/lib/doedesk/tmp/$name --setenv=BUN_INSTALL_CACHE_DIR=/var/lib/doedesk/tmp /opt/doedesk/api/current/server/ops/geo-update.sh; sudo rm -f /var/lib/doedesk/tmp/$name; curl -s http://127.0.0.1:8787/internal/health | grep -o '\"country\":{[^}]*}' || true"
