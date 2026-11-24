// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Accelerate Technology Establishment
// The database operations the service makes, written once and run against three databases by
// d1-parity.mjs: a real local D1, and the server's wrapper on Bun and on Node. Each step's answer
// is reduced to plain data so the three can be compared.
//
// Every statement here is one the code in `src/` uses, or the same shape with fewer columns.

const meta = (result) => ({ changes: result.meta.changes, success: result.success });
const attempt = async (work) => {
  try {
    return await work();
  } catch (cause) {
    return { threw: String(cause?.message ?? cause) };
  }
};

const USER = "INSERT INTO users (id, email, created_at, country, signup_method) VALUES (?, ?, ?, ?, ?)";
const COUNTERS = ["detect_requests", "detect_texts", "detect_characters", "detect_records", "detect_entities", "detect_refused", "detect_too_large", "detect_failed", "ocr_files", "ocr_pages", "ocr_bytes", "ocr_pdf_files", "ocr_pdf_pages", "ocr_pdf_bytes", "ocr_refused", "ocr_too_large", "ocr_failed", "worker_requests", "worker_input_tokens", "worker_output_tokens", "worker_refused", "worker_too_large", "worker_failed", "worker_off_region"];
const ADD = COUNTERS.map((counter) => `${counter} = ${counter} + excluded.${counter}`).join(", ");
const METER = `INSERT INTO usage_daily (user_id, day, client, ${COUNTERS.join(", ")}) VALUES (?, ?, ?, ${COUNTERS.map(() => "?").join(", ")}) ON CONFLICT (user_id, day, client) DO UPDATE SET ${ADD}`;

