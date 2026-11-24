#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Accelerate Technology Establishment
# Prepares a machine to run the DoeDesk Cloud API. Run as root, from an unpacked release:
#
#   sudo server/ops/install.sh
#
# Safe to run again: it creates what is missing and replaces the unit files and the pinned
# programs, and never touches the database, the settings in /etc/doedesk, the firewall, DNS or
# Caddy's configuration. It starts nothing that needs settings: those come next (docs/variables.md).
#
# What it makes:
#   user and group  doedesk (no shell, no home, no sudo)
#   /opt/doedesk/api/releases/   the code, one folder per release; /opt/doedesk/api/current points at one
#   /opt/doedesk/runtime/        bun, litestream and rclone, at pinned versions with checked checksums
#   /etc/doedesk/                settings and secrets, root only (the example files are put there if absent)
#   /var/lib/doedesk/            the database and what belongs to it, the service's user only
#   systemd units and timers     from server/ops/systemd
#
# DOEDESK_DATA_DIR=/some/mount moves the data folder (default /var/lib/doedesk is then a link to it).
set -euo pipefail

[ "$(id -u)" = "0" ] || { echo "install: run as root" >&2; exit 1; }
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

BUN_VERSION="1.4.3"
LITESTREAM_VERSION="0.5.18"
RCLONE_VERSION="1.76.0"
case "$(uname -m)" in
  x86_64)
    litestream_asset="litestream-${LITESTREAM_VERSION}-linux-x86_64.tar.gz"
    litestream_sha="d3687b9fd0f2e9426bbd3da828429ff3f1dfc5c9b74d54fdf028e4ee510e7dea"
    rclone_asset="rclone-v${RCLONE_VERSION}-linux-amd64"; rclone_sha="b00f00b3266c3764413afe599d3ec316f6f43b3e0ea8a0bc1d186d2133e46df7"
    # The ordinary build needs a processor with AVX2; the baseline build runs on any.
    if grep -q avx2 /proc/cpuinfo; then bun_asset="bun-linux-x64"; bun_sha="3e730528d89775f03f87f05c06787c4df4099d0a37f3f252e7b829cb23816e18"
    else bun_asset="bun-linux-x64-baseline"; bun_sha="1fc2edac843102909e3a1be1d8d9802cc6071cf074e67e88231f4ffe0f8b397b"; fi ;;
  aarch64|arm64)
    litestream_asset="litestream-${LITESTREAM_VERSION}-linux-arm64.tar.gz"
    litestream_sha="922a09e6a7ac67f2095571894dc6382e94e1dd4cdd9674883ddf1a8e74ab982d"
    rclone_asset="rclone-v${RCLONE_VERSION}-linux-arm64"; rclone_sha="ee169016675e23a69d77240565133ff7dbc9b33d16fa8f7053d4af39f1eaeb78"
    bun_asset="bun-linux-aarch64"; bun_sha="efa9813da5ed72423bf847f916e8d2c47c0d776add972354026a75e10da9aa21" ;;
  *) echo "install: no pinned programs for $(uname -m)" >&2; exit 1 ;;
esac

