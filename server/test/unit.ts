// What is new in `server/`, tested piece by piece, on whichever runtime runs this file:
//
//   bun server/test/unit.ts
//   node server/test/unit.ts
//
// Country lookup (and that every failure ends as "not known"), the rule for whose address a
// request carries, the settings the server refuses to start with, the mail it sends, and the
// placeholder count the database wrapper relies on. Nothing outside this machine is called.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isReadOnlySql } from "../../src/maintenance.ts";
import { resolveCaller } from "../client-address.ts";
import { ConfigError, readConfig } from "../config.ts";
import { countPlaceholders } from "../d1.ts";
import { buildGeo } from "../geo-build.ts";
import { openGeo, readGeoFile } from "../geo.ts";
import { formatIp, inRange, parseIp } from "../ip.ts";
import { buildMessage, sendMail, SmtpError } from "../smtp.ts";

let failures = 0;
const expect = (label: string, condition: boolean, detail: unknown = null): void => {
  if (!condition) failures += 1;
  console.log(`${condition ? "ok  " : "FAIL"} ${label}${condition ? "" : ` -> ${JSON.stringify(detail)?.slice(0, 700)}`}`);
};
const same = (label: string, actual: unknown, expected: unknown): void => expect(label, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });

const HERE = dirname(fileURLToPath(import.meta.url));
const folder = mkdtempSync(join(tmpdir(), "doedesk-unit-"));
async function* lines(text: string): AsyncGenerator<string> {
  for (const line of text.split("\n")) yield line;
}
const SMALL = { minimums: { v4: 1, v6: 1, countries: 1 } };
/** A small database in DB-IP's city format: ranges in order, covering what the tests ask about. */
const CITY = [
  "0.0.0.0,0.255.255.255,ZZ,ZZ,,,0,0",
  "5.42.224.0,5.42.224.255,AS,SA,Makkah,Jeddah,21.5,39.2",
  "5.42.225.0,5.42.225.127,AS,SA,Riyadh,Riyadh,24.7,46.7",
  "5.42.225.128,5.42.225.255,AS,AE,Dubai,Dubai,25.2,55.3",
  '24.200.0.0,24.200.255.255,NA,CA,Quebec,"Montréal, QC",45.5,-73.6',
  "24.201.0.0,24.201.255.255,NA,CA,Ontario,Toronto,43.7,-79.4",
  "24.202.0.0,24.202.255.255,NA,CA,Somewhere New,Nowhere,0,0",
  '91.0.0.0,91.0.0.255,EU,UA,"Donetsk Oblast",Donetsk,48,37.8',
  "91.0.1.0,91.0.1.255,EU,UA,Kyiv City,Kyiv,50.4,30.5",
  "91.0.2.0,91.0.2.255,EU,UA,Sebastopol City,Sevastopol,44.6,33.5",
  "100.0.0.0,100.0.0.255,EU,DE,Hesse,Frankfurt,50.1,8.7",
  "2001:db8::,2001:db8::ffff,AS,SA,Riyadh,Riyadh,24.7,46.7",
  "2001:db8:1::,2001:db8:1:ffff:ffff:ffff:ffff:ffff,EU,FR,Paris,Paris,48.9,2.4",
].join("\n");

