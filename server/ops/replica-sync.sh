#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Accelerate Technology Establishment
# Copies the folder Litestream keeps (server/ops/litestream.yml) to the replica bucket in Oracle
# Object Storage, Jeddah. Run once a minute by doedesk-replica-sync.timer.
#
# It signs in as this machine (an instance principal): Oracle knows the request comes from this
# instance and a policy says what this instance may do in which bucket. No key is stored.
#
# The bucket is made equal to the folder: new files are added first, and what Litestream has
# removed (changes older than 29 days) is removed last, so the bucket is restorable at every moment.
#
# Settings (/etc/doedesk/backup.env; none is a secret):
#   BACKUP_NAMESPACE     the Object Storage namespace of the tenancy (`oci os ns get`)
#   BACKUP_COMPARTMENT   OCID of the compartment the buckets are in
#   BACKUP_REGION        me-jeddah-1
#   REPLICA_BUCKET       the replica bucket's name
#   REPLICA_PREFIX       the folder in the bucket: doedesk (the default) for production; another name
#                        for a rehearsal machine, so that it never writes over production's copy
set -euo pipefail
umask 077
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$here/object-storage.sh"
: "${REPLICA_BUCKET:?REPLICA_BUCKET is not set}"
folder="${DOEDESK_REPLICA_DIR:-/var/lib/doedesk/replica}"
prefix="${REPLICA_PREFIX:-doedesk}"
case "$prefix" in ""|*/*|.*) echo "replica-sync: REPLICA_PREFIX must be one folder name" >&2; exit 2 ;; esac
[ -d "$folder" ] || { echo "replica-sync: $folder does not exist yet (is doedesk-litestream running?)" >&2; exit 1; }

store sync --delete-after --transfers 4 --checkers 8 "$folder" ":oos:$REPLICA_BUCKET/$prefix"
files="$(find "$folder" -type f | wc -l | tr -d ' ')"
if [ "$prefix" = "doedesk" ]; then echo "replica-sync: $files files in step with $REPLICA_BUCKET"
else echo "replica-sync: $files files in step with $REPLICA_BUCKET/$prefix"; fi
