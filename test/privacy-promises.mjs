// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Accelerate Technology Establishment
// Proves, on this machine, what the Privacy Policy and the Terms of Use promise of the service:
//   - acceptance of the Terms is recorded, and required when the switch says so; an app that sends
//     none can still sign in while the switch is off, and its account is marked as outstanding;
//   - usage data: the default by country, the consent stamp, and that no account or AI-provider
//     identifier is stored with an event;
//   - a person can get a copy of everything held about their account, correct their answers, and
//     delete the account, which removes every row of that account and no row of any other;
//   - the owner can do the same for a request that came by mail, and a log is kept;
//   - contact mail is forwarded and tracked; the nightly job deletes exactly what is past its time;
//   - sign-ins expire, the emailed link's secret is in no web address, new accounts can be refused
//     by country, and nothing that names an account reaches the service's log.
//
//   node test/privacy-promises.mjs
//
// It starts two copies of the service on throwaway databases, with stand-ins for the engine, SMS and
// mail (see local-service.mjs). Nothing outside this machine is called.
import { client, sha256Hex, startLocalService } from "./local-service.mjs";
import { LEGAL } from "../src/legal.ts";

let failures = 0;
const expect = (label, condition, detail = null) => {
  if (!condition) failures += 1;
  console.log(`${condition ? "ok  " : "FAIL"} ${label}${condition ? "" : ` -> ${JSON.stringify(detail)?.slice(0, 700)}`}`);
};
const same = (label, actual, expected) => expect(label, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });

// --- Time, counted the way the service counts it (src/http.ts, src/periods.ts) ------------------

const NOW = new Date();
const DAY = 86_400_000;
const HOUR = 3_600_000;
const daysAgo = (days, from = NOW) => new Date(from.getTime() - days * DAY);
const monthsAgo = (months, from = NOW) => {
  const target = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(from.getUTCDate(), lastDay));
  target.setUTCHours(from.getUTCHours(), from.getUTCMinutes(), from.getUTCSeconds(), from.getUTCMilliseconds());
  return target;
};
/** A moment `margin` milliseconds before (negative) or after (positive) a boundary, as text. */
const near = (boundary, margin) => new Date(boundary.getTime() + margin).toISOString();
const dayOf = (date) => date.toISOString().slice(0, 10);

// --- Rows put in the database before the service starts -----------------------------------------

const literal = (value) => (value === null || value === undefined ? "NULL" : typeof value === "number" ? String(value) : `'${String(value).replace(/'/g, "''")}'`);
const insert = (table, rows) =>
  rows.map((row) => `INSERT INTO ${table} (${Object.keys(row).join(", ")}) VALUES (${Object.values(row).map(literal).join(", ")});`).join("\n");
const id = (name) => `00000000-0000-4000-a000-${sha256Hex(`privacy:${name}`).slice(0, 12)}`;
const token = (name) => `dd_test_privacy_${name}`;
const user = (name, extra = {}) => ({
  id: id(name),
  email: `${name}@seeded.example`,
  phone: null,
  created_at: daysAgo(30).toISOString(),
  country: "SA",
  signup_method: "email",
  field: null,
  field_other: null,
  workplace: null,
  profile_at: null,
  last_active_at: null,
  ...extra,
});
const session = (name, extra = {}) => ({
  token_hash: sha256Hex(token(extra.as ?? name)),
  user_id: id(name),
  client: "desktop",
  device: "test",
  created_at: daysAgo(30).toISOString(),
  last_used_at: NOW.toISOString(),
  signed_in_at: null,
  ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== "as")),
});
const acceptanceRow = (name, extra = {}) => ({
  id: crypto.randomUUID(),
  user_id: id(name),
  document: "terms",
  decision: "accepted",
  terms_version: "1.3",
  privacy_version: "1.3",
  locale: "en",
  method: "checkbox+button",
  identifier_kind: "email",
  client: "desktop",
  app_version: "0.2.0",
  accepted_at: daysAgo(20).toISOString(),
  login_request_id: "attempt-of-old",
  country: "SA",
  account_closed_at: null,
  ...extra,
});
const mail = (name, extra = {}) => ({
  id: `mail-${name}`,
  address: "privacy@doedesk.com",
  sender: "writer@elsewhere.example",
  subject: name,
  received_at: daysAgo(3).toISOString(),
  raw: `Subject: ${name}\r\n\r\nbody`,
  forwarded_at: daysAgo(3).toISOString(),
  read_at: null,
  closed_at: null,
  ...extra,
});
const event = (name, extra = {}) => ({
  uuid: `event-${name}`,
  event: "client.turn.requested",
  distinct_id: "a".repeat(64),
  install_id: "a".repeat(64),
  at: NOW.toISOString(),
  day: dayOf(NOW),
  received_at: NOW.toISOString(),
  country: "SA",
  properties: "{}",
  ...extra,
});

// The periods under test. If one of these differs from src/periods.ts, the boundary checks fail.
const SESSION_IDLE = monthsAgo(12);
const ACCOUNT_UNUSED = monthsAgo(24);
const MAIL_CLOSED = monthsAgo(12);
const MAIL_NEVER_CLOSED = daysAgo(90, monthsAgo(12));
const FIVE_YEARS = monthsAgo(60);

const seedA = [
  insert("users", [
    user("bystander", { field: "legal", workplace: "self", profile_at: daysAgo(29).toISOString() }),
    user("stale"),
    user("viewed"),
    user("by-mail", { field: "finance", workplace: "small_company", profile_at: daysAgo(10).toISOString() }),
    user("idle"),
    // Unused accounts, either side of 24 months.
    user("unused-past", { created_at: monthsAgo(30).toISOString(), last_active_at: near(ACCOUNT_UNUSED, -DAY) }),
    user("unused-not-yet", { created_at: monthsAgo(30).toISOString(), last_active_at: near(ACCOUNT_UNUSED, +DAY) }),
    user("unused-never-signed-in", { created_at: near(ACCOUNT_UNUSED, -DAY) }),
    user("new-never-signed-in", { created_at: near(ACCOUNT_UNUSED, +DAY) }),
    user("old-with-idle-sign-in", { created_at: monthsAgo(30).toISOString() }),
    user("old-with-metered-day", { created_at: monthsAgo(30).toISOString() }),
  ]),
  insert("sessions", [
    session("bystander"),
    session("stale"),
    session("viewed"),
    session("by-mail"),
    // Either side of 12 months since last use.
    session("idle", { as: "idle-expired", last_used_at: near(SESSION_IDLE, -DAY) }),
    session("idle", { as: "idle-alive", last_used_at: near(SESSION_IDLE, +DAY) }),
    session("old-with-idle-sign-in", { last_used_at: monthsAgo(13).toISOString() }),
  ]),
  insert("usage_daily", [
    { user_id: id("bystander"), day: dayOf(daysAgo(2)), client: "desktop", detect_requests: 4, detect_characters: 900 },
    { user_id: id("by-mail"), day: dayOf(daysAgo(2)), client: "desktop", detect_requests: 2, detect_characters: 100 },
    { user_id: id("old-with-metered-day"), day: dayOf(monthsAgo(23)), client: "desktop", detect_requests: 1, detect_characters: 10 },
  ]),
  insert("usage", [
    { user_id: id("bystander"), month: "2025-01", detect_characters: 5000, ocr_pages: 2 },
    { user_id: id("by-mail"), month: "2025-02", detect_characters: 70, ocr_pages: 1 },
    { user_id: id("unused-past"), month: "2024-03", detect_characters: 123, ocr_pages: 0 },
  ]),
  insert("acceptances", [
    acceptanceRow("bystander"),
    acceptanceRow("by-mail"),
    acceptanceRow("unused-past", { accepted_at: monthsAgo(30).toISOString() }),
    // Proof kept after an account was deleted, either side of five years.
    acceptanceRow("closed-long-ago", { id: "acceptance-past", account_closed_at: near(FIVE_YEARS, -DAY), country: null, login_request_id: null }),
    acceptanceRow("closed-recently", { id: "acceptance-kept", account_closed_at: near(FIVE_YEARS, +DAY), country: null, login_request_id: null }),
  ]),
  insert("login_requests", [
    { id: "attempt-past", kind: "email", identifier: "nobody@seeded.example", secret_hash: "x", client: "desktop", created_at: daysAgo(3).toISOString(), expires_at: near(daysAgo(1), -HOUR), acceptance: '{"termsVersion":"1.3"}' },
    { id: "attempt-kept", kind: "email", identifier: "nobody@seeded.example", secret_hash: "x", client: "desktop", created_at: daysAgo(1).toISOString(), expires_at: near(daysAgo(1), +HOUR) },
    { id: "attempt-of-unused", kind: "email", identifier: "unused-past@seeded.example", secret_hash: "x", client: "desktop", created_at: NOW.toISOString(), expires_at: near(NOW, +HOUR) },
  ]),
  insert("rate_limits", [
    { key: "mail:ip:203.0.113.9:3600", bucket: String(Math.floor(NOW.getTime() / 1000 / 3600) - 3), count: 2 },
    { key: "mail:ip:203.0.113.9:3600", bucket: String(Math.floor(NOW.getTime() / 1000 / 3600) - 2), count: 2 },
    { key: "sms:all:86400", bucket: String(Math.floor(NOW.getTime() / 1000 / 86_400) - 9), count: 7 },
  ]),
  insert("contact_mail", [
    mail("unread-one"),
    mail("closed-past", { closed_at: near(MAIL_CLOSED, -DAY), received_at: monthsAgo(14).toISOString(), read_at: monthsAgo(14).toISOString() }),
    mail("closed-kept", { closed_at: near(MAIL_CLOSED, +DAY), received_at: monthsAgo(14).toISOString(), read_at: monthsAgo(14).toISOString() }),
    mail("never-closed-past", { received_at: near(MAIL_NEVER_CLOSED, -DAY), read_at: monthsAgo(15).toISOString() }),
    mail("never-closed-kept", { received_at: near(MAIL_NEVER_CLOSED, +DAY), read_at: monthsAgo(14).toISOString() }),
  ]),
  insert("test_inbox", [
    { address: "e2e-abcdefgh@doedesk.com", received_at: near(daysAgo(1), -HOUR), raw: "old" },
    { address: "e2e-abcdefgh@doedesk.com", received_at: near(daysAgo(1), +HOUR), raw: "new" },
  ]),
  insert("events", [
    event("ancient", { day: dayOf(daysAgo(390)), at: daysAgo(390).toISOString() }),
    // As apps up to 0.1.x were stored: an identifier derived from an AI-provider account.
    event("provider-id", { distinct_id: "b".repeat(64) }),
    event("owner-observed", { event: "install.owner_observed", properties: '{"ownerId":"cccc","ownerSource":"claude"}' }),
    event("profile-answered", { event: "onboarding.profile_answered", properties: '{"field":"legal"}' }),
    event("no-installation", { distinct_id: "d".repeat(64), install_id: null }),
    event("plain-old-app"),
    event("new-app", { distinct_id: "11111111-2222-4333-8444-555555555555", install_id: "11111111-2222-4333-8444-555555555555" }),
  ]),
  insert("usage_data_choices", [
    { install_id: "past", state: "on_consented", chosen_at: daysAgo(401).toISOString(), received_at: near(daysAgo(400), -HOUR) },
    { install_id: "kept", state: "on_consented", chosen_at: daysAgo(399).toISOString(), received_at: near(daysAgo(400), +HOUR) },
  ]),
  insert("crash_reports", [
    { id: "crash-past", received_at: daysAgo(181).toISOString(), day: dayOf(daysAgo(181)), source: "desktop", message: "m", detail: "{}" },
    { id: "crash-kept", received_at: daysAgo(180).toISOString(), day: dayOf(daysAgo(180)), source: "desktop", message: "m", detail: "{}" },
  ]),
  insert("rights_requests", [
    { id: "request-past", handled_at: near(FIVE_YEARS, -DAY), type: "access", channel: "email", outcome: "done" },
    { id: "request-kept", handled_at: near(FIVE_YEARS, +DAY), type: "access", channel: "email", outcome: "done" },
  ]),
  insert("deletion_receipts", [
    { token_hash: "receipt-past", account_id: "x", deleted_at: daysAgo(2).toISOString(), kept_until: "x", expires_at: near(NOW, -HOUR) },
    { token_hash: "receipt-kept", account_id: "x", deleted_at: NOW.toISOString(), kept_until: "x", expires_at: near(NOW, +HOUR) },
  ]),
].join("\n");

