// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Accelerate Technology Establishment
/**
 * The rights the Privacy Policy gives a person (section 13), as things the service does:
 * deleting an account with everything tied to it, giving a copy of everything held about it, and
 * keeping a log of the requests that were handled.
 *
 * WHAT A DELETED ACCOUNT LEAVES BEHIND, AND WHY
 * One thing is kept: the record that the account's holder accepted the Terms of Use (the rows in
 * `acceptances`), for ACCEPTANCE_YEARS_AFTER_CLOSURE years, after which the nightly job deletes it.
 * It is kept because it is the only proof of the agreement if a dispute comes after the account is
 * gone; `legal/consent-spec.md` section 5 sets the period. It is cut down when the account goes:
 * the country and the link to the sign-in attempt are cleared, and what remains names no person,
 * only the account's internal identifier, which the deletion confirmation gives to the person and
 * the rights log keeps. Everything else tied to the account is deleted in the same step.
 *
 * Not tied to the account, so not found by deleting it: usage data from the app (it carries an
 * installation identifier, never the account; the owner deletes it by that identifier), mail the
 * person sent (kept by its own rule), and this log's own entry for the deletion.
 */
import { acceptanceStatus } from "./acceptance.ts";
import { authenticate, bearerToken } from "./accounts.ts";
import { ApiError, daysBefore, type Env, json, nowIso, rateLimit, sha256Hex } from "./http.ts";
import { ACCEPTANCE_YEARS_AFTER_CLOSURE, DELETE_NEEDS_SIGN_IN_WITHIN_MINUTES, DELETION_RECEIPT_DAYS } from "./periods.ts";
import { extension } from "./extension.ts";
import { COUNTERS } from "./usage.ts";

// ---------------------------------------------------------------------------------------------
// The log of requests handled

export const RIGHTS_TYPES = ["access", "deletion", "correction", "withdrawal", "objection", "restriction", "other"] as const;
export type RightsType = (typeof RIGHTS_TYPES)[number];
export const RIGHTS_OUTCOMES = ["done", "refused", "not_found"] as const;
export type RightsOutcome = (typeof RIGHTS_OUTCOMES)[number];
/** app: the person, signed in. email: the owner, acting on a request that came by mail. */
export type RightsChannel = "app" | "email";

export interface RightsEntry {
  readonly type: RightsType;
  readonly channel: RightsChannel;
  readonly outcome: RightsOutcome;
  /** The account's internal identifier, when the request was about an account. */
  readonly accountId: string | null;
}

/** One line in the log. Never any content of the request, and never an email address or number. */
export const logRightsRequest = (env: Env, entry: RightsEntry, handledAt = nowIso()): D1PreparedStatement =>
  env.DB.prepare("INSERT INTO rights_requests (id, handled_at, type, channel, outcome, account_id) VALUES (?, ?, ?, ?, ?, ?)").bind(
    crypto.randomUUID(),
    handledAt,
    entry.type,
    entry.channel,
    entry.outcome,
    entry.accountId,
  );

// ---------------------------------------------------------------------------------------------
// Deleting accounts

/** Accounts per statement. Each statement binds an identifier at most twice; D1 allows 100 bindings. */
const ACCOUNTS_PER_STATEMENT = 40;

/** Until when the acceptance record of an account closed at `closedAt` is kept. */
export const acceptanceKeptUntil = (closedAt: string): string => {
  const until = new Date(closedAt);
  until.setUTCFullYear(until.getUTCFullYear() + ACCEPTANCE_YEARS_AFTER_CLOSURE);
  return until.toISOString();
};

/**
 * The statements that delete the given accounts and everything tied to them, for one batch.
 * A batch is applied whole or not at all, and running it again for accounts that are already gone
 * changes nothing. Rows that refer to an account go before the account itself.
 */
