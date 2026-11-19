// Proves usage metering end to end on this machine:
//   - detection and reading write the right daily rows, and the monthly totals follow;
//   - the allowance refuses at the right point, counting old monthly totals and daily rows together;
//   - the nightly job rolls old days into monthly totals without changing a month's total;
//   - the owner's views render with data for many accounts, and their CSV exports are correct;
//   - none of it can be reached without the admin key.
//
//   node test/usage-metering.mjs
//
// It starts its own copy of the service on a throwaway database, with a stand-in for the engine
// (see local-service.mjs). No real engine is called.
import { client, ENGINE_TOKEN, engineUnits, sha256Hex, startLocalService } from "./local-service.mjs";
import { COUNTERS, dayOf, monthOf, sampleData, sampleSql } from "./usage-sample.mjs";

// The engine's prices the service is given in its settings, for the dashboard's estimate (src/cost.ts).
const PRICES = { ENGINE_PRICE_PER_1000_UNITS: "1.0", ENGINE_PRICE_PER_1000_PAGES: "1.5" };
const USD_PER_UNIT = 1.0 / 1000;
const USD_PER_PAGE = 1.5 / 1000;
const CHARACTER_ALLOWANCE = 3_000_000;
const PAGE_ALLOWANCE = 200;

let failures = 0;
const expect = (label, condition, detail = null) => {
  if (!condition) failures += 1;
  console.log(`${condition ? "ok  " : "FAIL"} ${label}${condition ? "" : ` -> ${JSON.stringify(detail)?.slice(0, 600)}`}`);
};
const same = (label, actual, expected) => expect(label, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });

// --- What goes into the database before the service starts ------------------------------------

const today = dayOf(0);
const thisMonth = monthOf(today);
const lastMonthDay = `${monthOf(new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 15)).toISOString())}-15`;
const oldMonth = monthOf(dayOf(500));
const zero = Object.fromEntries(COUNTERS.map((counter) => [counter, 0]));
const user = (name, extra = {}) => ({
  id: `00000000-0000-4000-a000-${sha256Hex(name).slice(0, 12)}`,
  email: `${name}@test.example`,
  phone: null,
  created_at: new Date(Date.now() - 40 * 86_400_000).toISOString(),
  country: "SA",
  signup_method: "email",
  field: "legal",
  field_other: null,
  workplace: "self",
  profile_at: null,
  ...extra,
});
const token = (name, kind) => `dd_test_${name}_${kind}`;
const session = (person, name, kind) => ({
  token_hash: sha256Hex(token(name, kind)),
  user_id: person.id,
  client: kind,
  device: "test",
  created_at: person.created_at,
  // Used today already, so signing in adds no write of its own to what the tests count.
  last_used_at: new Date().toISOString(),
});

const metered = user("metered");
const nearText = user("near-text");
const nearPages = user("near-pages");
const fresh = user("fresh-month");
const rolled = user("rolled");
const formula = user("formula", { email: "=1+1@evil.example", field: "other", field_other: 'Notary, "private"' });
const plus = user("plus", { email: "+first@evil.example" });

const data = sampleData();
data.users.push(metered, nearText, nearPages, fresh, rolled, formula, plus);
data.sessions.push(
  session(metered, "metered", "desktop"),
  session(metered, "metered", "mobile"),
  session(nearText, "near-text", "server"),
  session(nearPages, "near-pages", "desktop"),
  session(fresh, "fresh-month", "desktop"),
);
data.daily.push(
  // 500 characters today, on top of the monthly total below.
  { user_id: nearText.id, day: today, client: "server", ...zero, detect_requests: 1, detect_texts: 1, detect_characters: 500, detect_records: 1 },
  // 199 pages this month, across two clients.
  { user_id: nearPages.id, day: today, client: "desktop", ...zero, ocr_files: 30, ocr_pages: 120, ocr_bytes: 9_000_000 },
  { user_id: nearPages.id, day: today, client: "mobile", ...zero, ocr_files: 20, ocr_pages: 79, ocr_bytes: 5_000_000 },
  // The whole allowance, last month.
  { user_id: fresh.id, day: lastMonthDay, client: "desktop", ...zero, detect_requests: 900, detect_texts: 900, detect_characters: CHARACTER_ALLOWANCE, detect_records: 3900, ocr_files: 40, ocr_pages: PAGE_ALLOWANCE },
  // Days old enough to be rolled up, in one month, and one day that is not.
  { user_id: rolled.id, day: `${oldMonth}-10`, client: "desktop", ...zero, detect_requests: 3, detect_texts: 9, detect_characters: 7000, detect_records: 12, detect_entities: 40, detect_failed: 1 },
  { user_id: rolled.id, day: `${oldMonth}-10`, client: "mobile", ...zero, ocr_files: 2, ocr_pages: 11, ocr_bytes: 900_000, ocr_pdf_files: 1, ocr_pdf_pages: 10, ocr_pdf_bytes: 800_000 },
  { user_id: rolled.id, day: `${oldMonth}-11`, client: "desktop", ...zero, detect_requests: 1, detect_texts: 2, detect_characters: 300, detect_records: 2, ocr_refused: 4 },
  { user_id: rolled.id, day: dayOf(399), client: "desktop", ...zero, detect_requests: 1, detect_texts: 1, detect_characters: 50, detect_records: 1 },
);
data.monthly.push(
  // A total written the old way: the two original columns only, as the Worker before this change did.
  { user_id: nearText.id, month: thisMonth, ...zero, detect_characters: 2_999_000, ocr_pages: 3 },
  { user_id: rolled.id, month: oldMonth, ...zero, detect_characters: 1000, detect_records: 1, ocr_pages: 5 },
);

