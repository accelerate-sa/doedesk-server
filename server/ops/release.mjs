#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Accelerate Technology Establishment
// Release records: what was sent to the production machine, signed, and how anyone checks it.
// docs/releases.md explains the design; this file is the whole of the tooling. Node 22 or newer,
// git, and (to sign or to check a signature) cosign 2.4 or newer. No other dependency.
//
//   node server/ops/release.mjs archive --repo <dir> --commit <rev> --out <file.tar> [--layer <folder>]
//       Writes the release archive of <rev>: `git archive --format=tar` of RELEASE_PATHS, with the
//       settings pinned so that any machine makes the same bytes. Prints "<commit> <sha256> <bytes>".
//       With --layer: the archive of what runs of that one folder instead (its index.ts, src/ and
//       migrations/), for a layer that runs beside the release and is not part of it
//       (docs/releases.md, "A layer beside the release").
//
//   node server/ops/release.mjs record --commit <sha> --sha256 <hex> --bytes <n> --release <id>
//       --log <dir> --out <file> [--repository <url>] [--service <name>]
//       [--layer-name <folder> --layer-sha256 <hex> --layer-bytes <n>]
//       Writes the release record: the JSON object that is signed, logged and served. The three
//       layer options add `layer`, which says that code beyond the commit runs, and which.
//
//   node server/ops/release.mjs sign --record <file> --key <cosign key> [--no-tlog]
//       Signs the record with cosign; writes <file without .json>.sigstore.json. The signature goes
//       to the public transparency log (Rekor) unless --no-tlog, which is for tests only.
//
//   node server/ops/release.mjs verify [--url <api origin> | --record <file>] [--repo <dir>]
//       [--key <cosign.pub>] [--log <dir>] [--no-tlog]
//       Checks one record: its signature, that the archive it names is the one <repo> makes from
//       its commit, and that it is in the log with an unbroken chain. Default: the record the
//       production API serves now, https://api.doedesk.com/v1/release.
//
//   node server/ops/release.mjs verify-log [--repo <dir>] [--key <cosign.pub>] [--no-tlog]
//       Checks every record in the log the same way, and the chain from the first to the last.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** What a release is made of. Changing this list changes every archive from then on. */
export const RELEASE_PATHS = ["server", "src", "migrations", "docs", "package.json"];
export const SCHEMA = "doedesk-release/1";
const DEFAULT_REPOSITORY = "https://github.com/accelerate-sa/doedesk-server";
const DEFAULT_SERVICE = "api.doedesk.com";
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_OF_THIS_FILE = resolve(HERE, "..", "..");

const fail = (message) => {
  console.error(`release: ${message}`);
  process.exit(1);
};

const options = (argv) => {
  const found = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) fail(`unexpected argument: ${arg}`);
    const name = arg.slice(2);
    if (name === "no-tlog") found[name] = true;
    else {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) fail(`--${name} needs a value`);
      found[name] = value;
      index += 1;
    }
  }
  return found;
};

const run = (command, args, { input, cwd, quiet = false } = {}) => {
  const result = spawnSync(command, args, { cwd, input, maxBuffer: 1024 * 1024 * 1024 });
  if (result.error?.code === "ENOENT") fail(`${command} is not installed`);
  if (result.status !== 0 && !quiet) fail(`${command} ${args.slice(0, 3).join(" ")} … failed:\n${result.stderr.toString()}`);
  return result;
};

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * The archive's bytes. `git archive` writes the same tar for the same commit on any machine, given
 * the same settings; the ones that could differ between machines are pinned here. The commit's
 * identifier is inside the tar (a pax header), so an archive names its commit.
 */
const PINNED = ["-c", "tar.umask=0002", "-c", "core.autocrlf=false", "-c", "core.eol=lf", "-c", "core.attributesFile=/dev/null"];

export const makeArchive = (repo, revision) => {
  const commit = run("git", ["-C", repo, "rev-parse", "--verify", `${revision}^{commit}`]).stdout.toString().trim();
  const bytes = run("git", ["-C", repo, ...PINNED, "archive", "--format=tar", commit, "--", ...RELEASE_PATHS]).stdout;
  return { commit, bytes, sha256: sha256(bytes) };
};

