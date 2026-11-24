// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Accelerate Technology Establishment
import { acceptanceForSignIn, parseAcceptance, recordAcceptance, settleSignInAcceptance } from "./acceptance.ts";
import {
  type Account,
  authenticate,
  bearerToken,
  createSession,
  endSession,
  findOrCreateUser,
  publicAccount,
  sessionClient,
  signInPurpose,
} from "./accounts.ts";
import { legalSummary } from "./legal.ts";
import { confirmPage, signInEmail } from "./pages.ts";
import { CONSENT_REGION_CODES, SIGN_UP_UNAVAILABLE_MESSAGE, signUpBlock, usageDataRule } from "./regions.ts";
import { describeAccount, extension } from "./extension.ts";
import {
  API_ORIGIN,
  ApiError,
  type Env,
  html,
  json,
  nowIso,
  placeOf,
  randomToken,
  rateLimit,
  readJson,
  sha256Hex,
  SITE_ORIGIN,
  text,
  timingSafeEqual,
} from "./http.ts";

const CODE_TTL_SECONDS = 5 * 60;
const LINK_TTL_SECONDS = 15 * 60;
const RESEND_SECONDS = 60;
const MAX_CODE_ATTEMPTS = 5;
/** A ceiling on what a flood of sign-in attempts can cost in SMS. */
const MAX_SMS_PER_DAY = 150;

/** Phone sign-in is offered to people connecting from Saudi Arabia; everyone can use email. */
const offersPhone = (country: string | null): boolean => country === "SA";

/**
 * What the sign-in screen needs before anyone types anything. It needs no sign-in and carries no
 * identifier, so the app also calls it at first run to learn the usage-data rule for its region.
 */
export const authOptions = (request: Request, env: Env): Response => {
  const place = placeOf(request, env);
  const phone = offersPhone(place.country);
  const blocked = signUpBlock(env, place) !== null;
  return json({
    country: place.country,
    methods: phone ? ["phone", "email"] : ["email"],
    default: phone ? "phone" : "email",
    // "ask": usage data stays off until the person agrees. "notice": it may be on by default, with
    // the notice shown. Decided from the country of this request; unknown is "ask".
    usageData: usageDataRule(place),
    // The whole list, for the app's other two signals (system region, time zone) and as its fallback.
    usageDataConsentRegions: CONSENT_REGION_CODES,
    // Whether an account can be created from here. An existing account can sign in either way.
    signUp: blocked ? { available: false, code: "signup_unavailable", message: SIGN_UP_UNAVAILABLE_MESSAGE } : { available: true },
    legal: legalSummary(env),
  });
};

/**
 * Raised when a verified number or address has no account and none may be created from where the
 * attempt began. Whether an account exists is only ever shown to someone who has proved they hold
 * the number or address.
 */
const signUpRefusal = (row: LoginRequestRow): ApiError | null => {
  // A sign-in made to delete an account never makes one.
  if (row.purpose === "delete_account") {
    return new ApiError(404, "no_account", "There is no DoeDesk Cloud account for this number or address. Nothing was deleted.");
  }
  return row.signup_block === null ? null : new ApiError(403, "signup_unavailable", SIGN_UP_UNAVAILABLE_MESSAGE);
};

/** The answer to a completed sign-in: the session, the account, and where its acceptance stands. */
const signedIn = async (env: Env, row: LoginRequestRow, found: Account, created: boolean) => {
  const acceptance = await settleSignInAcceptance(env, found.userId, row);
  const token = await createSession(env, found.userId, sessionClient(row.client), row.device, true, signInPurpose(row.purpose));
  // A layer beside the service may know this account (src/extension.ts) and give it back changed.
  const account = (await extension().signedIn?.(env, found)) ?? found;
  const about = await describeAccount(env, account);
  return { token, account: publicAccount(account), worker: about.worker, created, acceptance, legal: legalSummary(env), ...about.beside };
};

