// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Accelerate Technology Establishment
import type { WorkerRegionEnv } from "./worker-regions.ts";

/**
 * `WorkerRegionEnv`: the worker that reads sealed documents, one upstream per account region
 * (`WORKER_SA_*`, `WORKER_EU_*`, `WORKER_GLOBAL_*`). See worker-regions.ts.
 */
export interface Env extends WorkerRegionEnv {
  readonly DB: D1Database;
  readonly EMAIL: { send(message: unknown): Promise<{ messageId: string }> };
  readonly ASSETS: Fetcher;
  readonly AUTHENTICA_API_KEY: string;
  /** ES256 private key as a JWK string. Signs the short-lived tokens other services accept. */
  readonly JWT_PRIVATE_JWK: string;
  /** Opens the owner's dashboard. */
  readonly ADMIN_KEY: string;
  /**
   * "1" marks a test run: the code or link that would have been sent is returned to the caller, and
   * a request may state the country it comes from (see `placeOf`). Never set in production.
   */
  readonly EXPOSE_LOGIN_SECRETS?: string;
  /**
   * Whether accepting the Terms of Use is required. Unset or "off": an acceptance is recorded when
   * the app sends one, and an account without one is marked as outstanding. "signup": starting a
   * sign-in without an acceptance is refused. "all": as "signup", and detection and reading are
   * refused for accounts whose acceptance is outstanding. See legal.ts.
   */
  readonly REQUIRE_ACCEPTANCE?: string;
  /**
   * Where mail to the contact addresses is forwarded: one address, or several separated by commas.
   * Each must be a verified destination address in the account's Email Routing. See mail.ts.
   */
  readonly MAIL_FORWARD_TO?: string;
  /** Country codes, separated by commas, from which no new account may be created. See regions.ts. */
  readonly SIGNUP_BLOCKED_COUNTRIES?: string;
  /** "1" also refuses new accounts from the EU, the EEA and the United Kingdom. See regions.ts. */
  readonly SIGNUP_BLOCK_EU_UK?: string;
  /** "1" stops usage events being accepted unless their identifier is a random UUID. See ingest.ts. */
  readonly USAGE_DATA_RANDOM_IDENTIFIERS_ONLY?: string;
  /**
   * Base address of the detection and reading engine (`POST /v1/detect`, `POST /v1/ocr`): on the
   * machine, an engine on the same machine, reached on its loopback address. Every text and
   * file sent for detection or reading goes there and nowhere else. Unset: detection and reading
   * answer that the engine is not available. See engine.ts.
   */
  readonly ENGINE_URL?: string;
  /** Sent to the engine as a bearer token, when it asks for one. */
  readonly ENGINE_TOKEN?: string;
  /**
   * What the engine costs, in US dollars, per 1,000 engine units and per 1,000 pages read, for the
   * owner's estimate of what each account's use costs (cost.ts). Unset: no cost is shown anywhere.
   */
  readonly ENGINE_PRICE_PER_1000_UNITS?: string;
  readonly ENGINE_PRICE_PER_1000_PAGES?: string;
  /**
   * What the worker costs, in US dollars, per million tokens sent to it and per million tokens it
   * answers with, for the owner's estimate (cost.ts). Unset: the worker counts as free there.
   */
  readonly WORKER_PRICE_PER_1M_INPUT_TOKENS?: string;
  readonly WORKER_PRICE_PER_1M_OUTPUT_TOKENS?: string;
  /**
   * "1": every signed-in account has the worker for sealed documents. Unset: no account has it
   * unless a layer beside the service says so (extension.ts). The service keeps no list of its own.
   */
  readonly WORKER_OPEN?: string;
  /** "freeze": nothing is written to the database. For the minutes of a move. See maintenance.ts. */
  readonly MAINTENANCE?: string;
  /**
   * Worker only, for the days between moving the data and moving the address: every API request is
   * passed to this origin, with `FORWARD_SECRET` so that the origin trusts the caller's address and
   * country from this Worker and from nobody else. See maintenance.ts.
   */
  readonly FORWARD_API_TO?: string;
  readonly FORWARD_SECRET?: string;
  /** Worker only, once the API has its own address: `/auth/confirm` on the site redirects there. */
  readonly CONFIRM_REDIRECT_TO?: string;
  /** Where the emailed sign-in link opens. Unset: the site, which is what every link so far used. */
  readonly CONFIRM_ORIGIN?: string;
  /**
   * Worker only, once the database has moved: mail to the contact addresses is forwarded as before
   * and its copy is posted to this address (`POST /internal/inbound-mail` on the API) with
   * `MAIL_RELAY_KEY`, instead of being stored by the Worker. See mail.ts.
   */
  readonly MAIL_RELAY_URL?: string;
  readonly MAIL_RELAY_KEY?: string;
  /** Opens `POST /internal/inbound-mail`. Unset: that route does not exist. */
  readonly MAIL_INGEST_KEY?: string;
  /** Cloudflare Turnstile widget keys and protected phone number for public legal pages. */
  readonly TURNSTILE_SITE_KEY?: string;
  readonly TURNSTILE_SECRET_KEY?: string;
  readonly TURNSTILE_VERIFY_URL?: string;
  readonly CONTACT_PHONE?: string;
}