# --- Packages the scripts use ------------------------------------------------------------------
need=()
for program in curl unzip gzip age python3 openssl; do command -v "$program" >/dev/null 2>&1 || need+=("$program"); done
if [ ${#need[@]} -gt 0 ]; then
  if command -v apt-get >/dev/null 2>&1; then DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${need[@]}"
  elif command -v dnf >/dev/null 2>&1; then dnf install -y -q "${need[@]}"
  else echo "install: please install: ${need[*]}" >&2; exit 1; fi
fi

# --- The user, and the folders -----------------------------------------------------------------
getent group doedesk >/dev/null || groupadd --system doedesk
id doedesk >/dev/null 2>&1 || useradd --system --gid doedesk --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin doedesk

install -d -o root -g root -m 0755 /opt/doedesk /opt/doedesk/api /opt/doedesk/api/releases /opt/doedesk/runtime
install -d -o root -g root -m 0700 /etc/doedesk
data="${DOEDESK_DATA_DIR:-/var/lib/doedesk}"
install -d -o doedesk -g doedesk -m 0700 "$data"
if [ "$data" != "/var/lib/doedesk" ] && [ ! -e /var/lib/doedesk ]; then ln -s "$data" /var/lib/doedesk; fi
install -d -o doedesk -g doedesk -m 0700 /var/lib/doedesk/geo /var/lib/doedesk/tmp /var/lib/doedesk/before-migration /var/lib/doedesk/replica

# --- The pinned programs -----------------------------------------------------------------------
fetch() { # url, sha256, destination
  local url="$1" sha="$2" to="$3"
  curl --fail --silent --show-error --location --max-time 600 --output "$to" "$url"
  echo "$sha  $to" | sha256sum --check --quiet || { echo "install: $url does not match its pinned checksum" >&2; rm -f "$to"; exit 1; }
}
scratch="$(mktemp -d)"; trap 'rm -rf "$scratch"' EXIT
if [ ! -x "/opt/doedesk/runtime/bun-$BUN_VERSION/bun" ]; then
  fetch "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/$bun_asset.zip" "$bun_sha" "$scratch/bun.zip"
  unzip -q "$scratch/bun.zip" -d "$scratch"
  install -d -m 0755 "/opt/doedesk/runtime/bun-$BUN_VERSION"
  install -o root -g root -m 0755 "$scratch/$bun_asset/bun" "/opt/doedesk/runtime/bun-$BUN_VERSION/bun"
fi
ln -sfn "bun-$BUN_VERSION/bun" /opt/doedesk/runtime/bun
if [ ! -x "/opt/doedesk/runtime/litestream-$LITESTREAM_VERSION/litestream" ]; then
  fetch "https://github.com/benbjohnson/litestream/releases/download/v$LITESTREAM_VERSION/$litestream_asset" "$litestream_sha" "$scratch/litestream.tar.gz"
  install -d -m 0755 "/opt/doedesk/runtime/litestream-$LITESTREAM_VERSION"
  tar -xzf "$scratch/litestream.tar.gz" -C "/opt/doedesk/runtime/litestream-$LITESTREAM_VERSION" litestream
  chown root:root "/opt/doedesk/runtime/litestream-$LITESTREAM_VERSION/litestream"
fi
ln -sfn "litestream-$LITESTREAM_VERSION/litestream" /opt/doedesk/runtime/litestream
# rclone carries the backups to Object Storage, signing in as the machine itself.
if [ ! -x "/opt/doedesk/runtime/rclone-$RCLONE_VERSION/rclone" ]; then
  fetch "https://downloads.rclone.org/v$RCLONE_VERSION/$rclone_asset.zip" "$rclone_sha" "$scratch/rclone.zip"
  unzip -q "$scratch/rclone.zip" -d "$scratch"
  install -d -m 0755 "/opt/doedesk/runtime/rclone-$RCLONE_VERSION"
  install -o root -g root -m 0755 "$scratch/$rclone_asset/rclone" "/opt/doedesk/runtime/rclone-$RCLONE_VERSION/rclone"
fi
ln -sfn "rclone-$RCLONE_VERSION/rclone" /opt/doedesk/runtime/rclone

# --- Settings: the examples, only where nothing is there yet -------------------------------------
[ -e /etc/doedesk/api.env ] || install -o root -g root -m 0600 "$here/api.env.example" /etc/doedesk/api.env
for name in backup check; do [ -e "/etc/doedesk/$name.env" ] || install -o root -g root -m 0600 /dev/null "/etc/doedesk/$name.env"; done

# --- systemd ------------------------------------------------------------------------------------
install -o root -g root -m 0644 "$here"/systemd/*.service "$here"/systemd/*.timer /etc/systemd/system/
install -o root -g root -m 0644 "$here/systemd/journald@doedesk.conf" /etc/systemd/journald@doedesk.conf
# A data folder elsewhere: the units may write the real folder, not only the link to it.
if [ "$data" != "/var/lib/doedesk" ]; then
  for unit in doedesk-api doedesk-nightly doedesk-geo-update doedesk-litestream doedesk-replica-sync doedesk-snapshot doedesk-restore-test doedesk-check "doedesk-alert@"; do
    install -d -m 0755 "/etc/systemd/system/$unit.service.d"
    printf '[Service]\nReadWritePaths=%s\n' "$data" > "/etc/systemd/system/$unit.service.d/data-folder.conf"
  done
fi
systemctl daemon-reload
# The journal of its own that the units write to.
systemctl enable --now systemd-journald@doedesk.socket >/dev/null 2>&1 || true

echo "installed: bun $BUN_VERSION, litestream $LITESTREAM_VERSION, rclone $RCLONE_VERSION, user doedesk, data in $data"
echo "next: the settings (docs/variables.md), then the first start"