try {
  // --- Addresses -----------------------------------------------------------------------------------
  same("address: IPv4, IPv6, IPv6 short forms and an IPv4 address written as IPv6 are read", ["192.0.2.7", "2001:db8::1", "::1", "::ffff:192.0.2.7", "[2001:db8::2]", "fe80::1%en0", "2001:0db8:0000:0000:0000:0000:0000:0003"].map((ip) => formatIp(parseIp(ip) as Uint8Array)), [
    "192.0.2.7",
    "2001:db8:0:0:0:0:0:1",
    "0:0:0:0:0:0:0:1",
    "192.0.2.7",
    "2001:db8:0:0:0:0:0:2",
    "fe80:0:0:0:0:0:0:1",
    "2001:db8:0:0:0:0:0:3",
  ]);
  same("address: anything else is not an address", ["", "1.2.3", "1.2.3.4.5", "256.1.1.1", "1.2.3.x", "::g", "1::2::3", "2001:db8", "a".repeat(60), "1.2.3.4, 5.6.7.8", "example.com"].map(parseIp), new Array(11).fill(null));
  same("address: blocks", [inRange(parseIp("10.1.2.3") as Uint8Array, "10.0.0.0/8"), inRange(parseIp("11.1.2.3") as Uint8Array, "10.0.0.0/8"), inRange(parseIp("10.0.0.5") as Uint8Array, "10.0.0.5"), inRange(parseIp("2001:db8::9") as Uint8Array, "2001:db8::/32"), inRange(parseIp("10.0.0.1") as Uint8Array, "2001:db8::/32"), inRange(parseIp("10.129.0.1") as Uint8Array, "10.128.0.0/9")], [true, false, true, true, false, true]);

  // --- Country lookup -------------------------------------------------------------------------------
  const geoFile = join(folder, "country.ddgeo");
  const built = await buildGeo(lines(CITY), { source: "test-city", ...SMALL });
  writeFileSync(geoFile, built.bytes);
  const geo = openGeo(geoFile);
  const at = (ip: string): string => {
    const place = geo.lookup(ip);
    return place.country === null ? "unknown" : place.region === null ? place.country : `${place.country}-${place.region}`;
  };
  same("country: the file loads and says what it holds", [geo.status().state, geo.status().source, geo.status().ranges > 0], ["ok", "test-city", true]);
  same("country: an address in Saudi Arabia is in Saudi Arabia, to the last address of its range", [at("5.42.224.0"), at("5.42.224.255"), at("5.42.225.127"), at("2001:db8::7"), at("::ffff:5.42.224.9")], ["SA", "SA", "SA", "SA", "SA"]);
  same("country: the address after a Saudi range is not Saudi", [at("5.42.225.128"), at("5.42.226.0"), at("5.42.223.255"), at("2001:db8::1:0")], ["AE", "unknown", "unknown", "unknown"]);
  same("country: adjoining ranges of one country were joined, and ranges of different countries were not", [built.v4, built.v6], [10, 2]);
  same("country: a region is kept where a rule reads it, under its ISO code, and nowhere else", [at("24.200.9.9"), at("24.201.9.9"), at("24.202.9.9"), at("91.0.0.9"), at("91.0.1.9"), at("91.0.2.9"), at("100.0.0.9")], ["CA-QC", "CA-ON", "CA", "UA-14", "UA", "UA-40", "DE"]);
  same("country: an address that belongs to no country, a private one, this machine, or nonsense is not known", [at("0.1.2.3"), at("10.0.0.1"), at("127.0.0.1"), at("::1"), at(""), at("unknown"), at("1.2.3.4, 5.42.224.1"), at("5.42.224.1; DROP")], new Array(8).fill("unknown"));

  // Fail safe: every way the file can be wrong.
  same("country: no file configured, or no such file: every lookup is not known", [openGeo("").lookup("5.42.224.1").country, openGeo(join(folder, "absent.ddgeo")).lookup("5.42.224.1").country, openGeo(join(folder, "absent.ddgeo")).status().state], [null, null, "missing"]);
  const damaged = Buffer.from(built.bytes);
  damaged[damaged.length - 200] = (damaged[damaged.length - 200] ?? 0) ^ 0xff;
  writeFileSync(join(folder, "damaged.ddgeo"), damaged);
  writeFileSync(join(folder, "cut.ddgeo"), built.bytes.subarray(0, built.bytes.length - 500));
  writeFileSync(join(folder, "other.ddgeo"), "not a country file at all, just some text that is long enough to be read");
  same("country: a damaged file, a cut one and a file of another kind are refused whole: not known", ["damaged", "cut", "other"].map((name) => [openGeo(join(folder, `${name}.ddgeo`)).status().state, openGeo(join(folder, `${name}.ddgeo`)).lookup("5.42.224.1").country]), new Array(3).fill(["invalid", null]));
  const old = await buildGeo(lines(CITY), { source: "test-old", built: new Date(Date.now() - 101 * 86_400_000).toISOString(), ...SMALL });
  writeFileSync(join(folder, "old.ddgeo"), old.bytes);
  const stale = openGeo(join(folder, "old.ddgeo"), { maxAgeDays: 100 });
  same("country: a file older than the limit is not trusted: not known, and the status says stale", [stale.status().state, stale.lookup("5.42.224.1").country, openGeo(join(folder, "old.ddgeo"), { maxAgeDays: 200 }).lookup("5.42.224.1").country], ["stale", null, "SA"]);

  // Reload: a new file is picked up; a bad new file does not leave old answers in place.
  const live = join(folder, "live.ddgeo");
  writeFileSync(live, built.bytes);
  const reloading = openGeo(live);
  const moved = await buildGeo(lines(CITY.replace("AS,SA,Makkah,Jeddah", "AS,QA,Doha,Doha")), { source: "test-moved", ...SMALL });
  writeFileSync(live, moved.bytes);
  utimesSync(live, new Date(), new Date(Date.now() + 5000));
  reloading.reload();
  const afterGood = reloading.lookup("5.42.224.1").country;
  writeFileSync(live, "broken");
  utimesSync(live, new Date(), new Date(Date.now() + 10_000));
  reloading.reload();
  same("country: a replaced file is read again; a replacement that is broken gives not known, never yesterday's answer", [afterGood, reloading.lookup("5.42.224.1").country, reloading.status().state], ["QA", null, "invalid"]);

  // The builder refuses data that is not the real thing.
  const refuses = async (text: string, options = SMALL): Promise<boolean> => buildGeo(lines(text), { source: "x", ...options }).then(() => false, () => true);
  same("country builder: refuses ranges out of order, overlapping, backwards, unreadable, and a database that is too small", [
    await refuses("5.0.0.0,5.0.0.255,AS,SA,,,0,0\n4.0.0.0,4.0.0.255,AS,SA,,,0,0"),
    await refuses("5.0.0.0,5.0.0.255,AS,SA,,,0,0\n5.0.0.255,5.0.1.255,AS,AE,,,0,0"),
    await refuses("5.0.0.9,5.0.0.1,AS,SA,,,0,0"),
    await refuses("5.0.0.0,5.0.0.255,AS,Saudi,,,0,0"),
    await refuses(CITY, { minimums: { v4: 100_000, v6: 50_000, countries: 200 } }),
  ], [true, true, true, true, true]);
  same("country builder: also takes the three-column country file", (await buildGeo(lines("5.0.0.0,5.0.0.255,SA\n2001:db8::,2001:db8::ff,SA"), { source: "c", ...SMALL })).codes, ["SA"]);
  same("country file: the checksum covers every byte before it", [(() => { try { readGeoFile(geoFile); return "ok"; } catch { return "refused"; } })(), statSync(geoFile).size > 100], ["ok", true]);

  // --- Whose address a request carries --------------------------------------------------------------
  const trust = { trustedProxies: [] as Array<string>, forwardSecret: "" };
  const from = (peer: string, headers: Record<string, string>, settings = trust) => resolveCaller(new Headers(headers), peer, settings);
  same("address rule: through the proxy on this machine, the caller is the last entry the proxy wrote", [from("127.0.0.1", { "x-forwarded-for": "203.0.113.9" }).ip, from("::1", { "x-forwarded-for": "2001:db8::9" }).ip, from("::ffff:127.0.0.1", { "x-forwarded-for": "203.0.113.9" }).ip], ["203.0.113.9", "2001:db8:0:0:0:0:0:9", "203.0.113.9"]);
  same("address rule: entries the caller put in front are ignored", from("127.0.0.1", { "x-forwarded-for": "5.42.224.1, 10.0.0.1, 203.0.113.9" }).ip, "203.0.113.9");
  same("address rule: a connection from anywhere else is its own address, whatever it sends", [from("198.51.100.4", { "x-forwarded-for": "5.42.224.1" }).ip, from("198.51.100.4", { "x-forwarded-for": "5.42.224.1", "cf-connecting-ip": "5.42.224.1", "x-real-ip": "5.42.224.1" }).ip], ["198.51.100.4", "198.51.100.4"]);
  same("address rule: no header through the proxy is the proxy itself; a header that is not an address is unknown", [from("127.0.0.1", {}).ip, from("127.0.0.1", { "x-forwarded-for": "garbage" }).ip, from("", {}).ip], ["127.0.0.1", "unknown", "unknown"]);
  same("address rule: a second trusted proxy can be named, as an address or a block", [from("10.0.0.7", { "x-forwarded-for": "203.0.113.9" }, { ...trust, trustedProxies: ["10.0.0.0/24"] }).ip, from("10.0.1.7", { "x-forwarded-for": "203.0.113.9" }, { ...trust, trustedProxies: ["10.0.0.0/24"] }).ip], ["203.0.113.9", "10.0.1.7"]);
  const secret = "s".repeat(40);
  const forwarded = { "x-forwarded-for": "172.64.1.1", "x-doedesk-forward-secret": secret, "x-doedesk-client-ip": "5.42.224.1", "x-doedesk-client-country": "sa", "x-doedesk-client-region": "01" };
  same("address rule: the forwarding Worker's word is taken with the secret", from("127.0.0.1", forwarded, { ...trust, forwardSecret: secret }), { ip: "5.42.224.1", stated: { country: "SA", region: "01" } });
  same("address rule: without the secret, with a wrong one, with none configured, or not through the proxy, it is not", [
    from("127.0.0.1", { ...forwarded, "x-doedesk-forward-secret": "" }, { ...trust, forwardSecret: secret }),
    from("127.0.0.1", { ...forwarded, "x-doedesk-forward-secret": "t".repeat(40) }, { ...trust, forwardSecret: secret }),
    from("127.0.0.1", forwarded, trust),
    from("198.51.100.4", forwarded, { ...trust, forwardSecret: secret }),
  ], [{ ip: "172.64.1.1" }, { ip: "172.64.1.1" }, { ip: "172.64.1.1" }, { ip: "198.51.100.4" }]);
  same("address rule: the Worker stating no country means not known, not a lookup", from("127.0.0.1", { ...forwarded, "x-doedesk-client-country": "" }, { ...trust, forwardSecret: secret }).stated, { country: null, region: "01" });

  // --- Settings ------------------------------------------------------------------------------------
  const jwk = JSON.stringify({ kty: "EC", crv: "P-256", d: "x", x: "x", y: "y" });
  const good = { DOEDESK_DATABASE: join(folder, "db.sqlite"), JWT_PRIVATE_JWK: jwk, ADMIN_KEY: "a".repeat(32), ENGINE_URL: "http://127.0.0.1:8080", AUTHENTICA_API_KEY: "k", SMTP_HOST: "smtp.example", SMTP_USERNAME: "u", SMTP_PASSWORD: "p" };
  const problems = (source: Record<string, string | undefined>): Array<string> => {
    try {
      readConfig(source);
      return [];
    } catch (cause) {
      return cause instanceof ConfigError ? [...cause.problems] : [String(cause)];
    }
  };
  same("settings: a complete production set is taken, and production is the default", [problems(good), readConfig(good).stage, readConfig(good).host, readConfig(good).vars.ENGINE_URL], [[], "production", "127.0.0.1", "http://127.0.0.1:8080"]);
  expect("settings: production refuses to return sign-in codes, to open the test triggers, or to run without a way to send mail", problems({ ...good, EXPOSE_LOGIN_SECRETS: "1" }).length === 1 && problems({ ...good, DOEDESK_TEST_HOOKS: "1" }).length >= 1 && problems({ ...good, SMTP_HOST: "" }).length === 1 && problems({ ...good, SMTP_PASSWORD: "" }).length === 1, [problems({ ...good, EXPOSE_LOGIN_SECRETS: "1" }), problems({ ...good, DOEDESK_TEST_HOOKS: "1" })]);
  expect("settings: the test triggers open in the test stage only", problems({ ...good, DOEDESK_ENV: "rehearsal", DOEDESK_TEST_HOOKS: "1" }).length === 1 && problems({ ...good, DOEDESK_ENV: "test", DOEDESK_TEST_HOOKS: "1" }).length === 0);
  expect("settings: a missing database path, signing key or admin key, and a short key, are each named", problems({ ...good, DOEDESK_DATABASE: "" }).length === 1 && problems({ ...good, JWT_PRIVATE_JWK: "" }).length === 1 && problems({ ...good, ADMIN_KEY: "short" }).length === 1 && problems({ ...good, FORWARD_SECRET: "short" }).length === 1 && problems({ ...good, MAIL_INGEST_KEY: "short" }).length === 1);
  expect("settings: detection and reading need the engine's address, and nothing stands in for it", problems({ ...good, ENGINE_URL: "" }).length === 1 && problems({ ...good, ENGINE_URL: "127.0.0.1:8080" }).length === 1);
  same("settings: the engine's prices are optional, and must be numbers when set", [problems({ ...good, ENGINE_PRICE_PER_1000_UNITS: "1.5", ENGINE_PRICE_PER_1000_PAGES: "0" }).length, problems({ ...good, ENGINE_PRICE_PER_1000_PAGES: "$1" }).length, readConfig({ ...good, ENGINE_PRICE_PER_1000_PAGES: "2" }).vars.ENGINE_PRICE_PER_1000_PAGES], [0, 1, "2"]);
  const leaked = problems({ ...good, ADMIN_KEY: "tiny-secret", JWT_PRIVATE_JWK: '{"kty":"oct","k":"leak-me"}', FORWARD_SECRET: "forward-leak" }).join("\n");
  expect("settings: a refusal names the setting and never repeats its value", leaked.length > 0 && !/tiny-secret|leak-me|forward-leak/.test(leaked), leaked);

  // --- Statements --------------------------------------------------------------------------------------
  same("placeholders: counted as SQLite counts them, skipping text and comments", [countPlaceholders("SELECT ?"), countPlaceholders("SELECT ?, ?, ?"), countPlaceholders("SELECT ?1, ?2, ?1"), countPlaceholders("SELECT ?3"), countPlaceholders("SELECT ?2, ?"), countPlaceholders("SELECT '?' , \"a?\" , ? -- ?\n, /* ? */ ?"), countPlaceholders("SELECT 'it''s ?', ?"), countPlaceholders("SELECT 1")], [1, 3, 2, 3, 3, 2, 1, 0]);
  same("reads and writes are told apart for the freeze", ["SELECT 1", "  select * from users", "WITH m AS (SELECT 1) SELECT * FROM m", "INSERT INTO t VALUES (1)", "UPDATE t SET a = 1", "DELETE FROM t", "WITH m AS (SELECT 1) INSERT INTO t SELECT * FROM m", "PRAGMA journal_mode = DELETE", "DROP TABLE users", "REPLACE INTO t VALUES (1)", "INSERT INTO t VALUES (1) RETURNING a"].map(isReadOnlySql), [true, true, true, false, false, false, false, false, false, false, false]);

  // --- Mail ------------------------------------------------------------------------------------------
  const message = { to: "person@example.com", from: { email: "signin@doedesk.com", name: "DoeDesk" }, subject: "تسجيل الدخول إلى DoeDesk", text: "Line one\n.A line that starts with a dot\nhttps://doedesk.com/auth/confirm#r=1&t=2\n", html: "<p>مرحبًا</p>" };
  const wire = buildMessage(message, "id-1@doedesk.com", new Date("2026-11-18T10:00:00Z"));
  const subjectLine = /^Subject: (.*(?:\r\n .*)*)$/m.exec(wire)?.[1] ?? "";
  const decoded = [...subjectLine.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)].map((match) => Buffer.from(match[1] ?? "", "base64").toString("utf8")).join("");
  expect("mail: headers are complete, an Arabic subject is encoded and decodes back, and both forms of the body are carried", wire.includes('From: "DoeDesk" <signin@doedesk.com>') && wire.includes("To: <person@example.com>") && wire.includes("Message-ID: <id-1@doedesk.com>") && wire.includes("Date: Wed, 18 Nov 2026 10:00:00 +0000") && decoded === message.subject && wire.includes("multipart/alternative") && wire.includes(Buffer.from(message.html).toString("base64")) && wire.split("\r\n").every((line) => line.length <= 78), { subjectLine, decoded });
  same("mail: a line break in an address or a subject is refused, so no header can be added", [{ ...message, to: "a@example.com\r\nBcc: x@example.com" }, { ...message, subject: "x\nBcc: y@example.com" }, { ...message, from: { email: "a@b.c\n" } }].map((bad) => { try { buildMessage(bad, "i@d"); return "built"; } catch (cause) { return (cause as SmtpError).code; } }), ["smtp_invalid", "smtp_invalid", "smtp_invalid"]);

  const startStub = async (mode: string): Promise<{ port: number; stop: () => void; folder: string }> => {
    const stubFolder = mkdtempSync(join(folder, "smtp-"));
    const child = spawn("node", [join(HERE, "smtp-stub.mjs"), stubFolder], { env: { ...process.env, STUB_MODE: mode }, stdio: ["ignore", "pipe", "inherit"] });
    const port = await new Promise<number>((resolve, reject) => {
      child.stdout.once("data", (chunk: Buffer) => resolve((JSON.parse(chunk.toString()) as { port: number }).port));
      child.once("exit", () => reject(new Error("the mail stand-in did not start")));
    });
    return { port, stop: () => child.kill("SIGTERM"), folder: stubFolder };
  };
  const settings = (port: number) => ({ host: "localhost", port, username: "stub-user", password: "stub-password", allowSelfSigned: true, timeoutMs: 5000 });
  const stub = await startStub("");
  const sent = await sendMail(settings(stub.port), message).then((result) => result.messageId, (cause) => `failed: ${(cause as SmtpError).code} ${String(cause)}`);
  const received = existsSync(join(stub.folder, "messages.jsonl")) ? (JSON.parse(readFileSync(join(stub.folder, "messages.jsonl"), "utf8").trim()) as Record<string, string | boolean>) : {};
  const part = (type: string): string => Buffer.from(new RegExp(`Content-Type: ${type}[^\\r]*\\r\\nContent-Transfer-Encoding: base64\\r\\n\\r\\n([A-Za-z0-9+/=\\r\\n]+)`).exec(String(received.data))?.[1]?.replace(/\s/g, "") ?? "", "base64").toString("utf8");
  expect("mail: sent over STARTTLS with the user name and password, to the right envelope, and it arrives whole", /@doedesk\.com$/.test(sent) && received.tls === true && received.user === "stub-user" && received.password === "stub-password" && received.from === "signin@doedesk.com" && received.to === "person@example.com" && part("text/plain") === message.text && part("text/html") === message.html, { sent, received: { ...received, data: String(received.data).slice(0, 200) } });
  const untrusted = await sendMail({ ...settings(stub.port), allowSelfSigned: false }, message).then(() => "sent", (cause) => (cause as SmtpError).code);
  same("mail: a server whose certificate cannot be checked is not given the password or the message", [untrusted, readFileSync(join(stub.folder, "messages.jsonl"), "utf8").trim().split("\n").length], ["smtp_tls", 1]);
  const badPassword = await sendMail({ ...settings(stub.port), password: "wrong" }, message).then(() => "sent", (cause) => (cause as SmtpError).code);
  same("mail: a refused sign-in is reported by its number", badPassword, "smtp_535");
  stub.stop();
  const rejecting = await startStub("reject");
  const rejected = await sendMail(settings(rejecting.port), message).then(() => ({ code: "sent", text: "" }), (cause) => ({ code: (cause as SmtpError).code, text: String(cause) }));
  expect("mail: a refused recipient is reported by number, and the error does not repeat the address", rejected.code === "smtp_550" && !rejected.text.includes("person@example.com"), rejected);
  rejecting.stop();
  const plain = await startStub("no-starttls");
  same("mail: a server that offers no TLS is not used", await sendMail(settings(plain.port), message).then(() => "sent", (cause) => (cause as SmtpError).code), "smtp_tls");
  plain.stop();
  const silent = await startStub("silent");
  const startedAt = Date.now();
  const timedOut = await sendMail({ ...settings(silent.port), timeoutMs: 700 }, message).then(() => "sent", (cause) => (cause as SmtpError).code);
  expect("mail: a server that does not answer is given up on after the time allowed", timedOut === "smtp_timeout" && Date.now() - startedAt < 3000, { timedOut, ms: Date.now() - startedAt });
  silent.stop();
  same("mail: nothing listening is reported as such", await sendMail({ ...settings(1), timeoutMs: 3000 }, message).then(() => "sent", (cause) => (cause as SmtpError).code), "smtp_connect");
} finally {
  rmSync(folder, { recursive: true, force: true });
}
console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
