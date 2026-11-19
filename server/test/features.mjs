// What the move adds to the service itself, proved on this machine:
//   - the freeze used while the database is copied: reads and detection go on, nothing is written,
//     writes are refused in a way the apps handle (never 401);
//   - detection and reading by the engine at ENGINE_URL, with its token, and how its failures are
//     answered and counted;
//   - contact mail arriving over HTTPS from the Worker, with a key;
//   - where the emailed link opens.
// And, for the server only: the caller's address and country taken from the reverse proxy, the
// sign-in email really sent (to a stand-in mail server) and followed to a session, the limit on
// documents read at once, and the limit on a request's size.
//
//   node server/test/features.mjs                             the Worker (wrangler dev)
//   DOEDESK_TEST_TARGET=bun node server/test/features.mjs     the server, on Bun (or node)
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { client, engineUnits, sha256Hex, startEngineStub, startLocalService, TARGET } from "../../test/local-service.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ON_SERVER = TARGET !== "worker";
let failures = 0;
const expect = (label, condition, detail = null) => {
  if (!condition) failures += 1;
  console.log(`${condition ? "ok  " : "FAIL"} ${label}${condition ? "" : ` -> ${JSON.stringify(detail)?.slice(0, 900)}`}`);
};
const same = (label, actual, expected) => expect(label, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const NOW = new Date();
const DAY = 86_400_000;
const id = (name) => `00000000-0000-4000-a000-${sha256Hex(`features:${name}`).slice(0, 12)}`;
const token = (name) => `dd_test_features_${name}`;
const userSql = (name, lastUsed = NOW) =>
  `INSERT INTO users (id, email, created_at, country, signup_method) VALUES ('${id(name)}', '${name}@seeded.example', '${new Date(NOW - 30 * DAY).toISOString()}', 'SA', 'email');\n` +
  `INSERT INTO sessions (token_hash, user_id, client, device, created_at, last_used_at, signed_in_at) VALUES ('${sha256Hex(token(name))}', '${id(name)}', 'desktop', 'test', '${new Date(NOW - 30 * DAY).toISOString()}', '${lastUsed.toISOString()}', '${NOW.toISOString()}');`;
const TABLES = ["users", "sessions", "login_requests", "rate_limits", "usage", "usage_daily", "events", "crash_reports", "test_inbox", "acceptances", "deletion_receipts", "rights_requests", "contact_mail", "usage_data_choices"];
const snapshot = (service) => JSON.stringify(TABLES.map((table) => service.query(`SELECT * FROM ${table} ORDER BY 1, 2, 3`)));
const form = (values) => ({ raw: new URLSearchParams(values).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
// With the headers wrangler's local mail trigger insists on.
const rawMail = (to, subject) =>
  [
    `Received: from smtp.example.com (127.0.0.1) by cloudflare-email.com (unknown) id 4fwwffRXOpyR for <${to}>; Tue, 27 Aug 2024 15:50:20 +0000`,
    'From: "A Person" <writer@elsewhere.example>',
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset="utf-8"',
    "Date: Tue, 27 Aug 2024 08:49:44 -0700",
    `Message-ID: <${crypto.randomUUID()}@elsewhere.example>`,
    "",
    "Please answer.",
    "",
  ].join("\r\n");

// =====================================================================================================
// The freeze
{
  const yesterday = new Date(NOW - DAY);
  const pendingId = "frozen-attempt";
  const linkToken = "t".repeat(64);
  const seed = [
    userSql("frozen", yesterday),
    `INSERT INTO login_requests (id, kind, identifier, secret_hash, poll_hash, client, device, created_at, expires_at) VALUES ('${pendingId}', 'email', 'waiting@seeded.example', '${sha256Hex(linkToken)}', '${sha256Hex("poll")}', 'desktop', 'Mac', '${NOW.toISOString()}', '${new Date(NOW.getTime() + 600_000).toISOString()}');`,
    // An attempt whose link was confirmed just before the freeze: handing out its session would write.
    `INSERT INTO login_requests (id, kind, identifier, secret_hash, poll_hash, client, device, status, created_at, expires_at) VALUES ('approved-attempt', 'email', 'approved@seeded.example', 'h', '${sha256Hex("poll")}', 'desktop', 'Mac', 'approved', '${NOW.toISOString()}', '${new Date(NOW.getTime() + 600_000).toISOString()}');`,
  ].join("\n");
  const service = await startLocalService({ seedSql: seed, vars: { MAINTENANCE: "freeze", MAIL_FORWARD_TO: "owner@mailbox.example" } });
  try {
    const call = client(service.base);
    const admin = { authorization: `Bearer ${service.adminKey}` };
    const before = snapshot(service);
    const statuses = [];
    const note = (answer) => (statuses.push(answer.status), answer);

    const options = note(await call("GET", "/v1/auth/options", { headers: { "x-test-country": "SA" } }));
    const me = note(await call("GET", "/v1/me", { token: token("frozen") }));
    same("freeze: what only reads is answered: health, sign-in options, the legal versions, the public key, the account", [note(await call("GET", "/v1/health")).status, options.status, options.json?.methods, note(await call("GET", "/v1/legal")).status, note(await call("GET", "/.well-known/jwks.json")).status, me.status, me.json?.email], [200, 200, ["phone", "email"], 200, 200, 200, "frozen@seeded.example"]);
    const relay = note(await call("POST", "/v1/auth/token", { token: token("frozen"), body: { audience: "doedesk-relay" } }));
    expect("freeze: a signed-in app still gets its relay token", relay.status === 200 && relay.json.token.split(".").length === 3, relay);

    const detected = note(await call("POST", "/v1/detect", { token: token("frozen"), body: { texts: ["Jane Doe wrote to jane@example.com"] } }));
    const read = note(await call("POST", "/v1/ocr", { token: token("frozen"), raw: Buffer.from("%PDF-1.7 pages=2"), headers: { "content-type": "application/pdf" } }));
    same("freeze: detection and reading are answered as usual, so no message to a model is refused", [detected.status, detected.json?.results?.[0]?.entities?.map((entity) => entity.kind), read.status, read.json?.pages], [200, ["PERSON", "EMAIL"], 200, 2]);

    const refused = {
      "starting a sign-in by email": await call("POST", "/v1/auth/email/start", { body: { email: "new@person.example", client: "desktop" } }),
      "starting a sign-in by phone": await call("POST", "/v1/auth/phone/start", { body: { phone: "0500000009" }, headers: { "x-test-country": "SA" } }),
      "finishing a sign-in whose link was confirmed": await call("POST", "/v1/auth/email/poll", { body: { requestId: "approved-attempt", pollSecret: "poll" } }),
      "a second session": await call("POST", "/v1/auth/sessions", { token: token("frozen"), body: { client: "server" } }),
      "signing out": await call("POST", "/v1/auth/sign-out", { token: token("frozen") }),
      "the onboarding answers": await call("POST", "/v1/me/profile", { token: token("frozen"), body: { field: "legal" } }),
      "accepting the Terms": await call("POST", "/v1/me/acceptance", { token: token("frozen"), body: { acceptance: { termsVersion: "1.2", privacyVersion: "1.2", locale: "en" } } }),
      "a copy of the account": await call("GET", "/v1/me/export", { token: token("frozen") }),
      "deleting the account": await call("DELETE", "/v1/me", { token: token("frozen") }),
      "usage events": await call("POST", "/ingest/batch", { body: { api_key: "doedesk-client", batch: [] } }),
      "the usage-data choice": await call("POST", "/ingest/choice", { body: { api_key: "doedesk-client" } }),
      "an error report": await call("POST", "/ingest/crash", { body: { message: "Boom" } }),
    };
    for (const answer of Object.values(refused)) note(answer);
    const wrong = Object.entries(refused).filter(([, answer]) => !(answer.status === 503 && answer.json?.error?.code === "maintenance" && answer.headers.get("retry-after") === "300"));
    expect(`freeze: everything that would write is refused with 503 "maintenance" and a time to retry (${Object.keys(refused).length} kinds of request)`, wrong.length === 0, wrong.map(([name, answer]) => [name, answer.status, answer.text.slice(0, 120)]));
    expect("freeze: the refusal is a sentence a person can read, in the shape the apps already show", Object.values(refused).every((answer) => answer.json?.error?.message === "DoeDesk Cloud is moving to new servers. It will be back in a few minutes." && answer.json?.error?.retryAfterSeconds === 300), refused["signing out"].json);

    const waiting = note(await call("POST", "/v1/auth/email/poll", { body: { requestId: pendingId, pollSecret: "poll" } }));
    same("freeze: an app waiting for a link to be opened is told to keep waiting, as usual", [waiting.status, waiting.json], [200, { status: "pending" }]);

    const opened = note(await call("GET", "/auth/confirm"));
    const shown = note(await call("POST", "/auth/confirm", form({ r: pendingId, t: linkToken, step: "show" })));
    const confirmed = note(await call("POST", "/auth/confirm", form({ r: pendingId, t: linkToken })));
    expect("freeze: the emailed link's page opens and asks; confirming gets a page that says to come back, not an error in code", opened.status === 200 && shown.status === 200 && shown.text.includes("Confirm sign-in") && confirmed.status === 503 && confirmed.text.includes("Back in a few minutes") && (confirmed.headers.get("content-type") ?? "").startsWith("text/html") && confirmed.headers.get("retry-after") === "300", [opened.status, shown.status, confirmed.status, confirmed.text.slice(0, 200)]);
    const arabic = await call("POST", "/auth/confirm", { ...form({ r: pendingId, t: linkToken }), headers: { "content-type": "application/x-www-form-urlencoded", "accept-language": "ar-SA" } });
    expect("freeze: in Arabic for a reader of Arabic", arabic.status === 503 && arabic.text.includes("نعود بعد دقائق") && arabic.text.includes('dir="rtl"'), arabic.text.slice(0, 300));

    const dashboard = note(await call("GET", "/admin", { headers: admin }));
    expect("freeze: the owner's dashboard still opens", dashboard.status === 200 && dashboard.text.includes("<html"), dashboard.status);
    const night = note(await call("GET", "/cdn-cgi/handler/scheduled"));
    const mail = await fetch(`${service.base}/cdn-cgi/handler/email?from=${encodeURIComponent("writer@elsewhere.example")}&to=${encodeURIComponent("privacy@doedesk.com")}`, { method: "POST", body: rawMail("privacy@doedesk.com", "During the move") });
    expect("freeze: the nightly job does nothing; contact mail is forwarded to the owner and not stored", night.status === 200 && mail.status === 200 && service.log().includes("rcptTo: owner@mailbox.example"), [night.status, mail.status, service.log().slice(-300)]);

    same("freeze: not one row in any table changed, the session's date of last use included", snapshot(service) === before, true);
    same("freeze: no answer was 401, which is the one status that signs an app out", statuses.filter((status) => status === 401), []);
    expect("freeze: the log counts the requests that went uncounted, with no identifier", (service.log().match(/freeze_unmetered/g) ?? []).length === 2 && !/seeded\.example|person\.example/.test(service.log()), service.log().slice(-400));
  } finally {
    await service.stop();
  }
}

// =====================================================================================================
// The local engine, inbound mail over HTTPS, and where the link opens
{
  const engine = await startEngineStub();
  const mailKey = "k".repeat(40);
  const service = await startLocalService({
    seedSql: [userSql("local"), userSql("other")].join("\n"),
    vars: { ENGINE_URL: `${engine.origin}/`, ENGINE_TOKEN: "engine-token", MAIL_INGEST_KEY: mailKey, CONFIRM_ORIGIN: "https://api.doedesk.com/" },
  });
  try {
    const call = client(service.base);
    const daily = (name) => ({ ...service.query("SELECT * FROM usage_daily WHERE user_id = ?", id(name))[0] });
    const texts = ["Jane Doe wrote to jane@example.com", "", "Nothing here", "   ", "x".repeat(1500), "[[odd]] Jane Doe", "فاطمة كتبت إلى Jane Doe"];
    const detected = await call("POST", "/v1/detect", { token: token("local"), body: { texts } });
    same("engine: seven texts go to the local engine as one call, without the empty ones", [detected.status, engine.seen.detect.length, engine.seen.detect[0]?.length], [200, 1, 5]);
    same("engine: each text gets its own result, in order, with positions in that text", detected.json?.results?.map((result) => result.entities), [
      [{ start: 0, end: 8, kind: "PERSON" }, { start: 18, end: 34, kind: "EMAIL" }],
      [],
      [],
      [],
      [],
      // A kind the app does not know becomes OTHER; spans that are not spans are dropped.
      [{ start: 8, end: 16, kind: "PERSON" }, { start: 0, end: 3, kind: "OTHER" }],
      [{ start: 15, end: 23, kind: "PERSON" }],
    ]);
    const counted = daily("local");
    same("engine: counted: requests, texts, characters, entities, and the engine units the engine reported", [counted.detect_requests, counted.detect_texts, counted.detect_characters, counted.detect_entities, counted.detect_records], [1, 7, texts.reduce((total, text) => total + text.length, 0), 5, engineUnits(engine.seen.detect[0])]);

    const down = await call("POST", "/v1/detect", { token: token("local"), body: { texts: ["[[engine-down]]"] } });
    const short = await call("POST", "/v1/detect", { token: token("local"), body: { texts: ["[[short-answer]] a", "b"] } });
    same("engine: a failing engine, or one that skips a text, is an error the app refuses on, and is counted as failed", [down.status, down.json?.error?.code, short.status, short.json?.error?.code, daily("local").detect_failed, daily("local").detect_requests], [502, "detector_failed", 502, "detector_failed", 2, 1]);

    const says = await call("POST", "/v1/detect", { token: token("other"), body: { texts: ["[[says-seven]]"] } });
    const partly = await call("POST", "/v1/detect", { token: token("other"), body: { texts: ["[[used-then-failed]]"] } });
    const busy = await call("POST", "/v1/detect", { token: token("other"), body: { texts: ["[[busy]]"] } });
    const other = daily("other");
    same("engine: the units the engine reports are what is counted, for a failed call too; a busy engine is 503 with the engine's own time to retry", [says.status, partly.status, busy.status, busy.json?.error?.code, busy.json?.error?.retryAfterSeconds, other.detect_records, other.detect_requests, other.detect_failed], [200, 502, 503, "detector_busy", 7, 10, 1, 2]);
    const unavailable = await call("POST", "/v1/detect", { token: token("other"), body: { texts: ["[[unavailable]]"] } });
    const outOfTime = await call("POST", "/v1/detect", { token: token("other"), body: { texts: ["[[out-of-time]]"] } });
    same("engine: an engine that is unavailable is a failure, not a wait; one that ran out of time says so, and the units it reports are counted", [unavailable.status, unavailable.json?.error?.code, unavailable.json?.error?.retryAfterSeconds, outOfTime.status, outOfTime.json?.error?.code, daily("other").detect_records], [502, "detector_failed", undefined, 504, "detector_timeout", 12]);

    const pdf = await call("POST", "/v1/ocr", { token: token("local"), raw: Buffer.from("%PDF-1.7 pages=4 body"), headers: { "content-type": "application/pdf" } });
    const image = await call("POST", "/v1/ocr", { token: token("local"), raw: Buffer.from("an image with no page count"), headers: { "content-type": "image/png" } });
    same("engine: a file goes to the local reader with its media type; pages are counted, one when the reader gives none", [pdf.status, pdf.json, image.status, image.json, engine.seen.ocr.map((file) => file.type)], [200, { text: "text of 4 page(s)", pages: 4 }, 200, { text: "text", pages: 1 }, ["application/pdf", "image/png"]]);
    const unreadable = await call("POST", "/v1/ocr", { token: token("local"), raw: Buffer.from("[[unreadable]]"), headers: { "content-type": "image/png" } });
    const readerDown = await call("POST", "/v1/ocr", { token: token("local"), raw: Buffer.from("[[reader-down]]"), headers: { "content-type": "image/png" } });
    const after = daily("local");
    same("engine: a file the reader cannot read is the file's fault (422, with our own message, never the engine's); a reader that is down is ours (502); both counted as failed", [unreadable.status, unreadable.json?.error, readerDown.status, readerDown.json?.error?.code, after.ocr_failed, after.ocr_files, after.ocr_pages, after.ocr_pdf_pages], [422, { code: "unreadable", message: "The document could not be read." }, 502, "reader_failed", 2, 2, 5, 4]);
    const layout = await call("POST", "/v1/ocr?layout=1", { token: token("local"), raw: Buffer.from("an image"), headers: { "content-type": "image/png" } });
    expect("engine: a caller that asks where the words are (?layout=1) gets text and pages and no layout, which tells the app not to send the image", layout.status === 200 && layout.json?.text === "text" && !("layout" in (layout.json ?? {})), layout);
    same("engine: only the engine at ENGINE_URL was called, and it was given its token every time", [service.engine.seen.detect.length, service.engine.seen.ocr.length, [...engine.seen.authorization]], [0, 0, ["Bearer engine-token"]]);

    // Mail relayed by the Worker.
    const post = (body, key) => call("POST", "/internal/inbound-mail", { body, headers: key === undefined ? {} : { authorization: `Bearer ${key}` } });
    const mail = { to: "Privacy@doedesk.com", from: "writer@elsewhere.example", subject: "Please delete my account", raw: rawMail("privacy@doedesk.com", "Please delete my account"), forwarded: true, forwardError: null };
    same("mail in: nothing is taken without the key, or with a wrong one", [(await post(mail)).status, (await post(mail, "wrong")).status, (await post(mail, `${mailKey}x`)).status, service.query("SELECT COUNT(*) AS n FROM contact_mail")[0].n], [401, 401, 401, 0]);
    const taken = await post(mail, mailKey);
    const row = { ...service.query("SELECT address, sender, subject, raw, forwarded_at IS NOT NULL AS forwarded, forward_error FROM contact_mail")[0] };
    same("mail in: with the key a message to a contact address is stored, with who sent it and that it reached the owner", [taken.status, taken.json, row.address, row.sender, row.subject, row.raw === mail.raw, row.forwarded, row.forward_error], [200, { ok: true, kind: "contact" }, "privacy@doedesk.com", "writer@elsewhere.example", "Please delete my account", true, 1, null]);
    await post({ ...mail, to: "legal@doedesk.com", forwarded: false, forwardError: "destination address not verified" }, mailKey);
    same("mail in: one that did not reach the owner says why, for the dashboard", { ...service.query("SELECT forwarded_at, forward_error FROM contact_mail WHERE address = 'legal@doedesk.com'")[0] }, { forwarded_at: null, forward_error: "destination address not verified" });
    const testBox = await post({ to: "e2e-abcdefgh1@doedesk.com", from: "x@y.example", subject: "t", raw: "raw" }, mailKey);
    const stranger = await post({ to: "sales@doedesk.com", from: "x@y.example", subject: "t", raw: "raw" }, mailKey);
    const malformed = await post({ to: "privacy@doedesk.com" }, mailKey);
    same("mail in: a test mailbox is kept apart; any other address is refused; a message without its text is refused", [testBox.json?.kind, service.query("SELECT COUNT(*) AS n FROM test_inbox")[0].n, stranger.status, malformed.status, service.query("SELECT COUNT(*) AS n FROM contact_mail")[0].n], ["test", 1, 422, 400, 2]);
    expect("mail in: the log names no sender", !/elsewhere\.example|y\.example/.test(service.log()), service.log().slice(-300));

    const started = await call("POST", "/v1/auth/email/start", { body: { email: "link@person.example", client: "desktop" } });
    expect("link: with CONFIRM_ORIGIN set, the emailed link opens on the API's own address", started.status === 200 && started.json.emailedLink.startsWith("https://api.doedesk.com/auth/confirm#r="), started.json);
  } finally {
    await service.stop();
    await engine.stop();
  }
}
{
  const service = await startLocalService({});
  try {
    const call = client(service.base);
    const closed = await call("POST", "/internal/inbound-mail", { body: { to: "privacy@doedesk.com", from: "a@b.example", raw: "x" }, headers: { authorization: "Bearer anything" } });
    const started = await call("POST", "/v1/auth/email/start", { body: { email: "link@person.example", client: "desktop" } });
    same("without a mail key the route for relayed mail does not exist; without CONFIRM_ORIGIN the link opens on the site as before", [closed.status, started.json?.emailedLink?.startsWith("https://doedesk.com/auth/confirm#r=")], [404, true]);
  } finally {
    await service.stop();
  }
}

// =====================================================================================================
// The server only
if (ON_SERVER) {
  const folder = mkdtempSync(join(tmpdir(), "doedesk-features-"));
  const { buildGeo } = await import("../geo-build.ts");
  async function* lines(text) {
    for (const line of text.split("\n")) yield line;
  }
  const geoFile = join(folder, "country.ddgeo");
  writeFileSync(
    geoFile,
    (
      await buildGeo(
        lines(["198.51.100.0,198.51.100.255,EU,DE,Hesse,Frankfurt,0,0", "203.0.113.0,203.0.113.127,AS,SA,Riyadh,Riyadh,0,0", "203.0.113.128,203.0.113.191,NA,CA,Quebec,Montreal,0,0", "203.0.113.192,203.0.113.255,NA,CA,Ontario,Toronto,0,0", "2001:db8::,2001:db8::ffff,AS,SA,Riyadh,Riyadh,0,0"].join("\n")),
        { source: "features-test", minimums: { v4: 1, v6: 1, countries: 1 } },
      )
    ).bytes,
  );
  const smtpFolder = mkdtempSync(join(folder, "smtp-"));
  const smtp = spawn("node", [join(HERE, "smtp-stub.mjs"), smtpFolder], { stdio: ["ignore", "pipe", "inherit"] });
  const smtpPort = await new Promise((resolve) => smtp.stdout.once("data", (chunk) => resolve(JSON.parse(chunk.toString()).port)));
  const forwardSecret = "f".repeat(48);
  // No EXPOSE_LOGIN_SECRETS here: the country comes from the address, and the email is really sent.
  const service = await startLocalService({
    seedSql: userSql("server"),
    vars: {
      EXPOSE_LOGIN_SECRETS: "",
      DOEDESK_GEO_FILE: geoFile,
      FORWARD_SECRET: forwardSecret,
      SMTP_HOST: "localhost",
      SMTP_PORT: String(smtpPort),
      SMTP_USERNAME: "stub-user",
      SMTP_PASSWORD: "stub-password",
      SMTP_ALLOW_SELF_SIGNED: "1",
      DOEDESK_READING_AT_ONCE: "1",
    },
  });
  const engine = await startEngineStub();
  try {
    const call = client(service.base);
    const options = async (headers) => {
      const answer = await call("GET", "/v1/auth/options", { headers });
      return [answer.json?.country, answer.json?.methods?.join("+"), answer.json?.usageData];
    };
    same("country: a caller the proxy reports from a Saudi address is offered the phone; from Germany, email only and usage data waits", [await options({ "x-forwarded-for": "203.0.113.5" }), await options({ "x-forwarded-for": "198.51.100.7" }), await options({ "x-forwarded-for": "2001:db8::5" })], [["SA", "phone+email", "notice"], ["DE", "email", "ask"], ["SA", "phone+email", "notice"]]);
    same("country: an address in no range, no address at all, and nonsense are not known: email only, usage data waits", [await options({ "x-forwarded-for": "192.0.2.1" }), await options({}), await options({ "x-forwarded-for": "not-an-address" })], new Array(3).fill([null, "email", "ask"]));
    same("country: a Saudi address the caller wrote in front of the proxy's entry, or under Cloudflare's header, or stated outright, changes nothing", [await options({ "x-forwarded-for": "203.0.113.5, 198.51.100.7" }), await options({ "x-forwarded-for": "198.51.100.7", "cf-connecting-ip": "203.0.113.5", "x-real-ip": "203.0.113.5" }), await options({ "x-forwarded-for": "198.51.100.7", "x-test-country": "SA", "cf-ipcountry": "SA" })], new Array(3).fill(["DE", "email", "ask"]));
    same("country: the region decides where a rule reads it: Quebec waits for agreement, Ontario does not", [await options({ "x-forwarded-for": "203.0.113.130" }), await options({ "x-forwarded-for": "203.0.113.200" })], [["CA", "email", "ask"], ["CA", "email", "notice"]]);
    const phoneFromGermany = await call("POST", "/v1/auth/phone/start", { body: { phone: "0500000001" }, headers: { "x-forwarded-for": "198.51.100.7" } });
    same("country: phone sign-in is refused to a caller outside Saudi Arabia", [phoneFromGermany.status, phoneFromGermany.json?.error?.code], [403, "phone_unavailable"]);
    const worker = { "x-forwarded-for": "172.64.0.1", "x-doedesk-client-ip": "192.0.2.50", "x-doedesk-client-country": "SA", "x-doedesk-client-region": "01" };
    same("country: the forwarding Worker's word is taken with its secret, and is nothing without it", [await options({ ...worker, "x-doedesk-forward-secret": forwardSecret }), await options(worker), await options({ ...worker, "x-doedesk-forward-secret": "wrong" })], [["SA", "phone+email", "notice"], [null, "email", "ask"], [null, "email", "ask"]]);

    // The address is what rate limits count by: two callers behind the proxy are two callers.
    const crash = (ip) => call("POST", "/ingest/crash", { body: { message: "Boom" }, headers: { "x-forwarded-for": ip } });
    for (let index = 0; index < 60; index += 1) await crash("203.0.113.9");
    same("address: a caller past its limit is refused, and another caller behind the same proxy is not", [(await crash("203.0.113.9")).status, (await crash("203.0.113.10")).status, (await crash("198.51.100.1, 203.0.113.9")).status], [429, 200, 429]);
    expect("address: the counter is kept under the caller's address, not the proxy's", service.query("SELECT key FROM rate_limits WHERE key LIKE 'crash:%'").map((row) => row.key).sort().join() === "crash:203.0.113.10:3600,crash:203.0.113.9:3600", service.query("SELECT key FROM rate_limits"));

    // The sign-in email, really sent, and followed to a session.
    const address = "newcomer@person.example";
    const started = await call("POST", "/v1/auth/email/start", { body: { email: address, client: "desktop", device: "DoeDesk on Mac", locale: "ar" }, headers: { "x-forwarded-for": "203.0.113.5" } });
    same("email: the answer to the app carries no link and no code", [started.status, Object.keys(started.json ?? {}).sort()], [200, ["expiresIn", "pollSecret", "requestId"]]);
    const delivered = existsSync(join(smtpFolder, "messages.jsonl")) ? JSON.parse(readFileSync(join(smtpFolder, "messages.jsonl"), "utf8").trim().split("\n").at(-1)) : {};
    const text = Buffer.from(/Content-Type: text\/plain[^\r]*\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)/.exec(delivered.data ?? "")?.[1]?.replace(/\s/g, "") ?? "", "base64").toString("utf8");
    const link = /https:\/\/doedesk\.com\/auth\/confirm#r=([0-9a-f-]+)&t=([0-9a-f]+)/.exec(text);
    expect("email: it was sent over TLS, signed in to the mail server, from signin@doedesk.com to the person, in their language, with the link", delivered.tls === true && delivered.user === "stub-user" && delivered.from === "signin@doedesk.com" && delivered.to === address && link !== null && text.includes("تسجيل الدخول") && /^Subject: =\?UTF-8\?B\?/m.test(delivered.data), { ...delivered, data: undefined, text: text.slice(0, 200) });
    const shown = await call("POST", "/auth/confirm", form({ r: link?.[1], t: link?.[2], step: "show" }));
    const confirmed = await call("POST", "/auth/confirm", form({ r: link?.[1], t: link?.[2] }));
    const signedIn = await call("POST", "/v1/auth/email/poll", { body: { requestId: started.json.requestId, pollSecret: started.json.pollSecret } });
    const account = await call("GET", "/v1/me", { token: signedIn.json?.token });
    same("email: the link in that message confirms the sign-in, and the waiting app gets its session", [shown.text.includes("DoeDesk on Mac") && shown.text.includes("SA"), confirmed.text.includes("You are signed in"), signedIn.json?.status, signedIn.json?.created, account.json?.email], [true, true, "approved", true, address]);
    same("email: the account was made with the country of the address the request came from", service.query("SELECT country FROM users WHERE email = ?", address)[0]?.country, "SA");
    smtp.kill("SIGTERM");
    await sleep(200);
    const unsent = await call("POST", "/v1/auth/email/start", { body: { email: "nobody-home@person.example", client: "desktop" }, headers: { "x-forwarded-for": "203.0.113.6" } });
    expect("email: when the mail server cannot be reached the app is told, and the log keeps a code and no address", unsent.status === 502 && unsent.json?.error?.code === "email_failed" && /email_failed smtp_connect/.test(service.log()) && !/person\.example/.test(service.log()), [unsent.status, service.log().slice(-300)]);

    // Limits.
    await service.end();
    const limited = await startLocalService({ folder: service.folder, engine: service.engine, vars: { ENGINE_URL: engine.origin, DOEDESK_READING_AT_ONCE: "1", DOEDESK_GEO_FILE: geoFile } });
    try {
      const limitedCall = client(limited.base);
      const slow = limitedCall("POST", "/v1/ocr", { token: token("server"), raw: Buffer.from("[[slow]] pages=1"), headers: { "content-type": "image/png" } });
      await sleep(200);
      const second = await limitedCall("POST", "/v1/ocr", { token: token("server"), raw: Buffer.from("pages=1"), headers: { "content-type": "image/png" } });
      const first = await slow;
      const third = await limitedCall("POST", "/v1/ocr", { token: token("server"), raw: Buffer.from("pages=1"), headers: { "content-type": "image/png" } });
      same("limit: with one document being read, a second is asked to try again in a moment (not 401), and is taken once the first is done", [first.status, second.status, second.json?.error?.code, second.headers.get("retry-after"), third.status], [200, 503, "busy", "5", 200]);
      const big = await fetch(`${limited.base}/v1/ocr`, { method: "POST", headers: { authorization: `Bearer ${token("server")}`, "content-type": "application/pdf" }, body: new Uint8Array(22 * 1024 * 1024) }).then((response) => response.status, () => "connection closed");
      const allowed = await limitedCall("POST", "/v1/ocr", { token: token("server"), raw: Buffer.alloc(19 * 1024 * 1024, 0x20), headers: { "content-type": "application/pdf" } });
      expect("limit: a request larger than a document may be is refused before it is read; one of 19 MB is read", (big === 413 || big === "connection closed") && allowed.status === 200, [big, allowed.status, allowed.text.slice(0, 100)]);
      const health = await fetch(`${limited.base}/internal/health`).then((response) => response.json());
      same("health: says which engine is in use, that it is ready, and that the country file is in place", [health.engine, health.engineReady, health.engineState, health.country.state, health.country.source], ["local", true, "detection ready; reading ready", "ok", "features-test"]);
    } finally {
      await limited.end();
    }
  } finally {
    smtp.kill("SIGTERM");
    await service.stop();
    await engine.stop();
    rmSync(folder, { recursive: true, force: true });
  }
}

console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
