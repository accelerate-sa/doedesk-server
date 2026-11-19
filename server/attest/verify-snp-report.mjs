#!/usr/bin/env node
// Checks an AMD SEV-SNP attestation report the way the DoeDesk Mac app would, with nothing but
// Node's own crypto. Written for the confidential-VM spike; it is the reference for the app's
// check, not a library.
//
//   node server/attest/verify-snp-report.mjs --report r.bin --vcek vcek.pem --ask ask.pem --ark ark.pem \
//        [--expect-report-data <128 hex>] [--measurements allow.txt] [--min-tcb bl=12,tee=0,snp=29,ucode=88]
//
// It prints every field it read and every check it made, and exits non-zero on the first failure.
// The AMD root is pinned below: an ARK that is merely self-signed is not enough.

import { X509Certificate, verify, createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// SHA-256 of the DER of AMD's Genoa ARK (https://kdsintf.amd.com/vcek/v1/Genoa/cert_chain),
// fetched on 19 November 2026 from the Mac and, separately, from inside an Oracle confidential VM.
const PINNED_ARK_SHA256 = {
  Genoa: "4c6598d19c18719c5dfd4a7d335f674e5bfe1d8f800cea2cf270c10d103db2f1",
  Turin: "1f084161a44bb6d93778a904877d4819cafa5d05ef4193b2ded9dd9c73dd3f6a",
};

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};
const ok = (msg) => console.log(`ok    ${msg}`);

const report = readFileSync(args.report);
if (report.length !== 0x4a0) fail(`report is ${report.length} bytes, expected 1184`);

const u32 = (o) => report.readUInt32LE(o);
const u64 = (o) => report.readBigUInt64LE(o);
const hex = (o, n) => report.subarray(o, o + n).toString("hex");

const version = u32(0x00);
const policy = u64(0x08);
const vmpl = u32(0x30);
const sigAlgo = u32(0x34);
const reportData = hex(0x50, 64);
const measurement = hex(0x90, 48);
const hostData = hex(0xc0, 32);
const idKeyDigest = hex(0xe0, 48);
const reportIdMa = hex(0x160, 32);
const chipId = hex(0x1a0, 64);
const family = report[0x188];

// TCB layout differs by generation: Genoa (family 0x19, model 0x10-0x1f) keeps the old layout,
// Turin (family 0x1a) adds FMC and moves the fields.
const turin = family === 0x1a;
const tcb = (o) =>
  turin
    ? { fmc: report[o], bl: report[o + 1], tee: report[o + 2], snp: report[o + 3], ucode: report[o + 7] }
    : { bl: report[o], tee: report[o + 1], snp: report[o + 6], ucode: report[o + 7] };
const reportedTcb = tcb(0x180);
const currentTcb = tcb(0x38);
const committedTcb = tcb(0x1e0);
const launchTcb = tcb(0x1f0);

console.log(
  JSON.stringify(
    {
      version,
      policy: `0x${policy.toString(16)}`,
      vmpl,
      measurement,
      reportData,
      hostData,
      idKeyDigest,
      chipId,
      reportedTcb,
      currentTcb,
      committedTcb,
      launchTcb,
    },
    null,
    1,
  ),
);

// 1. The certificate chain: pinned ARK -> ASK -> VCEK.
const ark = new X509Certificate(readFileSync(args.ark));
const ask = new X509Certificate(readFileSync(args.ask));
const vcek = new X509Certificate(readFileSync(args.vcek));
const generation = turin ? "Turin" : "Genoa";
const arkSha = createHash("sha256").update(ark.raw).digest("hex");
if (PINNED_ARK_SHA256[generation] !== arkSha) fail(`ARK fingerprint ${arkSha} is not AMD's pinned ${generation} ARK`);
ok(`ARK is AMD's pinned ${generation} root (${arkSha.slice(0, 16)}...)`);
if (!ark.verify(ark.publicKey)) fail("ARK is not self-signed");
if (!ask.verify(ark.publicKey)) fail("ASK is not signed by the ARK");
ok("ASK signed by ARK");
if (!vcek.verify(ask.publicKey)) fail("VCEK is not signed by the ASK");
ok("VCEK signed by ASK");
const now = Date.now();
for (const [name, c] of [["ARK", ark], ["ASK", ask], ["VCEK", vcek]]) {
  if (now < Date.parse(c.validFrom) || now > Date.parse(c.validTo)) fail(`${name} is outside its validity period`);
}
ok("certificates within their validity periods");

