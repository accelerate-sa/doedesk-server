#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Accelerate Technology Establishment
# Puts a version of the code on the machine, with its signed release record, and switches to it.
# Run on the computer that holds the repositories:
#
#   server/ops/deploy.sh [options] <ssh host> [git revision, default HEAD]
#   server/ops/deploy.sh --first [options] <ssh host> [revision]     a machine that has never had it
#
# What is sent is always a commit of the PUBLIC repository (docs/releases.md):
#   - run from the public repository, the revision named (default HEAD) is sent;
#   - run from the private one, the public repository is DOEDESK_PUBLIC_REPO (default: a folder
#     doedesk-server beside this one) at DOEDESK_PUBLIC_REVISION (default its HEAD), and the
#     private revision is only compared with it: server/, src/ and migrations/ must be the same in
#     both, file for file, or nothing is sent. (package.json may differ: the private one also builds
#     the website. The server reads only its "type".)
#
# A layer (docs/releases.md, "A layer beside the release"): code that runs beside the release and is
# not part of the public repository. It is sent only when asked for with --layer, only from the
# private repository, and the record says so: it names the layer and the sha256 of what was sent.
# Without --layer the machine gets the public commit and nothing else, whatever the private
# repository holds.
#
# Steps:
#   1. The release archive is made (`node server/ops/release.mjs archive`: git archive of server/,
#      src/, migrations/, docs/ and package.json, reproducible on any machine) and its sha256 taken.
#   2. The release record {public commit, archive sha256, time, link to the previous record} is made
#      and signed with cosign (key: DOEDESK_RELEASE_KEY; password: COSIGN_PASSWORD, or asked), which
#      also puts the signature in the public transparency log. The record and its signature are
#      added to the public repository's log, releases/log/, and committed there (not pushed).
#   3. The archive is sent; the machine checks its sha256 before unpacking it to
#      /opt/doedesk/api/releases/<time>-<commit>, and stores RELEASE.json and RELEASE.sigstore.json
#      beside it, which the API serves at GET /v1/release and GET /v1/release/signature.
#   4. If the release brings migrations: the database is copied aside first (before-migration/), the
#      API is stopped, the migrations are applied, and the API is started on the new code;
#      otherwise the API is restarted on the new code, which finishes requests in flight first.
#   5. The API's health is read. If it is not well, the previous release is put back and started,
#      and this script exits 1. (Migrations are written to be safe under the previous code; the
#      copy made in step 4 is there if one is not.) The record stays in the log: the log lists every
#      release sent to production, and GET /v1/release says which one runs.
# The last five releases are kept. To go back by hand: server/ops/rollback.sh <ssh host>.
#
# Options (each also as an environment variable, for scripts):
#   --layer <folder>     DOEDESK_LAYER. From the private repository: also send that top-level
#                        folder of the private revision, to run beside the release. It is unpacked
#                        at <release>/<folder>, where the server looks for it, and named in the
#                        record by its sha256. The public commit must hold no folder of that name.
#   --dry-run            DOEDESK_DEPLOY_DRY_RUN=1. Do the comparison, make the archive (and the
#                        layer's), print what would be sent and the record that would be signed,
#                        and stop. Nothing is signed, logged, committed or sent.
#   --first              also runs server/ops/install.sh on the machine (the user, the folders, the
#                        pinned programs, the units) and makes the empty database. It starts
#                        nothing: the settings come next (docs/variables.md).
#   --unsigned           DOEDESK_RELEASE_UNSIGNED=1. Emergency only: deploy without signing (cosign
#                        missing, the key or the transparency log unreachable). The record is still
#                        made, logged and served, without a signature; anyone checking sees that.
#                        Sign it afterwards: docs/releases.md, "After an unsigned deploy".
#   --allow-unpublished  DOEDESK_ALLOW_UNPUBLISHED=1. Send a public commit that no remote branch
#                        holds yet. Nobody else can check such a record until the commit is pushed.
#   --allow-drift        DOEDESK_ALLOW_DRIFT=1. From the private repository: send the public commit
#                        even though the private revision differs from it. What runs is then not
#                        what was tested in the private repository.
#
# Other settings: DOEDESK_RELEASE_KEY (the cosign private key file; default
# ~/.config/doedesk/release-cosign.key), DOEDESK_RELEASE_LOG (another folder for the log, for tests;
# nothing is committed then), DOEDESK_RELEASE_NO_TLOG=1 (tests only: sign without the transparency
# log). The login on the machine must be able to run sudo without a password. DOEDESK_SSH replaces
# the ssh command, for a test or an unusual connection.
set -euo pipefail

