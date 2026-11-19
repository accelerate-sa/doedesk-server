#!/bin/sh
# Computes the SEV-SNP launch measurements an Oracle Cloud confidential VM (VM.Standard.E5.Flex or
# E6.Flex) reports, from Oracle's public firmware package, without trusting Oracle's own list.
#
#   server/attest/expected-measurements.sh 20260522-1 [E5|E6] [max OCPUs, default 4]
#
# Prints "<ocpus> <vcpus> <measurement>" lines. On 19 November 2026 these matched, byte for byte,
# the reference values Oracle ships in the veraison-cocli package (/usr/share/veraison-cocli/RV) and
# the reports of live VMs.
#
# What the number covers: Oracle's guest firmware (OVMF.cc.fd from edk2-ovmf), the vCPU count and
# the CPU model. Nothing from the disk: not the kernel, not the operating system, not DoeDesk.
#
# Needs: curl, bsdtar (macOS has it), and sev-snp-measure (pip install sev-snp-measure), run from
# a working folder of its own (downloaded files are untrusted input).
set -eu

version=${1:?firmware version, as in the edk2-ovmf package: e.g. 20260522-1}
shape=${2:-E5}
max_ocpus=${3:-4}
case "$shape" in
  E5) cpu=EPYC-Genoa ;;
  E6) cpu=EPYC-Turin ;;
  *) echo "shape must be E5 or E6" >&2; exit 2 ;;
esac

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
rpm="edk2-ovmf-${version}.el9.noarch.rpm"
curl -sSfL -o "$work/$rpm" "https://yum.oracle.com/repo/OracleLinux/OL9/kvm/utils/x86_64/getPackage/$rpm"
(cd "$work" && bsdtar -xf "$rpm" ./usr/share/edk2/ovmf/OVMF.cc.fd)
fd="$work/usr/share/edk2/ovmf/OVMF.cc.fd"
echo "# $rpm OVMF.cc.fd sha256 $(shasum -a 256 "$fd" | cut -d' ' -f1)" >&2

o=1
while [ "$o" -le "$max_ocpus" ]; do
  v=$((o * 2)) # one OCPU is two vCPUs (SMT on, Oracle's default)
  printf '%s %s %s\n' "$o" "$v" "$(sev-snp-measure --mode snp --vcpus "$v" --vcpu-type "$cpu" --vmm-type QEMU --ovmf "$fd")"
  o=$((o + 1))
done