/** `db` is `env.DB` or the wrapper. The schema (every migration) is already applied. */
export const runOps = async (db) => {
  const out = [];
  const step = async (name, work) => out.push({ name, answer: await attempt(work) });
  const now = "2026-11-18T10:00:00.000Z";

  // --- prepare / bind / first / all / run ------------------------------------------------------
  await step("upsert with RETURNING, read by first(): the rate limiter", async () => {
    const sql = "INSERT INTO rate_limits (key, bucket, count) VALUES (?, ?, 1) ON CONFLICT (key, bucket) DO UPDATE SET count = count + 1 RETURNING count";
    return [await db.prepare(sql).bind("k:60", "1").first(), await db.prepare(sql).bind("k:60", "1").first(), await db.prepare(sql).bind("k:60", "2").first()];
  });
  await step("insert, and what run() reports", async () => meta(await db.prepare(USER).bind("u1", "one@example.com", now, "SA", "email").run()));
  await step("a second row with the same unique value is refused", () => db.prepare(USER).bind("u2", "one@example.com", now, "SA", "email").run());
  await step("ON CONFLICT DO NOTHING changes nothing the second time", async () => {
    const sql = `${USER} ON CONFLICT (email) DO NOTHING`;
    return [meta(await db.prepare(sql).bind("u3", "three@example.com", now, null, "email").run()), meta(await db.prepare(sql).bind("u4", "three@example.com", now, null, "email").run())];
  });
  await step("first() gives the row, null when there is none, and one column when asked", async () => [
    await db.prepare("SELECT id, email, phone, is_admin FROM users WHERE email = ?").bind("one@example.com").first(),
    await db.prepare("SELECT id FROM users WHERE email = ?").bind("nobody@example.com").first(),
    await db.prepare("SELECT id, country FROM users WHERE id = ?").bind("u1").first("country"),
  ]);
  await step("first(column) for a column the row does not have", () => db.prepare("SELECT id FROM users WHERE id = ?").bind("u1").first("nope"));
  await step("all() gives results and success", async () => {
    const result = await db.prepare("SELECT id, email FROM users ORDER BY id").all();
    return { results: result.results, success: result.success, changes: result.meta.changes };
  });
  await step("run() on a SELECT also gives its rows, and reports no change", async () => {
    const result = await db.prepare("SELECT id FROM users ORDER BY id").run();
    return { results: result.results, changes: result.meta.changes };
  });
  await step("a read after a write reports no change of its own", async () => {
    await db.prepare("UPDATE users SET country = ? WHERE id = ?").bind("SA", "u3").run();
    return (await db.prepare("SELECT COUNT(*) AS n FROM users").all()).meta.changes;
  });
  await step("claiming a row: the UPDATE changes one row once", async () => {
    await db.prepare("INSERT INTO login_requests (id, kind, identifier, secret_hash, client, created_at, expires_at) VALUES (?, 'phone', ?, ?, ?, ?, ?)").bind("r1", "+966500000001", "h", "desktop", now, now).run();
    const claim = "UPDATE login_requests SET status = 'used' WHERE id = ? AND status = 'pending'";
    return [(await db.prepare(claim).bind("r1").run()).meta.changes, (await db.prepare(claim).bind("r1").run()).meta.changes];
  });
  await step("bind returns a new statement and leaves the first as it was", async () => {
    const statement = db.prepare("SELECT ? AS v");
    const a = statement.bind("a");
    const b = statement.bind("b");
    return [await a.first(), await b.first(), await a.first()];
  });
  await step("numbered placeholders, each used more than once: the month's rows", async () => {
    await db.prepare(METER).bind("u1", "2026-11-03", "desktop", ...COUNTERS.map((_, index) => index + 1)).run();
    await db.prepare(METER).bind("u1", "2026-11-03", "desktop", ...COUNTERS.map((_, index) => index + 1)).run();
    await db.prepare(METER).bind("u1", "2026-11-04", "mobile", ...COUNTERS.map(() => 2)).run();
    return db
      .prepare(
        "SELECT COALESCE(SUM(detect_characters), 0) AS detect_characters, COALESCE(SUM(ocr_pages), 0) AS ocr_pages FROM (" +
          "SELECT detect_characters, ocr_pages FROM usage WHERE user_id = ?2 AND month = ?1 " +
          "UNION ALL SELECT detect_characters, ocr_pages FROM usage_daily WHERE user_id = ?2 AND day >= ?1 || '-01' AND day <= ?1 || '-31')",
      )
      .bind("2026-11", "u1")
      .first();
  });
  await step("a sum over nothing is 0, as a number", () => db.prepare("SELECT COALESCE(SUM(ocr_pages), 0) AS pages, COUNT(*) AS n FROM usage_daily WHERE user_id = ?").bind("nobody").first());

  // --- what may and may not be bound --------------------------------------------------------------
  await step("undefined cannot be bound", () => db.prepare("SELECT ? AS v").bind(undefined).first());
  await step("a boolean is stored as 1 or 0", () => db.prepare("SELECT ? AS yes, ? AS no, typeof(?) AS kind").bind(true, false, true).first());
  await step("a whole number is an integer, a fraction a real, and joins to text as written", () =>
    db.prepare("SELECT typeof(?) AS whole, typeof(?) AS fraction, 'k:' || ? AS joined, ? + 1 AS sum, ? AS big").bind(3, 1.5, 60, 41, 9007199254740991).first(),
  );
  await step("null, empty text, and text in two scripts with an emoji", () => db.prepare("SELECT ? AS absent, ? AS blank, ? AS words, length(?) AS characters").bind(null, "", "فاطمة ✓ Jane 🦌", "فاطمة ✓ Jane 🦌").first());
  await step("too few values", () => db.prepare("SELECT ? AS a, ? AS b").bind("only one").first());
  await step("too many values", () => db.prepare("SELECT ? AS a").bind("one", "two").first());
  await step("no values for a statement that takes some", () => db.prepare("SELECT ? AS a").first());
  await step("a hundred values are taken", async () => Object.keys(await db.prepare(`SELECT ${Array.from({ length: 100 }, (_, index) => `? AS c${index}`).join(", ")}`).bind(...Array.from({ length: 100 }, (_, index) => index)).first()).length);
  await step("a hundred and one are not", () => db.prepare(`SELECT ${Array.from({ length: 101 }, (_, index) => `? AS c${index}`).join(", ")}`).bind(...Array.from({ length: 101 }, (_, index) => index)).first());
  await step("a long text goes in and comes back whole", async () => {
    const raw = "é".repeat(200_000);
    await db.prepare("INSERT INTO test_inbox (address, received_at, raw) VALUES (?, ?, ?)").bind("e2e-longtext1@doedesk.com", now, raw).run();
    const row = await db.prepare("SELECT length(raw) AS characters, raw FROM test_inbox WHERE address = ?").bind("e2e-longtext1@doedesk.com").first();
    return { characters: row.characters, same: row.raw === raw };
  });
  await step("the row number of an insert", async () => {
    const result = await db.prepare("INSERT INTO test_inbox (address, received_at, raw) VALUES (?, ?, ?)").bind("e2e-rownumber1@doedesk.com", now, "x").run();
    return { last_row_id: result.meta.last_row_id, changes: result.meta.changes };
  });

  // --- the SQL the dashboard and the nightly job lean on ----------------------------------------
  await step("LIKE ignores case for plain letters; MAX of two; substr; json_extract", async () => {
    await db.prepare("INSERT INTO events (uuid, event, distinct_id, install_id, at, day, received_at, properties) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind("e1", "client.turn.requested", "i", "i", now, "2026-11-18", now, JSON.stringify({ platform: "darwin", n: 3 })).run();
    return [
      await db.prepare("SELECT COUNT(*) AS n FROM users WHERE email LIKE ?").bind("%ONE@EXAMPLE%").first(),
      await db.prepare("SELECT MAX(?, ?) AS greater, substr(?, 1, 7) AS month").bind(3, 7, "2026-11-18").first(),
      await db.prepare("SELECT json_extract(properties, '$.platform') AS platform, json_extract(properties, '$.n') AS n FROM events WHERE uuid = ?").bind("e1").first(),
    ];
  });
  await step("IN with an empty list finds nothing", () => db.prepare("SELECT id FROM users WHERE id IN ()").all().then((result) => result.results));
  await step("a statement with a mistake in it", () => db.prepare("SELECT nothing FROM nowhere").all());
  await step("a row that points at an account that is not there is refused", () =>
    db.prepare("INSERT INTO sessions (token_hash, user_id, client, created_at, last_used_at) VALUES (?, ?, ?, ?, ?)").bind("t-orphan", "no-such-user", "desktop", now, now).run(),
  );

  // --- batch ----------------------------------------------------------------------------------------
  await step("batch: answers in order, each with its own count, later statements see earlier ones", async () => {
    const results = await db.batch([
      db.prepare(USER).bind("b1", "b1@example.com", now, "SA", "email"),
      db.prepare("INSERT INTO sessions (token_hash, user_id, client, created_at, last_used_at) VALUES (?, ?, ?, ?, ?)").bind("t-b1", "b1", "desktop", now, now),
      db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?").bind("b1"),
      db.prepare("UPDATE users SET country = ? WHERE id IN (?, ?)").bind("AE", "b1", "u1"),
    ]);
    return results.map((result) => ({ results: result.results, changes: result.meta.changes, success: result.success }));
  });
  await step("batch: when one statement fails, none of it is kept", async () => {
    const failed = await attempt(() =>
      db.batch([
        db.prepare(USER).bind("b2", "b2@example.com", now, "SA", "email"),
        db.prepare("UPDATE users SET country = 'ZZ' WHERE id = ?").bind("u1"),
        db.prepare(USER).bind("b3", "one@example.com", now, "SA", "email"),
        db.prepare(USER).bind("b4", "b4@example.com", now, "SA", "email"),
      ]),
    );
    return { failed, after: (await db.prepare("SELECT id, country FROM users WHERE id IN ('b2', 'b4', 'u1') ORDER BY id").all()).results };
  });
  await step("batch: deleting an account before what points at it is refused, and nothing goes", async () => {
    const failed = await attempt(() => db.batch([db.prepare("DELETE FROM rate_limits WHERE key = ?").bind("k:60"), db.prepare("DELETE FROM users WHERE id = ?").bind("b1")]));
    return { failed, counters: (await db.prepare("SELECT COUNT(*) AS n FROM rate_limits").first()).n, account: (await db.prepare("SELECT COUNT(*) AS n FROM users WHERE id = 'b1'").first()).n };
  });
  await step("batch: an account and everything tied to it, children first, as rights.ts does", async () => {
    const results = await db.batch([
      db.prepare("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE id IN (?))").bind("b1"),
      db.prepare("DELETE FROM usage_daily WHERE user_id IN (SELECT id FROM users WHERE id IN (?))").bind("b1"),
      db.prepare("DELETE FROM users WHERE id IN (?)").bind("b1"),
      db.prepare("INSERT INTO rights_requests (id, handled_at, type, channel, outcome, account_id) VALUES (?, ?, ?, ?, ?, ?)").bind("rr1", now, "deletion", "app", "done", "b1"),
    ]);
    return results.map((result) => result.meta.changes);
  });
  await step("batch: the roll-up moves days into a month and removes them, together", async () => {
    const results = await db.batch([
      db.prepare(
        `INSERT INTO usage (user_id, month, ${COUNTERS.join(", ")}) SELECT user_id, substr(day, 1, 7), ${COUNTERS.map((counter) => `SUM(${counter})`).join(", ")} ` +
          `FROM usage_daily WHERE day < ? GROUP BY user_id, substr(day, 1, 7) ON CONFLICT (user_id, month) DO UPDATE SET ${ADD}`,
      ).bind("2026-12-01"),
      db.prepare("DELETE FROM usage_daily WHERE day < ?").bind("2026-12-01"),
    ]);
    return { changes: results.map((result) => result.meta.changes), month: await db.prepare("SELECT * FROM usage WHERE user_id = 'u1'").first(), daysLeft: (await db.prepare("SELECT COUNT(*) AS n FROM usage_daily").first()).n };
  });
  await step("batch: counts for the nightly report, read only", async () =>
    (await db.batch([db.prepare("SELECT COUNT(*) AS n FROM users WHERE created_at < ?").bind("2030-01-01"), db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE last_used_at < ?").bind("2000-01-01")])).map((result) => result.results[0].n),
  );
  await step("batch: nothing to do", () => db.batch([]));
  await step("a delete that removes several rows says how many", async () => (await db.prepare("DELETE FROM rate_limits WHERE key LIKE '%:60' AND bucket < ?").bind("9").run()).meta.changes);
  return out;
};
