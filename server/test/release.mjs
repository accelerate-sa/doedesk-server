// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Accelerate Technology Establishment
// Release records (docs/releases.md): what the server serves at GET /v1/release, and the tooling
// that makes, signs and checks a record (server/ops/release.mjs).
//
//   node server/test/release.mjs              the server on Bun (DOEDESK_TEST_TARGET=node for Node)
//
// Signing needs cosign; without it those checks are skipped and say so. Nothing here reaches the
// public transparency log: the key is made for the run and every signature is made with --no-tlog.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { client, startServerService, TARGET } from "../../test/local-service.mjs";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const TOOL = join(ROOT, "server", "ops", "release.mjs");
let failures = 0;
const expect = (label, condition, detail = null) => {
  if (!condition) failures += 1;
  console.log(`${condition ? "ok  " : "FAIL"} ${label}${condition ? "" : ` -> ${JSON.stringify(detail)?.slice(0, 600)}`}`);
};
const tool = (args, env = {}) => spawnSync("node", [TOOL, ...args], { cwd: ROOT, encoding: "utf8", env: { ...process.env, ...env } });
const folder = mkdtempSync(join(process.env.DOEDESK_TEST_DIR ?? tmpdir(), "doedesk-release-"));

if (TARGET === "worker") {
  console.log("skipped: the release record is served by the server only");
  process.exit(0);
}

const service = await startServerService({ vars: { DOEDESK_RELEASE_DIR: folder } });
try {
  const call = client(service.base);
  const none = await call("GET", "/v1/release");
  const noSignature = await call("GET", "/v1/release/signature");
  expect("served: without a record, 404 with a code that says so", [none.status, none.json?.error?.code, noSignature.status].join() === "404,no_release_record,404", [none.status, none.json]);

  const offer = await call("GET", "/v1/source");
  expect("source: the service says where its source is and under which licence; with no release record it names no commit", offer.status === 200 && offer.json?.license === "AGPL-3.0-or-later" && offer.json?.source === "https://github.com/accelerate-sa/doedesk-server" && offer.json?.commit === null && !("layer" in offer.json), offer.json);

  // Written as deploy.sh writes them; the exact bytes matter, so the spacing is deliberately odd.
  const record = '{\n  "schema": "doedesk-release/1",   "commit": "0123"\n}\n';
  const bundle = '{"mediaType":"application/vnd.dev.sigstore.bundle.v0.3+json"}';
  writeFileSync(join(folder, "RELEASE.json"), record);
  const unsigned = await call("GET", "/v1/release/signature");
  expect("served: a record without a signature is served, and the signature is 404 not_signed", [(await call("GET", "/v1/release")).status, unsigned.status, unsigned.json?.error?.code].join() === "200,404,not_signed", unsigned.json);
  writeFileSync(join(folder, "RELEASE.sigstore.json"), bundle);
  const got = await fetch(`${service.base}/v1/release`);
  const gotText = await got.text();
  const gotSignature = await (await fetch(`${service.base}/v1/release/signature`)).text();
  expect("served: the record and its signature byte for byte, read fresh each time, to any origin", gotText === record && gotSignature === bundle && got.headers.get("access-control-allow-origin") === "*", [gotText, gotSignature]);
  const withCommit = await call("GET", "/v1/source");
  writeFileSync(join(folder, "RELEASE.json"), JSON.stringify({ schema: "doedesk-release/1", commit: "0123", layer: { name: "extra", sha256: "a".repeat(64), bytes: 9 } }));
  const withLayer = await call("GET", "/v1/source");
  expect("source: with a record it names the record's commit, and a layer beside the release when the record names one", withCommit.json?.commit === "0123" && !("layer" in withCommit.json) && withLayer.json?.layer?.name === "extra" && withLayer.json?.layer?.sha256 === "a".repeat(64) && /not part of this source/.test(withLayer.json?.layer?.note ?? ""), [withCommit.json, withLayer.json]);
  const posted = await call("POST", "/v1/release", { body: {} });
  expect("served: only GET; anything else goes on to the API, which does not know it", posted.status === 404 && posted.json?.error?.code === "not_found", posted.json);
} finally {
  await service.stop();
}

