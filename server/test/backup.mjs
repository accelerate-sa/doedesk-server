// Backup and restore, done for real on this machine with the same scripts and settings the server
// uses (server/ops/snapshot.sh, restore.sh, litestream.yml), with a folder standing in for the bucket:
//   - the continuous copy follows the running service, and brings the database back as it is now
//     and as it was at an earlier moment;
//   - a kill of the service loses nothing from the copy that was acknowledged;
//   - the nightly snapshot is encrypted, cannot be read without the private key, restores to
//     exactly the database it was taken from, and is uploaded in a way that cannot overwrite.
//
//   LITESTREAM_BIN=/path/to/litestream node server/test/backup.mjs
//
// Needs litestream 0.5 and age. Without them it says so and exits 0.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { sha256Hex, startServerService, TARGET } from "../../test/local-service.mjs";
import { compare, fingerprint, openSource } from "../migration/lib.mjs";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const litestream = process.env.LITESTREAM_BIN ?? "litestream";
const has = (command, args) => spawnSync(command, args, { stdio: "ignore" }).status === 0;
if (!has(litestream, ["version"]) || !has("age", ["--version"])) {
  console.log("skipped: litestream or age is not installed here (set LITESTREAM_BIN)\n\nall passed");
  process.exit(0);
}
let failures = 0;
const expect = (label, condition, detail = null) => {
  if (!condition) failures += 1;
  console.log(`${condition ? "ok  " : "FAIL"} ${label}${condition ? "" : ` -> ${JSON.stringify(detail)?.slice(0, 900)}`}`);
};
const same = (label, actual, expected) => expect(label, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const runtime = TARGET === "node" ? "node" : "bun";
const runtimeBin = spawnSync("which", [runtime], { encoding: "utf8" }).stdout.trim();

const NOW = new Date().toISOString();
const MARK = "backup-marker@seeded.example";
const seed = `INSERT INTO users (id, email, created_at, country, signup_method) VALUES ('u-backup', '${MARK}', '${NOW}', 'SA', 'email');`;
const INSTALL = "11111111-2222-4333-8444-555555555555";
const write = async (base, prefix, count) => {
  const answers = await Promise.all(
    Array.from({ length: count }, (_, index) =>
      fetch(`${base}/ingest/batch`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-country": "SA" },
        body: JSON.stringify({ api_key: "doedesk-client", batch: [{ uuid: `${prefix}-${index}`, event: "client.turn.requested", properties: { installId: INSTALL }, timestamp: new Date().toISOString() }] }),
      }).then((response) => response.status, () => 0),
    ),
  );
  return answers.filter((status) => status === 200).length;
};
const events = (file, prefix) => {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    return database.prepare("SELECT COUNT(*) AS n FROM events WHERE uuid LIKE ?").get(`${prefix}-%`).n;
  } finally {
    database.close();
  }
};
const sameDatabase = (a, b) => {
  const first = openSource(`sqlite:${a}`);
  const second = openSource(`sqlite:${b}`);
  try {
    return compare(fingerprint(first), fingerprint(second));
  } finally {
    first.close();
    second.close();
  }
};

let service = await startServerService({ runtime, seedSql: seed });
const { folder, databaseFile } = service;
const bucket = join(folder, "bucket");
const out = join(folder, "restored");
mkdirSync(out);
// The server's own configuration, with the bucket swapped for a folder.
const config = join(folder, "litestream.yml");
writeFileSync(
  config,
  readFileSync(join(ROOT, "server", "ops", "litestream.yml"), "utf8")
    .replace("/var/lib/doedesk/doedesk.sqlite", databaseFile)
    .replace("path: /var/lib/doedesk/replica", `path: ${bucket}`),
);
const replicate = spawn(litestream, ["replicate", "-config", config], { stdio: ["ignore", "pipe", "pipe"] });
let replicateLog = "";
replicate.stdout.on("data", (chunk) => (replicateLog += chunk));
replicate.stderr.on("data", (chunk) => (replicateLog += chunk));
const script = (name, args, env = {}) => spawnSync("bash", [join(ROOT, "server", "ops", name), ...args], { encoding: "utf8", env: { ...process.env, LITESTREAM_CONFIG: config, LITESTREAM_BIN: litestream, DOEDESK_DATABASE: databaseFile, DOEDESK_RUNTIME: runtimeBin, DOEDESK_SNAPSHOT_WORK: folder, ...env } });

