/**
 * The nightly job: deletes what the Privacy Policy says is no longer kept. The periods, each beside
 * the sentence of the policy it comes from, are in periods.ts.
 *
 * Every rule is one or two statements whose only input is the time, so running the job twice, or
 * after a night it missed, does the same as running it once. Each rule runs in its own batch, which
 * the database applies whole or not at all; a rule that fails does not stop the others, and the run
 * is then reported as failed.
 *
 * `retentionReport` is the dry run: the same rules, counted and not applied.
 *
 * D1's limits, checked on 18 November 2026 (developers.cloudflare.com/d1/platform/limits): a batch
 * may hold any number of statements and counts as one of the 50 (free plan) or 1,000 (paid) queries
 * a Worker invocation may make; each statement may bind 100 values and run for 30 seconds. A run
 * makes about 20 queries, and the statements that name accounts bind 40 at a time.
 */
import { daysBefore, type Env, monthsBefore } from "./http.ts";
import {
  ACCEPTANCE_YEARS_AFTER_CLOSURE,
  ACCOUNT_UNUSED_MONTHS,
  CONTACT_MAIL_AUTO_CLOSE_DAYS,
  CONTACT_MAIL_MONTHS_AFTER_CLOSED,
  ERROR_REPORT_DAYS,
  RATE_LIMIT_WINDOWS_KEPT,
  RIGHTS_LOG_YEARS,
  SESSION_IDLE_MONTHS,
  SIGN_IN_ATTEMPT_DAYS_AFTER_EXPIRY,
  TEST_MAIL_DAYS,
  USAGE_DATA_DAYS,
} from "./periods.ts";
import { accountDeletionStatements } from "./rights.ts";
import { DAILY_RETENTION_DAYS, rollUpUsage, utcDay, utcMonth } from "./usage.ts";

/** Unused accounts deleted in one night. More than this wait for the next night. */
const ACCOUNTS_PER_RUN = 400;

interface Rule {
  readonly id: string;
  /** What the rule removes, in the dashboard's words. */
  readonly what: string;
  /** How long that is kept. */
  readonly kept: string;
  /** Counts the rows the rule would remove now. One row, one column named `n`. */
  readonly count: D1PreparedStatement;
  readonly apply: () => Promise<unknown>;
}

