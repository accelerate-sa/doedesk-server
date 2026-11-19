#!/usr/bin/env bash
# The nightly snapshot: a consistent copy of the database, compressed, encrypted to a key whose
# private half is not on this machine, and uploaded to the snapshots bucket in Jeddah. The bucket
# copies each object to Riyadh by itself and deletes it after 29 days.
#
# It is uploaded as this machine itself (an instance principal; server/ops/object-storage.sh).
# Oracle's policy lets this machine add an object to that bucket and see the names there, and
# nothing else: it cannot read a snapshot back, replace one or delete one. So neither this machine
# nor anyone who takes it over can read old snapshots or remove them.
#
# Settings (in /etc/doedesk/backup.env):
#   SNAPSHOT_AGE_RECIPIENT   the public key, age1...
#   SNAPSHOT_BUCKET          the snapshots bucket's name, with BACKUP_NAMESPACE, BACKUP_COMPARTMENT, BACKUP_REGION
#   SNAPSHOT_PREFIX          put before each object's name: unset in production; a folder such as
#                            rehearsal-cc/ on a rehearsal machine, so its snapshots are told apart
#   SNAPSHOT_UPLOAD_URL      instead of SNAPSHOT_BUCKET: an upload address that can only add
#                            (a pre-authenticated request ending in /o/), for a machine that is
#                            not an Oracle instance
# and from the unit:
#   DOEDESK_DATABASE, DOEDESK_SNAPSHOT_WORK, DOEDESK_RUNTIME
#
# With SNAPSHOT_KEEP_LOCAL=<folder> the encrypted file is also left there, for a restore test.
set -euo pipefail
umask 077

: "${SNAPSHOT_AGE_RECIPIENT:?SNAPSHOT_AGE_RECIPIENT is not set}"
: "${DOEDESK_DATABASE:?DOEDESK_DATABASE is not set}"
work="${DOEDESK_SNAPSHOT_WORK:-/var/lib/doedesk/tmp}"
runtime="${DOEDESK_RUNTIME:-/opt/doedesk/runtime/bun}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
case "$SNAPSHOT_AGE_RECIPIENT" in age1*) ;; *) echo "snapshot: SNAPSHOT_AGE_RECIPIENT is not an age public key" >&2; exit 2 ;; esac

scratch="$(mktemp -d "$work/snapshot.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
name="doedesk-$stamp.sqlite.gz.age"
prefix="${SNAPSHOT_PREFIX:-}"
case "$prefix" in ""|[a-z0-9]*/) ;; *) echo "snapshot: SNAPSHOT_PREFIX must be empty or a folder name ending in /" >&2; exit 2 ;; esac

# 1. A copy of the database as it is at one moment, checked for soundness.
DOEDESK_DATABASE="$DOEDESK_DATABASE" "$runtime" "$here/../snapshot.ts" "$scratch/snapshot.sqlite"

# 2. Compressed, then encrypted. Only the holder of the private key can read the result.
gzip --stdout "$scratch/snapshot.sqlite" | age --recipient "$SNAPSHOT_AGE_RECIPIENT" --output "$scratch/$name"
rm -f "$scratch/snapshot.sqlite"
sum="$(sha256sum "$scratch/$name" | cut -d' ' -f1)"
size="$(stat -c %s "$scratch/$name" 2>/dev/null || stat -f %z "$scratch/$name")"

# 3. Uploaded. The store refuses to replace an object of the same name, either way.
if [ -n "${SNAPSHOT_BUCKET:-}" ]; then
  . "$here/object-storage.sh"
  store copyto --immutable "$scratch/$name" ":oos:$SNAPSHOT_BUCKET/$prefix$name"
  where="uploaded to $SNAPSHOT_BUCKET${prefix:+/${prefix%/}}"
elif [ -n "${SNAPSHOT_UPLOAD_URL:-}" ]; then
  curl --fail --silent --show-error --max-time 600 --request PUT --header "If-None-Match: *" \
    --header "Content-Type: application/octet-stream" --upload-file "$scratch/$name" "${SNAPSHOT_UPLOAD_URL%/}/$name" >/dev/null
  where="uploaded"
else
  where="not uploaded (SNAPSHOT_BUCKET is not set)"
fi
if [ -n "${SNAPSHOT_KEEP_LOCAL:-}" ]; then
  mkdir -p "$SNAPSHOT_KEEP_LOCAL"
  cp "$scratch/$name" "$SNAPSHOT_KEEP_LOCAL/$name"
fi
echo "snapshot $name bytes=$size sha256=$sum $where"
if [ -z "${SNAPSHOT_BUCKET:-}" ] && [ -z "${SNAPSHOT_UPLOAD_URL:-}" ] && [ -z "${SNAPSHOT_KEEP_LOCAL:-}" ]; then exit 1; fi