const service = await startLocalService({ seedSql: sampleSql(data), vars: PRICES });
const call = client(service.base);
const admin = { authorization: `Bearer ${service.adminKey}` };
const dailyRow = (userId, clientName, day = today) =>
  service.query("SELECT * FROM usage_daily WHERE user_id = ? AND day = ? AND client = ?", userId, day, clientName)[0];
const counters = (row) => Object.fromEntries(COUNTERS.map((counter) => [counter, row?.[counter] ?? 0]));
const counted = (extra) => ({ ...zero, ...extra });

try {
  // --- Nobody but the owner ---------------------------------------------------------------------
  const someone = data.users[0];
  const privatePaths = [
    "/admin/accounts",
    "/admin/accounts.csv",
    `/admin/accounts/${someone.id}`,
    `/admin/accounts/${someone.id}.csv`,
    "/admin/distribution",
  ];
  const leaks = (text) => text.includes(someone.email) || text.includes(someone.id) || /@[a-z-]+\.(sa|com|org)/.test(text);
  for (const path of privatePaths) {
    const bare = await call("GET", path);
    expect(`no key: ${path} refused`, bare.status === 401 && !leaks(bare.text), bare);
    const asUser = await call("GET", path, { token: token("metered", "desktop") });
    expect(`an account's own session: ${path} refused`, asUser.status === 401 && !leaks(asUser.text), asUser);
    const wrong = await call("GET", path, { token: `${service.adminKey}x` });
    expect(`wrong key: ${path} refused`, wrong.status === 401 && !leaks(wrong.text), wrong);
  }
  const form = (fields) => ({ raw: new URLSearchParams(fields).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
  for (const path of ["/admin/accounts", "/admin/accounts.csv"]) {
    const posted = await call("POST", path, form({ q: someone.email }));
    expect(`no key: search posted to ${path} refused`, posted.status === 401 && !leaks(posted.text), posted);
  }
  const badCookie = await call("GET", "/admin/accounts", { headers: { cookie: "dd_admin=0000" } });
  expect("forged cookie refused", badCookie.status === 401, badCookie);

  // --- Detection ---------------------------------------------------------------------------------
  const desktop = token("metered", "desktop");
  const mobile = token("metered", "mobile");
  const long = `${"x".repeat(2500)} Jane Doe`;
  const texts = ["Jane Doe wrote to jane@example.com on 2026-01-02, perhaps Smith too.", "", long];
  const first = await call("POST", "/v1/detect", { body: { texts }, token: desktop });
  same("detection answers one result per text", first.json?.results?.map((result) => result.entities.map((entity) => entity.kind)), [
    ["PERSON", "EMAIL"],
    [],
    ["PERSON"],
  ]);
  const firstCharacters = texts.reduce((total, text) => total + text.length, 0);
  same(
    "detection: requests, texts, characters, engine units and entities are counted",
    counters(dailyRow(metered.id, "desktop")),
    counted({ detect_requests: 1, detect_texts: 3, detect_characters: firstCharacters, detect_records: engineUnits([texts[0], long]), detect_entities: 3 }),
  );
  expect("engine units are what the engine reports, not characters", engineUnits([texts[0], long]) === 4);
  same("the engine is sent the texts in one call, without the empty one", service.engine.seen.detect.at(-1), [texts[0], long]);

  const seven = Array.from({ length: 7 }, (_, index) => `Text ${index} about Jane Doe. ${"y".repeat(index * 400)}`);
  const callsBefore = service.engine.seen.detect.length;
  const second = await call("POST", "/v1/detect", { body: { texts: seven }, token: mobile });
  expect("seven texts go to the engine as one call", second.status === 200 && service.engine.seen.detect.length - callsBefore === 1 && service.engine.seen.detect.at(-1)?.length === 7, second);
  same(
    "a second client of the same account gets its own row",
    counters(dailyRow(metered.id, "mobile")),
    counted({
      detect_requests: 1,
      detect_texts: 7,
      detect_characters: seven.reduce((total, text) => total + text.length, 0),
      detect_records: engineUnits(seven),
      detect_entities: 7,
    }),
  );
  same("…and the first client's row is untouched", counters(dailyRow(metered.id, "desktop")).detect_requests, 1);

  const unreported = `[[no-count]] ${"z".repeat(1490)}`;
  await call("POST", "/v1/detect", { body: { texts: [unreported] }, token: desktop });
  same(
    "when the engine does not report its units, each text counts as one",
    counters(dailyRow(metered.id, "desktop")).detect_records,
    4 + 1,
  );

  let expected = counters(dailyRow(metered.id, "desktop"));
  const tooMany = await call("POST", "/v1/detect", { body: { texts: Array.from({ length: 26 }, () => "a") }, token: desktop });
  expected = { ...expected, detect_too_large: 1 };
  expect("too many texts are refused", tooMany.status === 413, tooMany);
  same("…and counted as too large, with nothing else added", counters(dailyRow(metered.id, "desktop")), expected);

  const partFails = [...Array.from({ length: 5 }, () => "Fine. Jane Doe."), "[[used-then-failed]] this one fails"];
  const failed = await call("POST", "/v1/detect", { body: { texts: partFails }, token: desktop });
  // The stand-in reports 3 engine units for the call it failed.
  expected = { ...expected, detect_failed: 1, detect_records: expected.detect_records + 3 };
  expect("an engine failure is passed on", failed.status === 502 && failed.json?.error?.code === "detector_failed", failed);
  same("…counted as failed, with the units the engine reports it used, and no characters", counters(dailyRow(metered.id, "desktop")), expected);

  const invalid = await call("POST", "/v1/detect", { body: { texts: "not a list" }, token: desktop });
  expect("a malformed request is refused and not counted", invalid.status === 400, invalid);
  same("…row unchanged", counters(dailyRow(metered.id, "desktop")), expected);
  const anonymous = await call("POST", "/v1/detect", { body: { texts: ["Jane Doe"] } });
  expect("detection needs a sign-in", anonymous.status === 401, anonymous);

  // --- Reading -----------------------------------------------------------------------------------
  const send = (bytes, type, as = desktop) => call("POST", "/v1/ocr", { raw: bytes, token: as, headers: { "content-type": type } });
  const pdf = Buffer.from(`%PDF-1.7 pages=3 ${"p".repeat(5000)}`, "latin1");
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(3000, 7)]);
  const readPdf = await send(pdf, "application/pdf");
  expect("a PDF is read", readPdf.status === 200 && readPdf.json?.pages === 3, readPdf);
  expected = { ...expected, ocr_files: 1, ocr_pages: 3, ocr_bytes: pdf.length, ocr_pdf_files: 1, ocr_pdf_pages: 3, ocr_pdf_bytes: pdf.length };
  same("reading a PDF: file, pages and bytes are counted, and as PDF", counters(dailyRow(metered.id, "desktop")), expected);

  const readPng = await send(png, "image/png");
  expect("an image is read", readPng.status === 200 && readPng.json?.pages === 1, readPng);
  expected = { ...expected, ocr_files: 2, ocr_pages: 4, ocr_bytes: pdf.length + png.length };
  same("reading an image adds to the totals and not to the PDF part", counters(dailyRow(metered.id, "desktop")), expected);

  const mislabelled = await send(Buffer.from("%PDF-1.4 pages=2", "latin1"), "application/octet-stream");
  expect("a PDF sent without its media type is read", mislabelled.status === 200 && mislabelled.json?.pages === 2, mislabelled);
  expected = { ...expected, ocr_files: 3, ocr_pages: 6, ocr_bytes: expected.ocr_bytes + 16, ocr_pdf_files: 2, ocr_pdf_pages: 5, ocr_pdf_bytes: pdf.length + 16 };
  same("…and is still counted as a PDF, by its first bytes", counters(dailyRow(metered.id, "desktop")), expected);

  const unreadable = await send(Buffer.from("%PDF-1.7 [[unreadable]]", "latin1"), "application/pdf");
  const readerDown = await send(Buffer.from("[[reader-down]]", "latin1"), "image/jpeg");
  expected = { ...expected, ocr_failed: 2 };
  expect("a file the reader cannot read, and a reader that is down, are passed on", unreadable.status === 422 && readerDown.status === 502, { unreadable, readerDown });
  same("…both counted as failed, with no pages", counters(dailyRow(metered.id, "desktop")), expected);

  const empty = await send(Buffer.alloc(0), "application/pdf");
  expect("an empty body is refused and not counted", empty.status === 413, empty);
  const huge = await send(Buffer.alloc(20 * 1024 * 1024 + 1, 1), "image/png");
  expected = { ...expected, ocr_too_large: 1 };
  expect("a file over 20 MB is refused", huge.status === 413, { status: huge.status, text: huge.text.slice(0, 200) });
  same("…and counted as too large", counters(dailyRow(metered.id, "desktop")), expected);

  // --- What the app is told ------------------------------------------------------------------------
  const me = await call("GET", "/v1/me", { token: desktop });
  const mobileRow = counters(dailyRow(metered.id, "mobile"));
  same("the account's own view: this month's totals across its clients", me.json?.usage, {
    month: thisMonth,
    detectCharacters: expected.detect_characters + mobileRow.detect_characters,
    ocrPages: expected.ocr_pages,
    detectRequests: expected.detect_requests + mobileRow.detect_requests,
    ocrFiles: expected.ocr_files,
  });
  const resets = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1)).toISOString();
  same("…and the allowance, with when it starts over", me.json?.allowance, { detectCharacters: CHARACTER_ALLOWANCE, ocrPages: PAGE_ALLOWANCE, resetsAt: resets });
  expect("…with no price in it", !/usd|cost|price|\$/i.test(me.text), me.text);

  // --- A real sign-in carries its client into the meter -------------------------------------------
  const start = await call("POST", "/v1/auth/email/start", { body: { email: "signed-in@test.example", client: "web", device: "Browser" } });
  const link = new URL(start.json.testLink);
  await fetch(`${service.base}/auth/confirm`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ r: link.searchParams.get("r"), t: link.searchParams.get("t") }),
  });
  const signedIn = await call("POST", "/v1/auth/email/poll", { body: { requestId: start.json.requestId, pollSecret: start.json.pollSecret } });
  await call("POST", "/v1/detect", { body: { texts: ["Jane Doe"] }, token: signedIn.json.token });
  same("a session made by signing in is counted under the client it signed in as", counters(dailyRow(signedIn.json.account.id, "web")), counted({ detect_requests: 1, detect_texts: 1, detect_characters: 8, detect_records: engineUnits(["Jane Doe"]), detect_entities: 1 }));

  // --- The allowance -----------------------------------------------------------------------------
  const textToken = token("near-text", "server");
  const of = (length) => ({ body: { texts: ["k".repeat(length)] }, token: textToken });
  // 2,999,000 in the monthly total + 500 today = 2,999,500 used.
  const under = await call("POST", "/v1/detect", of(400));
  const over = await call("POST", "/v1/detect", of(101));
  const exact = await call("POST", "/v1/detect", of(100));
  const full = await call("POST", "/v1/detect", of(1));
  expect("text: 400 more characters fit (2,999,900 of 3,000,000)", under.status === 200, under);
  expect("text: 101 more would pass the allowance and are refused", over.status === 429 && over.json?.error?.code === "quota_exceeded", over);
  expect("text: 100 more reach it exactly and are allowed", exact.status === 200, exact);
  expect("text: one more character is refused", full.status === 429, full);
  same(
    "text: the day's row holds what was served and the two refusals",
    counters(dailyRow(nearText.id, "server")),
    // The seeded row's one unit, and what the engine reported for the two requests served.
    counted({ detect_requests: 3, detect_texts: 3, detect_characters: 1000, detect_records: 1 + 2 * engineUnits(["k"]), detect_refused: 2 }),
  );
  const nearMe = await call("GET", "/v1/me", { token: textToken });
  same("text: the month's total is the old monthly total plus the daily rows", [nearMe.json?.usage?.detectCharacters, nearMe.json?.usage?.ocrPages], [CHARACTER_ALLOWANCE, 3]);
  same(
    "text: the old monthly total was not written to",
    service.query("SELECT detect_characters, ocr_pages, detect_requests FROM usage WHERE user_id = ? AND month = ?", nearText.id, thisMonth)[0],
    { detect_characters: 2_999_000, ocr_pages: 3, detect_requests: 0 },
  );

  const pagesToken = token("near-pages", "desktop");
  const lastFile = await send(pdf, "application/pdf", pagesToken);
  const refusedFile = await send(pdf, "application/pdf", pagesToken);
  expect("pages: at 199 of 200 one more file is read (its pages cannot be known first)", lastFile.status === 200, lastFile);
  expect("pages: at 202 the next file is refused", refusedFile.status === 429 && refusedFile.json?.error?.code === "quota_exceeded", refusedFile);
  same(
    "pages: the row holds the file that was read and the refusal",
    counters(dailyRow(nearPages.id, "desktop")),
    counted({ ocr_files: 31, ocr_pages: 123, ocr_bytes: 9_000_000 + pdf.length, ocr_pdf_files: 1, ocr_pdf_pages: 3, ocr_pdf_bytes: pdf.length, ocr_refused: 1 }),
  );
  const stillText = await call("POST", "/v1/detect", { body: { texts: ["Jane Doe"] }, token: pagesToken });
  expect("pages: an account out of pages can still have text checked", stillText.status === 200, stillText);

  const freshToken = token("fresh-month", "desktop");
  const newMonthText = await call("POST", "/v1/detect", { body: { texts: ["Jane Doe"] }, token: freshToken });
  const newMonthFile = await send(png, "image/png", freshToken);
  expect("last month's use does not count against this month", newMonthText.status === 200 && newMonthFile.status === 200, { newMonthText, newMonthFile });

  // --- The nightly roll-up -------------------------------------------------------------------------
  const sumOf = (rows) => Object.fromEntries(COUNTERS.map((counter) => [counter, rows.reduce((total, row) => total + (row[counter] ?? 0), 0)]));
  const oldDaily = data.daily.filter((row) => row.user_id === rolled.id && monthOf(row.day) === oldMonth);
  const oldTotal = sumOf([...oldDaily, data.monthly.find((row) => row.user_id === rolled.id)]);
  const byMonth = async () => (await call("GET", `/admin/accounts/${rolled.id}`, { headers: admin })).text.split("By month")[1];
  const before = await byMonth();
  const scheduled = await call("GET", "/cdn-cgi/handler/scheduled");
  expect("the nightly job runs", scheduled.status === 200, scheduled);
  same("roll-up: days past their keeping time are gone", service.query("SELECT COUNT(*) AS rows FROM usage_daily WHERE user_id = ? AND day < ?", rolled.id, `${oldMonth}-32`)[0].rows, 0);
  same("roll-up: their month's total holds everything they held, added to what was there", counters(service.query("SELECT * FROM usage WHERE user_id = ? AND month = ?", rolled.id, oldMonth)[0]), oldTotal);
  same("roll-up: a day inside the keeping time stays", service.query("SELECT COUNT(*) AS rows FROM usage_daily WHERE user_id = ? AND day = ?", rolled.id, dayOf(399))[0].rows, 1);
  same("roll-up: nothing recent was touched", counters(dailyRow(metered.id, "desktop")), expected);
  expect("roll-up: the account's months read the same before and after", before.includes(`>${new Intl.NumberFormat("en-US").format(oldTotal.detect_characters)}</td>`) && before === (await byMonth()), before);
  await call("GET", "/cdn-cgi/handler/scheduled");
  same("roll-up: running it again changes nothing", counters(service.query("SELECT * FROM usage WHERE user_id = ? AND month = ?", rolled.id, oldMonth)[0]), oldTotal);

  // --- The owner's views, checked against the rows in the database --------------------------------
  // Worked out here from the tables, independently of the service's own queries.
  const users = service.query("SELECT * FROM users");
  const allDaily = service.query("SELECT * FROM usage_daily");
  const allMonthly = service.query("SELECT * FROM usage");
  const monthTotals = (month) =>
    new Map(
      users.map((person) => [
        person.id,
        sumOf([
          ...allDaily.filter((row) => row.user_id === person.id && monthOf(row.day) === month),
          ...allMonthly.filter((row) => row.user_id === person.id && row.month === month),
        ]),
      ]),
    );
  const now = monthTotals(thisMonth);
  const costOf = (total) => total.detect_records * USD_PER_UNIT + total.ocr_pages * USD_PER_PAGE;
  const since30 = dayOf(29);
  const activeDays = (id) => new Set(allDaily.filter((row) => row.user_id === id && row.day >= since30).map((row) => row.day)).size;

  // Accounts as CSV.
  const parseCsv = (text) => {
    const rows = [];
    let row = [];
    let cell = "";
    let quoted = false;
    const body = text.replace(/^﻿/, "");
    for (let index = 0; index < body.length; index += 1) {
      const character = body[index];
      if (quoted) {
        if (character === '"' && body[index + 1] === '"') (cell += '"'), (index += 1);
        else if (character === '"') quoted = false;
        else cell += character;
      } else if (character === '"') quoted = true;
      else if (character === ",") row.push(cell), (cell = "");
      else if (character === "\n") row.push(cell.replace(/\r$/, "")), rows.push(row), (row = []), (cell = "");
      else cell += character;
    }
    return rows;
  };
  const csv = await call("GET", "/admin/accounts.csv", { headers: admin });
  expect("accounts CSV: served as a download, never cached", csv.status === 200 && csv.headers.get("content-type").startsWith("text/csv") && csv.headers.get("content-disposition") === `attachment; filename="doedesk-accounts-${thisMonth}.csv"` && csv.headers.get("cache-control") === "no-store", [...csv.headers]);
  const [header, ...lines] = parseCsv(csv.text);
  same("accounts CSV: columns", header, ["account_id", "email", "phone", "field", "field_other", "workplace", "country", "sign_in", "joined_utc", "last_active_day_utc", "month_utc", "characters", "engine_units", "pages", "requests", "allowance_share", "estimated_engine_cost_usd", "active_days_last_30"]);
  same("accounts CSV: one line per account", lines.length, users.length);
  const byId = new Map(lines.map((line) => [line[0], Object.fromEntries(header.map((name, index) => [name, line[index]]))]));
  const wrongLines = users.filter((person) => {
    const line = byId.get(person.id);
    const total = now.get(person.id);
    const share = Math.max(total.detect_characters / CHARACTER_ALLOWANCE, total.ocr_pages / PAGE_ALLOWANCE);
    return !(
      line !== undefined &&
      line.email.replace(/^'/, "") === (person.email ?? "") &&
      line.phone === (person.phone ?? "") &&
      line.field === (person.field ?? "") &&
      line.field_other === (person.field_other ?? "") &&
      line.workplace === (person.workplace ?? "") &&
      line.country === (person.country ?? "") &&
      line.joined_utc === person.created_at &&
      line.month_utc === thisMonth &&
      Number(line.characters) === total.detect_characters &&
      Number(line.engine_units) === total.detect_records &&
      Number(line.pages) === total.ocr_pages &&
      Number(line.requests) === total.detect_requests + total.ocr_files &&
      Math.abs(Number(line.allowance_share) - share) < 0.0001 &&
      Math.abs(Number(line.estimated_engine_cost_usd) - costOf(total)) < 0.0001 &&
      Number(line.active_days_last_30) === activeDays(person.id)
    );
  });
  same("accounts CSV: every figure matches the rows in the database", wrongLines.map((person) => byId.get(person.id)), []);
  expect("accounts CSV: sorted by characters, most first", lines.every((line, index) => index === 0 || Number(lines[index - 1][11]) >= Number(line[11])));
  expect("accounts CSV: an address that would run as a formula is made plain text", csv.text.includes(",'=1+1@evil.example,") && csv.text.includes(",'+first@evil.example,"), csv.text.match(/.*evil.*/g));
  expect("accounts CSV: a phone number keeps its plus sign", /,\+9665\d{8},/.test(csv.text));
  expect("accounts CSV: commas and quotes are quoted", csv.text.includes(',"Notary, ""private""",'), csv.text.match(/.*Notary.*/g)?.slice(0, 2));
  same("accounts CSV: the metered account's line", [byId.get(metered.id).characters, byId.get(metered.id).pages, byId.get(metered.id).active_days_last_30], [String(expected.detect_characters + mobileRow.detect_characters), "6", "1"]);

  const searchedCsv = await call("POST", "/admin/accounts.csv", { ...form({ q: "evil.example" }), headers: { ...admin, "content-type": "application/x-www-form-urlencoded" } });
  same("accounts CSV: a search narrows the download", parseCsv(searchedCsv.text).length - 1, 2);

  // One account's daily rows as CSV.
  const accountCsv = await call("GET", `/admin/accounts/${metered.id}.csv`, { headers: admin });
  const [dailyHeader, ...dailyLines] = parseCsv(accountCsv.text);
  same("account CSV: columns", dailyHeader, ["account_id", "day_utc", "client", ...COUNTERS]);
  same(
    "account CSV: exactly the account's daily rows",
    dailyLines,
    allDaily
      .filter((row) => row.user_id === metered.id)
      .sort((left, right) => (left.day + left.client < right.day + right.client ? -1 : 1))
      .map((row) => [metered.id, row.day, row.client, ...COUNTERS.map((counter) => String(row[counter]))]),
  );
  expect("account CSV: named by the start of the id only", accountCsv.headers.get("content-disposition") === `attachment; filename="doedesk-account-${metered.id.slice(0, 8)}-daily.csv"`, accountCsv.headers.get("content-disposition"));
  const busy = allDaily.reduce((counts, row) => counts.set(row.user_id, (counts.get(row.user_id) ?? 0) + 1), new Map());
  const busiest = [...busy].sort((left, right) => right[1] - left[1])[0][0];
  const busiestCsv = parseCsv((await call("GET", `/admin/accounts/${busiest}.csv`, { headers: admin })).text);
  same("account CSV: a long history comes out whole", busiestCsv.length - 1, busy.get(busiest));
  expect("account CSV: unknown account is not found", (await call("GET", "/admin/accounts/00000000-0000-4000-a000-000000000000.csv", { headers: admin })).status === 404);

  // The accounts table.
  const number = (value) => new Intl.NumberFormat("en-US").format(value);
  const accountsPage = await call("GET", "/admin/accounts", { headers: admin });
  const rowIds = (page) => [...page.matchAll(/<td class="who"><a href="\/admin\/accounts\/([0-9a-f-]{36})">/g)].map((match) => match[1]);
  const ranked = (measure) => [...users].sort((left, right) => measure(right) - measure(left) || (left.id < right.id ? -1 : 1)).map((person) => person.id);
  expect("accounts page: renders", accountsPage.status === 200 && accountsPage.text.includes("<h1>Accounts"), accountsPage.status);
  same("accounts page: fifty accounts, most characters first", rowIds(accountsPage.text), ranked((person) => now.get(person.id).detect_characters).slice(0, 50));
  expect("accounts page: says how many there are", accountsPage.text.includes(`1–50 of ${number(users.length)}`));
  const top = users.find((person) => person.id === rowIds(accountsPage.text)[0]);
  expect("accounts page: shows who, and their figures", accountsPage.text.includes(`<bdi>${top.email ?? top.phone}</bdi>`) && accountsPage.text.includes(`>${number(now.get(top.id).detect_characters)}</td>`));
  expect("accounts page: no address on the page carries an email or a phone number", !/(href|action|formaction)="[^"]*(@|%40|\+966|%2B966)/.test(accountsPage.text));
  expect("accounts page: the search is sent in a form body", accountsPage.text.includes('<form method="post" action="/admin/accounts">'));

  const post = (fields) => call("POST", "/admin/accounts", { ...form(fields), headers: { ...admin, "content-type": "application/x-www-form-urlencoded" } });
  const second50 = await post({ s: "characters", d: "desc", page: "2" });
  same("accounts page: the second page holds the rest", rowIds(second50.text), ranked((person) => now.get(person.id).detect_characters).slice(50, 100));
  const byPages = await post({ s: "characters", d: "desc", sort: "pages" });
  same("accounts page: sorting by pages", rowIds(byPages.text), ranked((person) => now.get(person.id).ocr_pages).slice(0, 50));
  const byCost = await post({ s: "pages", d: "desc", sort: "cost" });
  // Costs are fractions, so equal ones may fall either way round: check the order, not the exact list.
  const costs = rowIds(byCost.text).map((id) => costOf(now.get(id)));
  const leftOut = users.filter((person) => !rowIds(byCost.text).includes(person.id)).map((person) => costOf(now.get(person.id)));
  expect(
    "accounts page: sorting by estimated cost",
    costs.length === 50 && costs.every((cost, index) => index === 0 || costs[index - 1] >= cost - 1e-9) && Math.max(...leftOut) <= costs.at(-1) + 1e-9,
    costs,
  );
  const turned = await post({ s: "cost", d: "desc", sort: "cost" });
  expect("accounts page: pressing the same column turns the order round", turned.text.includes('aria-sort="ascending"') && costOf(now.get(rowIds(turned.text)[0])) === 0);
  const found = await post({ q: "EVIL.example" });
  same("accounts page: search finds by part of an email, whatever the case", rowIds(found.text).sort(), [formula.id, plus.id].sort());
  const phoneUser = users.find((person) => person.phone !== null);
  const foundPhone = await post({ q: `0${phoneUser.phone.slice(4)}` });
  same("accounts page: search finds a phone number typed the local way", rowIds(foundPhone.text), [phoneUser.id]);
  const none = await post({ q: "nobody-by-this-name" });
  expect("accounts page: a search with no match says so", rowIds(none.text).length === 0 && none.text.includes("No account matches"));
  const wild = await post({ q: "%" });
  same("accounts page: a percent sign is searched for, not treated as a wildcard", rowIds(wild.text).length, 0);
  const inAddress = await call("GET", `/admin/accounts?q=${encodeURIComponent("evil.example")}`, { headers: admin });
  same("accounts page: a search term in the address is ignored", rowIds(inAddress.text).length, 50);
  const injected = await post({ sort: "characters; DROP TABLE users", s: "x", d: "sideways", page: "-4" });
  expect("accounts page: unknown sort, direction and page fall back to the defaults", injected.status === 200 && rowIds(injected.text).length === 50);

  // One account.
  const page = await call("GET", `/admin/accounts/${metered.id}`, { headers: admin });
  const total = now.get(metered.id);
  expect("account page: renders with the account's name", page.status === 200 && page.text.includes(`<bdi>${metered.email}</bdi>`), page.status);
  expect("account page: the title does not name the account", /<title>DoeDesk dashboard<\/title>/.test(page.text) && !page.text.split("</head>")[0].includes(metered.email));
  expect("account page: this month's characters, pages and requests", page.text.includes(`<div class="figure">${number(total.detect_characters)}</div>`) && page.text.includes(`<div class="figure">${number(total.ocr_pages)}</div>`) && page.text.includes(`<div class="figure">${number(total.detect_requests + total.ocr_files)}</div>`));
  expect("account page: estimated cost from engine units and pages", page.text.includes(`<div class="figure">$${costOf(total).toFixed(2)}</div>`), costOf(total));
  expect("account page: 90 days of characters, pages and requests, each with its table", (page.text.match(/class="card chart third"/g) ?? []).length === 3 && (page.text.match(/<summary>Table<\/summary>/g) ?? []).length === 3);
  expect("account page: today's characters are on the chart", page.text.includes(`: ${number(total.detect_characters)}"`));
  expect("account page: both clients", page.text.includes(">Desktop<") && page.text.includes(">Phone<"));
  expect(
    "account page: refusals and failures",
    page.text.includes(`<tr><th scope="row">Text</th><td class="num">0</td><td class="num">1</td><td class="num">1</td></tr>`) &&
      page.text.includes(`<tr><th scope="row">Files</th><td class="num">0</td><td class="num">1</td><td class="num">2</td></tr>`),
  );
  const refusedPage = await call("GET", `/admin/accounts/${nearText.id}`, { headers: admin });
  expect("account page: allowance refusals show for the account that met them", refusedPage.text.includes(`<tr><th scope="row">Text</th><td class="num">2</td>`));
  const veteranPage = await call("GET", `/admin/accounts/${data.users[0].id}`, { headers: admin });
  expect("account page: a month from before daily metering is in the monthly table", veteranPage.text.includes(">412,300</td>"));
  expect("account page: unknown account is not found", (await call("GET", "/admin/accounts/00000000-0000-4000-a000-000000000000", { headers: admin })).status === 404);
  expect("account page: a malformed id is not found", (await call("GET", "/admin/accounts/not-an-id", { headers: admin })).status === 404);

  // How usage spreads.
  const compact = (value) => new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
  const percentile = (values, share) => values[Math.min(values.length - 1, Math.max(0, Math.ceil(share * values.length) - 1))] ?? 0;
  for (const [name, month] of [["this month", thisMonth], ["last month", monthOf(lastMonthDay)]]) {
    const totals = [...monthTotals(month).values()];
    const active = totals.filter((item) => item.detect_characters > 0 || item.ocr_pages > 0 || item.detect_requests + item.ocr_files > 0);
    const sorted = (measure) => active.map(measure).sort((left, right) => left - right);
    const spread = await call("GET", `/admin/distribution?month=${month}`, { headers: admin });
    const cells = (label) => new RegExp(`<tr><th scope="row">${label}</th>(.*?)</tr>`).exec(spread.text)?.[1] ?? "";
    const want = (share) =>
      [(item) => item.detect_characters, (item) => item.ocr_pages, (item) => item.detect_requests + item.ocr_files]
        .map((measure) => {
          const value = percentile(sorted(measure), share);
          return `<td class="num"><span title="${number(value)}">${compact(value)}</span></td>`;
        })
        .join("");
    expect(`spread, ${name}: renders, with how many accounts are active`, spread.status === 200 && spread.text.includes(`<div class="figure">${number(active.length)}</div><div class="delta">of ${number(users.length)}</div>`), spread.status);
    for (const [label, share] of [["Median", 0.5], ["75th percentile", 0.75], ["90th", 0.9], ["99th", 0.99], ["Highest", 1]]) {
      expect(`spread, ${name}: ${label} of characters, pages and requests`, cells(label).startsWith(want(share)), { got: cells(label), want: want(share) });
    }
    const cost = active.reduce((sum, item) => sum + costOf(item), 0);
    expect(`spread, ${name}: average estimated cost per active account`, spread.text.includes(`<h2>Cost per active account</h2><div class="figure">$${(cost / active.length).toFixed(2)}</div>`), cost / active.length);
    const characters = sorted((item) => item.detect_characters).reverse();
    const share5 = Math.round((characters.slice(0, 5).reduce((sum, value) => sum + value, 0) / characters.reduce((sum, value) => sum + value, 0)) * 100);
    expect(`spread, ${name}: share of characters from the top five accounts`, cells("Top 5").startsWith(`<td class="num">${share5}%</td>`), { got: cells("Top 5"), share5 });
    const none = totals.filter((item) => item.detect_characters === 0).length;
    const middle = totals.filter((item) => item.detect_characters >= 10_000 && item.detect_characters < 100_000).length;
    expect(
      `spread, ${name}: accounts in each band of characters`,
      new RegExp(`<span class="name">None</span>.*?<span class="num">${none}</span>`).test(spread.text.split("Accounts by characters")[1].split("Accounts by pages")[0]) &&
        new RegExp(`<span class="name">10,000 to 100,000</span>.*?<span class="num">${middle}</span>`).test(spread.text),
      { none, middle },
    );
    const legal = users.filter((person) => person.field === "legal").map((person) => monthTotals(month).get(person.id));
    const legalActive = legal.filter((item) => item.detect_characters > 0 || item.ocr_pages > 0 || item.detect_requests + item.ocr_files > 0);
    expect(`spread, ${name}: by field, accounts and active accounts`, spread.text.includes(`<td>Legal</td><td class="num wide-only">${legal.length}</td><td class="num">${legalActive.length}</td>`), { all: legal.length, active: legalActive.length });
  }
  const badMonth = await call("GET", "/admin/distribution?month=2026-13", { headers: admin });
  expect("spread: an impossible month falls back to this one", badMonth.status === 200);

  const overview = await call("GET", "/admin", { headers: admin });
  const everyone = [...now.values()].reduce((sum, item) => sum + item.detect_characters, 0);
  expect("overview: this month's total counts the daily rows", overview.status === 200 && overview.text.includes(`<div class="figure">${number(everyone)}</div>`), everyone);

  // The cookie the key page sets opens the new views too.
  const login = await call("POST", "/admin", form({ key: service.adminKey }));
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  const withCookie = await call("GET", "/admin/accounts", { headers: { cookie } });
  expect("the admin cookie opens the accounts page", login.status === 303 && withCookie.status === 200 && withCookie.text.includes("<h1>Accounts"), login.status);

  // --- Nothing left this machine ------------------------------------------------------------------
  same("every engine call went to the stand-in, with the service's engine token", [...service.engine.seen.authorization], [`Bearer ${ENGINE_TOKEN}`]);
  expect("the service logged no account identifier", !/@test\.example|@evil\.example|\+9665\d{8}/.test(service.log()), service.log().match(/.*(@test|@evil|\+9665).*/g)?.slice(0, 3));
} catch (cause) {
  failures += 1;
  console.log("FAIL the run stopped:", cause);
  console.log(service.log().split("\n").slice(-30).join("\n"));
} finally {
  await service.stop();
}