/**
 * A layer's archive: what runs of one folder (its entry, its code and its migrations; not its
 * tests or notes). It is made from the files alone, with one fixed time and no commit in it, so
 * its sha256 changes when the layer's code changes and only then: two releases with the same
 * layer sha256 run the same layer. Needs git 2.40 or newer, for --mtime.
 */
export const makeLayerArchive = (repo, revision, name) => {
  const commit = run("git", ["-C", repo, "rev-parse", "--verify", `${revision}^{commit}`]).stdout.toString().trim();
  const paths = [`${name}/index.ts`, `${name}/src`, `${name}/migrations`].filter((path) => run("git", ["-C", repo, "ls-tree", commit, "--", path]).stdout.length > 0);
  if (!paths.includes(`${name}/index.ts`)) fail(`there is no ${name}/index.ts at ${revision} in ${repo}`);
  const bytes = run("git", ["-C", repo, ...PINNED, "archive", "--format=tar", "--mtime=2000-01-01T00:00:00Z", `${commit}^{tree}`, "--", ...paths]).stdout;
  return { commit, bytes, sha256: sha256(bytes) };
};

/** The records in a log folder, oldest first. A record is NNNNN-<time>-<commit>.json. */
export const logEntries = (folder) =>
  existsSync(folder)
    ? readdirSync(folder)
        .filter((name) => /^\d{5}-.*\.json$/.test(name) && !name.endsWith(".sigstore.json"))
        .sort()
        .map((name) => ({ name, path: join(folder, name), signature: join(folder, name.replace(/\.json$/, ".sigstore.json")) }))
    : [];

export const signaturePathOf = (recordPath) => recordPath.replace(/\.json$/, "") + ".sigstore.json";

const compactTime = (iso) => iso.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

/** A layer is one top-level folder that the release itself does not hold. */
const layerName = (name) => (/^[a-z][a-z0-9-]{0,39}$/.test(name) && !RELEASE_PATHS.includes(name) && name !== "releases" ? name : fail(`a layer is one top-level folder beside the release, not "${name}"`));

/**
 * The record. Its fields and their order are fixed; `previous` chains it to the log's last entry.
 * `layer` is there only when a layer was sent beside the release: a record without one is the
 * record of the public commit alone, as it always was.
 */
export const makeRecord = ({ commit, archiveSha256, bytes, release, log, repository, service, layer = null, now = new Date() }) => {
  const entries = logEntries(log);
  const last = entries.at(-1);
  const record = {
    schema: SCHEMA,
    service,
    repository,
    sequence: entries.length + 1,
    release,
    commit,
    archive: {
      sha256: archiveSha256,
      bytes,
      made: `git archive --format=tar ${commit} -- ${RELEASE_PATHS.join(" ")}`,
    },
    ...(layer === null ? {} : { layer }),
    deployedAt: now.toISOString().replace(/\.\d+Z$/, "Z"),
    previous: last === undefined ? null : { name: last.name, sha256: sha256(readFileSync(last.path)) },
  };
  const text = `${JSON.stringify(record, null, 2)}\n`;
  const name = `${String(record.sequence).padStart(5, "0")}-${compactTime(record.deployedAt)}-${commit.slice(0, 12)}.json`;
  return { record, text, name };
};

const cosign = (args) => run("cosign", args, { quiet: true });

const sign = (recordPath, key, noTlog) => {
  const bundle = signaturePathOf(recordPath);
  const args = ["sign-blob", "--yes", "--key", key, "--bundle", bundle];
  // Tests only: no entry in the public log. cosign 3 needs its signing config off for that.
  if (noTlog) args.push("--tlog-upload=false", "--use-signing-config=false");
  const result = cosign([...args, recordPath]);
  if (result.status !== 0) fail(`cosign could not sign ${basename(recordPath)}:\n${result.stderr.toString()}`);
  return bundle;
};

