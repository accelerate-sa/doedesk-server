// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Accelerate Technology Establishment
/**
 * Usage data from the apps (which features are used), the choice an installation made about it,
 * and error reports. None of it is tied to an account: these routes take no sign-in, ignore one
 * that is sent, and store no account identifier, phone number, email address or IP address.
 *
 * The rules are `legal/consent-spec.md` section 11 and Privacy Policy 4.5.
 */
import { ApiError, type Env, json, nowIso, placeOf, rateLimit, readJson, text } from "./http.ts";
import { usageDataRule } from "./regions.ts";

/** The app's public ingest key. It marks a batch as coming from a DoeDesk build; it is not a secret. */
const CLIENT_KEY = "doedesk-client";
const MAX_BATCH = 100;
const MAX_PROPERTIES_BYTES = 8_000;

/** A random UUID: the identifier the app makes for an installation (consent-spec 11.5). */
const RANDOM_IDENTIFIER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/**
 * What apps up to 0.1.x send as `installId`: the SHA-256 of a random identifier kept on the
 * computer. Not derived from any account either, but collected before the first-run choice existed.
 */
const LEGACY_IDENTIFIER = /^[0-9a-f]{64}$/;

/**
 * Events that are not stored at all.
 *   install.owner_observed        carries hashes of the person's AI-provider accounts.
 *   onboarding.profile_answered   repeats the onboarding answers, which are stored with the account,
 *                                 and could tie an installation to an account by its time.
 */
const EVENTS_NOT_STORED = new Set(["install.owner_observed", "onboarding.profile_answered"]);

/** Properties removed from an event before it is stored: anything that names an account or a person. */
const PROPERTIES_NOT_STORED = new Set([
  "ownerId",
  "ownerSource",
  "observedBy",
  "accountId",
  "account_id",
  "userId",
  "userID",
  "user_id",
  "distinctId",
  "distinct_id",
  "$user_id",
  "$device_id",
  "email",
  "phone",
]);

const stringProperty = (properties: Record<string, unknown>, key: string, max = 64): string | null =>
  text(properties[key], max);

/** The identifier an event is stored under, or null when it has none the service accepts. */
const installationOf = (env: Env, properties: Record<string, unknown>): string | null => {
  const value = typeof properties.installId === "string" ? properties.installId : "";
  if (RANDOM_IDENTIFIER.test(value)) return value;
  // Until the apps have switched to random identifiers, the old form is still taken.
  if (env.USAGE_DATA_RANDOM_IDENTIFIERS_ONLY !== "1" && LEGACY_IDENTIFIER.test(value)) return value;
  return null;
};

/** The consent stamp an event from a consent region must carry: which wording, and when. */
const consentOf = (value: unknown): { readonly wordingId: string; readonly at: string } | null => {
  if (value === null || typeof value !== "object") return null;
  const { wordingId, at } = value as { wordingId?: unknown; at?: unknown };
  if (typeof wordingId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(wordingId)) return null;
  if (typeof at !== "string" || Number.isNaN(Date.parse(at))) return null;
  return { wordingId, at: new Date(at).toISOString() };
};

/**
 * Usage events, in the PostHog batch format the app already speaks.
 * Retries resend whole batches, so events are keyed by their uuid and stored once.
 *
 * What is stored for an event is its name, its time, the installation identifier, the country of
 * the connection, and its properties. What is not:
 *   - the `distinct_id` the app sends. Apps up to 0.1.x derive it from the person's ChatGPT or
 *     Claude account when there is one; the service cannot use it and does not keep it. Every
 *     event is stored under `properties.installId` alone, and one without it is dropped;
 *   - the events and properties listed above;
 *   - any event from a place where usage data needs the person's agreement first, unless the
 *     event carries `properties.consent = { wordingId, at }`.
 * A dropped event is not an error: the batch is still answered with `status: 1`.
 */