export const accountDeletionStatements = (env: Env, accountIds: ReadonlyArray<string>, closedAt: string): Array<D1PreparedStatement> => {
  const statements: Array<D1PreparedStatement> = [];
  for (let start = 0; start < accountIds.length; start += ACCOUNTS_PER_STATEMENT) {
    const ids = accountIds.slice(start, start + ACCOUNTS_PER_STATEMENT);
    const marks = ids.map(() => "?").join(", ");
    const accounts = `(SELECT id FROM users WHERE id IN (${marks}))`;
    statements.push(
      // Sign-in attempts in progress for the account's number or address.
      env.DB.prepare(`DELETE FROM login_requests WHERE identifier IN (SELECT email FROM users WHERE id IN (${marks}) AND email IS NOT NULL)`).bind(...ids),
      env.DB.prepare(`DELETE FROM login_requests WHERE identifier IN (SELECT phone FROM users WHERE id IN (${marks}) AND phone IS NOT NULL)`).bind(...ids),
      // Counters whose key holds the number, the address or the account. They would go within hours anyway.
      ...[
        ["'mail:to:' || email || ':60'", "email"],
        ["'mail:to:' || email || ':3600'", "email"],
        ["'sms:phone:' || phone || ':60'", "phone"],
        ["'sms:phone:' || phone || ':3600'", "phone"],
        ["'export:' || id || ':3600'", "id"],
        ["'region:' || id || ':3600'", "id"],
      ].map(([key, column]) =>
        env.DB.prepare(`DELETE FROM rate_limits WHERE key IN (SELECT ${key} FROM users WHERE id IN (${marks}) AND ${column} IS NOT NULL)`).bind(...ids),
      ),
      env.DB.prepare(`DELETE FROM sessions WHERE user_id IN ${accounts}`).bind(...ids),
      env.DB.prepare(`DELETE FROM usage_daily WHERE user_id IN ${accounts}`).bind(...ids),
      env.DB.prepare(`DELETE FROM usage WHERE user_id IN ${accounts}`).bind(...ids),
      // The history of the account's region. The region itself goes with the account's row.
      env.DB.prepare(`DELETE FROM region_changes WHERE user_id IN ${accounts}`).bind(...ids),
      // The proof of acceptance stays for a fixed time, cut down to what proves it (see the top of this file).
      env.DB.prepare(
        `UPDATE acceptances SET account_closed_at = ?, login_request_id = NULL, country = NULL WHERE account_closed_at IS NULL AND user_id IN ${accounts}`,
      ).bind(closedAt, ...ids),
      // What a layer beside the service holds about the accounts (src/extension.ts).
      ...(extension().deletionStatements?.(env, ids) ?? []),
      // Last: the account, with the number or address and the onboarding answers.
      env.DB.prepare(`DELETE FROM users WHERE id IN (${marks})`).bind(...ids),
    );
  }
  return statements;
};

const confirmation = (accountId: string, deletedAt: string, keptUntil: string) => ({
  deleted: true,
  accountId,
  deletedAt,
  // What outlives the account, so the app can tell the person.
  kept: [
    {
      record: "terms_acceptance",
      until: keptUntil,
      reason: "Proof that the account holder accepted the Terms of Use. It names the account by its identifier only.",
    },
  ],
  // What was never tied to the account, and how to have it removed.
  notCovered: [
    { data: "usage_data", how: "Turn it off in Settings, and quote the installation identifier shown there to privacy@doedesk.com." },
    { data: "messages", how: "Mail sent to DoeDesk is deleted 12 months after the matter is closed, or on request." },
  ],
});

/** Deletes one account and writes the log line, for the owner acting on a request that came by mail. */
export const deleteAccountForOwner = async (env: Env, accountId: string): Promise<ReturnType<typeof confirmation> | null> => {
  const exists = await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(accountId).first<{ id: string }>();
  const deletedAt = nowIso();
  if (exists === null) {
    await logRightsRequest(env, { type: "deletion", channel: "email", outcome: "not_found", accountId }, deletedAt).run();
    return null;
  }
  await env.DB.batch([
    ...accountDeletionStatements(env, [accountId], deletedAt),
    logRightsRequest(env, { type: "deletion", channel: "email", outcome: "done", accountId }, deletedAt),
  ]);
  return confirmation(accountId, deletedAt, acceptanceKeptUntil(deletedAt));
};

