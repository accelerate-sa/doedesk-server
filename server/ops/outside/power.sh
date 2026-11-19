#!/usr/bin/env bash
# Reboots and a watchdog for the DoeDesk API's confidential VM, driven from OUTSIDE the machine.
#
# Why from outside: on Oracle a reboot or power-off started inside an SEV-SNP guest never completes;
# the machine is dead while Oracle shows it RUNNING. Oracle's
# own SOFTRESET (ACPI power button, then start) and RESET (power cycle) do work. A kernel panic
# would end the same way. So the machine never reboots itself (server/ops/confidential-vm.sh), and
# this script, on a computer that holds the oci CLI (the owner's Mac), does it instead.
#
#   power.sh status   <ssh host> <instance OCID>
#   power.sh reboot   <ssh host> <instance OCID> [--if-needed] [--window 01-03] [--hard]
#       A planned reboot: Oracle SOFTRESET (or RESET with --hard), then waits until the machine is
#       back on a NEW boot, the API says ok and detection and reading are ready. --if-needed: only
#       when the machine reports /var/run/reboot-required (a security update with a new kernel).
#       --window A-B: only between A:00 and B:00 UTC, otherwise do nothing (a run missed while this
#       computer slept is skipped, not done at a busy hour). If the machine is not well 15 minutes after a SOFTRESET, it is
#       given a RESET. Exit 0 when the machine is back and well.
#   power.sh watchdog <health URL> <ssh host> <instance OCID> [--minutes 5]
#       One look, meant to run every minute. The machine counts as dead when <health URL>/v1/health
#       does not answer 200 AND SSH does not answer either (a live machine whose API is down is
#       systemd's to restart, not this script's). Dead for --minutes in a row: Oracle RESET, at most
#       once in 30 minutes, never while a planned reboot is running and never when Oracle says the
#       instance is not RUNNING (stopped on purpose). If this computer cannot reach Oracle's API,
#       it cannot tell, and it does nothing.
#   power.sh install  <health URL> <ssh host> <instance OCID>   two launchd jobs on this Mac
#   power.sh uninstall                                          removes them
#
# State and log: $DOEDESK_POWER_STATE (default ~/.local/state/doedesk-power). A RESET or a failed
# reboot is also shown as a macOS notification, and DOEDESK_POWER_NOTIFY, if set, is run with the
# message as its one argument (an email or a chat hook).
#
# What the Oracle user behind the oci CLI needs: `use instances` on that one instance (the power
# actions) and `read instances`. Nothing else is called.
set -uo pipefail

state="${DOEDESK_POWER_STATE:-$HOME/.local/state/doedesk-power}"
mkdir -p "$state"
log() { local line; line="$(date -u +%FT%TZ) $*"; echo "$line"; echo "$line" >> "$state/power.log"; }
notify() {
  log "NOTICE $*"
  command -v osascript >/dev/null 2>&1 && osascript -e "display notification \"${*//\"/}\" with title \"DoeDesk server\"" >/dev/null 2>&1
  [ -z "${DOEDESK_POWER_NOTIFY:-}" ] || "$DOEDESK_POWER_NOTIFY" "$*" >/dev/null 2>&1 || true
}
usage() { sed -n '9,30p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
now() { date +%s; }
region_of() { echo "$1" | cut -d. -f4; }
lifecycle() { oci compute instance get --instance-id "$1" --region "$(region_of "$1")" --query 'data."lifecycle-state"' --raw-output 2>/dev/null; }
action() { oci compute instance action --instance-id "$1" --region "$(region_of "$1")" --action "$2" --query 'data."lifecycle-state"' --raw-output 2>&1; }
ssh_run() { ssh -o ConnectTimeout=10 -o BatchMode=yes "$@"; }
boot_id() { ssh_run "$1" cat /proc/sys/kernel/random/boot_id 2>/dev/null; }
api_ok() { ssh_run "$1" 'curl -s --max-time 5 http://127.0.0.1:8787/internal/health' 2>/dev/null | grep -q '"ok":true'; }
# Ready to serve people: the API is ok and detection and reading are ready (they start about a
# minute after the API).
ready() { local h; h="$(ssh_run "$1" 'curl -s --max-time 5 http://127.0.0.1:8787/internal/health' 2>/dev/null)"; case "$h" in *'"ok":true'*'"engineReady":false'*|'') return 1 ;; *'"ok":true'*) return 0 ;; *) return 1 ;; esac; }
url_ok() { [ "$(curl -s -o /dev/null --max-time 10 -w '%{http_code}' "${1%/}/v1/health")" = "200" ]; }

