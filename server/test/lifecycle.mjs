// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Accelerate Technology Establishment
// The things a process on a machine has to get right that a Worker never had to:
//   - the nightly job runs once a night, however often and however concurrently it is started;
//   - a stop loses no write that was acknowledged, and finishes the requests already taken;
//   - a restart in the middle of a slow request still answers that request;
//   - a kill at any moment leaves a sound database holding every acknowledged write.
//
//   DOEDESK_TEST_TARGET=bun node server/test/lifecycle.mjs      (or node)
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { client, sha256Hex, startEngineStub, startServerService, TARGET } from "../../test/local-service.mjs";

const runtime = TARGET === "node" ? "node" : "bun";
let failures = 0;
const expect = (label, condition, detail = null) => {
  if (!condition) failures += 1;
  console.log(`${condition ? "ok  " : "FAIL"} ${label}${condition ? "" : ` -> ${JSON.stringify(detail)?.slice(0, 800)}`}`);
};
const same = (label, actual, expected) => expect(label, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const NOW = new Date();
const iso = (msAgo) => new Date(NOW.getTime() - msAgo).toISOString();
const DAY = 86_400_000;
const USER = "00000000-0000-4000-a000-000000000001";
const TOKEN = "dd_test_lifecycle_token";
const seed = [
  `INSERT INTO users (id, email, created_at, country, signup_method) VALUES ('${USER}', 'lifecycle@seeded.example', '${iso(30 * DAY)}', 'SA', 'email');`,
  `INSERT INTO sessions (token_hash, user_id, client, device, created_at, last_used_at) VALUES ('${sha256Hex(TOKEN)}', '${USER}', 'desktop', 'test', '${iso(30 * DAY)}', '${NOW.toISOString()}');`,
  // Past its keeping time: the nightly job removes it.
  `INSERT INTO login_requests (id, kind, identifier, secret_hash, client, created_at, expires_at) VALUES ('old-attempt', 'email', 'gone@seeded.example', 'h', 'desktop', '${iso(3 * DAY)}', '${iso(3 * DAY - 900_000)}');`,
  `INSERT INTO login_requests (id, kind, identifier, secret_hash, client, created_at, expires_at) VALUES ('new-attempt', 'email', 'stays@seeded.example', 'h', 'desktop', '${iso(60_000)}', '${new Date(NOW.getTime() + 600_000).toISOString()}');`,
].join("\n");

const INSTALL = "11111111-2222-4333-8444-555555555555";
const event = (uuid) => ({ api_key: "doedesk-client", batch: [{ uuid, event: "client.turn.requested", properties: { installId: INSTALL, platform: "darwin" }, timestamp: new Date().toISOString() }] });
/** Sends `count` writes at once. Each resolves to { uuid, status } or { uuid, failed }. */
const burst = (base, prefix, count) =>
  Array.from({ length: count }, (_, index) => {
    const uuid = `${prefix}-${String(index).padStart(4, "0")}`;
    return fetch(`${base}/ingest/batch`, { method: "POST", headers: { "content-type": "application/json", "x-test-country": "SA" }, body: JSON.stringify(event(uuid)) }).then(
      async (response) => ({ uuid, status: response.status, stored: (await response.json().catch(() => ({}))).stored }),
      () => ({ uuid, failed: true }),
    );
  });
const check = (file) => {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    return { integrity: database.prepare("PRAGMA integrity_check").all().map((row) => row.integrity_check).join(","), foreignKeys: database.prepare("PRAGMA foreign_key_check").all().length };
  } finally {
    database.close();
  }
};