/**
 * DELETE /v1/me. Deletes the signed-in account.
 *
 * Safe against accidents and against a stolen token: the session must come straight from a code or
 * link verified in the last few minutes, so the app asks the person to sign in again first. A
 * session made from another session never qualifies.
 *
 * Safe to repeat: the session that deleted the account gets the same confirmation again for a day,
 * so a request whose answer was lost can simply be sent again.
 */
export const deleteMe = async (request: Request, env: Env): Promise<Response> => {
  const token = bearerToken(request);
  const tokenHash = await sha256Hex(token);
  let accountId: string;
  try {
    accountId = (await authenticate(request, env, { deletionOnly: true })).userId;
  } catch (cause) {
    const receipt =
      token.length === 0
        ? null
        : await env.DB.prepare("SELECT account_id, deleted_at, kept_until FROM deletion_receipts WHERE token_hash = ? AND expires_at > ?")
            .bind(tokenHash, nowIso())
            .first<{ account_id: string; deleted_at: string; kept_until: string }>();
    if (receipt === null) throw cause;
    return json(confirmation(receipt.account_id, receipt.deleted_at, receipt.kept_until));
  }
  const session = await env.DB.prepare("SELECT signed_in_at FROM sessions WHERE token_hash = ?")
    .bind(tokenHash)
    .first<{ signed_in_at: string | null }>();
  const earliest = new Date(Date.now() - DELETE_NEEDS_SIGN_IN_WITHIN_MINUTES * 60_000).toISOString();
  if (session === null || session.signed_in_at === null || session.signed_in_at < earliest) {
    throw new ApiError(403, "recent_sign_in_required", "To delete your account, sign in again first, then confirm the deletion.", {
      maxAgeSeconds: DELETE_NEEDS_SIGN_IN_WITHIN_MINUTES * 60,
    });
  }
  const deletedAt = nowIso();
  const keptUntil = acceptanceKeptUntil(deletedAt);
  await env.DB.batch([
    ...accountDeletionStatements(env, [accountId], deletedAt),
    logRightsRequest(env, { type: "deletion", channel: "app", outcome: "done", accountId }, deletedAt),
    env.DB.prepare(
      "INSERT INTO deletion_receipts (token_hash, account_id, deleted_at, kept_until, expires_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (token_hash) DO NOTHING",
    ).bind(tokenHash, accountId, deletedAt, keptUntil, daysBefore(-DELETION_RECEIPT_DAYS).toISOString()),
  ]);
  return json(confirmation(accountId, deletedAt, keptUntil));
};

// ---------------------------------------------------------------------------------------------
// A copy of everything held about an account

interface UserRow {
  readonly id: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly created_at: string;
  readonly country: string | null;
  readonly signup_method: string;
  readonly field: string | null;
  readonly field_other: string | null;
  readonly workplace: string | null;
  readonly profile_at: string | null;
  readonly last_active_at: string | null;
  readonly region: string;
  readonly region_updated_at: string | null;
}

/**
 * Everything the service holds about one account, as plain JSON. Null when there is no such account.
 * Hashes of secrets (session tokens, codes, link secrets) are left out: they are of no use to the
 * person and are not data about them.
 */
