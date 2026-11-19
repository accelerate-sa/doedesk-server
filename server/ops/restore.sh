#!/usr/bin/env bash
# Brings the database back from a backup, into a NEW file. It never touches the running database:
# putting the restored file into service is a separate, deliberate step (the runbook, "Restore").
#
#   restore.sh replica <output file> [--at 2026-11-20T03:00:00Z] [--local] [--prefix <folder>]
#       From the continuous copy, as of now or of a moment in the last 29 days. Run on the
#       machine, as root. The copy is first fetched from the replica bucket into a scratch folder
#       (settings in /etc/doedesk/backup.env; the machine signs in as itself), so what is proved
#       is the copy that is off the machine. --local reads the folder on this machine instead.
#       --prefix reads another folder of the bucket than REPLICA_PREFIX (default doedesk): a
#       rehearsal machine takes its copy of production with --prefix doedesk. Reading never
#       changes the bucket.
#
#   restore.sh snapshot <encrypted file> <output file> --identity <private key file>
#       From a nightly snapshot that has been downloaded. Needs the private key, which is kept
#       off the machine: run this where the key is.
#
# Either way the result is checked (SQLite's integrity check, references) and described by table
# counts, with no row printed. Compare it with another database using server/migration/verify.mjs.
set -euo pipefail
umask 077

usage() { sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
[ $# -ge 2 ] || usage
mode="$1"; shift

check() {
  local file="$1"
  if command -v sqlite3 >/dev/null 2>&1; then
    local integrity dangling
    integrity="$(sqlite3 "$file" 'PRAGMA integrity_check;')"
    dangling="$(sqlite3 "$file" 'PRAGMA foreign_key_check;' | wc -l | tr -d ' ')"
    [ "$integrity" = "ok" ] && [ "$dangling" = "0" ] || { echo "restore: the file is not sound (integrity: $integrity, dangling references: $dangling)" >&2; exit 1; }
    echo "restored $file: sound, $(sqlite3 "$file" "SELECT COUNT(*) FROM sqlite_master WHERE type='table'") tables, $(sqlite3 "$file" 'SELECT COUNT(*) FROM users') accounts, $(stat -c %s "$file" 2>/dev/null || stat -f %z "$file") bytes"
  else
    # No sqlite3 command here: the service's own runtime does the same check.
    local runtime="${DOEDESK_RUNTIME:-/opt/doedesk/runtime/bun}"
    local here; here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    "$runtime" "$here/../check-database.ts" "$file"
  fi
}

case "$mode" in
  replica)
    out="$1"; shift
    at=""
    local_copy=""
    prefix=""
    while [ $# -gt 0 ]; do case "$1" in --at) at="$2"; shift 2 ;; --local) local_copy="yes"; shift ;; --prefix) prefix="$2"; shift 2 ;; *) usage ;; esac; done
    [ ! -e "$out" ] || { echo "restore: $out exists; restore into a new file" >&2; exit 2; }
    config="${LITESTREAM_CONFIG:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/litestream.yml}"
    litestream="${LITESTREAM_BIN:-/opt/doedesk/runtime/litestream}"
    database="${DOEDESK_DATABASE:-/var/lib/doedesk/doedesk.sqlite}"
    if [ -r /etc/doedesk/backup.env ]; then set -a; . /etc/doedesk/backup.env; set +a; fi
    prefix="${prefix:-${REPLICA_PREFIX:-doedesk}}"
    case "$prefix" in */*|.*) echo "restore: --prefix must be one folder name" >&2; exit 2 ;; esac
    # LITESTREAM_CONFIG given: a test, or an unusual layout; it is used as it stands.
    if [ -z "$local_copy" ] && [ -z "${LITESTREAM_CONFIG:-}" ]; then
      : "${REPLICA_BUCKET:?REPLICA_BUCKET is not set in /etc/doedesk/backup.env (or pass --local)}"
      here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
      . "$here/object-storage.sh"
      fetched="$(mktemp -d "${DOEDESK_SNAPSHOT_WORK:-/var/lib/doedesk/tmp}/restore.XXXXXX")"
      trap 'rm -rf "$fetched"' EXIT
      store copy --transfers 8 ":oos:$REPLICA_BUCKET/$prefix" "$fetched/replica"
      echo "restore: fetched $(find "$fetched/replica" -type f | wc -l | tr -d ' ') files, $(du -sk "$fetched/replica" | cut -f1) KB, from $REPLICA_BUCKET/$prefix"
      config="$fetched/litestream.yml"
      printf 'dbs:\n  - path: %s\n    replica:\n      type: file\n      path: %s\n' "$database" "$fetched/replica" > "$config"
    fi
    args=(restore -config "$config" -o "$out" -integrity-check full)
    [ -z "$at" ] || args+=(-timestamp "$at")
    "$litestream" "${args[@]}" "$database"
    check "$out"
    ;;
  snapshot)
    [ $# -ge 2 ] || usage
    in="$1"; out="$2"; shift 2
    identity=""
    while [ $# -gt 0 ]; do case "$1" in --identity) identity="$2"; shift 2 ;; *) usage ;; esac; done
    [ -n "$identity" ] || usage
    [ ! -e "$out" ] || { echo "restore: $out exists; restore into a new file" >&2; exit 2; }
    age --decrypt --identity "$identity" "$in" | gunzip > "$out"
    check "$out"
    ;;
  *) usage ;;
esac
