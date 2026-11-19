-- Metering per account, per day and per client, in enough detail to price the service later.
-- Counts only: nothing sent for detection or reading is stored, here or anywhere.
-- Days and months are UTC.
--
-- How the two tables fit together:
--   usage_daily  one row per account, UTC day and client. Every request adds to it with one upsert.
--   usage        one row per account and UTC month, holding what is NOT in usage_daily: totals from
--                before this migration, and days that the nightly job has rolled up.
-- A month's total for an account is its `usage` row plus its `usage_daily` rows for that month.
-- The allowance reads both in one statement; the daily part is a walk of at most 31 days of the
-- primary key. Nothing is counted twice, because a request writes to one table only and the roll-up
-- moves rows from one to the other in a single batch.
--
-- Safe to apply before the new Worker is deployed: the old Worker reads and writes only
-- usage.detect_characters and usage.ocr_pages, which keep their names and meaning.

CREATE TABLE usage_daily (
  user_id TEXT NOT NULL REFERENCES users(id),
  -- UTC, YYYY-MM-DD.
  day TEXT NOT NULL,
  -- The client of the session that made the request: desktop, web, mobile, server, site.
  client TEXT NOT NULL,

  -- Detection. Requests that were answered, and what they carried.
  detect_requests INTEGER NOT NULL DEFAULT 0,
  detect_texts INTEGER NOT NULL DEFAULT 0,
  -- UTF-16 code units, the measure the monthly allowance is set in.
  detect_characters INTEGER NOT NULL DEFAULT 0,
  -- Engine units: the work detection cost, as the engine reports it. Includes the units of a
  -- request that failed part-way, since that work was done.
  detect_records INTEGER NOT NULL DEFAULT 0,
  -- How many entities were returned. A count; not what they were.
  detect_entities INTEGER NOT NULL DEFAULT 0,
  -- Requests turned away: allowance used up, over the size limit, engine failed.
  detect_refused INTEGER NOT NULL DEFAULT 0,
  detect_too_large INTEGER NOT NULL DEFAULT 0,
  detect_failed INTEGER NOT NULL DEFAULT 0,

  -- Reading. Files that were read, and their size. Pages are the unit reading is costed in.
  ocr_files INTEGER NOT NULL DEFAULT 0,
  ocr_pages INTEGER NOT NULL DEFAULT 0,
  ocr_bytes INTEGER NOT NULL DEFAULT 0,
  -- The part of the three figures above that was PDF. The rest is images.
  ocr_pdf_files INTEGER NOT NULL DEFAULT 0,
  ocr_pdf_pages INTEGER NOT NULL DEFAULT 0,
  ocr_pdf_bytes INTEGER NOT NULL DEFAULT 0,
  ocr_refused INTEGER NOT NULL DEFAULT 0,
  ocr_too_large INTEGER NOT NULL DEFAULT 0,
  ocr_failed INTEGER NOT NULL DEFAULT 0,

  PRIMARY KEY (user_id, day, client)
) WITHOUT ROWID;

-- For the dashboard's questions across accounts ("everyone this month") and for the roll-up.
CREATE INDEX usage_daily_day ON usage_daily(day, user_id);

-- The monthly table gains the same counters, so rolling a day up loses only the day and the client.
ALTER TABLE usage ADD COLUMN detect_requests INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage ADD COLUMN detect_texts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage ADD COLUMN detect_records INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage ADD COLUMN detect_entities INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage ADD COLUMN detect_refused INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage ADD COLUMN detect_too_large INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage ADD COLUMN detect_failed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage ADD COLUMN ocr_files INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage ADD COLUMN ocr_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage ADD COLUMN ocr_pdf_files INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage ADD COLUMN ocr_pdf_pages INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage ADD COLUMN ocr_pdf_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage ADD COLUMN ocr_refused INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage ADD COLUMN ocr_too_large INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage ADD COLUMN ocr_failed INTEGER NOT NULL DEFAULT 0;

-- No backfill: the months counted so far stay where they are, as monthly totals.