const ARABIC_INDIC_ZERO = 0x660;

export const normalizeSaudiMobile = (raw: string): string | null => {
  let digits = raw
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - ARABIC_INDIC_ZERO))
    .replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("966")) digits = digits.slice(3);
  if (digits.startsWith("0")) digits = digits.slice(1);
  return /^5\d{8}$/.test(digits) ? `+966${digits}` : null;
};

const normalizeEmail = (raw: unknown): string => {
  const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw new ApiError(400, "invalid_email", "Enter a valid email address.");
  }
  return email;
};

const sixDigits = (): string => {
  // Rejection sampling keeps every code equally likely.
  const buffer = new Uint32Array(1);
  const limit = Math.floor(0xffffffff / 1_000_000) * 1_000_000;
  do crypto.getRandomValues(buffer);
  while ((buffer[0] ?? 0) >= limit);
  return String((buffer[0] ?? 0) % 1_000_000).padStart(6, "0");
};

const expiry = (seconds: number): string => new Date(Date.now() + seconds * 1000).toISOString();

const sendSms = async (env: Env, phone: string, code: string): Promise<void> => {
  const response = await fetch("https://api.authentica.sa/api/v2/send-otp", {
    method: "POST",
    headers: {
      "x-authorization": env.AUTHENTICA_API_KEY,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ method: "sms", phone, otp: code }),
  });
  const body = (await response.json().catch(() => null)) as { success?: unknown } | null;
  if (!response.ok || body?.success !== true) {
    console.error("sms_failed", response.status);
    throw new ApiError(502, "sms_failed", "The code could not be sent. Try again, or sign in with email.");
  }
};

interface LoginRequestRow {
  readonly id: string;
  readonly kind: string;
  readonly identifier: string;
  readonly secret_hash: string;
  readonly poll_hash: string | null;
  readonly client: string;
  readonly device: string | null;
  readonly country: string | null;
  readonly city: string | null;
  readonly attempts: number;
  readonly status: string;
  readonly created_at: string;
  readonly expires_at: string;
  /** The acceptance of the Terms sent with the attempt, as JSON. Null when the app sent none. */
  readonly acceptance: string | null;
  /** Why no new account may come of this attempt, decided when it began. Null when one may. */
  readonly signup_block: string | null;
  /** `delete_account` for the sign-in that confirms a deletion. Null for every other. */
  readonly purpose: string | null;
}

const loadRequest = async (env: Env, id: unknown): Promise<LoginRequestRow> => {
  const row =
    typeof id === "string"
      ? await env.DB.prepare("SELECT * FROM login_requests WHERE id = ?").bind(id).first<LoginRequestRow>()
      : null;
  if (row === null || row.expires_at < nowIso()) {
    throw new ApiError(410, "expired", "This sign-in has expired. Start again.");
  }
  return row;
};

export const startPhone = async (request: Request, env: Env): Promise<Response> => {
  const place = placeOf(request, env);
  if (!offersPhone(place.country)) {
    throw new ApiError(403, "phone_unavailable", "Phone sign-in is available in Saudi Arabia. Sign in with email.");
  }
  const body = await readJson(request);
  const phone = normalizeSaudiMobile(typeof body.phone === "string" ? body.phone : "");
  if (phone === null) throw new ApiError(400, "invalid_phone", "Enter a Saudi mobile number, such as 05X XXX XXXX.");
  // Checked before anything is counted or sent, so a refusal costs the person no code.
  const purpose = signInPurpose(body.purpose);
  const acceptance = acceptanceForSignIn(env, body, purpose !== null);

  await rateLimit(env, `sms:phone:${phone}`, RESEND_SECONDS, 1, "Wait a minute before asking for another code.");
  await rateLimit(env, `sms:phone:${phone}`, 3600, 5, "Too many codes for this number. Try again in an hour.");
  await rateLimit(env, `sms:ip:${place.ip}`, 3600, 8, "Too many codes from this network. Try again in an hour.");
  await rateLimit(env, "sms:all", 86_400, MAX_SMS_PER_DAY, "Phone sign-in is busy. Sign in with email.");

  const code = sixDigits();
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO login_requests (id, kind, identifier, secret_hash, client, device, country, city, created_at, expires_at, acceptance, signup_block, purpose) " +
      "VALUES (?, 'phone', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      id,
      phone,
      await sha256Hex(`${id}:${code}`),
      sessionClient(body.client),
      text(body.device, 80),
      place.country,
      place.city,
      nowIso(),
      expiry(CODE_TTL_SECONDS),
      acceptance,
      signUpBlock(env, place),
      purpose,
    )
    .run();
  if (env.EXPOSE_LOGIN_SECRETS === "1") {
    return json({ requestId: id, expiresIn: CODE_TTL_SECONDS, resendIn: RESEND_SECONDS, testCode: code });
  }
  await sendSms(env, phone, code);
  return json({ requestId: id, expiresIn: CODE_TTL_SECONDS, resendIn: RESEND_SECONDS });
};