first="" ; unsigned="${DOEDESK_RELEASE_UNSIGNED:-}" ; unpublished="${DOEDESK_ALLOW_UNPUBLISHED:-}" ; drift_ok="${DOEDESK_ALLOW_DRIFT:-}"
layer="${DOEDESK_LAYER:-}" ; dry="${DOEDESK_DEPLOY_DRY_RUN:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --first) first="yes"; shift ;;
    --layer) layer="${2:?deploy: --layer needs a folder name}"; shift 2 ;;
    --dry-run) dry="1"; shift ;;
    --unsigned) unsigned="1"; shift ;;
    --allow-unpublished) unpublished="1"; shift ;;
    --allow-drift) drift_ok="1"; shift ;;
    --*) echo "deploy: unknown option $1" >&2; exit 2 ;;
    *) break ;;
  esac
done
ssh_command="${DOEDESK_SSH:-ssh}"
host="${1:?usage: deploy.sh [--first] [--unsigned] [--allow-unpublished] [--allow-drift] [--layer <folder>] [--dry-run] <ssh host> [revision]}"
root="$(git rev-parse --show-toplevel)"
here="$root/server/ops"
loud() { printf '\n\033[1;31m!!! %s\033[0m\n\n' "$*" >&2; }

# --- Which repository is sent -------------------------------------------------------------------
if [ -d "$root/releases" ]; then
  public="$root"
  public_revision="${2:-HEAD}"
else
  public="$(cd "${DOEDESK_PUBLIC_REPO:-$root/../doedesk-server}" 2>/dev/null && pwd)" || {
    echo "deploy: the public repository was not found (set DOEDESK_PUBLIC_REPO)." >&2; exit 1; }
  public_revision="${DOEDESK_PUBLIC_REVISION:-HEAD}"
fi
commit="$(git -C "$public" rev-parse --verify "$public_revision^{commit}")"
short="${commit:0:12}"
release="$(date -u +%Y%m%dT%H%M%SZ)-$short"

if [ -n "$(git -C "$public" status --porcelain -- server src migrations docs package.json)" ] && [ "$public_revision" = "HEAD" ]; then
  echo "deploy: there are uncommitted changes under server/, src/, migrations/ or docs/ in $public. Commit them, or name a revision." >&2
  exit 1
fi

# From the private repository: the code tested there must be the code sent.
compared="run from the public repository: nothing to compare"
if [ "$public" != "$root" ]; then
  private_revision="$(git rev-parse --verify "${2:-HEAD}^{commit}")"
  if [ -n "$(git -C "$root" status --porcelain -- server src migrations)" ] && [ "${2:-HEAD}" = "HEAD" ]; then
    echo "deploy: there are uncommitted changes under server/, src/ or migrations/ in $root. Commit them, or name a revision." >&2
    exit 1
  fi
  differences="$(diff <(git -C "$root" ls-tree -r "$private_revision" -- server src migrations) \
                      <(git -C "$public" ls-tree -r "$commit" -- server src migrations) || true)"
  if [ -n "$differences" ]; then
    echo "deploy: the private revision ${private_revision:0:12} and the public commit $short differ (< private, > public):" >&2
    echo "$differences" | grep '^[<>]' | awk '{print "  " $1 " " $NF}' >&2
    if [ -z "$drift_ok" ]; then
      echo "deploy: bring the public repository up to date (docs/releases.md, \"Keeping the public repository current\"), or use --allow-drift." >&2
      exit 1
    fi
    loud "DEPLOYING THE PUBLIC COMMIT $short, WHICH IS NOT THE PRIVATE REVISION ${private_revision:0:12} (--allow-drift)"
    compared="server/, src/ and migrations/ of the private revision ${private_revision:0:12} DIFFER from the public commit (--allow-drift)"
  else
    compared="server/, src/ and migrations/ of the private revision ${private_revision:0:12} are the public commit's, file for file"
  fi