// 2. The VCEK must be the one for this chip and this reported TCB (AMD writes both into it).
const der = vcek.raw;
const extValue = (oidTail) => {
  // AMD's OIDs are 1.3.6.1.4.1.3704.1.<tail>; encoded 2b 06 01 04 01 9c 78 01 <tail bytes>.
  const oid = Buffer.from([0x06, 0x09 + oidTail.length - 1, 0x2b, 0x06, 0x01, 0x04, 0x01, 0x9c, 0x78, 0x01, ...oidTail]);
  const at = der.indexOf(oid);
  if (at < 0) return null;
  let p = at + oid.length;
  if (der[p] === 0x01) p += 3; // optional "critical" BOOLEAN
  if (der[p] !== 0x04) return null; // OCTET STRING
  const len = der[p + 1];
  return der.subarray(p + 2, p + 2 + len);
};
const intIn = (b) => {
  // An INTEGER inside the OCTET STRING: 02 len value
  if (!b || b[0] !== 0x02) return null;
  return b.subarray(2, 2 + b[1]).reduce((v, x) => v * 256 + x, 0);
};
const hwid = extValue([0x04]);
if (!hwid) fail("VCEK carries no hwID extension");
const hwidBytes = hwid[0] === 0x04 ? hwid.subarray(2) : hwid; // AMD wraps it in a second OCTET STRING in some certs
if (hwidBytes.toString("hex") !== chipId) fail("VCEK is for another chip");
ok("VCEK is for the chip in the report");
const certTcb = { bl: intIn(extValue([0x03, 0x01])), tee: intIn(extValue([0x03, 0x02])), snp: intIn(extValue([0x03, 0x03])), ucode: intIn(extValue([0x03, 0x08])) };
for (const k of ["bl", "tee", "snp", "ucode"]) {
  if (certTcb[k] !== reportedTcb[k]) fail(`VCEK ${k}=${certTcb[k]} but report says ${reportedTcb[k]}`);
}
ok(`VCEK TCB matches the reported TCB ${JSON.stringify(certTcb)}`);

// 3. The report's signature (ECDSA P-384 over bytes 0x000-0x29f; R and S little-endian, 72 bytes each).
if (sigAlgo !== 1) fail(`signature algorithm ${sigAlgo} is not ECDSA P-384 with SHA-384`);
const r = Buffer.from(report.subarray(0x2a0, 0x2a0 + 48)).reverse();
const s = Buffer.from(report.subarray(0x2e8, 0x2e8 + 48)).reverse();
const signed = verify("sha384", report.subarray(0, 0x2a0), { key: vcek.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.concat([r, s]));
if (!signed) fail("report signature does not verify with the VCEK");
ok("report signed by the VCEK");

// 4. Policy: no debugging, no migration agent, the guest itself asked for the report.
const DEBUG = 1n << 19n;
const MIGRATE_MA = 1n << 18n;
if (policy & DEBUG) fail("policy allows debugging (the host could read the guest's memory)");
ok("debugging not allowed");
if (policy & MIGRATE_MA) fail("policy allows a migration agent");
if (!/^f+$/.test(reportIdMa)) fail("a migration agent is bound to this guest");
ok("no migration agent");
if (vmpl !== 0) fail(`report came from VMPL ${vmpl}, expected 0 (no paravisor on OCI)`);
ok("requested at VMPL 0");

// 5. TCB minimum (refuse firmware AMD has since fixed).
if (args["min-tcb"]) {
  const min = Object.fromEntries(args["min-tcb"].split(",").map((kv) => kv.split("=")).map(([k, v]) => [k, Number(v)]));
  for (const [k, v] of Object.entries(min)) if (reportedTcb[k] < v) fail(`reported TCB ${k}=${reportedTcb[k]} below the minimum ${v}`);
  ok(`reported TCB at or above ${args["min-tcb"]}`);
}

// 6. Measurement allow-list.
if (args.measurements) {
  const allow = readFileSync(args.measurements, "utf8").split(/\s+/).filter((l) => /^[0-9a-f]{96}$/i.test(l)).map((l) => l.toLowerCase());
  if (!allow.includes(measurement)) fail(`measurement ${measurement.slice(0, 16)}... is not on the allow-list`);
  ok("measurement on the allow-list");
}

// 7. Freshness and binding: REPORT_DATA must be exactly what the client computed from its nonce.
if (args["expect-report-data"]) {
  if (args["expect-report-data"].toLowerCase() !== reportData) fail("REPORT_DATA is not the expected binding of nonce and key");
  ok("REPORT_DATA binds the client's nonce and the server key");
}
console.log("all checks passed");