const ACCEPTANCE = { termsVersion: "1.3", privacyVersion: "1.3", wordingId: "signup-2026-11", locale: "ar", appVersion: "0.2.0" };
const from = (country, region) => ({ "x-test-country": country, ...(region === undefined ? {} : { "x-test-region": region }) });
const form = (fields) => ({ raw: new URLSearchParams(fields).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
const rawMail = (to, subject, text) =>
  [
    `Received: from smtp.example.com (127.0.0.1) by cloudflare-email.com (unknown) id 4fwwffRXOpyR for <${to}>; Tue, 27 Aug 2024 15:50:20 +0000`,
    'From: "A Person" <writer@elsewhere.example>',
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: quoted-printable",
    "Date: Tue, 27 Aug 2024 08:49:44 -0700",
    `Message-ID: <${crypto.randomUUID()}@elsewhere.example>`,
    "",
    text,
    "",
  ].join("\r\n");

/** Helpers bound to one running copy of the service. */
const against = (service) => {
  const call = client(service.base);
  const admin = { authorization: `Bearer ${service.adminKey}` };
  const adminPost = (path, fields) => call("POST", path, { raw: new URLSearchParams(fields).toString(), headers: { ...admin, "content-type": "application/x-www-form-urlencoded" } });
  const count = (sql, ...values) => service.query(`SELECT COUNT(*) AS n FROM ${sql}`, ...values)[0].n;
  const confirm = (link) => {
    const values = new URLSearchParams(new URL(link).hash.slice(1));
    return fetch(`${service.base}/auth/confirm`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ r: values.get("r"), t: values.get("t") }),
    });
  };
  /** Signs in by emailed link, the way an app does. `acceptance` is left out to play an app up to 0.1.x. */
  const signIn = async (email, { acceptance, purpose, headers = {}, client: kind = "desktop" } = {}) => {
    const start = await call("POST", "/v1/auth/email/start", { body: { email, client: kind, device: "Test device", ...(acceptance === undefined ? {} : { acceptance }), ...(purpose === undefined ? {} : { purpose }) }, headers });
    if (start.status !== 200) return { start };
    await confirm(start.json.emailedLink);
    const poll = await call("POST", "/v1/auth/email/poll", { body: { requestId: start.json.requestId, pollSecret: start.json.pollSecret } });
    return { start, poll, token: poll.json?.token, accountId: poll.json?.account?.id };
  };
  const sendMail = (to, subject, text = "Hello") =>
    fetch(`${service.base}/cdn-cgi/handler/email?from=${encodeURIComponent("writer@elsewhere.example")}&to=${encodeURIComponent(to)}`, { method: "POST", body: rawMail(to, subject, text) });
  return { call, admin, adminPost, count, confirm, signIn, sendMail };
};

// Everything that must never reach the service's log: collected as the test goes.
const mustNotBeLogged = new Set();

