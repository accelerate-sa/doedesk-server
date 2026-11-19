/**
 * Metering: what each account used, per UTC day and per client, as counts. Nothing sent for
 * detection or reading is kept.
 *
 * `usage_daily` takes one upsert per request. `usage` holds, per account and month, what is not in
 * `usage_daily`: totals from before daily metering, and days the nightly job has rolled up. A
 * month's total is the two added together, read in one statement. See migrations/0004.
 */
import { ApiError, type Env } from "./http.ts";
import { isFrozen } from "./maintenance.ts";

export const MONTHLY_DETECT_CHARACTERS = 3_000_000;
export const MONTHLY_OCR_PAGES = 200;

/** Daily rows older than this are rolled into monthly totals, a calendar month at a time. */
export const DAILY_RETENTION_DAYS = 400;

/** Every counter, in the order of the columns in both tables. */
export const COUNTERS = [
  "detect_requests",
  "detect_texts",
  "detect_characters",
  // Engine units the detection used, as the engine reported them (engine.ts).
  "detect_records",
  "detect_entities",
  "detect_refused",
  "detect_too_large",
  "detect_failed",
  "ocr_files",
  "ocr_pages",
  "ocr_bytes",
  "ocr_pdf_files",
  "ocr_pdf_pages",
  "ocr_pdf_bytes",
  "ocr_refused",
  "ocr_too_large",
  "ocr_failed",
] as const;
export type Counter = (typeof COUNTERS)[number];
export type Counts = Partial<Record<Counter, number>>;

/** Who a request is counted against: the account, and the client its session was made for. */
export interface Metered {
  readonly userId: string;
  readonly client: string;
}

export const utcDay = (at = new Date()): string => at.toISOString().slice(0, 10);
export const utcMonth = (at = new Date()): string => at.toISOString().slice(0, 7);
/** The month before `month`, both as YYYY-MM. */
export const previousMonth = (month: string): string =>
  utcMonth(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 2, 1)));
/** When the allowance next starts over: the first instant of the following UTC month. */
export const nextMonthStart = (at = new Date()): string =>
  new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1)).toISOString();

const COLUMNS = COUNTERS.join(", ");
const ADD_EXCLUDED = COUNTERS.map((counter) => `${counter} = ${counter} + excluded.${counter}`).join(", ");

const METER_SQL =
  `INSERT INTO usage_daily (user_id, day, client, ${COLUMNS}) ` +
  `VALUES (?, ?, ?, ${COUNTERS.map(() => "?").join(", ")}) ` +
  `ON CONFLICT (user_id, day, client) DO UPDATE SET ${ADD_EXCLUDED}`;

/**
 * Adds one request's counts to the account's row for today. One statement.
 * While the service is frozen for a move nothing is written, so the request goes uncounted; the log
 * gets a marker with no identifier, so the owner can see how many there were (maintenance.ts).
 */
export const meter = async (env: Env, who: Metered, counts: Counts): Promise<void> => {
  if (isFrozen(env)) {
    console.log("freeze_unmetered");
    return;
  }
  await env.DB.prepare(METER_SQL)
    .bind(who.userId, utcDay(), who.client, ...COUNTERS.map((counter) => counts[counter] ?? 0))
    .run();
};

/**
 * The same, for a request that is about to be refused or has failed: the count must not replace
 * the answer the caller is owed, so a failed write is logged and dropped.
 */
export const meterQuietly = async (env: Env, who: Metered, counts: Counts): Promise<void> => {
  try {
    await meter(env, who, counts);
  } catch (cause) {
    console.error("meter_failed", cause instanceof Error ? cause.message : String(cause));
  }
};

/**
 * Rows of one month for the given columns, from both tables, to be summed by the caller.
 * Binds: ?1 month (YYYY-MM). Days compare as text, so `-31` closes every month.
 */
export const monthRows = (columns: string): string =>
  `SELECT ${columns} FROM usage WHERE month = ?1 ` +
  `UNION ALL SELECT ${columns} FROM usage_daily WHERE day >= ?1 || '-01' AND day <= ?1 || '-31'`;

export const readUsage = async (env: Env, userId: string) => {
  const columns = "detect_characters, ocr_pages, detect_requests, ocr_files";
  const month = utcMonth();
  const row = await env.DB.prepare(
    "SELECT COALESCE(SUM(detect_characters), 0) AS detect_characters, COALESCE(SUM(ocr_pages), 0) AS ocr_pages, " +
      "COALESCE(SUM(detect_requests), 0) AS detect_requests, COALESCE(SUM(ocr_files), 0) AS ocr_files FROM (" +
      `SELECT ${columns} FROM usage WHERE user_id = ?2 AND month = ?1 ` +
      `UNION ALL SELECT ${columns} FROM usage_daily WHERE user_id = ?2 AND day >= ?1 || '-01' AND day <= ?1 || '-31')`,
  )
    .bind(month, userId)
    .first<{ detect_characters: number; ocr_pages: number; detect_requests: number; ocr_files: number }>();
  return {
    month,
    detectCharacters: row?.detect_characters ?? 0,
    ocrPages: row?.ocr_pages ?? 0,
    detectRequests: row?.detect_requests ?? 0,
    ocrFiles: row?.ocr_files ?? 0,
  };
};

export const quotaExceeded = (): ApiError =>
  new ApiError(429, "quota_exceeded", "This account has used its trial allowance for the month.");

/**
 * Moves daily rows past their keeping time into the monthly totals. Whole calendar months only, so a
 * month is either all days or one total. Both statements run in one batch, which D1 applies together
 * or not at all, so a month's total is the same before and after.
 */
export const rollUpUsage = async (env: Env, now = new Date()): Promise<void> => {
  const cutoff = `${utcMonth(new Date(now.getTime() - DAILY_RETENTION_DAYS * 86_400_000))}-01`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO usage (user_id, month, ${COLUMNS}) ` +
        `SELECT user_id, substr(day, 1, 7), ${COUNTERS.map((counter) => `SUM(${counter})`).join(", ")} ` +
        // The WHERE clause is also what lets SQLite tell this SELECT's end from the upsert clause.
        "FROM usage_daily WHERE day < ? GROUP BY user_id, substr(day, 1, 7) " +
        `ON CONFLICT (user_id, month) DO UPDATE SET ${ADD_EXCLUDED}`,
    ).bind(cutoff),
    env.DB.prepare("DELETE FROM usage_daily WHERE day < ?").bind(cutoff),
  ]);
};
