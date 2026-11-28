// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Accelerate Technology Establishment
/**
 * Anti-scraping gate for the contact phone number shown on public legal pages.
 * The raw number is never embedded in public HTML or Markdown; the browser completes an
 * automatic Cloudflare Turnstile check and exchanges the token here.
 */
import { ApiError, type Env, json, readJson, text } from "./http.ts";

const DEFAULT_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const MAX_TOKEN_LENGTH = 2_048;

interface TurnstileResult {
  readonly success?: boolean;
  readonly hostname?: string;
  readonly "error-codes"?: ReadonlyArray<string>;
}

/** Public Turnstile widget configuration for the legal pages. Never leaks secrets or the number. */
export const contactPhoneConfig = (env: Env): Response => {
  const siteKey = text(env.TURNSTILE_SITE_KEY, 256);
  const configured = siteKey !== null && text(env.TURNSTILE_SECRET_KEY, 512) !== null && text(env.CONTACT_PHONE, 64) !== null;
  return json({ configured, siteKey: configured ? siteKey : null });
};

/** Verifies a Turnstile token server-side and returns the protected contact phone number. */
export const revealContactPhone = async (request: Request, env: Env, url: URL): Promise<Response> => {
  const secret = text(env.TURNSTILE_SECRET_KEY, 512);
  const phone = text(env.CONTACT_PHONE, 64);
  if (secret === null || phone === null) {
    throw new ApiError(503, "unavailable", "Phone verification is not configured.");
  }

  const body = await readJson(request);
  const token = text(body.token, MAX_TOKEN_LENGTH);
  if (token === null) {
    throw new ApiError(400, "invalid_request", "Send a Turnstile token.");
  }

  const payload = new URLSearchParams({ secret, response: token });
  const ip = text(request.headers.get("cf-connecting-ip"), 128);
  if (ip !== null) payload.set("remoteip", ip);

  const verifyUrl = text(env.TURNSTILE_VERIFY_URL, 512) ?? DEFAULT_VERIFY_URL;
  let result: TurnstileResult;
  try {
    const response = await fetch(verifyUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: payload.toString(),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    result = (await response.json()) as TurnstileResult;
  } catch {
    throw new ApiError(502, "verification_unavailable", "Could not verify the check right now.");
  }

  if (result.success !== true) {
    throw new ApiError(403, "verification_failed", "Verification check did not pass.");
  }

  // On production doedesk.com, reject tokens minted for another hostname.
  if (
    url.hostname === "doedesk.com" &&
    typeof result.hostname === "string" &&
    result.hostname !== "" &&
    result.hostname !== "doedesk.com" &&
    result.hostname !== "www.doedesk.com"
  ) {
    throw new ApiError(403, "verification_failed", "Verification check did not match this site.");
  }

  return json({ phone });
};