// ================================================================================================
// First copy: nothing required, mail forwarding set. This is how the service is deployed first.
// ================================================================================================
{
  const service = await startLocalService({ seedSql: seedA, vars: { MAIL_FORWARD_TO: "owner@mailbox.example", WORKER_OPEN: "1" } });
  const { call, admin, adminPost, count, confirm, signIn, sendMail } = against(service);
  try {
    // --- The versions in force -------------------------------------------------------------------
    const legal = await call("GET", "/v1/legal");
    same("versions: public, and name both documents with their links", [legal.status, legal.json?.terms?.version, legal.json?.terms?.requiredVersion, legal.json?.privacy?.version, legal.json?.terms?.url, legal.json?.privacy?.url?.ar], [200, "1.3", "1.3", "1.3", { en: "https://doedesk.com/terms", ar: "https://doedesk.com/ar/terms" }, "https://doedesk.com/ar/privacy"]);
    same("versions: say that acceptance is not required yet", legal.json?.acceptance, { requiredToSignIn: false, requiredToUse: false });

    // --- Usage data: the default by country ------------------------------------------------------
    const rule = async (country, region) => (await call("GET", "/v1/auth/options", { headers: from(country, region) })).json?.usageData;
    const expected = { SA: "notice", US: "notice", CH: "notice", EG: "notice", DE: "ask", FR: "ask", IS: "ask", GB: "ask", JE: "ask", RE: "ask", TR: "ask", AE: "ask", IN: "ask", "": "ask", XX: "ask", T1: "ask" };
    const got = {};
    for (const country of Object.keys(expected)) got[country] = await rule(country);
    same("usage data: on by default except where agreement must come first, and never when the country is unknown", got, expected);
    same("usage data: in Canada only Quebec asks first, and Canada without a region asks", [await rule("CA", "QC"), await rule("CA", "ON"), await rule("CA")], ["ask", "notice", "ask"]);
    const options = await call("GET", "/v1/auth/options", { headers: from("SA") });
    expect("options: still what released apps read", options.json?.country === "SA" && options.json?.default === "phone" && options.json?.methods?.join() === "phone,email", options.json);
    expect("options: carry the list of consent regions, the versions, and that sign-up is open", options.json?.usageDataConsentRegions?.includes("DE") && options.json?.usageDataConsentRegions?.includes("CA-QC") && !options.json?.usageDataConsentRegions?.includes("SA") && options.json?.legal?.terms?.version === "1.3" && options.json?.signUp?.available === true, options.json);

    // --- An app up to 0.1.x: no acceptance sent --------------------------------------------------
    const oldApp = await signIn("old.app@person.example");
    mustNotBeLogged.add("old.app@person.example").add(oldApp.accountId).add(oldApp.token);
    expect("old app: signs in and gets an account without sending an acceptance", oldApp.poll?.status === 200 && oldApp.poll.json.status === "approved" && oldApp.poll.json.created === true && oldApp.token?.startsWith("dd_"), oldApp.poll);
    same("old app: the answer still has what it reads, and adds where acceptance stands", [typeof oldApp.poll.json.account?.email, oldApp.poll.json.acceptance?.outstanding, oldApp.poll.json.acceptance?.blocked, oldApp.poll.json.legal?.terms?.version], ["string", true, false, "1.3"]);
    same("old app: no acceptance was recorded for it", count("acceptances WHERE user_id = ?", oldApp.accountId), 0);
    const oldMe = await call("GET", "/v1/me", { token: oldApp.token });
    same("old app: its account is marked as outstanding, not refused", [oldMe.status, oldMe.json?.acceptance?.outstanding, oldMe.json?.acceptance?.termsVersion, oldMe.json?.acceptance?.requiredTermsVersion], [200, true, null, "1.3"]);
    const oldDetect = await call("POST", "/v1/detect", { body: { texts: ["Jane Doe"] }, token: oldApp.token });
    expect("old app: detection still works", oldDetect.status === 200 && oldDetect.json.results?.[0]?.entities?.length === 1, oldDetect);

    // --- An app that sends the acceptance --------------------------------------------------------
    const person = await signIn("new.app@person.example", { acceptance: ACCEPTANCE, headers: from("SA") });
    mustNotBeLogged.add("new.app@person.example").add(person.accountId).add(person.token).add(person.start.json.pollSecret);
    const linkSecret = new URLSearchParams(new URL(person.start.json.emailedLink).hash.slice(1)).get("t");
    mustNotBeLogged.add(linkSecret);
    expect("acceptance: sign-in with it succeeds and the account is up to date", person.poll?.status === 200 && person.poll.json.created === true && person.poll.json.acceptance?.outstanding === false && person.poll.json.acceptance?.termsVersion === "1.3", person.poll);
    const record = service.query("SELECT * FROM acceptances WHERE user_id = ?", person.accountId);
    const { id: recordId, accepted_at: acceptedAt, ...recorded } = record[0] ?? {};
    same("acceptance: one row, with the account, versions, language, wording, act, app, country and the verified attempt", recorded, {
      user_id: person.accountId,
      document: "terms",
      decision: "accepted",
      terms_version: "1.3",
      privacy_version: "1.3",
      terms_sha256: LEGAL.terms.sha256.ar,
      privacy_sha256: LEGAL.privacy.sha256.ar,
      wording_id: "signup-2026-11",
      locale: "ar",
      method: "checkbox+button",
      identifier_kind: "email",
      client: "desktop",
      app_version: "0.2.0",
      login_request_id: person.start.json.requestId,
      country: "SA",
      account_closed_at: null,
    });
    expect("acceptance: the time is the service's, to the second", record.length === 1 && Math.abs(Date.parse(acceptedAt) - Date.now()) < 120_000 && typeof recordId === "string", record);
    same("acceptance: the attempt held it until the link was confirmed", JSON.parse(service.query("SELECT acceptance FROM login_requests WHERE id = ?", person.start.json.requestId)[0].acceptance).termsVersion, "1.3");
    await new Promise((resolve) => setTimeout(resolve, 61_000 - (Date.now() % 60_000) + 500)); // the next minute: one link a minute per address
    const again = await signIn("new.app@person.example", { acceptance: { ...ACCEPTANCE, locale: "en" }, headers: from("SA") });
    mustNotBeLogged.add(again.token);
    expect("acceptance: signing in again with the same version adds no row", again.poll?.json?.created === false && again.accountId === person.accountId && count("acceptances WHERE user_id = ?", person.accountId) === 1, again.poll);

    for (const [label, acceptance, code] of [
      ["a version that was never published", { ...ACCEPTANCE, termsVersion: "9.9" }, "invalid_acceptance"],
      ["no language", { ...ACCEPTANCE, locale: undefined }, "invalid_acceptance"],
      ["something that is not an object", "yes", "invalid_acceptance"],
    ]) {
      const refused = await call("POST", "/v1/auth/email/start", { body: { email: `bad.${code}.${Math.random().toString(36).slice(2)}@person.example`, acceptance } });
      expect(`acceptance: ${label} is refused, even with the switch off`, refused.status === 400 && refused.json?.error?.code === code, refused);
    }

    // An account that exists accepts from inside the app (the sheet).
    const accept = await call("POST", "/v1/me/acceptance", { body: { acceptance: { ...ACCEPTANCE, locale: "en", method: "sheet+button" } }, token: oldApp.token, headers: from("AE") });
    const sheetRow = service.query("SELECT identifier_kind, method, locale, country, login_request_id, client FROM acceptances WHERE user_id = ?", oldApp.accountId);
    same("acceptance: an existing account accepts from the app, and the row says it was by session", [accept.status, accept.json?.acceptance?.outstanding, { ...sheetRow[0] }], [200, false, { identifier_kind: "session", method: "sheet+button", locale: "en", country: "AE", login_request_id: null, client: "desktop" }]);
    await call("POST", "/v1/me/acceptance", { body: { acceptance: ACCEPTANCE }, token: oldApp.token });
    same("acceptance: accepting the same version twice keeps one row", count("acceptances WHERE user_id = ?", oldApp.accountId), 1);
    same("acceptance: it needs a sign-in", (await call("POST", "/v1/me/acceptance", { body: { acceptance: ACCEPTANCE } })).status, 401);

    // By phone, which is offered from Saudi Arabia.
    const phoneStart = await call("POST", "/v1/auth/phone/start", { body: { phone: "0500001234", client: "mobile", acceptance: ACCEPTANCE }, headers: from("SA") });
    const phoneVerify = await call("POST", "/v1/auth/phone/verify", { body: { requestId: phoneStart.json?.requestId, code: phoneStart.json?.testCode } });
    mustNotBeLogged.add("+966500001234").add("500001234").add(phoneVerify.json?.account?.id).add(phoneVerify.json?.token);
    same("acceptance: by phone, the row says phone and names the app", [phoneVerify.status, { ...service.query("SELECT identifier_kind, client FROM acceptances WHERE user_id = ?", phoneVerify.json?.account?.id)[0] }], [200, { identifier_kind: "phone", client: "mobile" }]);

    // --- The emailed link keeps its secret out of web addresses ----------------------------------
    const linkStart = await call("POST", "/v1/auth/email/start", { body: { email: "link.check@person.example", client: "desktop", device: "DoeDesk on Mac" } });
    mustNotBeLogged.add("link.check@person.example");
    const emailed = new URL(linkStart.json.emailedLink);
    const values = new URLSearchParams(emailed.hash.slice(1));
    mustNotBeLogged.add(values.get("t")).add(linkStart.json.pollSecret);
    expect("link: the secret is after the #, where no request carries it", emailed.search === "" && emailed.pathname === "/auth/confirm" && values.get("r") === linkStart.json.requestId && values.get("t")?.length === 64, linkStart.json.emailedLink);
    const opened = await fetch(`${service.base}/auth/confirm`);
    const openedText = await opened.text();
    expect("link: the page behind it holds no secret and posts the values in a form body", opened.status === 200 && openedText.includes('name="step" value="show"') && openedText.includes("location.hash") && openedText.includes("history.replaceState") && !openedText.includes(values.get("t")), openedText.slice(0, 300));
    const pollLink = () => call("POST", "/v1/auth/email/poll", { body: { requestId: linkStart.json.requestId, pollSecret: linkStart.json.pollSecret } });
    const shown = await fetch(`${service.base}/auth/confirm`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ r: values.get("r"), t: values.get("t"), step: "show" }) });
    const shownText = await shown.text();
    expect("link: showing the question approves nothing", shown.status === 200 && shownText.includes("Confirm sign-in") && shownText.includes("DoeDesk on Mac") && (await pollLink()).json?.status === "pending", shownText.slice(0, 300));
    const wrongSecret = await fetch(`${service.base}/auth/confirm`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ r: values.get("r"), t: "0".repeat(64), step: "show" }) });
    expect("link: a wrong secret is shown as expired", wrongSecret.status === 410, wrongSecret.status);
    const pressed = await confirm(linkStart.json.emailedLink);
    const linkPoll = await pollLink();
    mustNotBeLogged.add(linkPoll.json?.token).add(linkPoll.json?.account?.id);
    expect("link: pressing the button signs the app in", (await pressed.text()).includes("You are signed in") && linkPoll.json?.status === "approved", linkPoll);
    const legacyStart = await call("POST", "/v1/auth/email/start", { body: { email: "legacy.link@person.example", client: "desktop" } });
    const legacy = new URL(legacyStart.json.testLink);
    const legacyPage = await (await fetch(`${service.base}/auth/confirm${legacy.search}`)).text();
    expect("link: one sent before this change, with the values as a query, still asks", legacy.searchParams.get("t")?.length === 64 && legacyPage.includes("Confirm sign-in"), legacyPage.slice(0, 200));

    // --- Correcting and withdrawing the onboarding answers --------------------------------------
    const answers = async () => ({ ...service.query("SELECT field, field_other, workplace, profile_at IS NOT NULL AS answered FROM users WHERE id = ?", person.accountId)[0] });
    await call("POST", "/v1/me/profile", { body: { field: "legal", fieldOther: null, workplace: "self" }, token: person.token });
    same("answers: saved", await answers(), { field: "legal", field_other: null, workplace: "self", answered: 1 });
    await call("POST", "/v1/me/profile", { body: { field: "other", fieldOther: "Notary", workplace: "small_company" }, token: person.token });
    same("answers: corrected by sending them again", await answers(), { field: "other", field_other: "Notary", workplace: "small_company", answered: 1 });
    const unanswering = await signIn("answers.withdrawn@person.example");
    mustNotBeLogged.add("answers.withdrawn@person.example").add(unanswering.accountId).add(unanswering.token);
    await call("POST", "/v1/me/profile", { body: { field: "healthcare", fieldOther: null, workplace: "government" }, token: unanswering.token });
    await call("POST", "/v1/me/profile", { body: { field: null, fieldOther: null, workplace: null }, token: unanswering.token });
    same("answers: withdrawn by sending nulls, which removes them", { ...service.query("SELECT field, field_other, workplace FROM users WHERE id = ?", unanswering.accountId)[0] }, { field: null, field_other: null, workplace: null });

    // --- A copy of everything held about the account --------------------------------------------
    await call("POST", "/v1/detect", { body: { texts: ["Jane Doe wrote."] }, token: person.token });
    await call("POST", "/v1/ocr", { raw: Buffer.from("%PDF-1.7 pages=3"), token: person.token, headers: { "content-type": "application/pdf" } });
    const extra = await call("POST", "/v1/auth/sessions", { body: { client: "server" }, token: person.token });
    mustNotBeLogged.add(extra.json?.token);
    const pending = await call("POST", "/v1/auth/phone/start", { body: { phone: "0500009001" }, headers: from("SA") }); // someone else's attempt
    mustNotBeLogged.add("559990001");
    // The account was made from Saudi Arabia, so it started there. The person moves it to the EU; so does a bystander.
    const moved = await call("POST", "/v1/me/region", { body: { region: "eu" }, token: person.token });
    await call("POST", "/v1/me/region", { body: { region: "eu" }, token: token("stale") });
    const copy = await call("GET", "/v1/me/export", { token: person.token });
    const held = {
      user: service.query("SELECT * FROM users WHERE id = ?", person.accountId)[0],
      sessions: service.query("SELECT client, device, created_at, last_used_at, signed_in_at, purpose FROM sessions WHERE user_id = ? ORDER BY created_at", person.accountId).map((row) => ({ ...row })),
      daily: service.query("SELECT * FROM usage_daily WHERE user_id = ?", person.accountId),
      attempts: count("login_requests WHERE identifier = ?", "new.app@person.example"),
    };
    same("export: the account, as held, with the region its worker runs in", copy.json?.account, { id: person.accountId, email: "new.app@person.example", phone: null, createdAt: held.user.created_at, signUpMethod: "email", signUpCountry: "SA", lastActiveAt: null, region: "eu", regionUpdatedAt: moved.json?.regionUpdatedAt });
    same("export: every change of region, and nobody else's", copy.json?.regionHistory, [{ from_region: "sa", to_region: "eu", changed_at: held.user.region_updated_at, client: "desktop" }]);
    same("export: the onboarding answers", { ...copy.json?.onboardingAnswers, answeredAt: undefined }, { field: "other", fieldOther: "Notary", workplace: "small_company" });
    same("export: every sign-in, marking the one that asked", copy.json?.signIns?.map(({ thisSignIn, ...rest }) => rest), held.sessions);
    same("export: three sign-ins, one of them this one", [copy.json?.signIns?.length, copy.json?.signIns?.filter((item) => item.thisSignIn).length], [3, 1]);
    same("export: the usage records, day by day", copy.json?.usage?.daily?.map((row) => [row.day, row.client, row.detect_requests, row.detect_characters, row.ocr_files, row.ocr_pages]), held.daily.map((row) => [row.day, row.client, row.detect_requests, row.detect_characters, row.ocr_files, row.ocr_pages]));
    expect("export: the usage records hold what was just used", copy.json?.usage?.daily?.[0]?.detect_characters === 15 && copy.json?.usage?.daily?.[0]?.ocr_pages === 3, copy.json?.usage);
    same("export: the acceptance history and where it stands", [copy.json?.termsAcceptance?.history?.length, copy.json?.termsAcceptance?.history?.[0]?.terms_version, copy.json?.termsAcceptance?.history?.[0]?.wording_id, copy.json?.termsAcceptance?.status?.outstanding], [1, "1.3", "signup-2026-11", false]);
    same("export: the sign-in attempts for its address", copy.json?.signInAttempts?.length, held.attempts);
    expect("export: no hash of a token, code or link secret, and nothing of another account", !/token_hash|secret_hash|poll_hash/.test(copy.text) && !copy.text.includes("old.app@person.example") && !copy.text.includes("0500009001") && !copy.text.includes(pending.json?.requestId ?? "none"), copy.text.slice(0, 300));
    expect("export: says what it cannot include", Array.isArray(copy.json?.notIncluded) && copy.json.notIncluded.length >= 3, copy.json?.notIncluded);
    const secondCopy = await call("GET", "/v1/me/export", { token: person.token });
    same("export: each copy is written to the log of requests, and the copy shows the log", secondCopy.json?.rightsRequests?.map((row) => [row.type, row.channel, row.outcome]), [["access", "app", "done"]]);
    same("export: needs a sign-in", (await call("GET", "/v1/me/export")).status, 401);

    // --- Deleting the account -------------------------------------------------------------------
    const tables = { users: "id", sessions: "user_id", usage_daily: "user_id", usage: "user_id", acceptances: "user_id", region_changes: "user_id" };
    const rowsOf = (accountId) => Object.fromEntries(Object.entries(tables).map(([table, column]) => [table, count(`${table} WHERE ${column} = ?`, accountId)]));
    const everyoneElse = () => Object.fromEntries(Object.keys(tables).map((table) => [table, count(`${table} WHERE ${tables[table]} <> ?`, person.accountId)]));
    const othersBefore = everyoneElse();
    const totalsBefore = { users: count("users"), mail: count("contact_mail"), events: count("events") };

    const staleDelete = await call("DELETE", "/v1/me", { token: token("stale") });
    same("delete: a sign-in from long ago is refused, and told to sign in again", [staleDelete.status, staleDelete.json?.error?.code, staleDelete.json?.error?.maxAgeSeconds, count("users WHERE id = ?", id("stale"))], [403, "recent_sign_in_required", 600, 1]);
    const extraDelete = await call("DELETE", "/v1/me", { token: extra.json.token });
    same("delete: a sign-in made from another sign-in never qualifies", [extraDelete.status, extraDelete.json?.error?.code, count("users WHERE id = ?", person.accountId)], [403, "recent_sign_in_required", 1]);
    same("delete: needs a sign-in", (await call("DELETE", "/v1/me")).status, 401);
    same("delete: an unknown token is refused", (await call("DELETE", "/v1/me", { token: "dd_unknown" })).status, 401);
    same("delete: the web app's preflight allows the method", (await call("OPTIONS", "/v1/me")).headers.get("access-control-allow-methods"), "GET, POST, DELETE, OPTIONS");

    same("delete: before, the account has rows in every table", rowsOf(person.accountId), { users: 1, sessions: 3, usage_daily: 1, usage: 0, acceptances: 1, region_changes: 1 });
    const deleted = await call("DELETE", "/v1/me", { token: again.token });
    expect("delete: a sign-in verified minutes ago deletes, and the confirmation names the account and what is kept", deleted.status === 200 && deleted.json.deleted === true && deleted.json.accountId === person.accountId && deleted.json.kept?.[0]?.record === "terms_acceptance" && Math.abs(Date.parse(deleted.json.kept[0].until) - (Date.now() + 5 * 365.25 * DAY)) < 3 * DAY, deleted);
    same("delete: every row of the account is gone, except the proof of acceptance", rowsOf(person.accountId), { users: 0, sessions: 0, usage_daily: 0, usage: 0, acceptances: 1, region_changes: 0 });
    same("delete: its sign-in attempts and counters are gone", [count("login_requests WHERE identifier = ?", "new.app@person.example"), count("rate_limits WHERE key LIKE ?", "%new.app@person.example%"), count("rate_limits WHERE key LIKE ?", `%${person.accountId}%`)], [0, 0, 0]);
    same("delete: no row of any other account was touched", everyoneElse(), othersBefore);
    same("delete: exactly one account went, and nothing that is not tied to an account", { users: count("users"), mail: count("contact_mail"), events: count("events") }, { ...totalsBefore, users: totalsBefore.users - 1 });
    const proof = service.query("SELECT * FROM acceptances WHERE user_id = ?", person.accountId)[0];
    expect("delete: the proof is cut down and stamped with the closing time", proof.account_closed_at === deleted.json.deletedAt && proof.country === null && proof.login_request_id === null && proof.terms_version === "1.3" && proof.wording_id === "signup-2026-11", proof);
    expect("delete: nowhere in the database does the address remain", !JSON.stringify(["users", "sessions", "login_requests", "rate_limits", "acceptances", "rights_requests", "deletion_receipts", "usage_daily", "usage"].map((table) => service.query(`SELECT * FROM ${table}`))).includes("new.app@person.example"));
    same("delete: written to the log, with the account's identifier and no content", service.query("SELECT type, channel, outcome, account_id FROM rights_requests WHERE account_id = ? AND type = 'deletion'", person.accountId).map((row) => ({ ...row })), [{ type: "deletion", channel: "app", outcome: "done", account_id: person.accountId }]);
    const repeated = await call("DELETE", "/v1/me", { token: again.token });
    same("delete: sent again, it answers the same and changes nothing", [repeated.status, repeated.json, count("rights_requests WHERE account_id = ? AND type = 'deletion'", person.accountId)], [200, deleted.json, 1]);
    same("delete: the account's other sign-ins have ended", [(await call("GET", "/v1/me", { token: person.token })).status, (await call("DELETE", "/v1/me", { token: person.token })).status, (await call("POST", "/v1/detect", { body: { texts: ["x"] }, token: extra.json.token })).status], [401, 401, 401]);
    const reborn = await signIn("new.app@person.example", { acceptance: ACCEPTANCE });
    mustNotBeLogged.add(reborn.accountId).add(reborn.token);
    expect("delete: the same address can make a new account, which shares nothing with the old one", reborn.poll?.json?.created === true && reborn.accountId !== person.accountId && count("usage_daily WHERE user_id = ?", reborn.accountId) === 0, reborn.poll);

    // --- Usage data: what is stored with an event -----------------------------------------------
    const batch = (events, headers = from("SA"), tokenToSend) => call("POST", "/ingest/batch/", { body: { api_key: "doedesk-client", batch: events }, headers, token: tokenToSend });
    const oldInstall = "e".repeat(64);
    const providerHash = "f".repeat(64);
    const item = (name, extra = {}) => ({ uuid: `sent-${name}`, event: "client.turn.requested", distinct_id: providerHash, timestamp: new Date().toISOString(), ...extra, properties: { installId: oldInstall, platform: "darwin", t3CodeVersion: "0.1.10", ...extra.properties } });
    const sent = await batch(
      [
        item("old-app"),
        item("owner", { event: "install.owner_observed", properties: { ownerSource: "openai", ownerId: "9".repeat(64), observedBy: "server" } }),
        item("profile", { event: "onboarding.profile_answered", properties: { field: "legal", workplace: "self" } }),
        item("extras", { properties: { accountId: oldApp.accountId, userId: "u-1", email: "old.app@person.example", ownerId: "9".repeat(64), provider: "claude" } }),
        item("no-installation", { properties: { installId: undefined } }),
        item("odd-installation", { properties: { installId: "not-an-identifier" } }),
      ],
      from("SA"),
      oldApp.token,
    );
    same("events: an old app's batch is still answered as before", [sent.status, sent.json?.status, sent.json?.stored, sent.json?.dropped], [200, 1, 2, 4]);
    const stored = service.query("SELECT * FROM events WHERE uuid LIKE 'sent-%' ORDER BY uuid");
    same("events: stored under the installation identifier alone; the account-derived one the app sent is not kept", stored.map((row) => [row.uuid, row.distinct_id, row.install_id, row.country, row.app_version]), [
      ["sent-extras", oldInstall, oldInstall, "SA", "0.1.10"],
      ["sent-old-app", oldInstall, oldInstall, "SA", "0.1.10"],
    ]);
    same("events: properties that name an account or a person are removed", JSON.parse(stored[0].properties), { installId: oldInstall, platform: "darwin", t3CodeVersion: "0.1.10", provider: "claude" });
    const eventColumns = service.query("SELECT name FROM pragma_table_info('events')").map((row) => row.name);
    expect("events: the table has no column for an account, and no stored event holds one", !eventColumns.some((name) => /user|account|email|phone|ip/.test(name)) && !JSON.stringify(service.query("SELECT * FROM events")).includes(oldApp.accountId) && !JSON.stringify(stored).includes(providerHash), eventColumns);
    const install = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const newItem = (name, extra = {}) => ({ uuid: `sent-${name}`, event: "feature.used", distinct_id: install, timestamp: new Date().toISOString(), ...extra, properties: { installId: install, appVersion: "0.2.0", ...extra.properties } });
    const consent = { wordingId: "usage-data-2026-11", at: "2026-11-01T10:00:00.000Z" };
    const fromGermany = await batch([newItem("de-no-consent"), newItem("de-consent", { properties: { consent } }), newItem("de-bad-consent", { properties: { consent: { wordingId: "x" } } })], from("DE"));
    const fromNowhere = await batch([newItem("unknown-no-consent"), newItem("unknown-consent", { properties: { consent } })], from(""));
    const fromRiyadh = await batch([newItem("sa-no-consent")], from("SA"));
    same("events: from a consent region, or an unknown one, only an event carrying the consent stamp is stored", [fromGermany.json, fromNowhere.json, fromRiyadh.json, service.query("SELECT uuid, country FROM events WHERE uuid LIKE 'sent-%' AND install_id = ? ORDER BY uuid", install).map((row) => `${row.uuid}:${row.country}`)], [
      { status: 1, stored: 1, dropped: 2 },
      { status: 1, stored: 1, dropped: 1 },
      { status: 1, stored: 1, dropped: 0 },
      ["sent-de-consent:DE", "sent-sa-no-consent:SA", "sent-unknown-consent:null"],
    ]);
    same("events: the consent stamp is kept with the event", JSON.parse(service.query("SELECT properties FROM events WHERE uuid = 'sent-de-consent'")[0].properties).consent, consent);
    await batch([newItem("de-consent", { properties: { consent } })], from("DE"));
    same("events: a batch sent twice is stored once", count("events WHERE uuid = 'sent-de-consent'"), 1);
    same("events: the client key is still needed", (await call("POST", "/ingest/batch", { body: { api_key: "x", batch: [] } })).status, 401);

    const choice = (body, headers = from("DE")) => call("POST", "/ingest/choice", { body: { api_key: "doedesk-client", ...body }, headers, token: oldApp.token });
    const chosen = await choice({ installId: install, state: "on_consented", at: "2026-11-01T10:00:00Z", wordingId: "usage-data-2026-11", basis: "ask", signal: "network", locale: "en", appVersion: "0.2.0" });
    await choice({ installId: install, state: "on_consented", at: "2026-11-01T10:00:00Z", wordingId: "usage-data-2026-11", basis: "ask", signal: "network", locale: "en", appVersion: "0.2.0" });
    const withdrawn = await choice({ installId: install, state: "off", at: "2026-11-02T10:00:00Z", wordingId: "usage-data-2026-11" });
    same("choice: agreed and then withdrawn are both kept, once each, by installation and with no account", [chosen.status, withdrawn.status, service.query("SELECT * FROM usage_data_choices WHERE install_id = ? ORDER BY chosen_at", install).map(({ received_at, ...row }) => row)], [200, 200, [
      { install_id: install, state: "on_consented", chosen_at: "2026-11-01T10:00:00.000Z", basis: "ask", signal: "network", wording_id: "usage-data-2026-11", locale: "en", country: "DE", app_version: "0.2.0" },
      { install_id: install, state: "off", chosen_at: "2026-11-02T10:00:00.000Z", basis: null, signal: null, wording_id: "usage-data-2026-11", locale: null, country: "DE", app_version: null },
    ]]);
    same("choice: an identifier that is not a random one, an unknown state, or no wording is refused", [(await choice({ installId: oldInstall, state: "off", at: "2026-11-02T10:00:00Z", wordingId: "w" })).status, (await choice({ installId: install, state: "maybe", at: "2026-11-02T10:00:00Z", wordingId: "w" })).status, (await choice({ installId: install, state: "off", at: "2026-11-02T10:00:00Z" })).status], [400, 400, 400]);
    const crash = await call("POST", "/ingest/crash", { body: { message: "Boom", stack: "at x", source: "desktop", installId: install, context: { prompt: "a client's secret", account: oldApp.accountId } } });
    same("error report: the free-form context is not stored", [crash.status, service.query("SELECT install_id, detail FROM crash_reports WHERE message = 'Boom'").map((row) => ({ ...row }))], [200, [{ install_id: install, detail: '{"stack":"at x"}' }]]);

    // --- The owner's dashboard: nobody but the owner --------------------------------------------
    for (const [method, path, body] of [
      ["GET", "/admin/privacy"],
      ["GET", "/admin/mail"],
      ["GET", "/admin/mail/mail-unread-one"],
      ["GET", "/admin/retention.json"],
      ["GET", "/admin/maintenance/usage-events?scope=legacy"],
      ["POST", "/admin/rights", { action: "export", account: id("by-mail") }],
      ["POST", "/admin/rights", { action: "delete", account: id("by-mail"), confirm: "DELETE" }],
      ["POST", "/admin/retention", { confirm: "RUN" }],
      ["POST", "/admin/mail", { action: "read-all" }],
      ["POST", "/admin/maintenance/usage-events", { scope: "legacy", confirm: "DELETE" }],
    ]) {
      const options = body === undefined ? {} : form(body);
      const bare = await call(method, path, options);
      const asAccount = await call(method, path, { ...options, token: token("bystander") });
      expect(`no key: ${method} ${path.split("?")[0]} is refused, with an account's sign-in too`, bare.status === 401 && asAccount.status === 401 && !bare.text.includes("@") && !asAccount.text.includes("seeded.example"), [bare.status, asAccount.status]);
    }
    same("no key: nothing was deleted, run or marked by those attempts", [count("users WHERE id = ?", id("by-mail")), count("contact_mail WHERE read_at IS NULL"), count("events WHERE uuid = 'event-ancient'")], [1, 1, 1]);

    // --- The owner's sign-in to the dashboard ---------------------------------------------------
    const login = await call("POST", "/admin", form({ key: service.adminKey }));
    const setCookie = login.headers.get("set-cookie") ?? "";
    const cookie = setCookie.split(";")[0];
    const [expires, signature] = cookie.replace("dd_admin=", "").split(".");
    expect("dashboard: the key opens it for twelve hours, in a cookie scripts cannot read", login.status === 303 && /Max-Age=43200\b/.test(setCookie) && /HttpOnly/.test(setCookie) && /SameSite=Strict/.test(setCookie) && Math.abs(Number(expires) - (Date.now() / 1000 + 43_200)) < 120, setCookie);
    same("dashboard: the cookie opens it; one with a later end, an ended one, or the old kind does not", [
      (await call("GET", "/admin/privacy", { headers: { cookie } })).status,
      (await call("GET", "/admin/privacy", { headers: { cookie: `dd_admin=${Number(expires) + 86_400}.${signature}` } })).status,
      (await call("GET", "/admin/privacy", { headers: { cookie: `dd_admin=${Math.floor(Date.now() / 1000) - 10}.${signature}` } })).status,
      (await call("GET", "/admin/privacy", { headers: { cookie: `dd_admin=${sha256Hex(`admin-cookie:${service.adminKey}`)}` } })).status,
    ], [200, 401, 401, 401]);
    const wrongKey = await call("POST", "/admin", form({ key: `${service.adminKey}x` }));
    const keyPage = await call("GET", "/admin");
    expect("dashboard: a wrong key sets no cookie, and the page says so in two words", wrongKey.status === 401 && wrongKey.headers.get("set-cookie") === null && wrongKey.text.includes('role="alert">Wrong key</p>') && wrongKey.text.includes('aria-invalid="true"'), wrongKey.text.slice(-300));
    expect("dashboard: the page that asks for the key says nothing was wrong before a key was tried, and holds no address", keyPage.status === 401 && keyPage.text.includes('name="key"') && !keyPage.text.includes("Wrong key") && !keyPage.text.includes("@"), keyPage.text.slice(-300));
    const signOut = await call("POST", "/admin/sign-out", { headers: { cookie } });
    expect("dashboard: signing out drops the cookie", signOut.status === 303 && /dd_admin=;/.test(signOut.headers.get("set-cookie") ?? "") && /Max-Age=0\b/.test(signOut.headers.get("set-cookie") ?? ""), signOut.headers.get("set-cookie"));
    expect("dashboard: every page offers the sign-out", (await call("GET", "/admin", { headers: admin })).text.includes('action="/admin/sign-out"'));

    // --- Contact mail ---------------------------------------------------------------------------
    const mailBefore = count("contact_mail");
    const delivered = await sendMail("privacy@doedesk.com", "Please delete my account", "My address is writer@elsewhere.example =E2=9C=93");
    const toLegal = await sendMail("legal@doedesk.com", "A legal notice");
    const toNobody = await sendMail("sales@doedesk.com", "Not an address");
    const toTestBox = await sendMail("e2e-zzzzzzzz@doedesk.com", "A test message");
    const received = service.query("SELECT * FROM contact_mail WHERE subject = 'Please delete my account'")[0];
    expect("mail: a message to privacy@ is stored with its sender and subject", delivered.status === 200 && received?.address === "privacy@doedesk.com" && received.sender === "writer@elsewhere.example" && received.raw.includes("My address is") && received.read_at === null && received.closed_at === null, received);
    expect("mail: and forwarded to the owner's mailbox", received?.forwarded_at !== null && received.forward_error === null && service.log().split("rcptTo: owner@mailbox.example").length - 1 === 2, { received, log: service.log().slice(-600) });
    same("mail: legal@ is accepted, an unknown address is not, and a test mailbox stays apart", [toLegal.status, count("contact_mail") - mailBefore, count("contact_mail WHERE subject = 'Not an address'"), toNobody.status < 500 && toTestBox.ok, count("test_inbox WHERE address = 'e2e-zzzzzzzz@doedesk.com'"), count("contact_mail WHERE subject = 'A test message'")], [200, 2, 0, true, 1, 0]);
    const overview = await call("GET", "/admin", { headers: admin });
    expect("mail: the dashboard shows how many are unread, on every page", overview.text.includes('>Mail<span class="badge">3</span></a>') && (await call("GET", "/admin/accounts", { headers: admin })).text.includes('>Mail<span class="badge">3</span></a>'), overview.text.match(/Mail[^<]*<[^>]+>[^<]*/)?.[0]);
    const inbox = await call("GET", "/admin/mail", { headers: admin });
    expect("mail: the list names each message and whether it was forwarded", inbox.status === 200 && inbox.text.includes("Please delete my account") && inbox.text.includes("3 unread") && inbox.text.includes(`/admin/mail/${received.id}`), inbox.text.slice(0, 300));
    const stateOf = (page, mailId) => new RegExp(`<tr class="[^"]*" data-state="([^"]*)"><td class="who">(?:<i [^>]*></i>)?<a href="/admin/mail/${mailId}">`).exec(page)?.[1];
    expect("mail: each row carries its state for the list's filter, which is offered with a box to type in", stateOf(inbox.text, received.id) === "unread open" && ["", "unread", "open", "closed"].every((state) => inbox.text.includes(`data-show="${state}"`)) && inbox.text.includes('aria-label="Filter mail"'), stateOf(inbox.text, received.id));
    const message = await call("GET", `/admin/mail/${received.id}`, { headers: admin });
    expect("mail: opening a message shows its text, decoded, and marks it read", message.status === 200 && message.text.includes("My address is writer@elsewhere.example ✓") && service.query("SELECT read_at FROM contact_mail WHERE id = ?", received.id)[0].read_at !== null && count("contact_mail WHERE read_at IS NULL") === 2, message.text.slice(0, 400));
    const closed = await adminPost("/admin/mail", { action: "close", id: received.id });
    expect("mail: the owner closes the matter, which starts the twelve months", closed.status === 303 && Math.abs(Date.parse(service.query("SELECT closed_at FROM contact_mail WHERE id = ?", received.id)[0].closed_at) - Date.now()) < 120_000);
    same("mail: a closed message is marked closed in the list, and no longer unread or open", stateOf((await call("GET", "/admin/mail", { headers: admin })).text, received.id), "closed");
    expect("mail: an opened message offers its sender's address to copy", message.text.includes('data-copy="writer@elsewhere.example"'));
    await adminPost("/admin/mail", { action: "read-all" });
    expect("mail: with nothing unread the count goes", count("contact_mail WHERE read_at IS NULL") === 0 && (await call("GET", "/admin", { headers: admin })).text.includes(">Mail</a>"));
    same("mail: an unknown message is not found", (await call("GET", "/admin/mail/nothing-here", { headers: admin })).status, 404);

    // --- The owner's views of acceptance --------------------------------------------------------
    const privacyPage = await call("GET", "/admin/privacy", { headers: admin });
    const acceptedNow = service.query("SELECT COUNT(DISTINCT user_id) AS n FROM acceptances WHERE account_closed_at IS NULL AND user_id IN (SELECT id FROM users)")[0].n;
    expect("privacy page: counts who has accepted, and lists who has not", privacyPage.status === 200 && privacyPage.text.includes(`<h2>Terms accepted</h2><div class="figure">${acceptedNow}</div>`) && privacyPage.text.includes(`<h2>Not accepted</h2><div class="figure">${count("users") - acceptedNow}</div>`) && privacyPage.text.includes("stale@seeded.example") && !privacyPage.text.includes(">bystander@seeded.example<"), privacyPage.text.slice(0, 400));
    expect("privacy page: says what is in force", privacyPage.text.includes("Recorded, not required") && privacyPage.text.includes("1 mailbox") && privacyPage.text.includes("from 2026-11-25") && privacyPage.text.includes("Nowhere"));
    const acceptedAccount = await call("GET", `/admin/accounts/${id("viewed")}`, { headers: admin });
    expect("account page: shows that an account has not accepted, with export and delete", acceptedAccount.status === 200 && acceptedAccount.text.includes("Not accepted") && acceptedAccount.text.includes('name="action" value="export"') && acceptedAccount.text.includes('name="action" value="delete"'), acceptedAccount.text.slice(0, 300));
    expect("account page: deleting asks in a dialog that names the account and wants the word typed", acceptedAccount.text.includes('name="action" value="delete" data-confirm="Delete this account?" data-detail="viewed@seeded.example" data-word="DELETE"') && acceptedAccount.text.includes('<dialog id="confirm"'), acceptedAccount.text.match(/value="delete"[^>]*/)?.[0]);
    expect("account page: the account's identifier and address can each be copied", acceptedAccount.text.includes(`data-copy="${id("viewed")}"`) && acceptedAccount.text.includes('data-copy="viewed@seeded.example"'));
    await call("POST", "/v1/me/acceptance", { body: { acceptance: ACCEPTANCE }, token: token("viewed") });
    expect("account page: shows the version accepted, and the record", (await call("GET", `/admin/accounts/${id("viewed")}`, { headers: admin })).text.match(/Accepted 1\.3 on \d+ \w+ \d{4}/) !== null);

    // --- A request that came by mail: export, then deletion, with a confirmation step ------------
    const byMail = id("by-mail");
    const ownerCopy = await adminPost("/admin/rights", { action: "export", account: byMail });
    expect("owner export: a file, never cached, with everything held about the account", ownerCopy.status === 200 && ownerCopy.headers.get("content-disposition") === `attachment; filename="doedesk-account-${byMail.slice(0, 8)}.json"` && ownerCopy.headers.get("cache-control") === "no-store" && ownerCopy.json?.account?.email === "by-mail@seeded.example" && ownerCopy.json.onboardingAnswers.field === "finance" && ownerCopy.json.usage.daily.length === 1 && ownerCopy.json.usage.monthly.length === 1 && ownerCopy.json.termsAcceptance.history.length === 1 && ownerCopy.json.signIns.length === 1, ownerCopy.text.slice(0, 300));
    const asked = await adminPost("/admin/rights", { action: "delete", account: byMail });
    expect("owner delete: first it asks, naming the account and what goes", asked.status === 200 && asked.text.includes("Delete this account?") && asked.text.includes("by-mail@seeded.example") && asked.text.includes("Type DELETE") && count("users WHERE id = ?", byMail) === 1, asked.text.slice(0, 300));
    const mistyped = await adminPost("/admin/rights", { action: "delete", account: byMail, confirm: "delete" });
    expect("owner delete: without the exact word nothing is deleted", mistyped.text.includes("Delete this account?") && count("users WHERE id = ?", byMail) === 1);
    const ownerBefore = { users: count("users"), sessions: count("sessions WHERE user_id <> ?", byMail), daily: count("usage_daily WHERE user_id <> ?", byMail), monthly: count("usage WHERE user_id <> ?", byMail) };
    const done = await adminPost("/admin/rights", { action: "delete", account: byMail, confirm: "DELETE" });
    same("owner delete: with it, the account and all its rows go, and only they", [done.status, done.text.includes("Account deleted"), count("users WHERE id = ?", byMail), count("sessions WHERE user_id = ?", byMail), count("usage_daily WHERE user_id = ?", byMail), count("usage WHERE user_id = ?", byMail), { users: count("users") + 1, sessions: count("sessions"), daily: count("usage_daily"), monthly: count("usage") }], [200, true, 0, 0, 0, 0, ownerBefore]);
    same("owner delete: the proof of acceptance stays, stamped", count("acceptances WHERE user_id = ? AND account_closed_at IS NOT NULL AND country IS NULL", byMail), 1);
    const twice = await adminPost("/admin/rights", { action: "delete", account: byMail, confirm: "DELETE" });
    same("owner delete: asked again, it reports that there is no such account", twice.status, 404);
    same("owner: both requests are in the log as handled by mail, and the repeat as not found", service.query("SELECT type, channel, outcome FROM rights_requests WHERE account_id = ? ORDER BY handled_at", byMail).map((row) => Object.values(row).join(" ")), ["access email done", "deletion email done", "deletion email not_found"]);
    await adminPost("/admin/rights", { action: "log", type: "correction", outcome: "refused" });
    const logged = await call("GET", "/admin/privacy", { headers: admin });
    expect("owner: a request answered by hand can be added, and the page lists the log without any content", service.query("SELECT type, channel, outcome, account_id FROM rights_requests WHERE type = 'correction'").map((row) => Object.values(row).join(" ")).join() === "correction email refused " && logged.text.includes('<td>correction</td><td>Mail</td><td class="keep"><i class="dot bad"></i>refused</td>') && logged.text.includes('aria-label="Filter requests"') && logged.text.includes(`<code>${byMail.slice(0, 8)}</code>`) && !logged.text.includes("by-mail@seeded.example"), logged.text.slice(0, 200));
    same("owner: an identifier that is not one is not found", (await adminPost("/admin/rights", { action: "export", account: "not-an-id" })).status, 404);

    // Usage data, by the installation identifier a person quotes.
    const usageCopy = await adminPost("/admin/rights", { action: "usage-export", installation: install });
    same("usage data by identifier: export gives the events, the choices and the error reports", [usageCopy.status, usageCopy.json?.events?.length, usageCopy.json?.choices?.length, usageCopy.json?.errorReports?.length, usageCopy.json?.events?.[0]?.properties?.installId], [200, 3, 2, 1, install]);
    const usageAsked = await adminPost("/admin/rights", { action: "usage-delete", installation: install });
    expect("usage data by identifier: deletion asks first, with the counts", usageAsked.text.includes("3 events") && usageAsked.text.includes("2 records of the choice") && count("events WHERE install_id = ?", install) === 3, usageAsked.text.slice(0, 200));
    const otherEvents = count("events WHERE install_id <> ? OR install_id IS NULL", install);
    await adminPost("/admin/rights", { action: "usage-delete", installation: install, confirm: "DELETE" });
    same("usage data by identifier: then everything under it goes, and nothing else", [count("events WHERE install_id = ?", install), count("usage_data_choices WHERE install_id = ?", install), count("crash_reports WHERE install_id = ?", install), count("events")], [0, 0, 0, otherEvents]);
    same("usage data by identifier: something that is not an identifier is refused", (await adminPost("/admin/rights", { action: "usage-delete", installation: "someone@example.com", confirm: "DELETE" })).status, 400);

    // --- One-off: usage events collected under the old identifiers -------------------------------
    const dry = async (query) => (await call("GET", `/admin/maintenance/usage-events?${query}`, { headers: admin })).json;
    const uuids = (where) => service.query(`SELECT uuid FROM events WHERE ${where} ORDER BY uuid`).map((row) => row.uuid);
    const eventsBefore = count("events");
    const providerDry = await dry("scope=provider");
    same("old identifiers: the dry run counts the events that hold an account-derived value, and deletes nothing", [providerDry.applied, providerDry.events, providerDry.eventsInTable, count("events")], [false, 4, eventsBefore, eventsBefore]);
    const legacyDry = await dry("scope=legacy");
    same("old identifiers: every event from before the random identifier is told apart by its form", [legacyDry.events, uuids("length(install_id) = 36")], [eventsBefore - 1, ["event-new-app"]]);
    same("old identifiers: deleting needs the word", [(await adminPost("/admin/maintenance/usage-events", { scope: "provider" })).status, count("events")], [400, eventsBefore]);
    same("old identifiers: a scope is needed, and a day for 'before'", [(await call("GET", "/admin/maintenance/usage-events", { headers: admin })).status, (await call("GET", "/admin/maintenance/usage-events?scope=before", { headers: admin })).status], [400, 400]);
    const providerRun = await adminPost("/admin/maintenance/usage-events", { scope: "provider", confirm: "DELETE" });
    same("old identifiers: 'provider' removes exactly the rows with an account-derived value", [providerRun.json?.applied, providerRun.json?.events, uuids("uuid LIKE 'event-%'")], [true, 4, ["event-ancient", "event-new-app", "event-plain-old-app"]]);
    const beforeRun = await adminPost("/admin/maintenance/usage-events", { scope: "before", before: dayOf(daysAgo(380)), confirm: "DELETE" });
    same("old identifiers: 'before' removes every event before the day given", [beforeRun.json?.events, beforeRun.json?.before, uuids("uuid LIKE 'event-%'")], [1, dayOf(daysAgo(380)), ["event-new-app", "event-plain-old-app"]]);
    await adminPost("/admin/maintenance/usage-events", { scope: "legacy", confirm: "DELETE" });
    same("old identifiers: 'legacy' leaves only events under a random identifier", [uuids("1 = 1"), (await dry("scope=legacy")).events], [["event-new-app"], 0]);
    // Two events under a random identifier, either side of 400 days, for the nightly job below.
    await batch([newItem("night-past", { timestamp: daysAgo(401).toISOString() }), newItem("night-kept", { timestamp: daysAgo(400).toISOString() })]);

    // --- Sign-ins expire ------------------------------------------------------------------------
    same("sign-ins: one unused for twelve months is refused before the nightly job has run; one used a day inside is not", [(await call("GET", "/v1/me", { token: token("idle-expired") })).status, (await call("GET", "/v1/me", { token: token("idle-alive") })).status], [401, 200]);
    expect("sign-ins: using one moves its date forward", Date.parse(service.query("SELECT last_used_at FROM sessions WHERE token_hash = ?", sha256Hex(token("idle-alive")))[0].last_used_at) > Date.now() - 120_000);
    const leaving = await signIn("leaving@person.example");
    mustNotBeLogged.add("leaving@person.example").add(leaving.accountId).add(leaving.token);
    await call("POST", "/v1/auth/sign-out", { token: leaving.token });
    expect("sign-ins: signing out leaves the account the date it was last used", Math.abs(Date.parse(service.query("SELECT last_active_at FROM users WHERE id = ?", leaving.accountId)[0].last_active_at) - Date.now()) < 120_000 && count("sessions WHERE user_id = ?", leaving.accountId) === 0);

    // --- The nightly job: exactly what is past its time -----------------------------------------
    // `idle-alive` was used a moment ago, so its place at the boundary is taken by a fresh row.
    const expectDeleted = {
      sign_in_attempts: ["attempt-past"],
      sessions: [sha256Hex(token("idle-expired")), sha256Hex(token("old-with-idle-sign-in"))],
      accounts: [id("unused-past"), id("unused-never-signed-in")],
      contact_mail: ["mail-closed-past", "mail-never-closed-past"],
      acceptances: ["acceptance-past"],
      rights_requests: ["request-past"],
      deletion_receipts: ["receipt-past"],
      error_reports: ["crash-past"],
    };
    const report = (await call("GET", "/admin/retention.json", { headers: admin })).json;
    const line = (name) => report.rules.find((item) => item.id === name)?.rows;
    const snapshot = () => JSON.stringify(["users", "sessions", "login_requests", "contact_mail", "acceptances", "rights_requests", "deletion_receipts", "crash_reports", "usage_data_choices", "test_inbox", "usage", "usage_daily"].map((table) => service.query(`SELECT * FROM ${table} ORDER BY 1, 2`)));
    const beforeNight = snapshot();
    same("retention dry run: counts what tonight would delete, per rule", { sign_in_attempts: line("sign_in_attempts"), sessions: line("sessions"), accounts: line("accounts"), contact_mail: line("contact_mail"), acceptances: line("acceptances"), rights_requests: line("rights_requests"), deletion_receipts: line("deletion_receipts"), error_reports: line("error_reports"), usage_data: line("usage_data"), usage_data_choices: line("usage_data_choices"), test_mail: line("test_mail"), counters: line("rate_limit_counters") >= 1 }, { ...Object.fromEntries(Object.entries(expectDeleted).map(([name, list]) => [name, list.length])), usage_data: 1, usage_data_choices: 1, test_mail: 1, counters: true });
    expect("retention dry run: changes nothing, and is marked as not applied", report.applied === false && snapshot() === beforeNight && report.rules.every((item) => typeof item.kept === "string" && typeof item.what === "string"), report);
    expect("retention: the privacy page shows the same table, with each period", (await call("GET", "/admin/privacy", { headers: admin })).text.includes("24 months without use") && privacyPage.text.includes("Due now"));

    const proofBefore = service.query("SELECT user_id, account_closed_at FROM acceptances WHERE user_id = ?", id("unused-past"))[0];
    const night = await call("GET", "/cdn-cgi/handler/scheduled");
    same("retention: the nightly job runs", night.status, 200);
    const ids = (table, column = "id") => service.query(`SELECT ${column} AS v FROM ${table}`).map((row) => row.v);
    same("retention: sign-in attempts go a day after they expire, not before; one for a deleted account goes with it", ids("login_requests").filter((v) => v.startsWith("attempt-")), ["attempt-kept"]);
    same("retention: sign-ins unused for twelve months go; one used a day inside stays", [count("sessions WHERE token_hash IN (?, ?)", ...expectDeleted.sessions), count("sessions WHERE token_hash = ?", sha256Hex(token("idle-alive")))], [0, 1]);
    expect("retention: an account whose sign-in went keeps the date it was last used", Math.abs(Date.parse(service.query("SELECT last_active_at FROM users WHERE id = ?", id("old-with-idle-sign-in"))[0].last_active_at) - monthsAgo(13).getTime()) < 1000);
    same("retention: accounts unused for 24 months go, with their rows", ["unused-past", "unused-never-signed-in"].map((name) => count("users WHERE id = ?", id(name)) + count("usage WHERE user_id = ?", id(name)) + count("sessions WHERE user_id = ?", id(name))), [0, 0]);
    same("retention: accounts a day inside, or used since, stay", ["unused-not-yet", "new-never-signed-in", "old-with-idle-sign-in", "old-with-metered-day", "bystander", "stale", "idle"].map((name) => count("users WHERE id = ?", id(name))), [1, 1, 1, 1, 1, 1, 1]);
    const proofAfter = service.query("SELECT user_id, account_closed_at, country FROM acceptances WHERE user_id = ?", id("unused-past"))[0];
    expect("retention: the deleted account's proof of acceptance is kept and stamped", proofBefore.account_closed_at === null && proofAfter.account_closed_at !== null && proofAfter.country === null, proofAfter);
    same("retention: mail goes twelve months after it was closed, or after it closed itself; not before", ids("contact_mail").filter((v) => /closed/.test(v)).sort(), ["mail-closed-kept", "mail-never-closed-kept"]);
    same("retention: proof for accounts deleted five years ago goes; newer proof stays", ids("acceptances").filter((v) => v.startsWith("acceptance-")), ["acceptance-kept"]);
    same("retention: the log of requests is kept five years", ids("rights_requests").filter((v) => v.startsWith("request-")), ["request-kept"]);
    same("retention: error reports are kept 180 days, usage events and records of the choice 400", [ids("crash_reports").filter((v) => v.startsWith("crash-")), ids("events", "uuid").filter((v) => v.startsWith("sent-night-")), ids("usage_data_choices", "install_id").filter((v) => v === "past" || v === "kept")], [["crash-kept"], ["sent-night-kept"], ["kept"]]);
    same("retention: an ended confirmation goes, a test message goes after a day, old counters go and the SMS count stays", [ids("deletion_receipts", "token_hash").filter((v) => v.startsWith("receipt-")), service.query("SELECT raw FROM test_inbox WHERE address = 'e2e-abcdefgh@doedesk.com'").map((row) => row.raw), count("rate_limits WHERE key = 'mail:ip:203.0.113.9:3600'"), count("rate_limits WHERE key = 'sms:all:86400' AND count = 7")], [["receipt-kept"], ["new"], 1, 1]);
    same("retention: the bystander's account, sign-in, usage and acceptance are untouched", [count("sessions WHERE user_id = ?", id("bystander")), count("usage_daily WHERE user_id = ?", id("bystander")), count("usage WHERE user_id = ?", id("bystander")), count("acceptances WHERE user_id = ? AND account_closed_at IS NULL", id("bystander"))], [1, 1, 1, 1]);
    const afterNight = snapshot();
    await call("GET", "/cdn-cgi/handler/scheduled");
    const secondReport = (await call("GET", "/admin/retention.json", { headers: admin })).json;
    expect("retention: running it again changes nothing, and the dry run then counts nothing", snapshot() === afterNight && secondReport.rules.every((item) => item.rows === 0 || item.id === "rate_limit_counters"), secondReport.rules.filter((item) => item.rows !== 0));
    const runNow = await adminPost("/admin/retention", { confirm: "RUN" });
    const unconfirmed = await adminPost("/admin/retention", { confirm: "" });
    same("retention: the owner can run it from the page, with the word; without it nothing runs", [runNow.status, runNow.text.includes("Removed just now"), unconfirmed.status], [200, true, 400]);
    expect("retention: without the word the page asks for it, and the page's button asks in a dialog", unconfirmed.text.includes('action="/admin/retention"') && unconfirmed.text.includes('placeholder="Type RUN"') && (await call("GET", "/admin/privacy", { headers: admin })).text.includes('data-confirm="Run retention now?" data-word="RUN"'), unconfirmed.text.slice(-400));

    // --- Nothing that names an account reaches the log ------------------------------------------
    const log = service.log();
    const leaked = [...mustNotBeLogged].filter((value) => typeof value === "string" && value.length > 0 && log.includes(value));
    expect(`log: none of ${mustNotBeLogged.size} addresses, numbers, account identifiers, tokens and link secrets appears in it`, mustNotBeLogged.size >= 20 && leaked.length === 0, leaked);
    expect("log: the same holds for the owner's actions on an account, which travel in a form body", !log.includes(byMail) && !log.includes("by-mail@seeded.example") && !log.includes(install), null);
    expect("log: the nightly job wrote counts only", /retention sign_in_attempts=\d+ /.test(log) && log.includes("accounts=2"), log.match(/retention [^\n]*/)?.[0]);
  } finally {
    await service.stop();
  }
}

