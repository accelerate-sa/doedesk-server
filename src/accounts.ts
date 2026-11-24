// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Accelerate Technology Establishment
import { ApiError, type Env, json, monthsBefore, nowIso, randomToken, rateLimit, readJson, sha256Hex, text } from "./http.ts";
import { isFrozen } from "./maintenance.ts";
import { SESSION_IDLE_MONTHS } from "./periods.ts";
import { defaultAccountRegion } from "./regions.ts";
import { extension, workerDecision } from "./extension.ts";
import { type AccountRegion, accountRegion, workerDescription, workerNotIncluded } from "./worker-regions.ts";

export const SESSION_CLIENTS = ["desktop", "web", "mobile", "server", "site"] as const;
export type SessionClient = (typeof SESSION_CLIENTS)[number];

export const sessionClient = (value: unknown): SessionClient =>
  SESSION_CLIENTS.includes(value as SessionClient) ? (value as SessionClient) : "web";

export const FIELDS = [
  "legal",
  "finance",
  "government",
  "healthcare",
  "hr",
  "real_estate",
  "consulting",
  "engineering",
  "research",
  "other",
] as const;

export const WORKPLACES = ["self", "small_company", "large_company", "government"] as const;

export interface Account {
  readonly userId: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly isAdmin: boolean;
  readonly profileAnswered: boolean;
  readonly field: string | null;
  readonly workplace: string | null;
  /** Where the worker for this account's sealed documents runs. See worker-regions.ts. */
  readonly region: AccountRegion;
  /** When the person last changed the region. Null: it is what the account started with. */
  readonly regionUpdatedAt: string | null;
}

/** An account as a request presents it: with the client its session was made for. */
export type SignedIn = Account & { readonly client: SessionClient };

interface UserRow {
  readonly id: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly is_admin: number;
  readonly profile_at: string | null;
  readonly field: string | null;
  readonly workplace: string | null;
  readonly region: string;
  readonly region_updated_at: string | null;
}

const accountOf = (row: UserRow): Account => ({
  userId: row.id,
  email: row.email,
  phone: row.phone,
  isAdmin: row.is_admin === 1,
  profileAnswered: row.profile_at !== null,
  field: row.field,
  workplace: row.workplace,
  // A value no code wrote reads as the region with no restriction, never as someone else's.
  region: accountRegion(row.region) ?? "global",
  regionUpdatedAt: row.region_updated_at,
});

const USER_COLUMNS = "users.id, users.email, users.phone, users.is_admin, users.profile_at, users.field, users.workplace, users.region, users.region_updated_at";

/** What the apps show for an account. A phone number is shown with its middle hidden. */
export const publicAccount = (account: Account) => ({
  id: account.userId,
  email: account.email,
  phone: account.phone === null ? null : `${account.phone.slice(0, 6)}•••${account.phone.slice(-3)}`,
  profileAnswered: account.profileAnswered,
  region: account.region,
  regionUpdatedAt: account.regionUpdatedAt,
});

/**
 * The account for a verified number or address, made now if there is none. `refuseNew`, when given,
 * is raised instead of making one: an existing account is still found and signed in.
 */