const engine = await startEngineStub();
let service = await startServerService({ seedSql: seed, runtime, engine });
const { folder, databaseFile } = service;
const restart = async (vars = {}) => (service = await startServerService({ runtime, engine, folder, vars }));
try {
  // === The nightly job, once ===========================================================================
  await service.end();
  const nightly = (args = [], env = {}) =>
    new Promise((resolve) => {
      const command = runtime === "node" ? ["node", "--disable-warning=ExperimentalWarning"] : ["bun"];
      const child = spawn(command[0], [...command.slice(1), join("server", "nightly.ts"), ...args], { env: { ...service.environment, ...env }, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.stderr.on("data", (chunk) => (out += chunk));
      child.once("exit", (code) => resolve({ code, out }));
    });
  const ledger = (sql, ...values) => {
    const database = new DatabaseSync(join(folder, "jobs.sqlite"));
    try {
      return database.prepare(sql).all(...values);
    } finally {
      database.close();
    }
  };
  const attempts = () => service.query("SELECT id FROM login_requests ORDER BY id").map((row) => row.id);
  const today = new Date().toISOString().slice(0, 10);

  const frozen = await nightly([], { MAINTENANCE: "freeze" });
  same("nightly: while frozen for a move it does nothing and is not recorded as run", [frozen.code, /frozen/.test(frozen.out), attempts(), existsSync(join(folder, "jobs.sqlite")) ? ledger("SELECT COUNT(*) AS n FROM job_runs")[0].n : 0], [0, true, ["new-attempt", "old-attempt"], 0]);

  const together = await Promise.all([nightly(), nightly(), nightly(), nightly(), nightly()]);
  const ran = together.filter((run) => /^nightly ran$/m.test(run.out));
  same("nightly: started five times at once, it runs once; the other four see the night is taken and stop", [ran.length, together.filter((run) => /already (done|running)/.test(run.out)).length, together.map((run) => run.code)], [1, 4, [0, 0, 0, 0, 0]]);
  same("nightly: it did its work: the attempt past its time is gone and the live one stays", attempts(), ["new-attempt"]);
  expect("nightly: the run reports counts per rule and no identifier", /retention sign_in_attempts=1 /.test(ran[0]?.out ?? "") && !/seeded\.example|old-attempt/.test(together.map((run) => run.out).join("")), ran[0]?.out);
  const again = await nightly();
  same("nightly: started again the same night, it does nothing", [again.code, /already done/.test(again.out), ledger("SELECT job, day, outcome FROM job_runs").map((row) => ({ ...row }))], [0, true, [{ job: "nightly", day: today, outcome: "done" }]]);
  const status = await nightly(["--status"]);
  expect("nightly: --status shows the last run", status.code === 0 && status.out.includes(`${today} done`), status.out);

  // A run that fails is recorded as failed, exits with an error, and may be tried again.
  ledger("DELETE FROM job_runs");
  const breakIt = new DatabaseSync(databaseFile);
  breakIt.exec("ALTER TABLE deletion_receipts RENAME TO deletion_receipts_away");
  const failed = await nightly();
  same("nightly: a failure makes the run fail, loudly, naming what failed and no account", [failed.code, /no such table: deletion_receipts/.test(failed.out), /seeded\.example/.test(failed.out), ledger("SELECT outcome FROM job_runs")[0]?.outcome], [1, true, false, "failed"]);
  breakIt.exec("ALTER TABLE deletion_receipts_away RENAME TO deletion_receipts");
  breakIt.close();
  const retried = await nightly();
  same("nightly: a failed night may be run again, and is then done", [retried.code, /^nightly ran$/m.test(retried.out), ledger("SELECT outcome FROM job_runs")[0]?.outcome], [0, true, "done"]);

  // A run that died without a word.
  ledger("UPDATE job_runs SET outcome = 'running', finished_at = NULL, started_at = ?", iso(10 * 60_000));
  const waiting = await nightly();
  ledger("UPDATE job_runs SET started_at = ?", iso(3 * 3_600_000));
  const takenOver = await nightly();
  same("nightly: a run in progress is left alone; one that has said nothing for two hours is taken over", [/already running/.test(waiting.out), /^nightly ran$/m.test(takenOver.out), ledger("SELECT outcome FROM job_runs")[0]?.outcome], [true, true, "done"]);
  const forced = await nightly(["--force"]);
  expect("nightly: --force runs it regardless", forced.code === 0 && /forced/.test(forced.out), forced.out);

  // === A stop loses nothing ===========================================================================
  await restart();
  let pending = burst(service.base, "stop", 300);
  // Stop it once the first answer is back: some requests are then in, some in flight, some not yet
  // sent. (A fixed wait of 25 ms stopped it before any had arrived, on the machine in Jeddah.)
  await Promise.race(pending);
  const stopped = await service.end("SIGTERM");
  let answers = await Promise.all(pending);
  let acknowledged = answers.filter((answer) => answer.status === 200 && answer.stored === 1).map((answer) => answer.uuid);
  let stored = service.query("SELECT uuid FROM events WHERE uuid LIKE 'stop-%' ORDER BY uuid").map((row) => row.uuid);
  const others = answers.filter((answer) => !(answer.status === 200 && answer.stored === 1));
  same("stop: the process ends by itself, cleanly", [stopped.code, stopped.signal, /stopped\n?$/.test(service.log())], [0, null, true]);
  expect(`stop: every request it had taken was answered (${acknowledged.length} of 300 were in before the door closed)`, acknowledged.length > 0 && others.every((answer) => answer.failed === true || answer.status === 503), others.slice(0, 5));
  same("stop: every acknowledged write is in the database, and nothing is there that was not acknowledged", stored, [...acknowledged].sort());
  const wal = `${databaseFile}-wal`;
  same("stop: the write-ahead log was folded into the file, and the file is sound", [existsSync(wal) ? statSync(wal).size : 0, check(databaseFile)], [0, { integrity: "ok", foreignKeys: 0 }]);

  // === A restart in the middle of a slow request ======================================================
  await restart();
  const call = client(service.base);
  // The stand-in engine takes 600 ms over a file marked [[slow]].
  const reading = call("POST", "/v1/ocr", { token: TOKEN, raw: Buffer.from("%PDF-1.7 [[slow]] pages=3 a document"), headers: { "content-type": "application/pdf" } });
  await sleep(150);
  const ending = service.end("SIGTERM");
  await sleep(100);
  const refused = await fetch(`${service.base}/v1/health`).then((response) => response.status, () => "refused");
  const read = await reading;
  const ended = await ending;
  same("restart: the request already being read is answered in full", [read.status, read.json?.pages, read.json?.text], [200, 3, "text of 3 page(s)"]);
  expect("restart: while it finishes, no new request is taken", refused === "refused" || refused === 503, refused);
  same("restart: and it was counted before the process ended", [ended.code, { ...service.query("SELECT ocr_files, ocr_pages, ocr_pdf_files FROM usage_daily WHERE user_id = ?", USER)[0] }], [0, { ocr_files: 1, ocr_pages: 3, ocr_pdf_files: 1 }]);
  expect("restart: the stop waited for the request", /stopping signal=SIGTERM in_flight=1/.test(service.log()), service.log().split("\n").slice(-5));
  await restart();
  const me = await client(service.base)("GET", "/v1/me", { token: TOKEN });
  same("restart: the new process serves the same sign-in and the same count", [me.status, me.json?.usage?.ocrPages], [200, 3]);

  // === A kill at any moment ============================================================================
  pending = burst(service.base, "kill", 300);
  await sleep(25);
  const killed = await service.end("SIGKILL");
  answers = await Promise.all(pending);
  acknowledged = answers.filter((answer) => answer.status === 200 && answer.stored === 1).map((answer) => answer.uuid);
  await restart();
  stored = new Set(service.query("SELECT uuid FROM events WHERE uuid LIKE 'kill-%'").map((row) => row.uuid));
  same("kill: the process was killed outright, mid-work", [killed.signal, answers.some((answer) => answer.failed === true)], ["SIGKILL", true]);
  expect(`kill: every write that was acknowledged (${acknowledged.length}) survived`, acknowledged.every((uuid) => stored.has(uuid)), acknowledged.filter((uuid) => !stored.has(uuid)).slice(0, 5));
  same("kill: the database is sound and the service starts on it and answers", [check(databaseFile), (await client(service.base)("GET", "/v1/me", { token: TOKEN })).status], [{ integrity: "ok", foreignKeys: 0 }, 200]);

  // === Health, and what is closed outside tests ========================================================
  const health = await fetch(`${service.base}/internal/health`).then(async (response) => ({ status: response.status, body: await response.json() }));
  expect("health: from this machine it reports the database, the country file, the nightly job and the engine", health.status === 200 && health.body.ok === true && health.body.database.ok === true && health.body.country.state === "missing" && health.body.nightly?.outcome === "done" && health.body.engine === "local" && health.body.engineReady === true && health.body.runtime.startsWith(runtime), health);
  same("health: it is not answered through the reverse proxy", (await fetch(`${service.base}/internal/health`, { headers: { "x-forwarded-for": "203.0.113.9" } })).status, 404);
  expect("health: it names no account", !/seeded\.example|lifecycle/.test(JSON.stringify(health.body)), health.body);
  await service.end();
  await restart({ DOEDESK_ENV: "rehearsal", DOEDESK_TEST_HOOKS: "" });
  same("outside the test stage the triggers for the nightly job and for mail do not exist", [(await fetch(`${service.base}/cdn-cgi/handler/scheduled`)).status, (await fetch(`${service.base}/cdn-cgi/handler/email?from=a@b.example&to=privacy@doedesk.com`, { method: "POST", body: "x" })).status], [404, 404]);
} catch (cause) {
  failures += 1;
  console.log(`FAIL the run stopped: ${cause?.stack ?? cause}`);
  console.log(service.log().split("\n").slice(-20).join("\n"));
} finally {
  await service.stop();
  await engine.stop();
}
console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