export const exportAccount = async (env: Env, accountId: string, currentTokenHash: string | null = null) => {
  const user = await env.DB.prepare(
    "SELECT id, email, phone, created_at, country, signup_method, field, field_other, workplace, profile_at, last_active_at, region, region_updated_at FROM users WHERE id = ?",
  )
    .bind(accountId)
    .first<UserRow>();
  if (user === null) return null;
  const identifiers = [user.email, user.phone].filter((value): value is string => value !== null);
  const counterKeys = [
    ...(user.email === null ? [] : [`mail:to:${user.email}:60`, `mail:to:${user.email}:3600`]),
    ...(user.phone === null ? [] : [`sms:phone:${user.phone}:60`, `sms:phone:${user.phone}:3600`]),
    `export:${user.id}:3600`,
    `region:${user.id}:3600`,
  ];
  const marks = (values: ReadonlyArray<unknown>): string => values.map(() => "?").join(", ");
  const [sessions, attempts, daily, monthly, acceptances, requests, counters, regionChanges] = (await env.DB.batch([
    env.DB.prepare("SELECT token_hash, client, device, created_at, last_used_at, signed_in_at, purpose FROM sessions WHERE user_id = ? ORDER BY created_at").bind(accountId),
    env.DB.prepare(
      `SELECT kind, client, device, country, city, attempts, status, created_at, expires_at, acceptance FROM login_requests WHERE identifier IN (${marks(identifiers)}) ORDER BY created_at`,
    ).bind(...identifiers),
    env.DB.prepare(`SELECT day, client, ${COUNTERS.join(", ")} FROM usage_daily WHERE user_id = ? ORDER BY day, client`).bind(accountId),
    env.DB.prepare(`SELECT month, ${COUNTERS.join(", ")} FROM usage WHERE user_id = ? ORDER BY month`).bind(accountId),
    env.DB.prepare(
      "SELECT id, document, decision, terms_version, privacy_version, terms_sha256, privacy_sha256, wording_id, locale, method, identifier_kind, " +
        "client, app_version, accepted_at, country FROM acceptances WHERE user_id = ? ORDER BY accepted_at",
    ).bind(accountId),
    env.DB.prepare("SELECT handled_at, type, channel, outcome FROM rights_requests WHERE account_id = ? ORDER BY handled_at").bind(accountId),
    env.DB.prepare(`SELECT key, bucket, count FROM rate_limits WHERE key IN (${marks(counterKeys)})`).bind(...counterKeys),
    env.DB.prepare("SELECT from_region, to_region, changed_at, client FROM region_changes WHERE user_id = ? ORDER BY changed_at").bind(accountId),
  ])) as Array<D1Result<Record<string, unknown>>>;
  const rows = (result: D1Result<Record<string, unknown>> | undefined) => result?.results ?? [];
  return {
    ...((await extension().exportAccount?.(env, accountId)) ?? {}),
    exportedAt: nowIso(),
    about: "Everything DoeDesk Cloud holds about this account. Times are UTC. See https://doedesk.com/privacy.",
    account: {
      id: user.id,
      email: user.email,
      phone: user.phone,
      createdAt: user.created_at,
      signUpMethod: user.signup_method,
      signUpCountry: user.country,
      lastActiveAt: user.last_active_at,
      // Where the worker that reads this account's sealed files runs: sa, eu or global.
      region: user.region,
      regionUpdatedAt: user.region_updated_at,
    },
    regionHistory: rows(regionChanges),
    onboardingAnswers: {
      field: user.field,
      fieldOther: user.field_other,
      workplace: user.workplace,
      answeredAt: user.profile_at,
    },
    termsAcceptance: { status: await acceptanceStatus(env, accountId), history: rows(acceptances) },
    signIns: rows(sessions).map(({ token_hash, ...session }) => ({ ...session, thisSignIn: token_hash === currentTokenHash })),
    signInAttempts: rows(attempts).map(({ acceptance, ...attempt }) => ({
      ...attempt,
      acceptance: typeof acceptance === "string" ? (JSON.parse(acceptance) as unknown) : null,
    })),
    usage: {
      about: "Counts only. No text, file or detected item is stored, and nothing sent to the worker or answered by it. `daily` is per UTC day and kind of app; `monthly` holds older months as one total each.",
      daily: rows(daily),
      monthly: rows(monthly),
    },
    rightsRequests: rows(requests),
    rateLimitCounters: rows(counters),
    notIncluded: [
      "Usage data sent by the app: it carries an installation identifier and never the account, so it cannot be found from the account. Quote the installation identifier shown in Settings to privacy@doedesk.com.",
      "Messages you sent to hello@, privacy@, security@ or legal@doedesk.com: ask at privacy@doedesk.com.",
      "Text and files sent for detection and reading, and what is sent to the worker and what it answers: they are not stored.",
      "Our hosting provider's technical request logs, kept for up to 7 days.",
    ],
  };
};