export const findOrCreateUser = async (
  env: Env,
  identifier: { readonly kind: "email" | "phone"; readonly value: string },
  country: string | null,
  refuseNew: ApiError | null = null,
): Promise<{ readonly account: Account; readonly created: boolean }> => {
  const column = identifier.kind === "email" ? "email" : "phone";
  const existing = await env.DB.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE ${column} = ?`)
    .bind(identifier.value)
    .first<UserRow>();
  if (existing !== null) return { account: accountOf(existing), created: false };
  if (refuseNew !== null) throw refuseNew;
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO users (id, ${column}, created_at, country, signup_method, region) VALUES (?, ?, ?, ?, ?, ?) ` +
      `ON CONFLICT (${column}) DO NOTHING`,
  )
    // The region is guessed here, once. No later sign-in changes it; only the person does.
    .bind(id, identifier.value, nowIso(), country, identifier.kind, defaultAccountRegion(identifier.kind, country))
    .run();
  // Two sign-ins for a new identifier can race; whichever row won is the account.
  const row = await env.DB.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE ${column} = ?`)
    .bind(identifier.value)
    .first<UserRow>();
  if (row === null) throw new ApiError(500, "internal", "The account could not be created.");
  return { account: accountOf(row), created: row.id === id };
};

/**
 * What a sign-in was made for, when the app said so. `delete_account` is the sign-in that confirms
 * "Delete my account": it is let through without an acceptance of the Terms even when one is
 * required, so that a person can always delete their account. In exchange it never creates an
 * account, and its session may read, export and delete the account and do nothing else.
 */
export type SignInPurpose = "delete_account";

export const signInPurpose = (value: unknown): SignInPurpose | null => {
  if (value === undefined || value === null) return null;
  if (value === "delete_account") return value;
  throw new ApiError(400, "invalid_request", "`purpose` must be \"delete_account\" or left out.");
};

/**
 * `verified` says the session comes straight from a code or link that was just verified, and not
 * from another session. Only such a session, while it is minutes old, may delete the account.
 */
export const createSession = async (
  env: Env,
  userId: string,
  client: SessionClient,
  device: string | null,
  verified = false,
  purpose: SignInPurpose | null = null,
): Promise<string> => {
  const token = `dd_${randomToken()}`;
  const now = nowIso();
  await env.DB.prepare(
    "INSERT INTO sessions (token_hash, user_id, client, device, created_at, last_used_at, signed_in_at, purpose) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(await sha256Hex(token), userId, client, device, now, now, verified ? now : null, purpose)
    .run();
  return token;
};

export const bearerToken = (request: Request): string => {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
};

/**
 * `deletionOnly` is passed by the few requests a deletion-only session may make: reading the
 * account, exporting it and deleting it. Every other request refuses such a session.
 */
export const authenticate = async (request: Request, env: Env, allow: { readonly deletionOnly?: boolean } = {}): Promise<SignedIn> => {
  const token = bearerToken(request);
  if (token.length === 0) throw new ApiError(401, "unauthenticated", "Sign in to DoeDesk.");
  return authenticateToken(env, token, allow);
};

export const authenticateToken = async (env: Env, token: string, allow: { readonly deletionOnly?: boolean } = {}): Promise<SignedIn> => {
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT ${USER_COLUMNS}, sessions.last_used_at AS last_used_at, sessions.client AS client, sessions.purpose AS purpose FROM sessions ` +
      "JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ?",
  )
    .bind(tokenHash)
    .first<UserRow & { last_used_at: string; client: string; purpose: string | null }>();
  // A session unused for SESSION_IDLE_MONTHS has expired, whether or not the nightly job has removed
  // it yet. Each day of use moves the date forward, so an app in use is never signed out.
  if (row === null || row.last_used_at < monthsBefore(SESSION_IDLE_MONTHS).toISOString()) {
    throw new ApiError(401, "unauthenticated", "This sign-in has ended. Sign in again.");
  }
  if (row.purpose === "delete_account" && allow.deletionOnly !== true) {
    throw new ApiError(403, "deletion_only_sign_in", "This sign-in can only delete the account. Sign in again to use DoeDesk Cloud.");
  }
  // Worth a write once a day, not on every request. Not at all while frozen for a move.
  if (!isFrozen(env) && row.last_used_at.slice(0, 10) !== nowIso().slice(0, 10)) {
    await env.DB.prepare("UPDATE sessions SET last_used_at = ? WHERE token_hash = ?").bind(nowIso(), tokenHash).run();
  }
  return { ...accountOf(row), client: sessionClient(row.client) };
};

export const endSession = async (env: Env, token: string): Promise<void> => {
  const tokenHash = await sha256Hex(token);
  await env.DB.batch([
    // Once the session is gone nothing else says when the account was last used, and the rule that
    // deletes unused accounts needs to know.
    env.DB.prepare(
      "UPDATE users SET last_active_at = (SELECT last_used_at FROM sessions WHERE token_hash = ?) " +
        "WHERE id = (SELECT user_id FROM sessions WHERE token_hash = ?) " +
        "AND (last_active_at IS NULL OR last_active_at < (SELECT last_used_at FROM sessions WHERE token_hash = ?))",
    ).bind(tokenHash, tokenHash, tokenHash),
    env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash),
  ]);
};

export const saveProfile = async (
  env: Env,
  userId: string,
  body: Record<string, unknown>,
): Promise<void> => {
  const field = FIELDS.includes(body.field as (typeof FIELDS)[number]) ? (body.field as string) : null;
  const workplace = WORKPLACES.includes(body.workplace as (typeof WORKPLACES)[number])
    ? (body.workplace as string)
    : null;
  await env.DB.prepare("UPDATE users SET field = ?, field_other = ?, workplace = ?, profile_at = ? WHERE id = ?")
    .bind(field, field === "other" ? text(body.fieldOther, 80) : null, workplace, nowIso(), userId)
    .run();
};

/**
 * POST /v1/me/region `{ "region": "sa" | "eu" | "global" }`. The person's own choice of where the
 * worker for their sealed documents runs. It takes effect with the next request to the worker.
 * Each change is added to the account's history; choosing the region the account already has
 * changes nothing and adds nothing. The region governs only the hosted worker, so an account
 * without it is refused and nothing is recorded for it.
 */
export const changeRegion = async (request: Request, env: Env): Promise<Response> => {
  const account = await authenticate(request, env);
  const decision = await workerDecision(env, account);
  if (!decision.included) throw decision.refusal ?? workerNotIncluded();
  const region = accountRegion((await readJson(request)).region);
  if (region === null) throw new ApiError(400, "invalid_request", "`region` must be \"sa\", \"eu\" or \"global\".");
  // A layer beside the service may hold the account to certain regions (src/extension.ts).
  if (region !== account.region) await extension().regionChange?.(env, account, region);
  let regionUpdatedAt = account.regionUpdatedAt;
  if (region !== account.region) {
    await rateLimit(env, `region:${account.userId}`, 3600, 20, "Too many changes of region. Try again in an hour.");
    regionUpdatedAt = nowIso();
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET region = ?, region_updated_at = ? WHERE id = ?").bind(region, regionUpdatedAt, account.userId),
      env.DB.prepare("INSERT INTO region_changes (id, user_id, from_region, to_region, changed_at, client) VALUES (?, ?, ?, ?, ?, ?)").bind(
        crypto.randomUUID(),
        account.userId,
        account.region,
        region,
        regionUpdatedAt,
        account.client,
      ),
    ]);
  }
  return json({ region, regionUpdatedAt, worker: workerDescription(env, region, await workerDecision(env, { ...account, region })) });
};