export const verifyPhone = async (request: Request, env: Env): Promise<Response> => {
  const body = await readJson(request);
  const row = await loadRequest(env, body.requestId);
  if (row.kind !== "phone" || row.status !== "pending") {
    throw new ApiError(410, "expired", "This code has been used. Ask for a new one.");
  }
  if (row.attempts >= MAX_CODE_ATTEMPTS) {
    throw new ApiError(429, "too_many_attempts", "Too many wrong codes. Ask for a new one.");
  }
  const code = typeof body.code === "string" ? body.code.replace(/\D/g, "") : "";
  if (!timingSafeEqual(await sha256Hex(`${row.id}:${code}`), row.secret_hash)) {
    await env.DB.prepare("UPDATE login_requests SET attempts = attempts + 1 WHERE id = ?").bind(row.id).run();
    throw new ApiError(401, "wrong_code", "That code is not right.");
  }
  // Only the request that flips the status may sign in, so a code works once.
  const claimed = await env.DB.prepare(
    "UPDATE login_requests SET status = 'used' WHERE id = ? AND status = 'pending'",
  )
    .bind(row.id)
    .run();
  if (claimed.meta.changes !== 1) throw new ApiError(410, "expired", "This code has been used. Ask for a new one.");
  const { account, created } = await findOrCreateUser(
    env,
    { kind: "phone", value: row.identifier },
    row.country,
    signUpRefusal(row),
  );
  return json(await signedIn(env, row, account, created));
};