/** GET /v1/me/export. Any valid sign-in may ask; ten copies an hour is plenty. */
export const exportMe = async (request: Request, env: Env): Promise<Response> => {
  const account = await authenticate(request, env, { deletionOnly: true });
  await rateLimit(env, `export:${account.userId}`, 3600, 10, "Too many copies asked for. Try again in an hour.");
  const copy = await exportAccount(env, account.userId, await sha256Hex(bearerToken(request)));
  if (copy === null) throw new ApiError(401, "unauthenticated", "This sign-in has ended. Sign in again.");
  await logRightsRequest(env, { type: "access", channel: "app", outcome: "done", accountId: account.userId }).run();
  return json(copy);
};

// ---------------------------------------------------------------------------------------------
// Usage data, found by the installation identifier a person quotes from Settings

/** A random UUID (new apps) or 64 hexadecimal characters (apps up to 0.1.x). */
export const isInstallationIdentifier = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value) || /^[0-9a-f]{64}$/.test(value);

export const exportUsageData = async (env: Env, installationId: string) => {
  const [events, choices, reports] = (await env.DB.batch([
    env.DB.prepare(
      "SELECT uuid, event, at, received_at, country, app_version, platform, surface, properties FROM events WHERE install_id = ? OR distinct_id = ? ORDER BY at",
    ).bind(installationId, installationId),
    env.DB.prepare(
      "SELECT state, basis, signal, wording_id, locale, chosen_at, received_at, country, app_version FROM usage_data_choices WHERE install_id = ? ORDER BY received_at",
    ).bind(installationId),
    env.DB.prepare("SELECT received_at, source, app_version, platform, message, detail FROM crash_reports WHERE install_id = ? ORDER BY received_at").bind(
      installationId,
    ),
  ])) as Array<D1Result<Record<string, unknown>>>;
  return {
    exportedAt: nowIso(),
    installationIdentifier: installationId,
    events: (events?.results ?? []).map(({ properties, ...event }) => ({
      ...event,
      properties: typeof properties === "string" ? (JSON.parse(properties) as unknown) : properties,
    })),
    choices: choices?.results ?? [],
    errorReports: reports?.results ?? [],
  };
};

/** How many rows carry the identifier, per table. */
export const countUsageData = async (env: Env, installationId: string) => {
  const [events, choices, reports] = (await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE install_id = ? OR distinct_id = ?").bind(installationId, installationId),
    env.DB.prepare("SELECT COUNT(*) AS n FROM usage_data_choices WHERE install_id = ?").bind(installationId),
    env.DB.prepare("SELECT COUNT(*) AS n FROM crash_reports WHERE install_id = ?").bind(installationId),
  ])) as Array<D1Result<{ n: number }>>;
  const n = (result: D1Result<{ n: number }> | undefined): number => result?.results[0]?.n ?? 0;
  return { events: n(events), choices: n(choices), errorReports: n(reports) };
};

export const deleteUsageData = async (env: Env, installationId: string) => {
  const counts = await countUsageData(env, installationId);
  const found = counts.events + counts.choices + counts.errorReports > 0;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM events WHERE install_id = ? OR distinct_id = ?").bind(installationId, installationId),
    env.DB.prepare("DELETE FROM usage_data_choices WHERE install_id = ?").bind(installationId),
    env.DB.prepare("DELETE FROM crash_reports WHERE install_id = ?").bind(installationId),
    logRightsRequest(env, { type: "deletion", channel: "email", outcome: found ? "done" : "not_found", accountId: null }),
  ]);
  return counts;
};
