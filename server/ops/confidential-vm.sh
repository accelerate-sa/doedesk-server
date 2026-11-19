#!/usr/bin/env bash
# Settings that a confidential VM (AMD SEV-SNP on Oracle) needs and
# an ordinary machine does not. Run as root, on the machine, after install.sh. Safe to run again.
#
#   sudo /opt/doedesk/api/current/server/ops/confidential-vm.sh           apply
#   sudo /opt/doedesk/api/current/server/ops/confidential-vm.sh --show    print the state, change nothing
#
# What it does, and why:
#   1. No reboot from inside. On Oracle a reboot or power-off started inside an SNP guest never
#      completes: the console says "reboot: Restarting system", the machine is dead, and Oracle
#      still shows it RUNNING. So reboot.target, ctrl-alt-del.target and kexec.target are masked
#      (`systemctl reboot` and `sudo reboot` then fail at once instead of killing the machine), and
#      automatic updates never reboot (unattended-upgrades.sh). Reboots are Oracle's SOFTRESET or
#      RESET, driven from outside: server/ops/outside/power.sh. `reboot -f` bypasses systemd and
#      still hangs the machine: never use it.
#      Oracle's SOFTRESET presses the ACPI power button, which is poweroff.target, not masked.
#   2. Oracle's cloud agent is removed. Its Run Command plugin gives anyone holding the right
#      Oracle permission a root shell; disabling the plugin in the instance's settings is a switch
#      the same people can turn back on, so the agent itself goes. Nothing here uses it (no OS
#      Management, no Bastion, no metrics: health is watched from outside).
#   3. No memory reaches the disk: core dumps are discarded by the kernel (for every process on the
#      machine, whatever runs it), Ubuntu's crash reporter is off, and there is no swap. The
#      memory is encrypted against Oracle's host; a core file or a swap page on the boot volume
#      would not be.
#   4. A note at login, so nobody types `reboot` by habit.
set -euo pipefail
[ "$(id -u)" = "0" ] || { echo "confidential-vm: run as root" >&2; exit 1; }
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

snp() { [ -e /dev/sev-guest ] || dmesg 2>/dev/null | grep -q 'Memory Encryption Features active:.*SEV-SNP'; }

show() {
  if snp; then echo "memory encryption: SEV-SNP active ($(dmesg 2>/dev/null | grep -o 'SNP running at VMPL[0-9]' | head -1 || true))"
  else echo "memory encryption: NOT active (this is not a confidential VM)"; fi
  for unit in reboot.target ctrl-alt-del.target kexec.target; do echo "$unit: $(systemctl is-enabled "$unit" 2>/dev/null || true)"; done
  if command -v snap >/dev/null 2>&1 && snap list oracle-cloud-agent >/dev/null 2>&1; then echo "oracle-cloud-agent: INSTALLED"
  elif systemctl list-unit-files 2>/dev/null | grep -q '^oracle-cloud-agent'; then echo "oracle-cloud-agent: INSTALLED (package)"
  else echo "oracle-cloud-agent: not installed"; fi
  echo "core dumps: $(cat /proc/sys/kernel/core_pattern)"
  echo "crash reporter: $(systemctl is-enabled apport.service 2>/dev/null || true)"
  echo "swap: $(swapon --noheadings --show=NAME 2>/dev/null | tr '\n' ' ' | sed 's/ $//' | grep . || echo none)"
  echo "automatic reboot after updates: $(sed -n 's/^Unattended-Upgrade::Automatic-Reboot "\(.*\)";/\1/p' /etc/apt/apt.conf.d/52doedesk-unattended 2>/dev/null || echo 'not set up')"
  if [ -e /var/run/reboot-required ]; then echo "reboot required: yes, since $(date -u -r /var/run/reboot-required +%FT%TZ)"; else echo "reboot required: no"; fi
}

if [ "${1:-}" = "--show" ]; then show; exit 0; fi
[ -z "${1:-}" ] || { echo "usage: confidential-vm.sh [--show]" >&2; exit 2; }
snp || { echo "confidential-vm: SEV-SNP is not active on this machine; nothing done" >&2; exit 1; }

# 1. No reboot from inside.
systemctl mask --quiet reboot.target ctrl-alt-del.target kexec.target
"$here/unattended-upgrades.sh" --no-reboot

# 2. Oracle's cloud agent.
if command -v snap >/dev/null 2>&1 && snap list oracle-cloud-agent >/dev/null 2>&1; then
  snap remove --purge oracle-cloud-agent >/dev/null
  echo "confidential-vm: oracle-cloud-agent removed"
fi

# 3. No memory on disk.
# The crash reporter first: stopping it puts the kernel's core pattern back to "core".
if systemctl list-unit-files apport.service >/dev/null 2>&1; then
  systemctl disable --now --quiet apport.service 2>/dev/null || true
  [ ! -f /etc/default/apport ] || sed -i 's/^enabled=.*/enabled=0/' /etc/default/apport
fi
cat > /etc/sysctl.d/60-doedesk-confidential.conf <<'CONF'
# DoeDesk confidential VM (server/ops/confidential-vm.sh): no process memory is written to disk.
kernel.core_pattern=|/bin/false
fs.suid_dumpable=0
CONF
sysctl --quiet --load /etc/sysctl.d/60-doedesk-confidential.conf
install -d -m 0755 /etc/security/limits.d
printf '* hard core 0\n* soft core 0\n' > /etc/security/limits.d/60-doedesk-no-core.conf
if [ -n "$(swapon --noheadings --show=NAME 2>/dev/null)" ]; then
  echo "confidential-vm: warning: swap is on ($(swapon --noheadings --show=NAME | tr '\n' ' ')); turn it off and remove it from /etc/fstab" >&2
fi

# 4. The note at login.
cat > /etc/update-motd.d/99-doedesk-confidential <<'MOTD'
#!/bin/sh
echo
echo "  DoeDesk confidential VM (AMD SEV-SNP). Do NOT reboot or power off from here: on Oracle it"
echo "  never comes back. Reboots are done from outside: server/ops/outside/power.sh."
[ -e /var/run/reboot-required ] && echo "  A reboot is waiting for a security update, since $(date -u -r /var/run/reboot-required '+%F %H:%M UTC')."
echo
MOTD
chmod 0755 /etc/update-motd.d/99-doedesk-confidential

show
