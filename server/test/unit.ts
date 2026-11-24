// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Accelerate Technology Establishment
// What is new in `server/`, tested piece by piece, on whichever runtime runs this file:
//
//   bun server/test/unit.ts
//   node server/test/unit.ts
//
// Country lookup (and that every failure ends as "not known"), the rule for whose address a
// request carries, the settings the server refuses to start with, the mail it sends, and the
// placeholder count the database wrapper relies on. Nothing outside this machine is called.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isReadOnlySql } from "../../src/maintenance.ts";
import { defaultAccountRegion, EU_REGION_COUNTRIES } from "../../src/regions.ts";
import { WorkerQueue } from "../../src/worker-queue.ts";
import { ACCOUNT_REGIONS, isOpenWeightWorkerModel, recordCheckDue, servedWhereRequired, workerSettingProblems, workerUpstream } from "../../src/worker-regions.ts";
import { resolveCaller } from "../client-address.ts";
import { ConfigError, readConfig } from "../config.ts";
import { countPlaceholders } from "../d1.ts";
import { buildGeo } from "../geo-build.ts";
import { openGeo, readGeoFile } from "../geo.ts";
import { formatIp, inRange, parseIp } from "../ip.ts";
import { loadRuntime } from "../runtime/index.ts";
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
  same(
    "settings: each region's worker is optional; its settings reach the handlers, its address must be one, and its prices numbers",
    [
      problems(good).length,
      readConfig(good).vars.WORKER_SA_API_KEY,
      problems({ ...good, WORKER_EU_URL: "eu.openrouter.ai/api/v1" }),
      problems({ ...good, WORKER_GLOBAL_STRUCTURED: "xml", WORKER_SA_MIN_OUTPUT_TOKENS: "0", WORKER_EU_PROVIDER: "[1]" }).length,
      problems({ ...good, WORKER_SA_PARALLEL: "0", WORKER_SA_PER_MINUTE: "many", WORKER_EU_MAX_WAIT_SECONDS: "60" }),
      problems({ ...good, WORKER_PRICE_PER_1M_INPUT_TOKENS: "cheap" }).length,
      ((vars) => [vars.WORKER_SA_URL, vars.WORKER_SA_API_KEY, vars.WORKER_EU_MODEL, vars.WORKER_EU_PROVIDER, vars.WORKER_GLOBAL_EXPECTED_PROVIDER, vars.WORKER_PRICE_PER_1M_INPUT_TOKENS, vars.WORKER_PRICE_PER_1M_OUTPUT_TOKENS])(
        readConfig({ ...good, WORKER_SA_URL: "https://worker.example/v1", WORKER_SA_API_KEY: "k", WORKER_EU_MODEL: "qwen/qwen3.8-27b", WORKER_EU_PROVIDER: "none", WORKER_GLOBAL_EXPECTED_PROVIDER: "Host", WORKER_PRICE_PER_1M_INPUT_TOKENS: "0.3", WORKER_PRICE_PER_1M_OUTPUT_TOKENS: "0.6" }).vars,
      ),
    ],
    [0, undefined, ["WORKER_EU_URL must start with http:// or https://"], 3, ["WORKER_SA_PARALLEL must be a whole number of at least 1", "WORKER_SA_PER_MINUTE must be a whole number of at least 0", "WORKER_EU_MAX_WAIT_SECONDS must be at most 25"], 1, ["https://worker.example/v1", "k", "qwen/qwen3.8-27b", "none", "Host", "0.3", "0.6"]],
  );

  // --- Regions -----------------------------------------------------------------------------------------
  same(
    "region: a new account starts in Saudi Arabia for a Saudi number or a sign-up from there, in the EU for the EU, the EEA, the United Kingdom and Switzerland, and in the global region otherwise",
    [defaultAccountRegion("phone", null), defaultAccountRegion("phone", "DE"), defaultAccountRegion("email", "SA"), ...["DE", "FR", "NO", "IS", "GB", "CH", "RE"].map((country) => defaultAccountRegion("email", country)), ...["US", "AE", "TR", "CA", "XX", null].map((country) => defaultAccountRegion("email", country))],
    ["sa", "sa", "sa", ...Array.from({ length: 7 }, () => "eu"), ...Array.from({ length: 6 }, () => "global")],
  );
  {
    // The accounts that existed before regions get theirs from migration 0008, in SQL. Run here on
    // every country either rule knows, and compared with what a new account would get.
    const database = (await loadRuntime()).openDatabase(join(folder, "regions.sqlite"));
    const migrations = join(dirname(dirname(HERE)), "migrations");
    for (const name of readdirSync(migrations).filter((file) => file.endsWith(".sql")).sort()) {
      if (name === "0008_account_regions.sql") {
        const add = "INSERT INTO users (id, email, phone, created_at, country, signup_method) VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z', ?, ?)";
        let made = 0;
        for (const country of [...EU_REGION_COUNTRIES, "SA", "US", "AE", "TR", "CA", "JP", "XX", null]) {
          for (const method of ["email", "phone"] as const) {
            made += 1;
            database.query(add, [`account-${made}`, method === "email" ? `${made}@unit.example` : null, method === "phone" ? `+9665${String(made).padStart(8, "0")}` : null, country, method]);
          }
        }
      }
      database.exec(readFileSync(join(migrations, name), "utf8"));
    }
    const rows = database.query("SELECT country, signup_method, region, region_updated_at FROM users", []) as Array<{ country: string | null; signup_method: "email" | "phone"; region: string; region_updated_at: string | null }>;
    const wrong = rows.filter((row) => row.region !== defaultAccountRegion(row.signup_method, row.country) || row.region_updated_at !== null);
    expect("region: accounts from before regions are given the region a new account would get from the same facts, and none counts as changed", rows.length > 80 && wrong.length === 0, { rows: rows.length, wrong: wrong.slice(0, 5) });
    database.close();
  }
  same(
    "region: each region's upstream comes from its own settings and from no other region's, and one without a key has no worker",
    [
      ACCOUNT_REGIONS.map((region) => workerUpstream({ WORKER_GLOBAL_API_KEY: "global-key", WORKER_SA_MODEL: "ignored-without-a-key" }, region)?.region ?? null),
      ((upstream) => [upstream?.url, upstream?.model, upstream?.apiKey, upstream?.provider, upstream?.minOutputTokens, upstream?.structured])(workerUpstream({ WORKER_EU_API_KEY: "eu-key", WORKER_GLOBAL_API_KEY: "global-key", WORKER_SA_API_KEY: "sa-key" }, "global")),
      ((upstream) => [upstream?.url, upstream?.model, upstream?.provider, upstream?.limits, upstream?.hostedIn])(workerUpstream({ WORKER_SA_API_KEY: "sa-key" }, "sa")),
      ((upstream) => [upstream?.limits, upstream?.hostedIn])(workerUpstream({ WORKER_SA_API_KEY: "sa-key", WORKER_SA_PARALLEL: "5", WORKER_SA_PER_MINUTE: "280", WORKER_SA_MAX_WAIT_SECONDS: "15", WORKER_SA_HOSTED_IN: "any" }, "sa")),
      ((upstream) => [upstream?.url, upstream?.model])(workerUpstream({ WORKER_GLOBAL_API_KEY: "global-key" }, "global")),
    ],
    [
      [null, null, "global"],
      ["https://openrouter.ai/api/v1", "thinkingmachines/inkling-2-mini", "global-key", { data_collection: "deny", zdr: true }, 4000, "jsonSchema"],
      ["https://alapi.deep.sa/v1", "qwen/qwen3.8-27b", null, { parallel: 1, perMinute: 55, maxWaitMs: 20_000, maxWaiting: 200 }, "saudi"],
      [{ parallel: 5, perMinute: 280, maxWaitMs: 15_000, maxWaiting: 200 }, null],
      ["https://openrouter.ai/api/v1", "thinkingmachines/inkling-2-mini"],
    ],
  );
  // --- What each region's worker is, with nothing set but its key: what the evaluation measured ----------
  {
    const NO_RETENTION = { data_collection: "deny", zdr: true };
    const measured = {
      // deep.sa refuses one strict-schema call in five; asked for a JSON object, none.
      sa: { url: "https://alapi.deep.sa/v1", model: "qwen/qwen3.8-27b", structured: "jsonObject", reasoningEffort: "none", provider: null, expectedProvider: null, expectedDataRegion: null, hostedIn: "saudi", parallel: 1, perMinute: 55 },
      global: { url: "https://openrouter.ai/api/v1", model: "thinkingmachines/inkling-2-mini", structured: "jsonSchema", reasoningEffort: "none", provider: NO_RETENTION, expectedProvider: null, expectedDataRegion: null, hostedIn: null, parallel: 16, perMinute: 0 },
    };
    for (const region of ["sa", "global"] as const) {
      const upstream = workerUpstream({ [`WORKER_${region.toUpperCase()}_API_KEY`]: "key" }, region);
      for (const setting of ["url", "model", "structured", "reasoningEffort", "provider", "expectedProvider", "expectedDataRegion", "hostedIn"] as const) {
        same(`region ${region}: ${setting} is the one measured`, upstream?.[setting], measured[region][setting]);
      }
      same(`region ${region}: the calls it takes at once and in a minute`, [upstream?.limits.parallel, upstream?.limits.perMinute], [measured[region].parallel, measured[region].perMinute]);
    }
    // The EU: a hosted worker is not offered there yet. No host serves either measured model where the region requires.
    same("region eu: a key alone gives it no worker, for it has no address and no model of its own; nor does a key with one of the two", [workerUpstream({ WORKER_EU_API_KEY: "key" }, "eu"), workerUpstream({ WORKER_EU_API_KEY: "key", WORKER_EU_URL: "https://eu.example/v1" }, "eu"), workerUpstream({ WORKER_EU_API_KEY: "key", WORKER_EU_MODEL: "qwen/qwen3.8-27b" }, "eu")], [null, null, null]);
    same(
      "region eu: …and the server refuses to start with such a key, naming what is missing",
      [workerSettingProblems({ WORKER_EU_API_KEY: "key" }).length, /WORKER_EU_URL and WORKER_EU_MODEL/.test(workerSettingProblems({ WORKER_EU_API_KEY: "key" })[0] ?? ""), workerSettingProblems({}), workerSettingProblems({ WORKER_SA_API_KEY: "key", WORKER_GLOBAL_API_KEY: "key" })],
      [1, true, [], []],
    );
    const set = workerUpstream({ WORKER_EU_API_KEY: "key", WORKER_EU_URL: "https://eu.example/v1/", WORKER_EU_MODEL: "Qwen/Qwen3.8-27B", WORKER_EU_STRUCTURED: "jsonSchema", WORKER_EU_REASONING_EFFORT: "low", WORKER_EU_PROVIDER: '{"order":["host-one/eu"],"allow_fallbacks":false}', WORKER_EU_EXPECTED_PROVIDER: "Host One", WORKER_EU_EXPECTED_DATA_REGION: "europe" }, "eu");
    same("region eu: set by settings alone, with an address and an open-weight model, it has a worker and the checks asked of it", [set?.url, set?.model, set?.structured, set?.reasoningEffort, set?.provider, set?.expectedProvider, set?.expectedDataRegion], ["https://eu.example/v1", "Qwen/Qwen3.8-27B", "jsonSchema", "low", { order: ["host-one/eu"], allow_fallbacks: false }, "Host One", "europe"]);
    const loose = workerUpstream({ WORKER_GLOBAL_API_KEY: "key", WORKER_GLOBAL_REASONING_EFFORT: "caller", WORKER_GLOBAL_EXPECTED_PROVIDER: "any", WORKER_GLOBAL_EXPECTED_DATA_REGION: "any", WORKER_GLOBAL_STRUCTURED: "nonsense" }, "global");
    same("region: the caller's reasoning setting can be passed on, a check can be switched off, and a setting that is not one leaves the measured one", [loose?.reasoningEffort, loose?.expectedProvider, loose?.expectedDataRegion, loose?.structured], [null, null, null, "jsonSchema"]);

    // The worker is an open-weight model. A closed one, or one that was not measured, cannot be set.
    const closed = ["anthropic/claude-haiku-5.5", "google/gemini-3.5-flash-lite", "openai/gpt-6-luna", "mistralai/mistral-small-2603", "qwen/qwen3.8-9b", "thinkingmachines/inkling-2", "doedesk-worker"];
    const open = ["qwen/qwen3.8-27b", "Qwen/Qwen3.8-27B", "Qwen/Qwen3.8-27B-Instruct", "thinkingmachines/inkling-2-mini", "accounts/host/models/inkling-2-mini:free"];
    same("open weights: Qwen3.8 27B and Inkling 2 mini are workers, however a host writes their names", open.map(isOpenWeightWorkerModel), open.map(() => true));
    same("open weights: a closed model, or one that was not measured, is not", closed.map(isOpenWeightWorkerModel), closed.map(() => false));
    same(
      "open weights: a region set to such a model has no worker, in any region, and the server refuses to start, naming the setting and the two that are allowed",
      [
        closed.slice(0, 4).flatMap((model) => ACCOUNT_REGIONS.map((region) => workerUpstream({ [`WORKER_${region.toUpperCase()}_API_KEY`]: "key", [`WORKER_${region.toUpperCase()}_URL`]: "https://host.example/v1", [`WORKER_${region.toUpperCase()}_MODEL`]: model }, region))).every((upstream) => upstream === null),
        workerSettingProblems({ WORKER_SA_API_KEY: "key", WORKER_SA_MODEL: "anthropic/claude-haiku-5.5" }),
        workerSettingProblems({ WORKER_GLOBAL_MODEL: "Qwen/Qwen3.8-27B" }),
      ],
      [true, ['WORKER_SA_MODEL: "anthropic/claude-haiku-5.5" is not an open-weight model the evaluation measured. A worker is Qwen3.8 27B or Inkling 2 mini'], []],
    );

    // OpenRouter's own record of a call: read with the region's key, at its own address.
    const eu = workerUpstream({ WORKER_EU_API_KEY: "eu-key", WORKER_EU_URL: "https://eu.example/api/v1", WORKER_EU_MODEL: "qwen/qwen3.8-27b", WORKER_EU_EXPECTED_PROVIDER: "Host One", WORKER_EU_EXPECTED_DATA_REGION: "europe" }, "eu");
    const world = workerUpstream({ WORKER_GLOBAL_API_KEY: "key" }, "global");
    if (eu === null || world === null) throw new Error("no upstream");
    const realFetch = globalThis.fetch;
    const asked: Array<[string, string | null]> = [];
    const answering = (records: ReadonlyArray<unknown>) => {
      let turn = 0;
      globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
        asked.push([String(input), new Headers(init?.headers).get("authorization")]);
        const record = records[Math.min(turn, records.length - 1)];
        turn += 1;
        return record === null ? new Response("{}", { status: 404 }) : Response.json({ data: record });
      }) as typeof fetch;
    };
    try {
      answering([{ provider_name: "Host One", data_region: "europe" }]);
      const asRequired = await servedWhereRequired(eu, "gen-1 a", [0]);
      answering([{ provider_name: "Host One", data_region: "us" }]);
      const otherRegion = await servedWhereRequired(eu, "gen-2", [0]);
      answering([{ provider_name: "Another Host", data_region: "europe" }]);
      const otherHost = await servedWhereRequired(eu, "gen-3", [0]);
      answering([null, { provider_name: "host one", data_region: "Europe" }]);
      const written = await servedWhereRequired(eu, "gen-4", [0, 0]);
      answering([null]);
      const never = await servedWhereRequired(eu, "gen-5", [0, 0]);
      same("record: Europe and the expected host is as required, another region or another host is not, and a record that never comes is unread", [asRequired, otherRegion, otherHost, written, never], [true, false, false, true, null]);
      same("record: asked for at the region's own address, by the call's id, with the region's key", asked[0], ["https://eu.example/api/v1/generation?id=gen-1%20a", "Bearer eu-key"]);
    } finally {
      globalThis.fetch = realFetch;
    }
    same(
      "record: the first answer's is read and then one a minute, and never where no data region is required",
      [recordCheckDue(eu, 1_000_000), recordCheckDue(eu, 1_030_000), recordCheckDue(eu, 1_059_999), recordCheckDue(eu, 1_060_000), recordCheckDue(world, 1_000_000)],
      [true, false, false, true, false],
    );
  }
  // --- The queue in front of a region's upstream --------------------------------------------------------
  {
    // A clock the test moves, so that minutes and waits are exact.
    const makeClock = (start: number) => {
      let now = start;
      let nextId = 0;
      const timers = new Map<number, { at: number; run: () => void }>();
      return {
        now: () => now,
        setTimeout: (run: () => void, ms: number) => {
          nextId += 1;
          timers.set(nextId, { at: now + ms, run });
          return nextId;
        },
        clearTimeout: (handle: unknown) => {
          timers.delete(handle as number);
        },
        /** Moves time on, running what falls due in order. */
        advance: async (ms: number) => {
          const until = now + ms;
          for (;;) {
            const due = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((left, right) => left[1].at - right[1].at)[0];
            if (due === undefined) break;
            now = due[1].at;
            timers.delete(due[0]);
            due[1].run();
            await Promise.resolve();
          }
          now = until;
          await Promise.resolve();
        },
      };
    };
    const settle = async () => {
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    };
    const limits = { parallel: 1, perMinute: 0, maxWaitMs: 20_000, maxWaiting: 200 };
    /** Enters a request and notes when it is sent, so the order of sending can be read. */
    const order: Array<string> = [];
    const releases = new Map<string, () => void>();
    const outcomes = new Map<string, string>();
    const enter = (queue: WorkerQueue, account: string, name: string, options: Parameters<WorkerQueue["enter"]>[1] = {}) =>
      void queue.enter(account, options).then((admission) => {
        if (admission.admitted) {
          order.push(name);
          releases.set(name, admission.release);
        } else outcomes.set(name, admission.reason === "busy" ? `busy waiting=${admission.waiting} retry=${admission.retryAfterSeconds}` : "gone");
      });
    const finish = async (name: string) => {
      releases.get(name)?.();
      await settle();
    };

    // Fairness: one account's folder and two other people's single questions.
    let clock = makeClock(Date.UTC(2026, 10, 24, 9, 0, 5));
    let queue = new WorkerQueue({ ...limits }, clock);
    for (const name of ["a1", "a2", "a3", "a4"]) enter(queue, "a", name);
    enter(queue, "b", "b1");
    enter(queue, "c", "c1");
    await settle();
    same("queue: with one request at a time, one is sent and the rest wait", [order, queue.state()], [["a1"], { parallel: 1, active: 1, waiting: 5 }]);
    for (const name of ["a1", "a2", "b1", "c1", "a3"]) await finish(name);
    same("queue: accounts take turns, so two people's single questions are sent before the rest of a third person's folder", order, ["a1", "a2", "b1", "c1", "a3", "a4"]);
    await finish("a4");
    same("queue: when all are answered nothing is in flight or waiting", queue.state(), { parallel: 1, active: 0, waiting: 0 });

    // The limit at once is never exceeded, whatever the number waiting.
    order.length = 0;
    queue = new WorkerQueue({ ...limits, parallel: 3 }, clock);
    let most = 0;
    for (let index = 0; index < 20; index += 1) enter(queue, `account-${index % 4}`, `r${index}`);
    await settle();
    for (let done = 0; done < 20; done += 1) {
      most = Math.max(most, queue.state().active);
      await finish(order[done] ?? "");
    }
    same("queue: never more in flight than the region takes at once, and every request is sent in the end", [most, order.length, queue.state().active], [3, 20, 0]);

    // The limit a minute counts every request sent, and the rest wait for the next clock minute.
    order.length = 0;
    clock = makeClock(Date.UTC(2026, 10, 24, 9, 0, 50));
    queue = new WorkerQueue({ ...limits, parallel: 10, perMinute: 3 }, clock);
    for (let index = 0; index < 5; index += 1) enter(queue, "a", `m${index}`);
    await settle();
    same("queue: no more are sent in a clock minute than the region allows, though slots are free", [order, queue.state().waiting], [["m0", "m1", "m2"], 2]);
    await clock.advance(9_000);
    same("queue: …still none a second before the minute ends", order.length, 3);
    await clock.advance(1_000);
    await settle();
    same("queue: …and the rest are sent when the next minute begins", order, ["m0", "m1", "m2", "m3", "m4"]);

    // The upstream says to wait.
    order.length = 0;
    clock = makeClock(Date.UTC(2026, 10, 24, 9, 0, 5));
    queue = new WorkerQueue({ ...limits }, clock);
    queue.blockFor(4_000);
    enter(queue, "a", "w1");
    await clock.advance(3_900);
    same("queue: nothing is sent while the upstream said to wait", order, []);
    await clock.advance(100);
    await settle();
    same("queue: …and the next is sent when that time has passed", order, ["w1"]);

    // The wait is bounded.
    order.length = 0;
    outcomes.clear();
    queue = new WorkerQueue({ ...limits, maxWaitMs: 5_000, maxWaiting: 3 }, clock);
    enter(queue, "a", "long");
    enter(queue, "b", "waits-1");
    await clock.advance(1_000);
    enter(queue, "c", "waits-2");
    enter(queue, "a", "waits-3");
    enter(queue, "d", "one-too-many");
    await settle();
    same("queue: a request beyond the number that may wait is answered as busy at once", outcomes.get("one-too-many"), "busy waiting=4 retry=5");
    await clock.advance(4_000);
    await settle();
    same("queue: a request not sent within the wait is answered as busy, with how many were waiting, itself included", [outcomes.get("waits-1"), queue.state().waiting, order], ["busy waiting=3 retry=5", 2, ["long"]]);
    await clock.advance(1_000);
    await settle();
    same("queue: …each at its own time", [outcomes.get("waits-2"), outcomes.get("waits-3"), queue.state().waiting], ["busy waiting=2 retry=5", "busy waiting=1 retry=5", 0]);

    // A caller that goes away, and a request sent again after the upstream refused it.
    order.length = 0;
    outcomes.clear();
    queue = new WorkerQueue({ ...limits }, clock);
    const leaving = new AbortController();
    enter(queue, "a", "holds");
    enter(queue, "b", "leaves", { signal: leaving.signal });
    enter(queue, "c", "stays");
    enter(queue, "c", "stays-2");
    await settle();
    leaving.abort();
    await settle();
    enter(queue, "d", "refused-and-back", { front: true });
    await settle();
    for (const name of ["holds", "refused-and-back", "stays"]) await finish(name);
    same("queue: a caller that went away keeps no place, and a request the upstream refused in its turn goes first when it comes back", [outcomes.get("leaves"), order], ["gone", ["holds", "refused-and-back", "stays", "stays-2"]]);
  }

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
