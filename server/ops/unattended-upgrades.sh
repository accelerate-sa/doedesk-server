#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Accelerate Technology Establishment
# Turns on automatic security updates, and a reboot at a fixed quiet hour when one is needed.
# Ubuntu and Debian (unattended-upgrades) or Oracle Linux and the like (dnf-automatic). Run as root.
#
# A reboot takes the API away for two to five minutes. It happens only when an update asks for
# one (a new kernel, mostly), at 01:30 UTC (04:30 in Riyadh), the quietest hour. To choose the
# moment yourself instead, run with --no-reboot and reboot from outside (server/ops/outside/power.sh).
#
# On a confidential VM (AMD SEV-SNP) a reboot started inside the machine never completes on Oracle:
# the machine stays dead while Oracle shows it RUNNING. There
# the reboot is always off, whatever is asked, and the reboot is done from outside
# (server/ops/outside/power.sh).
set -euo pipefail
[ "$(id -u)" = "0" ] || { echo "run as root" >&2; exit 1; }
reboot="true"; [ "${1:-}" != "--no-reboot" ] || reboot="false"
if [ -e /dev/sev-guest ] || dmesg 2>/dev/null | grep -q 'Memory Encryption Features active:.*SEV-SNP'; then
  [ "$reboot" = "false" ] || echo "unattended-upgrades: this is a confidential VM (SEV-SNP): no reboot from inside; reboots are done from outside"
  reboot="false"
fi

if command -v apt-get >/dev/null 2>&1; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq unattended-upgrades
  cat > /etc/apt/apt.conf.d/20auto-upgrades <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
CONF
  cat > /etc/apt/apt.conf.d/52doedesk-unattended <<CONF
// DoeDesk: security updates by themselves; a reboot, when one is needed, at a fixed quiet hour.
Unattended-Upgrade::Automatic-Reboot "$reboot";
Unattended-Upgrade::Automatic-Reboot-Time "01:30";
Unattended-Upgrade::Automatic-Reboot-WithUsers "true";
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
CONF
  systemctl enable --now unattended-upgrades.service apt-daily.timer apt-daily-upgrade.timer >/dev/null
  echo "automatic security updates: on (unattended-upgrades); reboot when needed at 01:30 UTC: $reboot"
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y -q dnf-automatic
  sed -i -e 's/^upgrade_type *=.*/upgrade_type = security/' -e 's/^apply_updates *=.*/apply_updates = yes/' /etc/dnf/automatic.conf
  if grep -q '^reboot *=' /etc/dnf/automatic.conf; then sed -i "s/^reboot *=.*/reboot = $([ "$reboot" = true ] && echo when-needed || echo never)/" /etc/dnf/automatic.conf; fi
  mkdir -p /etc/systemd/system/dnf-automatic.timer.d
  printf '[Timer]\nOnCalendar=\nOnCalendar=*-*-* 01:30:00 UTC\nRandomizedDelaySec=0\n' > /etc/systemd/system/dnf-automatic.timer.d/doedesk.conf
  systemctl daemon-reload
  systemctl enable --now dnf-automatic.timer >/dev/null
  echo "automatic security updates: on (dnf-automatic, at 01:30 UTC); reboot when needed: $reboot"
else
  echo "no apt-get or dnf here: set up automatic updates by hand" >&2; exit 1
fi