export const startEmail = async (request: Request, env: Env): Promise<Response> => {
  const place = placeOf(request, env);
  const body = await readJson(request);
  const email = normalizeEmail(body.email);
  const purpose = signInPurpose(body.purpose);
  const acceptance = acceptanceForSignIn(env, body, purpose !== null);
  await rateLimit(env, `mail:to:${email}`, RESEND_SECONDS, 1, "Wait a minute before asking for another link.");
  await rateLimit(env, `mail:to:${email}`, 3600, 6, "Too many links for this address. Try again in an hour.");
  await rateLimit(env, `mail:ip:${place.ip}`, 3600, 20, "Too many links from this network. Try again in an hour.");

  const id = crypto.randomUUID();
  const linkToken = randomToken();
  const pollSecret = randomToken();
  const device = text(body.device, 80);
  await env.DB.prepare(
    "INSERT INTO login_requests (id, kind, identifier, secret_hash, poll_hash, client, device, country, city, created_at, expires_at, acceptance, signup_block, purpose) " +
      "VALUES (?, 'email', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      id,
      email,
      await sha256Hex(linkToken),
      await sha256Hex(pollSecret),
      sessionClient(body.client),
      device,
      place.country,
      place.city,
      nowIso(),
      expiry(LINK_TTL_SECONDS),
      acceptance,
      signUpBlock(env, place),
      purpose,
    )
    .run();
  // The link's secret travels after the `#`, which a browser keeps to itself: it is in no request,
  // so it reaches no request log. The page behind the link posts it back in a form body.
  // It opens on the site unless the service is told otherwise (`CONFIRM_ORIGIN`, once the API has
  // an address of its own that answers this page).
  const origin = (env.CONFIRM_ORIGIN ?? "").replace(/\/+$/, "") || SITE_ORIGIN;
  const link = `${origin}/auth/confirm#r=${id}&t=${linkToken}`;
  if (env.EXPOSE_LOGIN_SECRETS === "1") {
    return json({
      requestId: id,
      pollSecret,
      expiresIn: LINK_TTL_SECONDS,
      // `testLink` keeps the shape test tools already take apart (r and t as a query). `emailedLink`
      // is the link exactly as the email would carry it.
      testLink: `${origin}/auth/confirm?r=${id}&t=${linkToken}`,
      emailedLink: link,
    });
  }
  const message = signInEmail(link, body.locale === "ar" ? "ar" : "en");
  try {
    await env.EMAIL.send({
      to: email,
      from: { email: "signin@doedesk.com", name: "DoeDesk" },
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  } catch (cause) {
    console.error("email_failed", (cause as { code?: string }).code ?? "unknown");
    throw new ApiError(502, "email_failed", "The email could not be sent. Check the address and try again.");
  }
  return json({ requestId: id, pollSecret, expiresIn: LINK_TTL_SECONDS });
};

/** The app waits here while the person opens the link in their email. */
export const pollEmail = async (request: Request, env: Env): Promise<Response> => {
  const body = await readJson(request);
  const row = await loadRequest(env, body.requestId);
  const pollSecret = typeof body.pollSecret === "string" ? body.pollSecret : "";
  if (row.kind !== "email" || row.poll_hash === null || !timingSafeEqual(await sha256Hex(pollSecret), row.poll_hash)) {
    throw new ApiError(401, "unauthenticated", "This sign-in is not valid. Start again.");
  }
  if (row.status === "pending") return json({ status: "pending" });
  const claimed = await env.DB.prepare(
    "UPDATE login_requests SET status = 'used' WHERE id = ? AND status = 'approved'",
  )
    .bind(row.id)
    .run();
  if (claimed.meta.changes !== 1) throw new ApiError(410, "expired", "This sign-in has been used. Start again.");
  const { account, created } = await findOrCreateUser(
    env,
    { kind: "email", value: row.identifier },
    row.country,
    signUpRefusal(row),
  );
  return json({ status: "approved", ...(await signedIn(env, row, account, created)) });
};

/**
 * The page behind the emailed link. Opening it changes nothing, because mail scanners open links;
 * the person presses a button to confirm, after seeing which app is asking.
 *
 * The link carries the attempt and its secret after a `#`. Three steps follow:
 *   GET  /auth/confirm                 a page whose script posts the two values from the `#`
 *   POST /auth/confirm  step=show      the question: "Sign in to DoeDesk?", naming the app that asked
 *   POST /auth/confirm                 the person pressed the button: the attempt is approved
 * Links sent before this change carry the values as a query (`?r=…&t=…`); they are still answered,
 * straight with the question, for the fifteen minutes such a link lives.
 */
export const confirmLink = async (request: Request, env: Env): Promise<Response> => {
  const url = new URL(request.url);
  const locale = request.headers.get("accept-language")?.toLowerCase().startsWith("ar") ? "ar" : "en";
  if (request.method === "GET" && !url.searchParams.has("r")) return html(confirmPage({ state: "open", locale }));
  const form = request.method === "POST" ? await request.formData() : null;
  const id = form?.get("r") ?? url.searchParams.get("r");
  const token = String(form?.get("t") ?? url.searchParams.get("t") ?? "");
  const row =
    typeof id === "string"
      ? await env.DB.prepare("SELECT * FROM login_requests WHERE id = ?").bind(id).first<LoginRequestRow>()
      : null;
  const valid =
    row !== null && row.kind === "email" && timingSafeEqual(await sha256Hex(token), row.secret_hash);
  if (!valid || row.expires_at < nowIso()) return html(confirmPage({ state: "expired", locale }), 410);
  if (row.status !== "pending") return html(confirmPage({ state: "done", locale }));
  if (request.method !== "POST" || form?.get("step") === "show") {
    return html(
      confirmPage({
        state: "ask",
        locale,
        requestId: row.id,
        token,
        device: row.device,
        place: [row.city, row.country].filter(Boolean).join(", ") || null,
      }),
    );
  }
  await env.DB.prepare("UPDATE login_requests SET status = 'approved' WHERE id = ? AND status = 'pending'")
    .bind(row.id)
    .run();
  return html(confirmPage({ state: "done", locale }));
};

/** A second sign-in for the same account, for the app's local service to use on its own. */
export const createExtraSession = async (request: Request, env: Env): Promise<Response> => {
  const account = await authenticate(request, env);
  const body = await readJson(request);
  const token = await createSession(env, account.userId, sessionClient(body.client), text(body.device, 80));
  return json({ token, account: publicAccount(account) });
};

/**
 * Acceptance of the Terms by an account that is already signed in: one made before the checkbox
 * existed, or one that has to accept a new version.
 */
export const acceptTerms = async (request: Request, env: Env): Promise<Response> => {
  const account = await authenticate(request, env);
  const acceptance = parseAcceptance(env, (await readJson(request)).acceptance);
  if (acceptance === null) throw new ApiError(400, "invalid_acceptance", "Send an `acceptance` object.");
  const status = await recordAcceptance(env, account.userId, acceptance, {
    identifierKind: "session",
    client: account.client,
    loginRequestId: null,
    country: placeOf(request, env).country,
  });
  return json({ acceptance: status, legal: legalSummary(env) });
};

export const signOut = async (request: Request, env: Env): Promise<Response> => {
  const token = bearerToken(request);
  if (token.length > 0) await endSession(env, token);
  return json({ ok: true });
};

const TOKEN_AUDIENCES = new Set(["doedesk-relay"]);
const TOKEN_TTL_SECONDS = 5 * 60;

const base64Url = (bytes: ArrayBuffer | Uint8Array): string =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const encodeSegment = (value: unknown): string => base64Url(new TextEncoder().encode(JSON.stringify(value)));

interface SigningJwk extends JsonWebKey {
  readonly kid?: string;
}

const signingJwk = (env: Env): SigningJwk => JSON.parse(env.JWT_PRIVATE_JWK) as SigningJwk;

export const jwks = (env: Env): Response => {
  const { kty, crv, x, y, kid } = signingJwk(env);
  return new Response(JSON.stringify({ keys: [{ kty, crv, x, y, kid, alg: "ES256", use: "sig" }] }), {
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=3600",
      "access-control-allow-origin": "*",
    },
  });
};

/** A short-lived signed token that DoeDesk Connect accepts as proof of who is signed in. */
export const mintToken = async (request: Request, env: Env): Promise<Response> => {
  const account = await authenticate(request, env);
  const body = await readJson(request);
  const audience = typeof body.audience === "string" ? body.audience : "";
  if (!TOKEN_AUDIENCES.has(audience)) throw new ApiError(400, "invalid_audience", "Unknown audience.");
  const jwk = signingJwk(env);
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + TOKEN_TTL_SECONDS;
  const unsigned = `${encodeSegment({ alg: "ES256", typ: "JWT", kid: jwk.kid })}.${encodeSegment({
    iss: API_ORIGIN,
    aud: audience,
    sub: account.userId,
    iat: issuedAt,
    nbf: issuedAt - 5,
    exp: expiresAt,
    jti: randomToken(12),
  })}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(unsigned),
  );
  return json({ token: `${unsigned}.${base64Url(signature)}`, expiresAt });
};
