// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Accelerate Technology Establishment
// The tools that move the database, tried on a local D1 holding awkward data:
//   - copy-from-d1: export, import, verify; and that it refuses an unsafe folder or an existing file;
//   - the comparison notices every kind of difference: a changed character, a missing row, a number
//     that became text, an empty text that became nothing, a changed schema;
//   - the server starts on the copy, knows which migrations it has, and serves the same sign-in;
//   - back-copy: what the server holds afterwards loads into a D1 and compares the same, with no
//     statement longer than D1 takes.
//
//   node server/test/migration.mjs          (DOEDESK_TEST_TARGET=node for the server on Node)
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { client, sha256Hex, startServerService, TARGET } from "../../test/local-service.mjs";
import { compare, D1_STATEMENT_BYTES, fingerprint, openSource, ROOT } from "../migration/lib.mjs";

let failures = 0;
const expect = (label, condition, detail = null) => {
  if (!condition) failures += 1;
  console.log(`${condition ? "ok  " : "FAIL"} ${label}${condition ? "" : ` -> ${JSON.stringify(detail)?.slice(0, 900)}`}`);
};
const same = (label, actual, expected) => expect(label, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });

const work = mkdtempSync(join(tmpdir(), "doedesk-migration-"));
chmodSync(work, 0o700);
const wrangler = (args, options = {}) => spawnSync("npx", ["wrangler", ...args], { cwd: ROOT, encoding: "utf8", env: { ...process.env, CI: "1", NO_COLOR: "1" }, maxBuffer: 256 * 1024 * 1024, ...options });
const tool = (script, args) => spawnSync("node", ["--disable-warning=ExperimentalWarning", join(ROOT, "server", "migration", script), ...args], { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const mustRun = (result, what) => {
  if (result.status !== 0) throw new Error(`${what} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
};
const localD1 = (state, withSchema) => {
  if (withSchema) mustRun(wrangler(["d1", "migrations", "apply", "doedesk-cloud", "--local", "--persist-to", state]), "applying migrations to a local D1");
  return state;
};
const load = (state, file) => mustRun(wrangler(["d1", "execute", "doedesk-cloud", "--local", "--persist-to", state, "--file", file, "--yes"]), "loading SQL into a local D1");

// --- Data chosen to be awkward -------------------------------------------------------------------------
const NOW = new Date().toISOString();
const q = (value) => (value === null ? "NULL" : typeof value === "number" ? String(value) : `'${String(value).replace(/'/g, "''")}'`);
const insert = (table, row) => `INSERT INTO ${table} (${Object.keys(row).join(", ")}) VALUES (${Object.values(row).map(q).join(", ")});`;
const TOKEN = "dd_test_migration_token";
const SECRET_MARKS = ["awkward-one@seeded.example", "+966500000077", "فاطمة", "long-mail-sender@elsewhere.example"];
const longMail = `From: long-mail-sender@elsewhere.example\r\nSubject: it's "long"; -- not a comment\r\n\r\n${"السلام عليكم ✓ it's a 'quoted' line; with; semicolons\n".repeat(4200)}`;
const seed = [
  insert("users", { id: "u-1", email: "awkward-one@seeded.example", phone: null, created_at: NOW, country: "SA", signup_method: "email", field: "other", field_other: "فاطمة's \"field\"; DROP TABLE users; --", workplace: null, profile_at: NOW }),
  insert("users", { id: "u-2", email: null, phone: "+966500000077", created_at: NOW, country: null, signup_method: "phone", field: "", workplace: "self" }),
  insert("sessions", { token_hash: sha256Hex(TOKEN), user_id: "u-1", client: "desktop", device: "123", created_at: NOW, last_used_at: NOW }),
  insert("sessions", { token_hash: "h-2", user_id: "u-2", client: "mobile", device: null, created_at: NOW, last_used_at: NOW }),
  insert("usage", { user_id: "u-1", month: "2026-10", detect_characters: 12345, ocr_pages: 7, ocr_bytes: 9007199254740991 }),
  insert("usage_daily", { user_id: "u-1", day: "2026-11-17", client: "desktop", detect_requests: 3, detect_characters: 4000 }),
  insert("usage_daily", { user_id: "u-2", day: "2026-11-18", client: "mobile", ocr_files: 1, ocr_pages: 2 }),
  insert("events", { uuid: "e-1", event: "client.turn.requested", distinct_id: "i", install_id: "i", at: NOW, day: NOW.slice(0, 10), received_at: NOW, country: "SA", properties: JSON.stringify({ platform: "darwin", note: "line\nbreak 'quote' \"double\" 🦌", n: 1.5 }) }),
  insert("rate_limits", { key: "mail:to:awkward-one@seeded.example:60", bucket: "29000000", count: 1 }),
  insert("login_requests", { id: "r-1", kind: "email", identifier: "awkward-one@seeded.example", secret_hash: "h", poll_hash: null, client: "desktop", device: null, country: null, city: null, created_at: NOW, expires_at: NOW, acceptance: JSON.stringify({ termsVersion: "1.1" }) }),
  insert("acceptances", { id: "a-1", user_id: "u-1", document: "terms", decision: "accepted", terms_version: "1.1", privacy_version: "1.1", locale: "ar", method: "checkbox+button", accepted_at: NOW }),
  // Two rows that are the same in every column, in a table with no key.
  insert("test_inbox", { address: "e2e-samesame1@doedesk.com", received_at: NOW, raw: "same" }),
  insert("test_inbox", { address: "e2e-samesame1@doedesk.com", received_at: NOW, raw: "same" }),
  insert("usage_data_choices", { install_id: "11111111-2222-4333-8444-555555555555", state: "off", chosen_at: NOW, received_at: NOW }),
  // A long message, put in piece by piece because D1 takes no statement over 100,000 bytes.
  insert("contact_mail", { id: "m-1", address: "privacy@doedesk.com", sender: "long-mail-sender@elsewhere.example", subject: "", received_at: NOW, raw: "" }),
  ...Array.from({ length: Math.ceil(longMail.length / 20_000) }, (_, index) => `UPDATE contact_mail SET raw = raw || ${q(longMail.slice(index * 20_000, (index + 1) * 20_000))} WHERE id = 'm-1';`),
].join("\n");

try {
  const state = localD1(join(work, "d1"), true);
  writeFileSync(join(work, "seed.sql"), seed);
  load(state, join(work, "seed.sql"));

  // One row of the ledger per migration file.
  const MIGRATIONS = readdirSync(join(ROOT, "migrations")).filter((name) => name.endsWith(".sql")).length;
  // --- Copy ---------------------------------------------------------------------------------------------
  const out = join(work, "private");
  mkdirSync(out, { mode: 0o700 });
  const copied = tool("copy-from-d1.mjs", ["--from", `d1:local:${state}`, "--out", out]);
  const file = join(out, "doedesk.sqlite");
  expect("copy: export, import and verify all pass, and say so", copied.status === 0 && /1\. export/.test(copied.stdout) && /2\. import.*sound/.test(copied.stdout) && /3\. verify/.test(copied.stdout) && /The copy is exact/.test(copied.stdout) && !/DIFF/.test(copied.stdout), [copied.status, copied.stdout.slice(-600), copied.stderr.slice(-400)]);
  expect("copy: every table is listed with its row count and checksum, and no row is printed", /same {2}contact_mail\s+1 rows {2}[0-9a-f]{16}/.test(copied.stdout) && /same {2}test_inbox\s+2 rows/.test(copied.stdout) && new RegExp(`same {2}d1_migrations\\s+${MIGRATIONS} rows`).test(copied.stdout) && SECRET_MARKS.every((mark) => !copied.stdout.includes(mark) && !copied.stderr.includes(mark)), copied.stdout);
  const recorded = JSON.parse(readFileSync(join(out, "verify.json"), "utf8"));
  expect("copy: a record of the comparison is kept beside the copy, with no row in it", recorded.same === true && recorded.d1.tables.length === recorded.copy.tables.length && SECRET_MARKS.every((mark) => !JSON.stringify(recorded).includes(mark)), recorded.problems);
  const direct = new DatabaseSync(file, { readOnly: true });
  const mail = direct.prepare("SELECT raw FROM contact_mail").get().raw;
  const big = direct.prepare("SELECT CAST(ocr_bytes AS TEXT) AS bytes FROM usage").get().bytes;
  const blank = direct.prepare("SELECT field IS NULL AS missing, field = '' AS blank, device FROM users JOIN sessions ON user_id = id WHERE id = 'u-2'").get();
  direct.close();
  same("copy: a long message with quotes, semicolons and two scripts; the largest whole number D1 can hold; empty text beside nothing: all arrive as they were", [mail === longMail, big, { ...blank }], [true, "9007199254740991", { missing: 0, blank: 1, device: null }]);
  same("copy: the file and the export can be read by their owner alone", [(await import("node:fs")).statSync(file).mode & 0o777, (await import("node:fs")).statSync(join(out, "d1-export.sql")).mode & 0o777], [0o600, 0o600]);

  const again = tool("copy-from-d1.mjs", ["--from", `d1:local:${state}`, "--out", out]);
  const inRepo = tool("copy-from-d1.mjs", ["--from", `d1:local:${state}`, "--out", join(ROOT, "server", "test", `not-here-${process.pid}`)]);
  rmSync(join(ROOT, "server", "test", `not-here-${process.pid}`), { recursive: true, force: true });
  const open = join(work, "open");
  mkdirSync(open, { mode: 0o755 });
  const readable = tool("copy-from-d1.mjs", ["--from", `d1:local:${state}`, "--out", open]);
  same("copy: refuses to write over a file, into a git repository, or into a folder others can read", [again.status, /exists/.test(again.stderr), inRepo.status, /inside a git repository/.test(inRepo.stderr), readable.status, /can be read by other users/.test(readable.stderr)], [1, true, 1, true, 1, true]);

  // --- The comparison notices ------------------------------------------------------------------------------
  const original = fingerprint(openSource(`sqlite:${file}`));
  const differs = (name, change) => {
    const altered = join(work, `altered-${name}.sqlite`);
    copyFileSync(file, altered);
    const database = new DatabaseSync(altered);
    database.exec(change);
    database.close();
    const source = openSource(`sqlite:${altered}`);
    const result = compare(original, fingerprint(source));
    source.close();
    return result.problems.map((problem) => problem.replace(/sqlite:[^\s,:]+/g, "X"));
  };
  same("verify: one changed character in one long row", differs("character", "UPDATE contact_mail SET raw = replace(raw, 'Subject: it', 'Subject: It')"), ["contact_mail: same number of rows (1), different contents"]);
  same("verify: a missing row, and an extra one", [differs("missing", "DELETE FROM test_inbox WHERE rowid = 1"), differs("extra", `INSERT INTO rate_limits (key, bucket, count) VALUES ('x', '1', 1)`)], [["test_inbox: 2 rows in X, 1 in X"], ["rate_limits: 1 rows in X, 2 in X"]]);
  same("verify: empty text that became nothing, a number that lost its last digit, and text that differs only in case", [differs("null", "UPDATE users SET field = NULL WHERE id = 'u-2'"), differs("precision", "UPDATE usage SET ocr_bytes = 9007199254740990"), differs("case", "UPDATE users SET email = upper(email) WHERE id = 'u-1'")], [["users: same number of rows (2), different contents"], ["usage: same number of rows (1), different contents"], ["users: same number of rows (2), different contents"]]);
  expect("verify: a changed schema: an index added, a table gone", differs("index", "CREATE INDEX extra_index ON users(country)").some((problem) => problem.startsWith("schema: only in X: index extra_index")) && differs("table", "DROP TABLE usage_data_choices").some((problem) => problem.startsWith("usage_data_choices: missing")), differs("index", "CREATE INDEX extra_index ON users(country)"));
  const cli = tool("verify.mjs", ["--a", `d1:local:${state}`, "--b", `sqlite:${join(work, "altered-missing.sqlite")}`]);
  expect("verify: the command exits 1 on a difference and names the table, with no row", cli.status === 1 && /DIFF {2}test_inbox/.test(cli.stdout) && /DIFFERENT/.test(cli.stdout) && SECRET_MARKS.every((mark) => !cli.stdout.includes(mark)), [cli.status, cli.stdout.slice(-400)]);

  // --- The server on the copy ------------------------------------------------------------------------------
  const serverFolder = join(work, "server");
  mkdirSync(serverFolder);
  copyFileSync(file, join(serverFolder, "doedesk.sqlite"));
  const service = await startServerService({ runtime: TARGET === "node" ? "node" : "bun", folder: serverFolder });
  let afterFile;
  try {
    const status = service.run("migrate.ts", ["--status"]);
    expect("server: the copy arrives knowing its five migrations, and none is pending", /applied: 0001_init\.sql, 0002_accounts_v2\.sql, 0003_test_inbox\.sql, 0004_usage_metering\.sql, 0005_consent_rights_retention\.sql/.test(status) && /pending: none/.test(status), status);
    const call = client(service.base);
    const me = await call("GET", "/v1/me", { token: TOKEN });
    same("server: a sign-in made on Cloudflare works here, with the same account and the same usage so far", [me.status, me.json?.email, me.json?.usage?.detectCharacters], [200, "awkward-one@seeded.example", 4000]);
    const detected = await call("POST", "/v1/detect", { token: TOKEN, body: { texts: ["Jane Doe"] } });
    const started = await call("POST", "/v1/auth/email/start", { body: { email: "after-the-move@person.example", client: "desktop" } });
    const link = new URL(started.json.testLink);
    await call("POST", "/auth/confirm", { raw: new URLSearchParams({ r: link.searchParams.get("r"), t: link.searchParams.get("t") }).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
    const signedIn = await call("POST", "/v1/auth/email/poll", { body: { requestId: started.json.requestId, pollSecret: started.json.pollSecret } });
    same("server: it takes new work on top: a detection is counted, a new account signs in", [detected.status, (await call("GET", "/v1/me", { token: TOKEN })).json?.usage?.detectCharacters, signedIn.json?.created], [200, 4008, true]);
  } finally {
    await service.end();
    afterFile = join(work, "after.sqlite");
    copyFileSync(join(serverFolder, "doedesk.sqlite"), afterFile);
  }

  // --- Going back ------------------------------------------------------------------------------------------
  const back = tool("back-copy.mjs", ["--sqlite", afterFile, "--out", out]);
  const statements = readFileSync(join(out, "back-copy.sql"), "utf8").split(";\n").filter((statement) => statement.trim() !== "");
  const longest = statements.reduce((most, statement) => Math.max(most, Buffer.byteLength(statement, "utf8")), 0);
  expect("back-copy: writes the SQL and the two commands to run, touches no D1 itself, and prints no row", back.status === 0 && /wrangler d1 execute doedesk-cloud --remote --file/.test(back.stdout) && /verify\.mjs/.test(back.stdout) && SECRET_MARKS.every((mark) => !back.stdout.includes(mark)), [back.status, back.stdout, back.stderr]);
  expect(`back-copy: no statement is longer than D1 takes (the longest is ${longest} bytes of ${D1_STATEMENT_BYTES})`, longest < D1_STATEMENT_BYTES && statements.length > 30, longest);
  // Loaded over the D1 the data first came from, which still holds the old rows.
  load(state, join(out, "back-copy.sql"));
  const overOld = tool("verify.mjs", ["--a", `sqlite:${afterFile}`, "--b", `d1:local:${state}`]);
  expect("back-copy: loaded over the old D1, D1 then holds exactly what the server held, new account included", overOld.status === 0 && /the same/.test(overOld.stdout) && /same {2}users\s+3 rows/.test(overOld.stdout), [overOld.status, overOld.stdout.slice(-700), overOld.stderr.slice(-300)]);
  const fresh = localD1(join(work, "d1-fresh"), false);
  load(fresh, join(out, "back-copy.sql"));
  const intoFresh = tool("verify.mjs", ["--a", `sqlite:${afterFile}`, "--b", `d1:local:${fresh}`]);
  expect("back-copy: loaded into an empty D1, the same", intoFresh.status === 0, [intoFresh.stdout.slice(-500), intoFresh.stderr.slice(-300)]);
} catch (cause) {
  failures += 1;
  console.log(`FAIL the run stopped: ${cause?.stack ?? cause}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
