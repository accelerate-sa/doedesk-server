#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Accelerate Technology Establishment
# Looks the service over, on the machine. Run every five minutes by doedesk-check.timer; a problem
# is printed and makes the exit status 1, which emails the owner (doedesk-alert@.service).
#
# Checks: the API answers and says its database is sound; the country file is in use; last night's
# job ran and did not fail; replication is running and reaching its bucket; last night's snapshot was made; the data
# volume has room; a reboot for a security update has not been waiting too long (a confidential VM
# never reboots itself: server/ops/outside/power.sh does). Prints no account data: the health
# answer holds counts and states only.
#
# Settings: DOEDESK_PORT (8787), DOEDESK_DATA (/var/lib/doedesk), CHECK_MIN_FREE_MB (2048),
# CHECK_REPLICATION (1; set 0 on a machine with no replication yet), CHECK_SNAPSHOT (1),
# CHECK_REBOOT_DAYS (7; 0 turns the check off).
set -uo pipefail

port="${DOEDESK_PORT:-8787}"
data="${DOEDESK_DATA:-/var/lib/doedesk}"
min_free_mb="${CHECK_MIN_FREE_MB:-2048}"
problems=()

health="$(curl --silent --max-time 10 "http://127.0.0.1:$port/internal/health" || true)"
field() { printf '%s' "$health" | python3 -c "import json,sys
try:
    value = json.load(sys.stdin)
    for key in sys.argv[1].split('.'):
        value = value[key]
    print(value if value is not None else '')
except Exception:
    print('')" "$1"; }

if [ -z "$health" ]; then
  problems+=("the API does not answer on 127.0.0.1:$port")
else
  [ "$(field ok)" = "True" ] || problems+=("the API reports its database is not usable")
  state="$(field country.state)"
  [ "$state" = "ok" ] || problems+=("the country file is $state: every caller counts as 'country not known' (no phone sign-in)")
  age_days="$(field country.ageDays)"
  if [ -n "$age_days" ] && [ "$age_days" -gt 60 ]; then problems+=("the country file is $age_days days old: the monthly update is not working"); fi
  # The engine on this machine, asked by the API on every health request.
  [ "$(field engineReady)" != "False" ] || problems+=("detection and reading are not available: $(field engineState). Look at: curl -s http://127.0.0.1:8080/v1/health")
  [ "$(field frozen)" = "False" ] || problems+=("the API is frozen (MAINTENANCE=freeze): nothing is being written")
  night="$(field nightly.day)"; outcome="$(field nightly.outcome)"
  yesterday="$(date -u -d 'yesterday' +%F 2>/dev/null || date -u -v-1d +%F)"
  if [ -z "$night" ]; then
    # A new machine has no night behind it yet; a day after it starts, it should.
    uptime="$(field uptimeSeconds)"; [ "${uptime:-0}" -lt 100000 ] || problems+=("the nightly job has never run")
  else
    [ "$outcome" != "failed" ] || problems+=("the nightly job failed on $night")
    [ "$night" \> "$yesterday" ] || [ "$night" = "$yesterday" ] || problems+=("the nightly job last ran on $night")
  fi
fi

if [ "${CHECK_REPLICATION:-1}" = "1" ]; then
  systemctl is-active --quiet doedesk-litestream.service || problems+=("replication (doedesk-litestream) is not running")
  # The copy off the machine: the last run to the bucket must have worked, and not long ago.
  synced="$(systemctl show doedesk-replica-sync.service --property=Result --value 2>/dev/null || true)"
  [ "$synced" = "success" ] || [ -z "$synced" ] || problems+=("the last copy to the replica bucket ended with: $synced")
  last="$(systemctl show doedesk-replica-sync.service --property=ExecMainExitTimestampMonotonic --value 2>/dev/null || echo 0)"
  now="$(awk '{print int($1 * 1000000)}' /proc/uptime 2>/dev/null || echo 0)"
  if [ "${last:-0}" -gt 0 ] && [ "$now" -gt 0 ] && [ $(( (now - last) / 1000000 )) -gt 600 ]; then problems+=("nothing has been copied to the replica bucket for $(( (now - last) / 60000000 )) minutes"); fi
  if [ "${last:-0}" = "0" ]; then uptime_s="$(field uptimeSeconds)"; [ "${uptime_s:-0}" -lt 600 ] || problems+=("the copy to the replica bucket has not run since the machine started"); fi
fi
if [ "${CHECK_SNAPSHOT:-1}" = "1" ]; then
  result="$(systemctl show doedesk-snapshot.service --property=Result --value 2>/dev/null || true)"
  [ "$result" = "success" ] || [ -z "$result" ] || problems+=("the last nightly snapshot ended with: $result")
fi

reboot_days="${CHECK_REBOOT_DAYS:-7}"
if [ "$reboot_days" -gt 0 ] && [ -e /var/run/reboot-required ]; then
  waiting=$(( ( $(date +%s) - $(stat -c %Y /var/run/reboot-required 2>/dev/null || date +%s) ) / 86400 ))
  [ "$waiting" -lt "$reboot_days" ] || problems+=("a reboot for a security update has been waiting $waiting days: server/ops/outside/power.sh reboot (from outside)")
fi

free_mb="$(df --output=avail -m "$data" 2>/dev/null | tail -1 | tr -d ' ' || true)"
if [ -n "$free_mb" ] && [ "$free_mb" -lt "$min_free_mb" ]; then problems+=("only $free_mb MB free on $data"); fi

if [ ${#problems[@]} -eq 0 ]; then
  echo "check ok"
  exit 0
fi
printf 'check: %s\n' "${problems[@]}"
exit 1