const rules = (env: Env, now: Date): ReadonlyArray<Rule> => {
  const db = env.DB;
  const iso = (date: Date): string => date.toISOString();
  const batch = (statements: Array<D1PreparedStatement>) => () => db.batch(statements);

  const attemptsBefore = iso(daysBefore(SIGN_IN_ATTEMPT_DAYS_AFTER_EXPIRY, now));
  const testMailBefore = iso(daysBefore(TEST_MAIL_DAYS, now));
  const usageDataBefore = utcDay(daysBefore(USAGE_DATA_DAYS, now));
  const choicesBefore = iso(daysBefore(USAGE_DATA_DAYS, now));
  const errorReportsBefore = utcDay(daysBefore(ERROR_REPORT_DAYS, now));
  const sessionsBefore = iso(monthsBefore(SESSION_IDLE_MONTHS, now));
  const accountsBefore = iso(monthsBefore(ACCOUNT_UNUSED_MONTHS, now));
  const mailClosedBefore = iso(monthsBefore(CONTACT_MAIL_MONTHS_AFTER_CLOSED, now));
  // A message nobody closed counts as closed CONTACT_MAIL_AUTO_CLOSE_DAYS after it arrived.
  const mailReceivedBefore = iso(daysBefore(CONTACT_MAIL_AUTO_CLOSE_DAYS, monthsBefore(CONTACT_MAIL_MONTHS_AFTER_CLOSED, now)));
  const acceptancesClosedBefore = iso(monthsBefore(ACCEPTANCE_YEARS_AFTER_CLOSURE * 12, now));
  const rightsLogBefore = iso(monthsBefore(RIGHTS_LOG_YEARS * 12, now));
  const dailyUsageBefore = `${utcMonth(daysBefore(DAILY_RETENTION_DAYS, now))}-01`;

  // Counters sit in fixed windows of a minute, an hour or a day; `bucket` is the window's number.
  const oldestBucket = (windowSeconds: number): string =>
    String(Math.floor(now.getTime() / 1000 / windowSeconds) - RATE_LIMIT_WINDOWS_KEPT);
  const oldCounters =
    "(key LIKE '%:60' AND bucket < ?) OR (key LIKE '%:3600' AND bucket < ?) " +
    // Daily SMS counts stay for the dashboard; everything else on a daily window can go.
    "OR (key LIKE '%:86400' AND key <> 'sms:all:86400' AND bucket < ?)";
  const counterBuckets = [oldestBucket(60), oldestBucket(3600), oldestBucket(86_400)];

  // An account is unused when everything that shows use is older than the period: its creation,
  // the last use recorded when a sign-in ended, its live sign-ins, and its metered days and months.
  // (A metered month counts as use until the whole month is past the period.)
  const unusedAccounts =
    "FROM users WHERE created_at < ? AND (last_active_at IS NULL OR last_active_at < ?) " +
    "AND NOT EXISTS (SELECT 1 FROM sessions WHERE sessions.user_id = users.id AND sessions.last_used_at >= ?) " +
    "AND NOT EXISTS (SELECT 1 FROM usage_daily WHERE usage_daily.user_id = users.id AND usage_daily.day >= ?) " +
    "AND NOT EXISTS (SELECT 1 FROM usage WHERE usage.user_id = users.id AND usage.month >= ?)";
  const unusedBindings = [accountsBefore, accountsBefore, accountsBefore, accountsBefore.slice(0, 10), accountsBefore.slice(0, 7)];

  const idleSessionLastUse = "(SELECT MAX(last_used_at) FROM sessions WHERE sessions.user_id = users.id AND sessions.last_used_at < ?)";

  return [
    {
      id: "sign_in_attempts",
      what: "Sign-in attempts, with any acceptance nobody completed",
      kept: `${SIGN_IN_ATTEMPT_DAYS_AFTER_EXPIRY} day after they expire`,
      count: db.prepare("SELECT COUNT(*) AS n FROM login_requests WHERE expires_at < ?").bind(attemptsBefore),
      apply: batch([db.prepare("DELETE FROM login_requests WHERE expires_at < ?").bind(attemptsBefore)]),
    },
    {
      id: "rate_limit_counters",
      what: "Rate-limit counters",
      kept: `${RATE_LIMIT_WINDOWS_KEPT} windows: minutes, hours, or two days`,
      count: db.prepare(`SELECT COUNT(*) AS n FROM rate_limits WHERE ${oldCounters}`).bind(...counterBuckets),
      apply: batch([db.prepare(`DELETE FROM rate_limits WHERE ${oldCounters}`).bind(...counterBuckets)]),
    },
    {
      id: "sessions",
      what: "Sign-ins not used",
      kept: `${SESSION_IDLE_MONTHS} months since last use`,
      count: db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE last_used_at < ?").bind(sessionsBefore),
      apply: batch([
        // The account keeps the date of its last use, which the unused-account rule reads.
        db
          .prepare(
            `UPDATE users SET last_active_at = ${idleSessionLastUse} ` +
              "WHERE id IN (SELECT user_id FROM sessions WHERE last_used_at < ?) " +
              `AND (last_active_at IS NULL OR last_active_at < ${idleSessionLastUse})`,
          )
          .bind(sessionsBefore, sessionsBefore, sessionsBefore),
        db.prepare("DELETE FROM sessions WHERE last_used_at < ?").bind(sessionsBefore),
      ]),
    },
    {
      id: "accounts",
      what: "Accounts not used, with their sign-ins, usage records and onboarding answers",
      kept: `${ACCOUNT_UNUSED_MONTHS} months without use`,
      count: db.prepare(`SELECT COUNT(*) AS n ${unusedAccounts}`).bind(...unusedBindings),
      apply: async () => {
        const found = await db
          .prepare(`SELECT id ${unusedAccounts} ORDER BY created_at LIMIT ${ACCOUNTS_PER_RUN}`)
          .bind(...unusedBindings)
          .all<{ id: string }>();
        const ids = found.results.map((row) => row.id);
        if (ids.length > 0) await db.batch(accountDeletionStatements(env, ids, iso(now)));
      },
    },
    {
      id: "usage_daily",
      what: "Day-by-day usage records, added into monthly totals",
      kept: `${DAILY_RETENTION_DAYS} days, to the end of that calendar month`,
      count: db.prepare("SELECT COUNT(*) AS n FROM usage_daily WHERE day < ?").bind(dailyUsageBefore),
      apply: () => rollUpUsage(env, now),
    },
    {
      id: "usage_data",
      what: "App usage events",
      kept: `${USAGE_DATA_DAYS} days`,
      count: db.prepare("SELECT COUNT(*) AS n FROM events WHERE day < ?").bind(usageDataBefore),
      apply: batch([db.prepare("DELETE FROM events WHERE day < ?").bind(usageDataBefore)]),
    },
    {
      id: "usage_data_choices",
      what: "Records of the usage-data choice",
      kept: `${USAGE_DATA_DAYS} days`,
      count: db.prepare("SELECT COUNT(*) AS n FROM usage_data_choices WHERE received_at < ?").bind(choicesBefore),
      apply: batch([db.prepare("DELETE FROM usage_data_choices WHERE received_at < ?").bind(choicesBefore)]),
    },
    {
      id: "error_reports",
      what: "Error reports",
      kept: `${ERROR_REPORT_DAYS} days`,
      count: db.prepare("SELECT COUNT(*) AS n FROM crash_reports WHERE day < ?").bind(errorReportsBefore),
      apply: batch([db.prepare("DELETE FROM crash_reports WHERE day < ?").bind(errorReportsBefore)]),
    },
    {
      id: "contact_mail",
      what: "Messages sent to the contact addresses",
      kept: `${CONTACT_MAIL_MONTHS_AFTER_CLOSED} months after the matter is closed (closed automatically ${CONTACT_MAIL_AUTO_CLOSE_DAYS} days after arrival)`,
      count: db
        .prepare("SELECT COUNT(*) AS n FROM contact_mail WHERE closed_at < ? OR (closed_at IS NULL AND received_at < ?)")
        .bind(mailClosedBefore, mailReceivedBefore),
      apply: batch([
        db.prepare("DELETE FROM contact_mail WHERE closed_at < ? OR (closed_at IS NULL AND received_at < ?)").bind(mailClosedBefore, mailReceivedBefore),
      ]),
    },
    {
      id: "test_mail",
      what: "Mail to the test mailboxes",
      kept: `${TEST_MAIL_DAYS} day`,
      count: db.prepare("SELECT COUNT(*) AS n FROM test_inbox WHERE address LIKE 'e2e-%' AND received_at < ?").bind(testMailBefore),
      apply: batch([db.prepare("DELETE FROM test_inbox WHERE address LIKE 'e2e-%' AND received_at < ?").bind(testMailBefore)]),
    },
    {
      id: "acceptances",
      what: "Proof of acceptance of the Terms, for accounts that were deleted",
      kept: `${ACCEPTANCE_YEARS_AFTER_CLOSURE} years after the account was deleted`,
      count: db.prepare("SELECT COUNT(*) AS n FROM acceptances WHERE account_closed_at < ?").bind(acceptancesClosedBefore),
      apply: batch([db.prepare("DELETE FROM acceptances WHERE account_closed_at < ?").bind(acceptancesClosedBefore)]),
    },
    {
      id: "rights_requests",
      what: "The log of rights requests handled",
      kept: `${RIGHTS_LOG_YEARS} years`,
      count: db.prepare("SELECT COUNT(*) AS n FROM rights_requests WHERE handled_at < ?").bind(rightsLogBefore),
      apply: batch([db.prepare("DELETE FROM rights_requests WHERE handled_at < ?").bind(rightsLogBefore)]),
    },
    {
      id: "deletion_receipts",
      what: "Confirmations kept for a repeated account deletion",
      kept: "1 day",
      count: db.prepare("SELECT COUNT(*) AS n FROM deletion_receipts WHERE expires_at < ?").bind(iso(now)),
      apply: batch([db.prepare("DELETE FROM deletion_receipts WHERE expires_at < ?").bind(iso(now))]),
    },
  ];
};