export const SITE_ORIGIN = "https://doedesk.com";
export const API_ORIGIN = "https://api.doedesk.com";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly extra: Record<string, unknown>;
  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

// The API is called from the desktop app, the web app and the phone app, each on its own origin.
// It authenticates with a bearer token and never with cookies, so any origin may call it.
export const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "86400",
};

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...CORS_HEADERS,
    },
  });

export const html = (body: string, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      ...headers,
    },
  });

export const readJson = async (request: Request): Promise<Record<string, unknown>> => {
  const body = (await request.json().catch(() => null)) as unknown;
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(400, "invalid_request", "Send a JSON object.");
  }
  return body as Record<string, unknown>;
};

export const text = (value: unknown, maxLength: number): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, maxLength) : null;

export const toHex = (bytes: ArrayBuffer | Uint8Array): string =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

export const sha256Hex = async (value: string): Promise<string> =>
  toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));

export const randomToken = (bytes = 32): string => toHex(crypto.getRandomValues(new Uint8Array(bytes)));

export const timingSafeEqual = (left: string, right: string): boolean => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
};

export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

export const nowIso = (): string => new Date().toISOString();

export interface Place {
  /** Two letters, upper case, as the network provider reports it. Null when it reports none. */
  readonly country: string | null;
  /** The subdivision inside the country, such as "QC" for Quebec. Null when not reported. */
  readonly region: string | null;
  readonly city: string | null;
  readonly ip: string;
}

/**
 * Where a request comes from, as Cloudflare reports it from the IP address.
 *
 * In a test run (`EXPOSE_LOGIN_SECRETS` is "1", which production never sets) the request may state
 * its own country and region in `x-test-country` and `x-test-region`, so the rules that depend on
 * the country can be proved on one machine. An empty `x-test-country` means "not reported".
 */
export const placeOf = (request: Request, env?: Pick<Env, "EXPOSE_LOGIN_SECRETS">): Place => {
  const cf = (request as { cf?: { country?: unknown; regionCode?: unknown; city?: unknown } }).cf;
  const stated = env?.EXPOSE_LOGIN_SECRETS === "1" ? request.headers.get("x-test-country") : null;
  if (stated !== null) {
    return {
      country: stated.trim() === "" ? null : stated.trim().toUpperCase(),
      region: request.headers.get("x-test-region")?.trim().toUpperCase() || null,
      city: null,
      ip: request.headers.get("cf-connecting-ip") ?? "unknown",
    };
  }
  return {
    country: typeof cf?.country === "string" && cf.country !== "" ? cf.country.toUpperCase() : null,
    region: typeof cf?.regionCode === "string" && cf.regionCode !== "" ? cf.regionCode.toUpperCase() : null,
    city: typeof cf?.city === "string" ? cf.city : null,
    ip: request.headers.get("cf-connecting-ip") ?? "unknown",
  };
};

/** `months` calendar months before `from`, in UTC. The day is kept, or pulled back to the month's last day. */
export const monthsBefore = (months: number, from = new Date()): Date => {
  const target = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(from.getUTCDate(), lastDay));
  target.setUTCHours(from.getUTCHours(), from.getUTCMinutes(), from.getUTCSeconds(), from.getUTCMilliseconds());
  return target;
};

export const daysBefore = (days: number, from = new Date()): Date => new Date(from.getTime() - days * 86_400_000);

/**
 * Counts one use of `key` in the current window and refuses past `limit`.
 * Windows are fixed, so a burst can straddle two; the limits are set with that in mind.
 */
export const rateLimit = async (
  env: Env,
  key: string,
  windowSeconds: number,
  limit: number,
  message: string,
): Promise<void> => {
  const bucket = String(Math.floor(Date.now() / 1000 / windowSeconds));
  const row = await env.DB.prepare(
    "INSERT INTO rate_limits (key, bucket, count) VALUES (?, ?, 1) " +
      "ON CONFLICT (key, bucket) DO UPDATE SET count = count + 1 RETURNING count",
  )
    .bind(`${key}:${windowSeconds}`, bucket)
    .first<{ count: number }>();
  if ((row?.count ?? 0) > limit) throw new ApiError(429, "too_many_requests", message);
};
