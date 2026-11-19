# Sourced by the backup scripts. Gives them `store`, which talks to Oracle Object Storage as this
# machine itself (an instance principal), through rclone at its pinned version. No key, no user.
#
# Settings: BACKUP_NAMESPACE, BACKUP_COMPARTMENT, BACKUP_REGION (default me-jeddah-1).
: "${BACKUP_NAMESPACE:?BACKUP_NAMESPACE is not set (see docs/variables.md, backup.env)}"
: "${BACKUP_COMPARTMENT:?BACKUP_COMPARTMENT is not set (see docs/variables.md, backup.env)}"
store() {
  RCLONE_CONFIG=/dev/null \
  RCLONE_CACHE_DIR="${DOEDESK_SNAPSHOT_WORK:-/var/lib/doedesk/tmp}" \
  RCLONE_OOS_PROVIDER=instance_principal_auth \
  RCLONE_OOS_NAMESPACE="$BACKUP_NAMESPACE" \
  RCLONE_OOS_COMPARTMENT="$BACKUP_COMPARTMENT" \
  RCLONE_OOS_REGION="${BACKUP_REGION:-me-jeddah-1}" \
  RCLONE_OOS_NO_CHECK_BUCKET=true \
    "${RCLONE_BIN:-/opt/doedesk/runtime/rclone}" --retries 3 --low-level-retries 5 --stats 0 --log-level NOTICE "$@"
}