/** Checks one record. Returns a list of [ok, label] pairs; nothing here stops at the first failure. */
const checkRecord = ({ text, bundle, repo, key, noTlog, logFolder }) => {
  const results = [];
  const check = (ok, label) => results.push([ok, label]);
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    check(false, "the record is JSON");
    return { results };
  }
  check(record.schema === SCHEMA, `the record is a ${SCHEMA} record`);
  // A layer is named, never hidden: its code is not in this repository, so it cannot be checked here.
  if (record.layer !== undefined) {
    const named = typeof record.layer?.name === "string" && /^[0-9a-f]{64}$/.test(record.layer?.sha256 ?? "") && Number.isInteger(record.layer?.bytes);
    check(named, "the layer the record names has a name, a sha256 and a size");
    if (named) console.log(`info  beside the public commit this release runs a layer that is not in this repository: ${record.layer.name}, sha256 ${record.layer.sha256}, ${record.layer.bytes} bytes`);
  }

  // 1. The signature, over these exact bytes, by the key published in the repository.
  if (bundle === null) check(false, "the record is signed (no signature was found)");
  else {
    const folder = mkdtempSync(join(tmpdir(), "doedesk-release-"));
    try {
      writeFileSync(join(folder, "record.json"), text);
      writeFileSync(join(folder, "record.sigstore.json"), bundle);
      const args = ["verify-blob", "--key", key, "--bundle", join(folder, "record.sigstore.json")];
      if (noTlog) args.push("--insecure-ignore-tlog=true");
      const result = cosign([...args, join(folder, "record.json")]);
      check(result.status === 0, `the signature is good, by the key in ${key}${noTlog ? " (transparency log not checked)" : ", and is in the public transparency log"}${result.status === 0 ? "" : `: ${result.stderr.toString().trim().split("\n").at(-1)}`}`);
      const time = (() => {
        try {
          const parsed = JSON.parse(bundle.toString());
          const entry = parsed.verificationMaterial?.tlogEntries?.[0] ?? parsed.rekorBundle?.Payload;
          const seconds = Number(entry?.integratedTime ?? entry?.IntegratedTime);
          return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
        } catch {
          return null;
        }
      })();
      if (time !== null) console.log(`info  the transparency log took the signature at ${time}; the record says it was deployed at ${record.deployedAt}`);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }

  // 2. The archive: made again here from the commit, it must be the same bytes.
  const known = run("git", ["-C", repo, "cat-file", "-e", `${record.commit}^{commit}`], { quiet: true }).status === 0;
  check(known, `the commit ${record.commit} is in ${repo}${known ? "" : " (fetch it, or this is not the public repository)"}`);
  if (known) {
    const again = makeArchive(repo, record.commit);
    check(again.sha256 === record.archive?.sha256 && again.bytes.length === record.archive?.bytes, `the archive made here from that commit has the sha256 in the record (${again.sha256})`);
  }

  // 3. The log: the record is there, byte for byte, and its link to the entry before it holds.
  const entries = logEntries(logFolder);
  const position = entries.findIndex((entry) => readFileSync(entry.path).equals(Buffer.from(text)));
  check(position !== -1, `the record is in the log (${logFolder})${position === -1 ? "; pull the repository if it is newer than your copy" : `: ${entries[position].name}`}`);
  if (position !== -1) {
    const before = entries[position - 1];
    const expected = before === undefined ? null : { name: before.name, sha256: sha256(readFileSync(before.path)) };
    check(JSON.stringify(record.previous) === JSON.stringify(expected) && record.sequence === position + 1, "its link to the entry before it, and its sequence number, hold");
  }
  return { results, record };
};

const report = (results) => {
  for (const [ok, label] of results) console.log(`${ok ? "ok  " : "FAIL"}  ${label}`);
  return results.every(([ok]) => ok);
};