export interface RetentionLine {
  readonly id: string;
  readonly what: string;
  readonly kept: string;
  /** Rows the rule removes: counted before a run, and what a dry run reports. */
  readonly rows: number;
  /** Set when the rule was run and failed. */
  readonly error?: string;
}

export interface RetentionReport {
  readonly at: string;
  /** False for a dry run: nothing was changed. */
  readonly applied: boolean;
  readonly rules: ReadonlyArray<RetentionLine>;
}

const counted = async (env: Env, list: ReadonlyArray<Rule>): Promise<Array<RetentionLine>> => {
  const results = (await env.DB.batch(list.map((rule) => rule.count))) as Array<D1Result<{ n: number }>>;
  return list.map((rule, index) => ({ id: rule.id, what: rule.what, kept: rule.kept, rows: results[index]?.results[0]?.n ?? 0 }));
};

/** The dry run: what tonight's job would delete. Reads only. */
export const retentionReport = async (env: Env, now = new Date()): Promise<RetentionReport> => ({
  at: now.toISOString(),
  applied: false,
  rules: await counted(env, rules(env, now)),
});

/** Applies every rule. The report says what each removed; a failed rule is named in it. */
export const applyRetention = async (env: Env, now = new Date()): Promise<RetentionReport> => {
  const list = rules(env, now);
  const lines = await counted(env, list);
  for (const [index, rule] of list.entries()) {
    try {
      await rule.apply();
    } catch (cause) {
      const line = lines[index];
      if (line !== undefined) lines[index] = { ...line, error: cause instanceof Error ? cause.message : String(cause) };
    }
  }
  return { at: now.toISOString(), applied: true, rules: lines };
};