export const ingestBatch = async (request: Request, env: Env): Promise<Response> => {
  const place = placeOf(request, env);
  await rateLimit(env, `ingest:${place.ip}`, 3600, 1200, "Too many event batches.");
  const body = await readJson(request);
  if (body.api_key !== CLIENT_KEY) throw new ApiError(401, "unauthenticated", "Unknown ingest key.");
  const batch = body.batch;
  if (!Array.isArray(batch) || batch.length > MAX_BATCH) {
    throw new ApiError(400, "invalid_request", `Send at most ${MAX_BATCH} events.`);
  }
  const consentNeeded = usageDataRule(place) === "ask";
  const receivedAt = nowIso();
  const statements: Array<D1PreparedStatement> = [];
  for (const item of batch as ReadonlyArray<Record<string, unknown>>) {
    const uuid = text(item?.uuid, 64);
    const event = text(item?.event, 120);
    if (uuid === null || event === null || EVENTS_NOT_STORED.has(event)) continue;
    const sent =
      item.properties !== null && typeof item.properties === "object" ? (item.properties as Record<string, unknown>) : {};
    const installation = installationOf(env, sent);
    if (installation === null) continue;
    const consent = consentOf(sent.consent ?? item.consent);
    if (consentNeeded && consent === null) continue;
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(sent)) if (!PROPERTIES_NOT_STORED.has(key)) properties[key] = value;
    if (consent === null) delete properties.consent;
    else properties.consent = consent;
    const serialized = JSON.stringify(properties);
    if (serialized.length > MAX_PROPERTIES_BYTES) continue;
    const parsed = typeof item.timestamp === "string" ? Date.parse(item.timestamp) : Number.NaN;
    const at = Number.isNaN(parsed) ? receivedAt : new Date(parsed).toISOString();
    statements.push(
      env.DB.prepare(
        // `distinct_id` is the installation identifier again: the column predates this rule and may not be empty.
        "INSERT INTO events (uuid, event, distinct_id, install_id, at, day, received_at, country, app_version, platform, surface, properties) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (uuid) DO NOTHING",
      ).bind(
        uuid,
        event,
        installation,
        installation,
        at,
        at.slice(0, 10),
        receivedAt,
        place.country,
        stringProperty(properties, "t3CodeVersion") ?? stringProperty(properties, "appVersion"),
        stringProperty(properties, "platform"),
        stringProperty(properties, "surface"),
        serialized,
      ),
    );
  }
  if (statements.length > 0) await env.DB.batch(statements);
  return json({ status: 1, stored: statements.length, dropped: batch.length - statements.length });
};

const CHOICE_STATES = ["on_consented", "on_by_default_notice_shown", "off"] as const;

/**
 * The choice an installation made about usage data, so that it can be shown later: the person
 * agreed, or saw the notice with usage data on by default, or switched it off. Kept by installation
 * identifier, like the events themselves, and never with an account.
 *
 * The app sends it when the state changes. For "off" it sends the identifier it is about to discard.
 */
export const ingestChoice = async (request: Request, env: Env): Promise<Response> => {
  const place = placeOf(request, env);
  await rateLimit(env, `choice:${place.ip}`, 3600, 60, "Too many requests.");
  const body = await readJson(request);
  if (body.api_key !== CLIENT_KEY) throw new ApiError(401, "unauthenticated", "Unknown ingest key.");
  const installId = typeof body.installId === "string" && RANDOM_IDENTIFIER.test(body.installId) ? body.installId : null;
  const state = CHOICE_STATES.find((candidate) => candidate === body.state);
  const chosenAt = typeof body.at === "string" && !Number.isNaN(Date.parse(body.at)) ? new Date(body.at).toISOString() : null;
  const label = (value: unknown): string | null =>
    typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(value) ? value : null;
  const wordingId = label(body.wordingId);
  if (installId === null || state === undefined || chosenAt === null || wordingId === null) {
    throw new ApiError(400, "invalid_request", "Send { installId (a random UUID), state, at, wordingId }.");
  }
  await env.DB.prepare(
    "INSERT INTO usage_data_choices (install_id, state, chosen_at, basis, signal, wording_id, locale, received_at, country, app_version) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (install_id, chosen_at, state) DO NOTHING",
  )
    .bind(
      installId,
      state,
      chosenAt,
      body.basis === "ask" || body.basis === "notice" ? body.basis : null,
      body.signal === "network" || body.signal === "locale" || body.signal === "timezone" ? body.signal : null,
      wordingId,
      body.locale === "ar" || body.locale === "en" ? body.locale : null,
      nowIso(),
      place.country,
      label(body.appVersion),
    )
    .run();
  return json({ ok: true });
};

/**
 * A crash or error report from one of the apps: a message and a stack trace. The free-form
 * `context` object that used to be stored is ignored, so a report cannot carry a person's content.
 */
export const ingestCrash = async (request: Request, env: Env): Promise<Response> => {
  const place = placeOf(request, env);
  await rateLimit(env, `crash:${place.ip}`, 3600, 60, "Too many reports.");
  const body = await readJson(request);
  const message = text(body.message, 2_000);
  if (message === null) throw new ApiError(400, "invalid_request", "Send a message.");
  const receivedAt = nowIso();
  const installation = installationOf(env, { installId: body.installId });
  await env.DB.prepare(
    "INSERT INTO crash_reports (id, received_at, day, source, app_version, platform, install_id, message, detail) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      crypto.randomUUID(),
      receivedAt,
      receivedAt.slice(0, 10),
      text(body.source, 32) ?? "unknown",
      text(body.appVersion, 64),
      text(body.platform, 64),
      installation,
      message,
      JSON.stringify({ stack: text(body.stack, 16_000) }),
    )
    .run();
  return json({ ok: true });
};