// --- Without the engine's prices in the settings, no cost anywhere -------------------------------
{
  const unpriced = await startLocalService({ seedSql: sampleSql(data) });
  try {
    const ask = client(unpriced.base);
    const owner = { authorization: `Bearer ${unpriced.adminKey}` };
    const someone = data.users.find((person) => person.email !== null) ?? data.users[0];
    const pages = {
      accounts: await ask("GET", "/admin/accounts", { headers: owner }),
      sortedByCost: await ask("GET", "/admin/accounts?sort=cost", { headers: owner }),
      account: await ask("GET", `/admin/accounts/${someone.id}`, { headers: owner }),
      spread: await ask("GET", "/admin/distribution", { headers: owner }),
    };
    const csv = await ask("GET", "/admin/accounts.csv", { headers: owner });
    expect(
      "no prices: every view answers, and none shows a cost",
      Object.values(pages).every((page) => page.status === 200 && !/cost|\$\d/i.test(page.text)),
      Object.fromEntries(Object.entries(pages).map(([name, page]) => [name, page.status, page.text.match(/.{0,60}(cost|\$\d).{0,40}/i)?.[0]])),
    );
    expect("no prices: asking to sort by cost sorts by characters", pages.sortedByCost.text.includes('value="characters" aria-pressed="true"'), pages.sortedByCost.text.match(/aria-pressed="true"[^>]*/)?.[0]);
    expect("no prices: the accounts CSV has no cost column", csv.status === 200 && !csv.text.split("\r\n")[0].includes("cost"), csv.text.split("\r\n")[0]);
  } catch (cause) {
    failures += 1;
    console.log("FAIL the run without prices stopped:", cause);
  } finally {
    await unpriced.stop();
  }
}
console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