// --- The tooling ------------------------------------------------------------------------------------
const hasCommit = spawnSync("git", ["-C", ROOT, "rev-parse", "--verify", "HEAD^{commit}"], { encoding: "utf8" }).status === 0;
if (!hasCommit) {
  console.log("skipped: this checkout has no commit to make an archive from");
} else {
  const first = tool(["archive", "--repo", ROOT, "--commit", "HEAD", "--out", join(folder, "a.tar")]);
  const clone = join(folder, "clone");
  spawnSync("git", ["clone", "--quiet", "--no-local", ROOT, clone]);
  const again = tool(["archive", "--repo", clone, "--commit", "HEAD", "--out", join(folder, "b.tar")], { GIT_CONFIG_PARAMETERS: "'tar.umask'='0077'" });
  const [commit, sha, bytes] = first.stdout.trim().split(" ");
  expect("archive: a fresh clone, with a different tar.umask set, makes the same bytes", first.status === 0 && first.stdout === again.stdout && readFileSync(join(folder, "a.tar")).equals(readFileSync(join(folder, "b.tar"))), [first.stdout, again.stdout, first.stderr, again.stderr]);
  const listing = spawnSync("tar", ["-tf", join(folder, "a.tar")], { encoding: "utf8" }).stdout.split("\n");
  expect("archive: holds server/, src/, migrations/, docs/ and package.json, and nothing else", listing.includes("package.json") && listing.includes("server/main.ts") && listing.includes("src/index.ts") && !listing.some((name) => /^(test|releases|web|legal)\//.test(name)), listing.slice(0, 5));

  const log = join(folder, "log");
  const makeRecord = (release) => {
    const out = join(folder, `${release}.json`);
    const made = tool(["record", "--commit", commit, "--sha256", sha, "--bytes", bytes, "--release", release, "--log", log, "--out", out]);
    return { out, name: made.stdout.trim(), status: made.status, stderr: made.stderr };
  };
  spawnSync("mkdir", ["-p", log]);
  const one = makeRecord("r1");
  const recordOne = JSON.parse(readFileSync(one.out, "utf8"));
  expect("record: names the commit, the archive's sha256 and size, the time, and starts the chain", one.status === 0 && recordOne.commit === commit && recordOne.archive.sha256 === sha && recordOne.archive.bytes === Number(bytes) && recordOne.sequence === 1 && recordOne.previous === null && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(recordOne.deployedAt) && /^00001-\d{8}T\d{6}Z-[0-9a-f]{12}\.json$/.test(one.name), [one, recordOne]);

  // A layer beside the release (docs/releases.md): a folder that is not part of the release.
  const beside = join(folder, "beside");
  spawnSync("mkdir", ["-p", join(beside, "extra", "src"), join(beside, "extra", "test"), join(beside, "src")]);
  for (const [name, text] of [["extra/index.ts", "export const extension = { name: 'extra' };\n"], ["extra/src/a.ts", "export {};\n"], ["extra/test/t.mjs", "// a test\n"], ["src/index.ts", "export {};\n"]]) writeFileSync(join(beside, name), text);
  for (const args of [["init", "--quiet"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "--quiet", "-m", "a layer"]]) spawnSync("git", ["-C", beside, ...args]);
  const layerArchive = tool(["archive", "--repo", beside, "--commit", "HEAD", "--layer", "extra", "--out", join(folder, "layer.tar")]);
  const [, layerSha, layerBytes] = layerArchive.stdout.trim().split(" ");
  const layerListing = spawnSync("tar", ["-tf", join(folder, "layer.tar")], { encoding: "utf8" }).stdout.split("\n").filter((name) => name !== "" && name !== "pax_global_header");
  expect("layer: its archive holds what runs of that one folder, and nothing of the release or of its tests", layerArchive.status === 0 && layerListing.includes("extra/index.ts") && layerListing.includes("extra/src/a.ts") && layerListing.every((name) => name.startsWith("extra/") && !name.startsWith("extra/test")), layerListing);
  const notLayers = ["server", "src", "docs", "releases", "../x", "nothing-here"].map((name) => tool(["archive", "--repo", beside, "--commit", "HEAD", "--layer", name, "--out", join(folder, "no.tar")]).status);
  expect("layer: a folder of the release itself, a path, or a folder with no index.ts is not a layer", notLayers.every((status) => status === 1), notLayers);
  const withLayerOut = join(folder, "with-layer.json");
  const withLayer = tool(["record", "--commit", commit, "--sha256", sha, "--bytes", bytes, "--release", "r-layer", "--log", join(folder, "empty-log"), "--out", withLayerOut, "--layer-name", "extra", "--layer-sha256", layerSha, "--layer-bytes", layerBytes]);
  const recordWithLayer = withLayer.status === 0 ? JSON.parse(readFileSync(withLayerOut, "utf8")) : {};
  const half = tool(["record", "--commit", commit, "--sha256", sha, "--bytes", bytes, "--release", "r-half", "--log", join(folder, "empty-log"), "--out", join(folder, "half.json"), "--layer-name", "extra"]);
  expect(
    "record: a layer sent beside the release is named with its sha256 and size; a record without one has no such field; half a layer is refused",
    JSON.stringify(recordWithLayer.layer) === JSON.stringify({ name: "extra", sha256: layerSha, bytes: Number(layerBytes) }) && Object.keys(recordWithLayer).join() === "schema,service,repository,sequence,release,commit,archive,layer,deployedAt,previous" && !("layer" in recordOne) && half.status === 1,
    [recordWithLayer, half.stderr],
  );

  const cosign = spawnSync("cosign", ["version"], { encoding: "utf8" });
  if (cosign.error !== undefined) {
    console.log("skipped: cosign is not installed, so signing and checking are not tried");
  } else {
    spawnSync("cosign", ["generate-key-pair", "--output-key-prefix", "test"], { cwd: folder, env: { ...process.env, COSIGN_PASSWORD: "test" } });
    const key = join(folder, "test.key");
    const pub = join(folder, "test.pub");
    const sign = (path) => tool(["sign", "--record", path, "--key", key, "--no-tlog"], { COSIGN_PASSWORD: "test" });
    const signed = sign(one.out);
    writeFileSync(join(log, one.name), readFileSync(one.out));
    writeFileSync(join(log, one.name.replace(/\.json$/, ".sigstore.json")), readFileSync(one.out.replace(/\.json$/, ".sigstore.json")));
    const two = makeRecord("r2");
    sign(two.out);
    const recordTwo = JSON.parse(readFileSync(two.out, "utf8"));
    expect("record: the next one links to the one before by its sha256", recordTwo.sequence === 2 && recordTwo.previous?.name === one.name && recordTwo.previous?.sha256 === spawnSync("shasum", ["-a", "256", join(log, one.name)], { encoding: "utf8" }).stdout.split(" ")[0], recordTwo);
    writeFileSync(join(log, two.name), readFileSync(two.out));
    writeFileSync(join(log, two.name.replace(/\.json$/, ".sigstore.json")), readFileSync(two.out.replace(/\.json$/, ".sigstore.json")));

    const verify = (args) => tool(["verify", ...args, "--key", pub, "--log", log, "--no-tlog"]);
    const good = verify(["--record", two.out]);
    expect("verify: a signed, logged record whose archive is made again from the commit passes", signed.status === 0 && good.status === 0 && !/FAIL/.test(good.stdout), [signed.stderr, good.stdout, good.stderr]);
    // A release with a layer: the record checks as any other, and the check says a layer runs.
    const layered = join(folder, "layered");
    spawnSync("mkdir", ["-p", layered]);
    const layeredOut = join(folder, "layered.json");
    const layeredName = tool(["record", "--commit", commit, "--sha256", sha, "--bytes", bytes, "--release", "r3", "--log", layered, "--out", layeredOut, "--layer-name", "extra", "--layer-sha256", layerSha, "--layer-bytes", layerBytes]).stdout.trim();
    sign(layeredOut);
    writeFileSync(join(layered, layeredName), readFileSync(layeredOut));
    const withLayerCheck = tool(["verify", "--record", layeredOut, "--key", pub, "--log", layered, "--no-tlog"]);
    expect("verify: a record that names a layer passes, and the check prints the layer's name and sha256", withLayerCheck.status === 0 && !/FAIL/.test(withLayerCheck.stdout) && withLayerCheck.stdout.includes(`a layer that is not in this repository: extra, sha256 ${layerSha}`), [withLayerCheck.stdout, withLayerCheck.stderr]);
    const all = tool(["verify-log", "--key", pub, "--log", log, "--no-tlog"]);
    expect("verify-log: the whole chain passes", all.status === 0 && /all 2 records hold/.test(all.stdout), all.stdout);

    // A record changed after signing: the signature fails, and the log does not hold it.
    const altered = join(folder, "altered.json");
    writeFileSync(altered, readFileSync(two.out, "utf8").replace(/"deployedAt": "2/, '"deployedAt": "1'));
    writeFileSync(join(folder, "altered.sigstore.json"), readFileSync(two.out.replace(/\.json$/, ".sigstore.json")));
    const bad = verify(["--record", altered]);
    expect("verify: a record altered after signing fails on its signature and on the log", bad.status === 1 && /FAIL\s+the signature/.test(bad.stdout) && /FAIL\s+the record is in the log/.test(bad.stdout), bad.stdout);

    // A record that names an archive the commit does not make, signed by the right key: the archive check fails.
    const lying = join(folder, "lying.json");
    writeFileSync(lying, readFileSync(one.out, "utf8").replace(sha, "0".repeat(64)));
    sign(lying);
    const lie = verify(["--record", lying]);
    expect("verify: a signed record whose archive is not the commit's fails on the archive", lie.status === 1 && /ok\s+the signature/.test(lie.stdout) && /FAIL\s+the archive made here/.test(lie.stdout), lie.stdout);

    // A log with an entry taken out: the chain breaks at the next one.
    const gapped = join(folder, "gapped");
    spawnSync("mkdir", ["-p", gapped]);
    for (const name of readdirSync(log)) if (!name.startsWith("00001-")) writeFileSync(join(gapped, name), readFileSync(join(log, name)));
    const gap = tool(["verify-log", "--key", pub, "--log", gapped, "--no-tlog"]);
    expect("verify-log: a log with an entry removed fails on the link", gap.status === 1 && /FAIL\s+its link/.test(gap.stdout), gap.stdout);
  }
}

rmSync(folder, { recursive: true, force: true });
console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