// ================================================================================================
// Second copy: acceptance required for everything, new accounts refused from some places, only
// random usage-data identifiers taken, and mail forwarding not set.
// ================================================================================================
{
  const seedB = [
    insert("users", [user("before-terms"), user("abroad", { email: "abroad@seeded.example" }), user("leaver"), user("phone-leaver", { email: null, phone: "+966500007002", signup_method: "phone" })]),
    insert("sessions", [session("before-terms"), session("leaver")]),
  ].join("\n");
  const service = await startLocalService({
    seedSql: seedB,
    vars: { WORKER_OPEN: "1", REQUIRE_ACCEPTANCE: "all", SIGNUP_BLOCKED_COUNTRIES: "IR, kp,UA-43", SIGNUP_BLOCK_EU_UK: "1", USAGE_DATA_RANDOM_IDENTIFIERS_ONLY: "1" },
  });
  const { call, admin, count, signIn, sendMail } = against(service);
  try {
    same("required: the public versions say so", (await call("GET", "/v1/legal")).json?.acceptance, { requiredToSignIn: true, requiredToUse: true });

    // --- No sign-in without acceptance ----------------------------------------------------------
    const refusedEmail = await call("POST", "/v1/auth/email/start", { body: { email: "no.tick@person.example", client: "desktop" }, headers: from("SA") });
    const refusedPhone = await call("POST", "/v1/auth/phone/start", { body: { phone: "0500007001" }, headers: from("SA") });
    same("required: starting without an acceptance is refused, by email and by phone, with the versions to show", [refusedEmail.status, refusedEmail.json?.error?.code, refusedEmail.json?.error?.legal?.terms?.version, refusedPhone.status, refusedPhone.json?.error?.code], [400, "terms_required", "1.3", 400, "terms_required"]);
    same("required: a refused start leaves no attempt, no account and no counter", [count("login_requests"), count("users WHERE email = 'no.tick@person.example'"), count("rate_limits WHERE key LIKE 'mail:to:%' OR key LIKE 'sms:%'")], [0, 0, 0]);
    const accepted = await signIn("ticked@person.example", { acceptance: ACCEPTANCE, headers: from("SA") });
    expect("required: with it, the account is made and the acceptance recorded", accepted.poll?.json?.created === true && accepted.poll.json.acceptance?.outstanding === false && count("acceptances WHERE user_id = ?", accepted.accountId) === 1, accepted.poll ?? accepted.start);
    same("required: an account that accepted can use the service", (await call("POST", "/v1/detect", { body: { texts: ["Jane Doe"] }, token: accepted.token })).status, 200);

    // --- An account from before the Terms -------------------------------------------------------
    const early = token("before-terms");
    const earlyMe = await call("GET", "/v1/me", { token: early });
    same("required: an earlier account can still read its state, which says it is paused", [earlyMe.status, earlyMe.json?.acceptance?.outstanding, earlyMe.json?.acceptance?.blocked], [200, true, true]);
    const pausedText = await call("POST", "/v1/detect", { body: { texts: ["Jane Doe"] }, token: early });
    const pausedFile = await call("POST", "/v1/ocr", { raw: Buffer.from("%PDF-1.7 pages=1"), token: early, headers: { "content-type": "application/pdf" } });
    const pausedWorker = await call("POST", "/v1/worker/chat/completions", { body: { messages: [{ role: "user", content: "A sealed document." }] }, token: early });
    same("required: detection, reading and the worker are refused for it, with a code the app shows the sheet for", [pausedText.status, pausedText.json?.error?.code, pausedText.json?.error?.legal?.terms?.url?.en, pausedFile.status, pausedFile.json?.error?.code, pausedWorker.status, pausedWorker.json?.error?.code], [403, "terms_update_required", "https://doedesk.com/terms", 403, "terms_update_required", 403, "terms_update_required"]);
    same("required: nothing was sent to the engine or counted for the refused requests", [service.engine.seen.detect.length, service.engine.seen.ocr.length, count("usage_daily WHERE user_id = ?", id("before-terms"))], [1, 0, 0]);
    expect("required: it can still export and delete, which are its rights", (await call("GET", "/v1/me/export", { token: early })).status === 200 && (await call("DELETE", "/v1/me", { token: early })).json?.error?.code === "recent_sign_in_required");

    // --- Leaving without accepting --------------------------------------------------------------
    // The app asks for a new sign-in before it deletes. That sign-in says what it is for, and is
    // let through without an acceptance; it can then do nothing but read, export and delete.
    const plainAgain = await call("POST", "/v1/auth/email/start", { body: { email: "leaver@seeded.example", client: "desktop" }, headers: from("SA") });
    same("leaving: an ordinary sign-in without an acceptance is still refused for that account", [plainAgain.status, plainAgain.json?.error?.code], [400, "terms_required"]);
    const badPurpose = await call("POST", "/v1/auth/email/start", { body: { email: "leaver@seeded.example", client: "desktop", purpose: "anything" }, headers: from("SA") });
    same("leaving: a purpose the service does not know is refused, not ignored", [badPurpose.status, badPurpose.json?.error?.code], [400, "invalid_request"]);
    const leaving = await signIn("leaver@seeded.example", { purpose: "delete_account", headers: from("SA") });
    same("leaving: the sign-in that confirms a deletion needs no acceptance", [leaving.start.status, leaving.poll?.status, leaving.poll?.json?.created, leaving.poll?.json?.account?.id, leaving.poll?.json?.acceptance?.outstanding], [200, 200, false, id("leaver"), true]);
    same("leaving: and records none", count("acceptances WHERE user_id = ?", id("leaver")), 0);
    const limited = leaving.token;
    same(
      "leaving: that sign-in cannot use the service, make another sign-in, mint a token or accept",
      [
        [(await call("POST", "/v1/detect", { body: { texts: ["Jane Doe"] }, token: limited })).json?.error?.code],
        [(await call("POST", "/v1/ocr", { raw: Buffer.from("%PDF-1.7 pages=1"), token: limited, headers: { "content-type": "application/pdf" } })).json?.error?.code],
        [(await call("POST", "/v1/worker/chat/completions", { body: { messages: [{ role: "user", content: "A sealed document." }] }, token: limited })).json?.error?.code],
        [(await call("POST", "/v1/auth/sessions", { body: { client: "web" }, token: limited })).json?.error?.code],
        [(await call("POST", "/v1/auth/token", { body: { audience: "doedesk-relay" }, token: limited })).json?.error?.code],
        [(await call("POST", "/v1/me/acceptance", { body: { acceptance: ACCEPTANCE }, token: limited })).json?.error?.code],
        [(await call("POST", "/v1/me/profile", { body: { field: "legal" }, token: limited })).json?.error?.code],
      ].flat(),
      Array(7).fill("deletion_only_sign_in"),
    );
    same("leaving: it can read the account and export it", [(await call("GET", "/v1/me", { token: limited })).status, (await call("GET", "/v1/me/export", { token: limited })).status], [200, 200]);
    same("leaving: the account's older sign-in, which is not fresh, still cannot delete", (await call("DELETE", "/v1/me", { token: token("leaver") })).json?.error?.code, "recent_sign_in_required");
    const left = await call("DELETE", "/v1/me", { token: limited });
    same("leaving: it deletes the account, which never accepted", [left.status, left.json?.deleted, left.json?.accountId, count("users WHERE id = ?", id("leaver")), count("sessions WHERE user_id = ?", id("leaver")), count("login_requests WHERE identifier = 'leaver@seeded.example'")], [200, true, id("leaver"), 0, 0, 0]);
    const phoneLeaving = await call("POST", "/v1/auth/phone/start", { body: { phone: "0500007002", client: "desktop", purpose: "delete_account" }, headers: from("SA") });
    const phoneLeft = await call("POST", "/v1/auth/phone/verify", { body: { requestId: phoneLeaving.json?.requestId, code: phoneLeaving.json?.testCode } });
    const phoneDeleted = await call("DELETE", "/v1/me", { token: phoneLeft.json?.token });
    same("leaving: the same by phone", [phoneLeaving.status, phoneLeft.status, phoneLeft.json?.created, phoneDeleted.status, phoneDeleted.json?.accountId, count("users WHERE id = ?", id("phone-leaver"))], [200, 200, false, 200, id("phone-leaver"), 0]);
    const nobody = await signIn("nobody.here@person.example", { purpose: "delete_account", headers: from("SA") });
    same("leaving: such a sign-in never makes an account", [nobody.start.status, nobody.poll?.status, nobody.poll?.json?.error?.code, nobody.token, count("users WHERE email = 'nobody.here@person.example'"), count("sessions WHERE purpose IS NOT NULL")], [200, 404, "no_account", undefined, 0, 0]);

    const resumed = await call("POST", "/v1/me/acceptance", { body: { acceptance: ACCEPTANCE }, token: early });
    same("required: once it accepts in the app, the service answers again", [resumed.status, resumed.json?.acceptance?.blocked, (await call("POST", "/v1/detect", { body: { texts: ["Jane Doe"] }, token: early })).status], [200, false, 200]);

    // --- New accounts by country ----------------------------------------------------------------
    const signUpFrom = async (country, region) => (await call("GET", "/v1/auth/options", { headers: from(country, region) })).json?.signUp?.available;
    same("sign-up by country: the options say where an account cannot be made", { IR: await signUpFrom("IR"), KP: await signUpFrom("KP"), DE: await signUpFrom("DE"), GB: await signUpFrom("GB"), NO: await signUpFrom("NO"), crimea: await signUpFrom("UA", "43"), kyiv: await signUpFrom("UA", "30"), ukraine: await signUpFrom("UA"), SA: await signUpFrom("SA"), US: await signUpFrom("US"), CH: await signUpFrom("CH"), unknown: await signUpFrom(""), tor: await signUpFrom("T1") }, { IR: false, KP: false, DE: false, GB: false, NO: false, crimea: false, kyiv: true, ukraine: true, SA: true, US: true, CH: true, unknown: true, tor: true });
    const blockedOptions = (await call("GET", "/v1/auth/options", { headers: from("IR") })).json;
    expect("sign-up by country: with a message the app can show, and the sign-in methods still listed", blockedOptions.signUp.code === "signup_unavailable" && /cannot be created from your country/.test(blockedOptions.signUp.message) && blockedOptions.methods.includes("email"), blockedOptions);
    let minute = 0;
    const attempt = async (email, country, region) => {
      const result = await signIn(email, { acceptance: ACCEPTANCE, headers: from(country, region) });
      return [result.start.status, result.poll?.status, result.poll?.json?.error?.code ?? result.poll?.json?.status, count("users WHERE email = ?", email)];
    };
    same("sign-up by country: from a listed country the link is sent as usual, and no account comes of it", await attempt("tehran@person.example", "IR"), [200, 403, "signup_unavailable", 0]);
    same("sign-up by country: the same for a listed region of a country", await attempt("crimea@person.example", "UA", "43"), [200, 403, "signup_unavailable", 0]);
    same("sign-up by country: and for the EU, EEA and UK while their switch is on", [await attempt("berlin@person.example", "DE"), await attempt("london@person.example", "GB")], [[200, 403, "signup_unavailable", 0], [200, 403, "signup_unavailable", 0]]);
    same("sign-up by country: no acceptance is recorded for an account that was not made", count("acceptances WHERE login_request_id IN (SELECT id FROM login_requests WHERE signup_block IS NOT NULL)"), 0);
    same("sign-up by country: an account that exists still signs in from there", await attempt("abroad@seeded.example", "IR"), [200, 200, "approved", 1]);
    same("sign-up by country: elsewhere, and where the country is unknown, an account is made", [await attempt("kyiv@person.example", "UA", "30"), await attempt("nowhere@person.example", ""), await attempt("zurich@person.example", "CH")], [[200, 200, "approved", 1], [200, 200, "approved", 1], [200, 200, "approved", 1]]);
    void minute;

    // --- Only random identifiers ----------------------------------------------------------------
    const sent = await call("POST", "/ingest/batch", { body: { api_key: "doedesk-client", batch: [
      { uuid: "b-old", event: "x", distinct_id: "a".repeat(64), properties: { installId: "a".repeat(64) } },
      { uuid: "b-new", event: "x", distinct_id: "0f8fad5b-d9cb-469f-a165-70867728950e", properties: { installId: "0f8fad5b-d9cb-469f-a165-70867728950e" } },
    ] }, headers: from("SA") });
    same("random identifiers only: an event under the old form is no longer stored", [sent.json, service.query("SELECT uuid FROM events").map((row) => row.uuid)], [{ status: 1, stored: 1, dropped: 1 }, ["b-new"]]);

    // --- Mail without a mailbox to forward to ---------------------------------------------------
    await sendMail("hello@doedesk.com", "Hello there");
    const kept = service.query("SELECT forwarded_at, forward_error FROM contact_mail")[0];
    const privacyPage = await call("GET", "/admin/privacy", { headers: admin });
    expect("mail: with no mailbox set the message is kept, marked as not forwarded, and the dashboard says so", kept?.forwarded_at === null && kept.forward_error === "MAIL_FORWARD_TO is not set" && !service.log().includes("rcptTo:") && privacyPage.text.includes('Set MAIL_FORWARD_TO.">Off</span>') && (await call("GET", "/admin/mail", { headers: admin })).text.includes("Forwarding off"), kept);
    expect("privacy page: shows the switches in force", privacyPage.text.includes("Required for sign-in and use") && privacyPage.text.includes("IR, KP, UA-43 · EU, EEA and UK") && privacyPage.text.includes("Random only") && privacyPage.text.includes("Blocked until accepted"));
  } finally {
    await service.stop();
  }
}

console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