fi

# A layer beside the release: private code, sent only when asked for, and never part of the commit.
if [ -n "$layer" ]; then
  [ "$public" != "$root" ] || { echo "deploy: --layer is for the private repository. The public one holds no layer." >&2; exit 2; }
  case "$layer" in
    server|src|migrations|docs|releases|test|*/*|.*) echo "deploy: a layer is one top-level folder beside the release, not $layer." >&2; exit 2 ;;
  esac
  [ -n "$(git -C "$root" ls-tree "$private_revision" -- "$layer/index.ts")" ] || { echo "deploy: there is no $layer/index.ts at the private revision ${private_revision:0:12}." >&2; exit 1; }
  if [ -n "$(git -C "$root" status --porcelain -- "$layer")" ] && [ "${2:-HEAD}" = "HEAD" ]; then
    echo "deploy: there are uncommitted changes under $layer/ in $root. Commit them, or name a revision." >&2
    exit 1
  fi
  # What is published stays the service alone: the public commit holds nothing of the layer.
  [ -z "$(git -C "$public" ls-tree "$commit" -- "$layer")" ] || { echo "deploy: the public commit $short holds a folder named $layer. A layer is private: it is never part of what is published." >&2; exit 1; }
fi

# A record nobody else can check is worth little: the commit must be on a remote branch.
if [ -z "$(git -C "$public" branch -r --contains "$commit" 2>/dev/null)" ]; then
  if [ -n "$dry" ]; then
    echo "deploy: (dry run) the public commit $short is on no remote branch; a real deploy stops here without --allow-unpublished." >&2
  elif [ -z "$unpublished" ]; then
    echo "deploy: the public commit $short is on no remote branch. Push it first (git -C $public push), or use --allow-unpublished." >&2
    exit 1
  else
    loud "THE PUBLIC COMMIT $short IS NOT PUSHED: NOBODY ELSE CAN CHECK THIS RELEASE UNTIL IT IS (--allow-unpublished)"
  fi
fi

# --- The archive and the record -----------------------------------------------------------------
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
archive_line="$(node "$here/release.mjs" archive --repo "$public" --commit "$commit" --out "$work/release.tar")"
read -r _ archive_sha archive_bytes <<< "$archive_line"
layer_sha="" ; layer_bytes=""
if [ -n "$layer" ]; then
  layer_line="$(node "$here/release.mjs" archive --repo "$root" --commit "$private_revision" --layer "$layer" --out "$work/layer.tar")"
  read -r _ layer_sha layer_bytes <<< "$layer_line"
fi
log="${DOEDESK_RELEASE_LOG:-$public/releases/log}"
[ -n "$dry" ] || mkdir -p "$log"
record_name="$(node "$here/release.mjs" record --commit "$commit" --sha256 "$archive_sha" --bytes "$archive_bytes" --release "$release" \
  --log "$log" --out "$work/RELEASE.json" ${DOEDESK_PUBLIC_URL:+--repository "$DOEDESK_PUBLIC_URL"} \
  ${layer:+--layer-name "$layer" --layer-sha256 "$layer_sha" --layer-bytes "$layer_bytes"})"
echo "deploy: release $release, public commit $short, archive sha256 $archive_sha${layer:+, with the layer $layer (sha256 $layer_sha)}"

if [ -n "$dry" ]; then
  # Top-level names only: enough to see what an archive holds and what it does not.
  holds() { tar -tf "$1" | grep -v '^pax_global_header$' | cut -d/ -f1 | sort -u | tr '\n' ' '; }
  echo "deploy: DRY RUN. Nothing was signed, logged, committed or sent."
  echo "  compared   $compared"
  echo "  release    public commit $commit"
  echo "             archive sha256 $archive_sha, $archive_bytes bytes, $(tar -tf "$work/release.tar" | grep -vc '/$') files, holding: $(holds "$work/release.tar")"
  if [ -n "$layer" ]; then
    echo "  layer      $layer, from the private revision ${private_revision:0:12}"
    echo "             archive sha256 $layer_sha, $layer_bytes bytes, $(tar -tf "$work/layer.tar" | grep -vc '/$') files, holding: $(holds "$work/layer.tar")"
  else
    echo "  layer      none: the machine would run the public commit and nothing else"
  fi
  echo "  record     as it would be signed:"
  sed 's/^/             /' "$work/RELEASE.json"
  exit 0
fi

if [ -n "$unsigned" ]; then
  loud "THIS RELEASE IS NOT SIGNED (--unsigned). ITS RECORD IS LOGGED AND SERVED WITHOUT A SIGNATURE. SIGN IT AS SOON AS YOU CAN: docs/releases.md, \"After an unsigned deploy\"."
else
  key="${DOEDESK_RELEASE_KEY:-$HOME/.config/doedesk/release-cosign.key}"
  [ -f "$key" ] || { echo "deploy: no signing key at $key (set DOEDESK_RELEASE_KEY). In an emergency: --unsigned." >&2; exit 1; }
  if ! node "$here/release.mjs" sign --record "$work/RELEASE.json" --key "$key" ${DOEDESK_RELEASE_NO_TLOG:+--no-tlog} >/dev/null; then
    echo "deploy: signing failed; nothing was sent. In an emergency: --unsigned." >&2
    exit 1
  fi
fi

cp "$work/RELEASE.json" "$log/$record_name"
[ -f "$work/RELEASE.sigstore.json" ] && cp "$work/RELEASE.sigstore.json" "$log/${record_name%.json}.sigstore.json"
if [ -z "${DOEDESK_RELEASE_LOG:-}" ]; then
  if git -C "$public" add -- releases/log && git -C "$public" commit --quiet -m "Release record ${record_name%.json}" -- releases/log; then
    echo "deploy: the record is committed to the log in $public. Push it: git -C $public push"
  else
    loud "THE RECORD COULD NOT BE COMMITTED TO THE LOG. IT IS IN $log/$record_name: COMMIT AND PUSH IT BY HAND."
  fi
fi

# --- Sending ------------------------------------------------------------------------------------
echo "deploy: sending $release to $host"
# The machine checks that what arrived is the archive in the record before it unpacks anything.
unpack="$(cat <<'UNPACK'
set -euo pipefail
folder="/opt/doedesk/api/releases/$1"
mkdir -p "$folder"
received="$(mktemp)"
gunzip -c > "$received"
if [ "$(sha256sum "$received" | cut -d' ' -f1)" != "$2" ]; then
  echo "deploy: the archive that arrived is not the one in the record; nothing was unpacked" >&2
  rm -rf "$received" "$folder"
  exit 1
fi
tar -xf "$received" -C "$folder" --no-same-owner
rm -f "$received"
echo "$3" > "$folder/REVISION"
UNPACK
)"
# Sent as base64 so that any login shell on the machine passes it to bash unchanged.
unpack_b64="$(printf '%s' "$unpack" | base64 | tr -d '\n')"
gzip -n -c "$work/release.tar" | $ssh_command "$host" "sudo bash -c \"\$(echo $unpack_b64 | base64 -d)\" unpack $release $archive_sha $short"
if [ -n "$layer" ]; then
  # The layer goes beside the release it was recorded with, checked the same way, and may put
  # files only in its own folder: it cannot replace a file of the public commit.
  unpack_layer="$(cat <<'UNPACK'
set -euo pipefail
folder="/opt/doedesk/api/releases/$1"
received="$(mktemp)"
gunzip -c > "$received"
if [ "$(sha256sum "$received" | cut -d' ' -f1)" != "$2" ]; then
  echo "deploy: the layer that arrived is not the one in the record; the release was removed" >&2
  rm -rf "$received" "$folder"
  exit 1
fi
if tar -tf "$received" | grep -v -e "^$3/" -e '^pax_global_header$' | grep -q .; then
  echo "deploy: the layer holds files outside $3/; the release was removed" >&2
  rm -rf "$received" "$folder"
  exit 1
fi
tar -xf "$received" -C "$folder" --no-same-owner
rm -f "$received"
UNPACK
)"
  unpack_layer_b64="$(printf '%s' "$unpack_layer" | base64 | tr -d '\n')"
  gzip -n -c "$work/layer.tar" | $ssh_command "$host" "sudo bash -c \"\$(echo $unpack_layer_b64 | base64 -d)\" unpack $release $layer_sha $layer"
fi
$ssh_command "$host" "sudo tee /opt/doedesk/api/releases/$release/RELEASE.json >/dev/null" < "$work/RELEASE.json"
if [ -f "$work/RELEASE.sigstore.json" ]; then
  $ssh_command "$host" "sudo tee /opt/doedesk/api/releases/$release/RELEASE.sigstore.json >/dev/null" < "$work/RELEASE.sigstore.json"
fi

$ssh_command "$host" sudo bash -s -- "$release" "$first" <<'REMOTE'
set -euo pipefail
release="$1"
first="${2:-}"
if [ -n "$first" ]; then
  chmod +x /opt/doedesk/api/releases/"$release"/server/ops/*.sh
  /opt/doedesk/api/releases/"$release"/server/ops/install.sh
fi
[ -d /var/lib/doedesk ] || { echo "deploy: this machine has not been prepared. Run: deploy.sh --first <host>" >&2; exit 1; }
releases=/opt/doedesk/api/releases
current=/opt/doedesk/api/current
previous="$(readlink -f "$current" 2>/dev/null || true)"
bun=/opt/doedesk/runtime/bun
database=/var/lib/doedesk/doedesk.sqlite
# Runs a command as the service's user. Migrations and snapshots need the database's path and nothing secret.
as_service() { systemd-run --quiet --wait --collect --pipe --uid=doedesk --gid=doedesk --property=UMask=0077 --setenv=DOEDESK_DATABASE="$database" --setenv=BUN_INSTALL_CACHE_DIR=/var/lib/doedesk/tmp --working-directory="$releases/$release" "$@"; }
healthy() {
  for _ in $(seq 1 30); do
    if curl --silent --max-time 3 http://127.0.0.1:8787/internal/health | grep -q '"ok":true'; then return 0; fi
    sleep 1
  done
  return 1
}

chmod -R go-w "$releases/$release"
chmod a+r "$releases/$release"/RELEASE*.json
chmod +x "$releases/$release"/server/ops/*.sh
pending="$(as_service "$bun" "$releases/$release/server/migrate.ts" --status | sed -n 's/^pending: //p')"
if [ -n "$first" ]; then
  as_service "$bun" "$releases/$release/server/migrate.ts"
  ln -sfn "$releases/$release" "$current"
  echo "deploy: $release is in place and the database is made. Nothing was started: fill /etc/doedesk/api.env next."
  exit 0
elif [ -n "$pending" ] && [ "$pending" != "none" ]; then
  echo "deploy: migrations to apply: $pending"
  copy="/var/lib/doedesk/before-migration/$release.sqlite"
  if [ -e "$database" ]; then as_service "$bun" "$releases/$release/server/snapshot.ts" "$copy"; fi
  systemctl stop doedesk-api.service
  as_service "$bun" "$releases/$release/server/migrate.ts"
  ln -sfn "$releases/$release" "$current"
  systemctl start doedesk-api.service
else
  ln -sfn "$releases/$release" "$current"
  # `restart` sends SIGTERM first: requests in flight are answered before the new code starts.
  systemctl is-enabled --quiet doedesk-api.service && systemctl restart doedesk-api.service || echo "deploy: doedesk-api is not enabled yet; not started"
fi

if systemctl is-enabled --quiet doedesk-api.service && ! healthy; then
  echo "deploy: the API is not well on $release" >&2
  journalctl --namespace doedesk -u doedesk-api.service -n 20 --no-pager >&2 || true
  if [ -n "$previous" ] && [ -d "$previous" ]; then
    ln -sfn "$previous" "$current"
    systemctl restart doedesk-api.service
    echo "deploy: put back $(basename "$previous")" >&2
  fi
  exit 1
fi
systemctl daemon-reload
# Keep five releases.
ls -1d "$releases"/*/ | sort | head -n -5 | while read -r old; do [ "$(readlink -f "$current")" = "${old%/}" ] || rm -rf "$old"; done
echo "deploy: $release is live"
REMOTE
[ -n "$unsigned" ] && loud "REMINDER: $release IS LIVE WITHOUT A SIGNATURE. Sign its record: docs/releases.md, \"After an unsigned deploy\"."
exit 0