const fetchBytes = async (url) => {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (response.status === 404) return null;
  if (!response.ok) fail(`${url} answered ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
};

const [command, ...rest] = process.argv.slice(2);
const given = options(rest);
const repo = resolve(given.repo ?? REPO_OF_THIS_FILE);
const key = resolve(given.key ?? join(repo, "releases", "cosign.pub"));
const logFolder = resolve(given.log ?? join(repo, "releases", "log"));

switch (command) {
  case "archive": {
    if (given.out === undefined) fail("archive needs --out");
    const from = resolve(given.repo ?? ".");
    const archive = given.layer === undefined ? makeArchive(from, given.commit ?? "HEAD") : makeLayerArchive(from, given.commit ?? "HEAD", layerName(given.layer));
    writeFileSync(given.out, archive.bytes);
    console.log(`${archive.commit} ${archive.sha256} ${archive.bytes.length}`);
    break;
  }
  case "record": {
    for (const name of ["commit", "sha256", "bytes", "release", "log", "out"]) if (given[name] === undefined) fail(`record needs --${name}`);
    if (!/^[0-9a-f]{40}$/.test(given.commit)) fail("--commit must be a full commit identifier");
    if (!/^[0-9a-f]{64}$/.test(given.sha256)) fail("--sha256 must be 64 hex characters");
    const layerGiven = ["layer-name", "layer-sha256", "layer-bytes"].filter((name) => given[name] !== undefined);
    if (layerGiven.length !== 0 && layerGiven.length !== 3) fail("a layer needs --layer-name, --layer-sha256 and --layer-bytes together");
    if (layerGiven.length === 3 && !/^[0-9a-f]{64}$/.test(given["layer-sha256"])) fail("--layer-sha256 must be 64 hex characters");
    const made = makeRecord({
      layer: layerGiven.length === 0 ? null : { name: layerName(given["layer-name"]), sha256: given["layer-sha256"], bytes: Number(given["layer-bytes"]) },
      commit: given.commit,
      archiveSha256: given.sha256,
      bytes: Number(given.bytes),
      release: given.release,
      log: resolve(given.log),
      repository: given.repository ?? DEFAULT_REPOSITORY,
      service: given.service ?? DEFAULT_SERVICE,
    });
    writeFileSync(given.out, made.text);
    console.log(made.name);
    break;
  }
  case "sign": {
    if (given.record === undefined || given.key === undefined) fail("sign needs --record and --key");
    if (!existsSync(given.key)) fail(`no key at ${given.key}`);
    console.log(sign(resolve(given.record), resolve(given.key), given["no-tlog"] === true));
    break;
  }
  case "verify": {
    let text;
    let bundle;
    if (given.record !== undefined) {
      text = readFileSync(given.record);
      const signature = given.signature ?? signaturePathOf(given.record);
      bundle = existsSync(signature) ? readFileSync(signature) : null;
      console.log(`info  record ${given.record}`);
    } else {
      const origin = (given.url ?? `https://${DEFAULT_SERVICE}`).replace(/\/+$/, "");
      text = await fetchBytes(`${origin}/v1/release`);
      if (text === null) fail(`${origin}/v1/release has no release record`);
      bundle = await fetchBytes(`${origin}/v1/release/signature`);
      console.log(`info  record served by ${origin}/v1/release`);
    }
    const { results, record } = checkRecord({ text, bundle, repo, key, noTlog: given["no-tlog"] === true, logFolder });
    if (record !== undefined) console.log(`info  release ${record.release}, commit ${record.commit}, deployed ${record.deployedAt}`);
    process.exit(report(results) ? 0 : 1);
  }
  case "verify-log": {
    const entries = logEntries(logFolder);
    if (entries.length === 0) fail(`the log ${logFolder} is empty`);
    let all = true;
    for (const entry of entries) {
      console.log(`\n${entry.name}`);
      const bundle = existsSync(entry.signature) ? readFileSync(entry.signature) : null;
      all = report(checkRecord({ text: readFileSync(entry.path), bundle, repo, key, noTlog: given["no-tlog"] === true, logFolder }).results) && all;
    }
    console.log(all ? `\nall ${entries.length} records hold` : "\nsome records do not hold");
    process.exit(all ? 0 : 1);
  }
  default:
    console.error("usage: node server/ops/release.mjs archive|record|sign|verify|verify-log [options]; see the top of this file");
    process.exit(2);
}
