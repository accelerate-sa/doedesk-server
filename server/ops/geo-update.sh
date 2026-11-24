#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Accelerate Technology Establishment
# Refreshes the country file the API reads (server/geo.ts) from DB-IP's free "IP to City Lite"
# database, which is published monthly under CC BY 4.0 (https://db-ip.com/db/download/ip-to-city-lite).
#
# Downloads this month's edition (last month's if this month's is not out yet), builds the file
# beside the old one, checks it, and moves it into place. The API notices the new file within five
# minutes. If anything fails the old file stays and this script exits 1.
#
# Settings (all have defaults for the machine):
#   DOEDESK_GEO_FILE     where the file lives          /var/lib/doedesk/geo/country.ddgeo
#   DOEDESK_GEO_WORK     scratch space, about 700 MB   /var/lib/doedesk/tmp
#   DOEDESK_RUNTIME      bun or node                   /opt/doedesk/runtime/bun
#   DOEDESK_GEO_EXPECT   checks the new file must pass, as "ip=CODE ip=CODE"
set -euo pipefail

file="${DOEDESK_GEO_FILE:-/var/lib/doedesk/geo/country.ddgeo}"
work="${DOEDESK_GEO_WORK:-/var/lib/doedesk/tmp}"
runtime="${DOEDESK_RUNTIME:-/opt/doedesk/runtime/bun}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Addresses whose country does not change: a block Oracle publishes for its Jeddah region (where
# this runs), Google's resolver, and one each in Germany and Japan. A file that places them
# elsewhere is not used.
expect="${DOEDESK_GEO_EXPECT:-193.122.64.1=SA 8.8.8.8=US 194.25.2.129=DE 202.12.27.33=JP}"

scratch="$(mktemp -d "$work/geo.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT
mkdir -p "$(dirname "$file")"

# DOEDESK_GEO_SOURCE=<file>: an edition somebody has already downloaded (dbip-city-lite-YYYY-MM.csv.gz),
# for a machine the publisher's site will not serve. DB-IP sits behind a challenge page that refuses
# requests from Oracle Cloud's addresses (seen from Jeddah on 19 November 2026: HTTP 403), so on
# that machine the file is fetched elsewhere and sent over (the runbook, "The country file").
edition=""
if [ -n "${DOEDESK_GEO_SOURCE:-}" ]; then
  edition="$(basename "$DOEDESK_GEO_SOURCE" .csv.gz)"
  case "$edition" in dbip-city-lite-20[0-9][0-9]-[01][0-9]) ;; *) echo "geo-update: $DOEDESK_GEO_SOURCE is not named dbip-city-lite-YYYY-MM.csv.gz" >&2; exit 1 ;; esac
  cp "$DOEDESK_GEO_SOURCE" "$scratch/$edition.csv.gz"
else
  this_month="$(date -u +%Y-%m)"
  last_month="$(date -u -d "$(date -u +%Y-%m-15) -1 month" +%Y-%m 2>/dev/null || date -u -v-1m +%Y-%m)"
  for month in "$this_month" "$last_month"; do
    name="dbip-city-lite-$month"
    if curl --fail --silent --show-error --location --max-time 900 --output "$scratch/$name.csv.gz" "https://download.db-ip.com/free/$name.csv.gz"; then
      edition="$name"
      break
    fi
  done
  if [ -z "$edition" ]; then
    echo "geo-update: neither $this_month nor $last_month could be downloaded. If this machine is refused (HTTP 403), fetch the file elsewhere and run with DOEDESK_GEO_SOURCE=<file>" >&2
    exit 1
  fi
fi

gunzip "$scratch/$edition.csv.gz"
args=(--input "$scratch/$edition.csv" --output "$file" --source "$edition")
for check in $expect; do args+=(--expect "$check"); done
"$runtime" "$here/../geo-build.ts" "${args[@]}"