/** The scheduled entry point. Logs counts only, never an identifier. */
export const nightly = async (env: Env): Promise<void> => {
  const report = await applyRetention(env);
  console.log("retention", report.rules.map((line) => `${line.id}=${line.error === undefined ? line.rows : "failed"}`).join(" "));
  const failed = report.rules.filter((line) => line.error !== undefined);
  if (failed.length > 0) throw new Error(`Retention rules failed: ${failed.map((line) => `${line.id} (${line.error})`).join("; ")}`);
};

// ---------------------------------------------------------------------------------------------
// One-off: usage events collected under the old identifiers
//
// Apps up to 0.1.x sent each event with a `distinct_id` that was the SHA-256 of the person's
// ChatGPT workspace id or Claude user id when either existed, and a separate `installId` that was
// the SHA-256 of a random identifier. Both were stored. So the events in the table are of three kinds,
// and the table itself says which is which:
//
//   provider   `distinct_id` differs from `install_id` (or there is no `install_id`): the stored
//              `distinct_id` came from an AI-provider account. Also every `install.owner_observed`
//              event, whose properties hold hashes of provider accounts, and every
//              `onboarding.profile_answered` event, which repeats the account's onboarding answers.
//   legacy     everything an app sent before it had a random identifier: the identifier is 64
//              hexadecimal characters, where the new one is a UUID of 36. This includes the
//              `provider` kind. It also includes events whose own identifier was not derived from
//              an account but which sit beside events that were, from the same installation, and
//              which were collected before the first-run choice existed.
//   before     every event before a given day, whatever it carries.
//
// `provider` removes exactly the rows that hold an account-derived value. It leaves the other events
// of the same installations, which is why consent-spec 11.6 asks for more: after the apps switch,
// run `legacy` (or `before` with the switch date). Removing a row here removes it from the live
// database; the hosting provider's point-in-time backups keep it for up to 30 more days.

export type UsageEventScope = "provider" | "legacy" | "before";

const scopeCondition = (scope: UsageEventScope): string =>
  scope === "provider"
    ? "(install_id IS NULL OR distinct_id <> install_id OR event IN ('install.owner_observed', 'onboarding.profile_answered'))"
    : scope === "legacy"
      ? "(install_id IS NULL OR length(install_id) <> 36 OR distinct_id <> install_id)"
      : "day < ?";

/**
 * Counts, and when `apply` is true deletes, the usage events in `scope`. `before` is a day
 * (YYYY-MM-DD) and is needed for the `before` scope only.
 */
export const cleanUsageEvents = async (env: Env, scope: UsageEventScope, before: string | null, apply: boolean) => {
  const condition = scopeCondition(scope);
  const bindings = scope === "before" ? [before] : [];
  const [matching, all] = (await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) AS n, MIN(day) AS first_day, MAX(day) AS last_day FROM events WHERE ${condition}`).bind(...bindings),
    env.DB.prepare("SELECT COUNT(*) AS n FROM events"),
  ])) as Array<D1Result<{ n: number; first_day?: string | null; last_day?: string | null }>>;
  if (apply) await env.DB.prepare(`DELETE FROM events WHERE ${condition}`).bind(...bindings).run();
  const found = matching?.results[0];
  return {
    scope,
    before: scope === "before" ? before : null,
    applied: apply,
    events: found?.n ?? 0,
    firstDay: found?.first_day ?? null,
    lastDay: found?.last_day ?? null,
    eventsInTable: all?.results[0]?.n ?? 0,
  };
};
