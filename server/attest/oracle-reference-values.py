# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Accelerate Technology Establishment
"""Lists the SEV-SNP launch measurements in Oracle's reference-value files.

Oracle ships them in the veraison-cocli package (Oracle Linux 9, repository ol9_oci_included or
oci_included): /usr/share/veraison-cocli/RV/<E5|E6>-EPYC-<Genoa|Turin>-edk2-ovmf-<version>-OL9-v3.cbor,
one CoRIM file per firmware build, 126 entries each (one per vCPU count, 2 vCPUs first).

    python3 -I server/attest/oracle-reference-values.py RV/*.cbor

Needs cbor2 (pip install cbor2).
"""

import re
import sys

import cbor2

# Inside each CoMID the measurement is a tagged 48-byte string: tag 560 (0xd9 0x0230), bytes(48).
MEASUREMENT = re.compile(rb"\xd9\x02\x30\x58\x30(.{48})", re.S)

for path in sys.argv[1:]:
    with open(path, "rb") as f:
        corim = cbor2.load(f)
    entries = corim.value[1]  # tag 501 (CoRIM), key 1: the CoMIDs
    print(f"# {path.rsplit('/', 1)[-1]}: {len(entries)} entries")
    for i, comid in enumerate(entries):
        raw = comid.value if isinstance(comid.value, bytes) else cbor2.dumps(comid.value)
        m = MEASUREMENT.search(raw)
        print(f"{i + 1} {(i + 1) * 2} {m.group(1).hex() if m else '?'}")