case "${1:-}" in
  status)
    [ $# -eq 3 ] || usage
    host="$2"; instance="$3"
    echo "oracle: $(lifecycle "$instance" || echo 'unknown (Oracle API not reachable)')"
    if b="$(boot_id "$host")"; then
      echo "ssh: answers; boot $b, up $(ssh_run "$host" 'cut -d. -f1 /proc/uptime') s"
      if api_ok "$host"; then echo "api: ok"; else echo "api: NOT ok"; fi
      ssh_run "$host" 'if [ -e /var/run/reboot-required ]; then echo "reboot required: yes, since $(date -u -r /var/run/reboot-required +%FT%TZ) ($(tr "\n" " " < /var/run/reboot-required.pkgs 2>/dev/null))"; else echo "reboot required: no"; fi'
    else echo "ssh: does not answer"; fi
    quiet="$(cat "$state/quiet-until" 2>/dev/null || echo 0)"; [ "$quiet" -le "$(now)" ] || echo "watchdog: quiet until $(date -u -r "$quiet" +%FT%TZ) (a planned reboot)"
    [ ! -e "$state/fail-since" ] || echo "watchdog: failing since $(date -u -r "$(cat "$state/fail-since")" +%FT%TZ)"
    [ ! -e "$state/last-reset" ] || echo "watchdog: last RESET $(date -u -r "$(cat "$state/last-reset")" +%FT%TZ)"
    ;;

  reboot)
    [ $# -ge 3 ] || usage
    host="$2"; instance="$3"; shift 3
    if_needed=""; window=""; first="SOFTRESET"
    while [ $# -gt 0 ]; do case "$1" in --if-needed) if_needed=1; shift ;; --window) window="$2"; shift 2 ;; --hard) first="RESET"; shift ;; *) usage ;; esac; done
    if [ -n "$window" ]; then
      from="${window%-*}"; to="${window#*-}"; hour="$(date -u +%H)"
      if [ $((10#$hour)) -lt $((10#$from)) ] || [ $((10#$hour)) -ge $((10#$to)) ]; then exit 0; fi
    fi
    [ "$(lifecycle "$instance")" = "RUNNING" ] || { log "reboot: Oracle does not show $instance RUNNING (or cannot be reached); nothing done"; exit 1; }
    before="$(boot_id "$host")" || { log "reboot: $host does not answer SSH; nothing done (if it is hung, the watchdog or 'reboot --hard' is the way)"; exit 1; }
    if [ -n "$if_needed" ]; then
      ssh_run "$host" test -e /var/run/reboot-required || exit 0
    fi
    why="$(ssh_run "$host" 'cat /var/run/reboot-required.pkgs 2>/dev/null | tr "\n" " "' || true)"
    log "reboot: $host, ${why:+for }${why:-asked by hand}"
    echo $(( $(now) + 25 * 60 )) > "$state/quiet-until"
    started="$(now)"
    log "reboot: Oracle $first: $(action "$instance" "$first")"
    deadline=$(( started + 15 * 60 )); escalated=""
    while :; do
      sleep 5
      after="$(boot_id "$host" || true)"
      if [ -n "$after" ] && [ "$after" != "$before" ] && ready "$host"; then break; fi
      if [ "$(now)" -ge "$deadline" ]; then
        if [ -n "$escalated" ] || [ "$first" = "RESET" ]; then
          rm -f "$state/quiet-until"
          notify "reboot of $host: not back $(( ($(now) - started) / 60 )) minutes after $first${escalated:+ and RESET}. Look at the console (oci compute console-history)."
          exit 1
        fi
        log "reboot: not back after 15 minutes; Oracle RESET: $(action "$instance" RESET)"
        escalated=1; deadline=$(( $(now) + 10 * 60 ))
      fi
    done
    rm -f "$state/quiet-until" "$state/fail-since"
    log "reboot: $host back on a new boot, API and detection ready, $(( $(now) - started )) s after $first${escalated:+ (and a RESET)}; reboot required now: $(ssh_run "$host" 'test -e /var/run/reboot-required && echo yes || echo no')"
    ;;

  watchdog)
    [ $# -ge 4 ] || usage
    url="$2"; host="$3"; instance="$4"; shift 4
    minutes=5
    while [ $# -gt 0 ]; do case "$1" in --minutes) minutes="$2"; shift 2 ;; *) usage ;; esac; done
    if url_ok "$url"; then
      [ ! -e "$state/fail-since" ] || log "watchdog: $url answers again"
      rm -f "$state/fail-since"; exit 0
    fi
    life="$(lifecycle "$instance")" || life=""
    [ -n "$life" ] || exit 0                                   # this computer is offline: cannot tell
    if [ "$life" != "RUNNING" ]; then rm -f "$state/fail-since"; exit 0; fi   # stopped or starting on purpose
    if boot_id "$host" >/dev/null; then                         # alive, only the API is down
      [ -e "$state/fail-since" ] || log "watchdog: $url does not answer, but $host answers SSH: not a hung machine; nothing done"
      rm -f "$state/fail-since"; exit 0
    fi
    [ -e "$state/fail-since" ] || { now > "$state/fail-since"; log "watchdog: $url and SSH to $host do not answer; RESET after $minutes minutes of this"; }
    since="$(cat "$state/fail-since")"
    [ $(( $(now) - since )) -ge $(( minutes * 60 )) ] || exit 0
    quiet="$(cat "$state/quiet-until" 2>/dev/null || echo 0)"
    [ "$quiet" -le "$(now)" ] || exit 0
    last="$(cat "$state/last-reset" 2>/dev/null || echo 0)"
    if [ $(( $(now) - last )) -lt 1800 ]; then exit 0; fi
    now > "$state/last-reset"
    notify "watchdog: $host dead for $(( ($(now) - since) / 60 )) minutes; Oracle RESET: $(action "$instance" RESET)"
    ;;

  install)
    [ $# -eq 4 ] || usage
    url="$2"; host="$3"; instance="$4"
    [ "$(uname)" = "Darwin" ] || { echo "install: launchd is macOS; elsewhere run 'watchdog' every minute and 'reboot --if-needed --window 01-03' every 30 minutes from cron" >&2; exit 2; }
    home_bin="$HOME/.local/share/doedesk-power"; mkdir -p "$home_bin" "$HOME/Library/LaunchAgents"
    # A copy, so that checking out another branch of the repository does not change what runs.
    install -m 0755 "$0" "$home_bin/power.sh"
    path="$(dirname "$(command -v oci)"):/usr/bin:/bin:/usr/sbin:/sbin"
    plist() { # label, interval seconds, arguments...
      local label="$1" interval="$2"; shift 2
      local args=""; for a in "$home_bin/power.sh" "$@"; do args="$args<string>$a</string>"; done
      cat > "$HOME/Library/LaunchAgents/$label.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$label</string>
<key>ProgramArguments</key><array>$args</array>
<key>StartInterval</key><integer>$interval</integer>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>$path</string></dict>
<key>StandardOutPath</key><string>/dev/null</string>
<key>StandardErrorPath</key><string>$state/launchd.err</string>
</dict></plist>
PLIST
      launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
      launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$label.plist"
    }
    plist com.doedesk.power-watchdog 60 watchdog "$url" "$host" "$instance"
    plist com.doedesk.power-reboot 1800 reboot "$host" "$instance" --if-needed --window 01-03
    log "installed: watchdog every minute ($url, $host), reboot when needed between 01:00 and 03:00 UTC, for $instance"
    ;;

  uninstall)
    for label in com.doedesk.power-watchdog com.doedesk.power-reboot; do
      launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
      rm -f "$HOME/Library/LaunchAgents/$label.plist"
    done
    log "uninstalled the launchd jobs"
    ;;

  *) usage ;;
esac
