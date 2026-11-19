#!/usr/bin/env bash
# The machine's own firewall: everything coming in is dropped except SSH, and, once the service is
# public, the web ports. Run as root.
#
# Where ufw is already the machine's firewall (Ubuntu, and the machine in Jeddah as it was handed
# over), this script works through ufw and adds no second set of rules beside it. Elsewhere it
# keeps one nftables table of its own.
#
#   firewall.sh            SSH only: the state for the rehearsal. The API is reached through an SSH tunnel.
#   firewall.sh --web      SSH, 80 and 443: the state for the switch. 80 is for certificates and redirects.
#   firewall.sh --show     print the rules in force and change nothing
#
# This is the second of two walls. The first is Oracle's network security group, which must allow
# the same ports. The API (8787) and the engine listen on the machine only and are not reachable
# from outside either way: nothing here opens a port for them.
#
# Other software on the machine may keep tables of its own; this script owns one table of its own
# ("doedesk") and leaves every other table alone.
set -euo pipefail
[ "$(id -u)" = "0" ] || { echo "firewall: run as root" >&2; exit 1; }

# --- ufw, where it is in charge -------------------------------------------------------------------
# SSH's rule is left exactly as it is (it may be narrowed to one address, and this script must
# never lock its caller out); only the two web ports are added or taken away.
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then
  case "${1:-}" in
    --show) ufw status verbose; exit 0 ;;
    --web) ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; echo "firewall (ufw): in force: SSH as it was, 80, 443" ;;
    "") ufw --force delete allow 80/tcp >/dev/null 2>&1 || true; ufw --force delete allow 443/tcp >/dev/null 2>&1 || true; echo "firewall (ufw): in force: SSH as it was; 80 and 443 closed" ;;
    *) echo "usage: firewall.sh [--web|--show]" >&2; exit 2 ;;
  esac
  ufw status | grep -q '^22/tcp .*ALLOW' || echo "firewall: warning: ufw has no rule allowing SSH (22/tcp)" >&2
  exit 0
fi

command -v nft >/dev/null 2>&1 || { echo "firewall: nftables (nft) is not installed" >&2; exit 1; }

if [ "${1:-}" = "--show" ]; then nft list table inet doedesk; exit 0; fi
web=""
[ "${1:-}" != "--web" ] || web="tcp dport { 80, 443 } accept"
ssh_from="${DOEDESK_SSH_FROM:-}"   # e.g. "100.64.0.0/10" to allow SSH from one network only
ssh_rule="tcp dport 22 accept"
[ -z "$ssh_from" ] || ssh_rule="ip saddr { $ssh_from } tcp dport 22 accept"

nft -f - <<RULES
table inet doedesk
delete table inet doedesk
table inet doedesk {
	chain input {
		type filter hook input priority filter; policy drop;
		ct state established,related accept
		ct state invalid drop
		iifname "lo" accept
		meta l4proto { icmp, ipv6-icmp } accept
		$ssh_rule
		$web
	}
}
RULES
mkdir -p /etc/nftables.d
nft list table inet doedesk > /etc/nftables.d/doedesk.nft
if [ -f /etc/nftables.conf ] && ! grep -q 'nftables.d/doedesk.nft' /etc/nftables.conf; then echo 'include "/etc/nftables.d/doedesk.nft"' >> /etc/nftables.conf; fi
systemctl enable nftables.service >/dev/null 2>&1 || true
echo "firewall: in force: SSH${ssh_from:+ from $ssh_from}${web:+, 80, 443}"