try {
  // === The continuous copy ==========================================================================
  await sleep(1500);
  const first = await write(service.base, "first", 40);
  await sleep(3500);
  const between = new Date().toISOString();
  await sleep(2500);
  const second = await write(service.base, "second", 40);
  await sleep(3500);
  expect("replica: the configuration the server uses is accepted, and files reach the bucket", replicate.exitCode === null && existsSync(bucket) && readdirSync(bucket, { recursive: true }).length > 2, replicateLog.slice(-600));

  const latest = script("restore.sh", ["replica", join(out, "latest.sqlite")]);
  const compared = latest.status === 0 ? sameDatabase(databaseFile, join(out, "latest.sqlite")) : { same: false, problems: [latest.stderr] };
  expect("replica: restored as of now, it is the running database to the row: every table's count and checksum agree", latest.status === 0 && /restored .*: sound/.test(latest.stdout) && compared.same && first === 40 && second === 40, [latest.stdout.slice(-300), latest.stderr.slice(-300), compared.problems]);
  const earlier = script("restore.sh", ["replica", join(out, "earlier.sqlite"), "--at", between]);
  same("replica: restored as of a moment between two rounds of writes, it holds the first round and none of the second", [earlier.status, earlier.status === 0 ? events(join(out, "earlier.sqlite"), "first") : null, earlier.status === 0 ? events(join(out, "earlier.sqlite"), "second") : null], [0, 40, 0]);
  const again = script("restore.sh", ["replica", join(out, "latest.sqlite")]);
  expect("restore: never writes over a file that exists", again.status !== 0 && /exists/.test(again.stderr), [again.status, again.stderr]);
  expect("restore: describes what it restored by counts, and prints no row", !latest.stdout.includes(MARK) && /1 accounts/.test(latest.stdout), latest.stdout);

  // A kill of the service, with the copy running.
  const third = await write(service.base, "third", 60);
  const killed = await service.end("SIGKILL");
  await sleep(3500);
  const afterKill = script("restore.sh", ["replica", join(out, "after-kill.sqlite")]);
  same("replica: after the service is killed outright, the copy holds every write the service had acknowledged", [killed.signal, afterKill.status, afterKill.status === 0 ? events(join(out, "after-kill.sqlite"), "third") : null], ["SIGKILL", 0, third]);
  service = await startServerService({ runtime, folder, engine: service.engine });
  await write(service.base, "fourth", 10);
  await sleep(3500);
  const resumed = script("restore.sh", ["replica", join(out, "resumed.sqlite")]);
  same("replica: when the service comes back, the copy carries on", [resumed.status, resumed.status === 0 ? events(join(out, "resumed.sqlite"), "fourth") : null], [0, 10]);

  // === The nightly snapshot ===========================================================================
  const keyFile = join(folder, "private.key");
  const keygen = spawnSync("age-keygen", ["-o", keyFile], { encoding: "utf8" });
  const recipient = /age1[0-9a-z]+/.exec(`${keygen.stderr}${readFileSync(keyFile, "utf8")}`)?.[0];
  // Stands in for the bucket's write-only upload address.
  const uploads = new Map();
  const store = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const name = request.url.split("/").at(-1);
    if (request.method !== "PUT") return response.writeHead(405).end();
    if (request.headers["if-none-match"] === "*" && uploads.has(name)) return response.writeHead(412).end();
    uploads.set(name, { bytes: Buffer.concat(chunks), ifNoneMatch: request.headers["if-none-match"] });
    response.writeHead(200).end();
  });
  await new Promise((resolve) => store.listen(0, "127.0.0.1", resolve));
  const kept = join(folder, "kept");
  const env = { SNAPSHOT_AGE_RECIPIENT: recipient, SNAPSHOT_UPLOAD_URL: `http://127.0.0.1:${store.address().port}/p/token/n/ns/b/bucket/o/`, SNAPSHOT_KEEP_LOCAL: kept };
  // Async, so that the stand-in store in this process can take the upload.
  const snapshot = await new Promise((resolve) => {
    const child = spawn("bash", [join(ROOT, "server", "ops", "snapshot.sh")], { env: { ...process.env, DOEDESK_DATABASE: databaseFile, DOEDESK_RUNTIME: runtimeBin, DOEDESK_SNAPSHOT_WORK: folder, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.once("exit", (status) => resolve({ status, output }));
  });
  const [name] = [...uploads.keys()];
  const uploaded = uploads.get(name);
  const line = /snapshot (\S+) bytes=(\d+) sha256=([0-9a-f]{64}) uploaded/.exec(snapshot.output);
  expect("snapshot: taken from the running service, checked, and uploaded under a dated name with its checksum reported", snapshot.status === 0 && /snapshot ok bytes=\d+ tables=\d+ rows=\d+/.test(snapshot.output) && line !== null && /^doedesk-\d{8}T\d{6}Z\.sqlite\.gz\.age$/.test(name ?? "") && line[1] === name && createHash("sha256").update(uploaded.bytes).digest("hex") === line[3] && uploaded.ifNoneMatch === "*", snapshot.output);
  const encrypted = uploaded?.bytes ?? Buffer.alloc(0);
  expect("snapshot: what leaves the machine is encrypted: it is not a database, and no address from the database can be found in it", encrypted.subarray(0, 21).toString("latin1").startsWith("age-encryption.org/v1") && !encrypted.includes(Buffer.from(MARK)) && !encrypted.includes(Buffer.from("SQLite format 3")), encrypted.subarray(0, 30).toString("latin1"));
  same("snapshot: nothing readable is left behind in the work folder", readdirSync(folder).filter((entry) => entry.startsWith("snapshot.")), []);
  const encryptedFile = join(kept, name);
  const restored = script("restore.sh", ["snapshot", encryptedFile, join(out, "from-snapshot.sqlite"), "--identity", keyFile]);
  const snapshotCompared = restored.status === 0 ? sameDatabase(databaseFile, join(out, "from-snapshot.sqlite")) : { same: false, problems: [restored.stderr] };
  expect("snapshot: with the private key it restores to exactly the database it was taken from", restored.status === 0 && snapshotCompared.same, [restored.stdout, restored.stderr, snapshotCompared.problems]);
  const otherKey = join(folder, "other.key");
  spawnSync("age-keygen", ["-o", otherKey], { stdio: "ignore" });
  const wrongKey = script("restore.sh", ["snapshot", encryptedFile, join(out, "wrong-key.sqlite"), "--identity", otherKey]);
  expect("snapshot: with any other key it does not restore", wrongKey.status !== 0 && (!existsSync(join(out, "wrong-key.sqlite")) || statSync(join(out, "wrong-key.sqlite")).size === 0), [wrongKey.status, wrongKey.stderr.slice(0, 200)]);
  // The same name again: the store refuses.
  const overwrite = await fetch(`${env.SNAPSHOT_UPLOAD_URL}${name}`, { method: "PUT", headers: { "if-none-match": "*" }, body: "replacement" });
  same("snapshot: an upload under a name that exists is refused by the store, so a snapshot cannot be replaced", [overwrite.status, uploads.get(name).bytes.length === encrypted.length], [412, true]);
  const noKey = script("snapshot.sh", [], { SNAPSHOT_AGE_RECIPIENT: "" });
  const badKey = script("snapshot.sh", [], { SNAPSHOT_AGE_RECIPIENT: "not-a-key", SNAPSHOT_KEEP_LOCAL: kept });
  expect("snapshot: without a public key, or with something that is not one, it refuses to run rather than write an unencrypted file", noKey.status !== 0 && badKey.status !== 0 && readdirSync(kept).length === 1, [noKey.status, badKey.status, readdirSync(kept)]);
  await new Promise((resolve) => (store.close(resolve), store.closeAllConnections()));
} catch (cause) {
  failures += 1;
  console.log(`FAIL the run stopped: ${cause?.stack ?? cause}\n${replicateLog.slice(-800)}`);
} finally {
  replicate.kill("SIGTERM");
  await service.stop();
}
console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
