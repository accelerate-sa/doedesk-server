/**
 * Acceptance of the Terms of Use: taking it with a sign-in, recording it, and saying whether an
 * account is up to date. The design is `legal/consent-spec.md`, sections 4 to 7.
 *
 * The record is the `acceptances` table, which is only ever added to. The state of an account is
 * its newest row.
 */
import { acceptanceRule, compareVersions, LEGAL, legalSummary, type Locale } from "./legal.ts";
import { ApiError, type Env, nowIso, text } from "./http.ts";

/** What the app sends with a sign-in, or from the sheet shown to an account that has not accepted. */
export interface Acceptance {
  readonly termsVersion: string;
  readonly privacyVersion: string;
  readonly locale: Locale;
  /** Which wording of the notice and checkbox was on the screen, for example `signup-2026-11`. */
  readonly wordingId: string | null;
  /** The act. `checkbox+button` unless the app says otherwise. */
  readonly method: string;
  readonly appVersion: string | null;
}

const DEFAULT_METHOD = "checkbox+button";
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

const invalid = (message: string): ApiError => new ApiError(400, "invalid_acceptance", message);

/**
 * Reads an `acceptance` object. Null when there is none. A malformed one is refused whatever the
 * switch says: a proof that cannot be read must not be dropped silently.
 */
export const parseAcceptance = (env: Env, value: unknown): Acceptance | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw invalid("Send `acceptance` as an object.");
  const input = value as Record<string, unknown>;
  const termsVersion = text(input.termsVersion, 16);
  const privacyVersion = text(input.privacyVersion, 16);
  if (termsVersion === null || !(LEGAL.terms.published as ReadonlyArray<string>).includes(termsVersion)) {
    throw invalid("`acceptance.termsVersion` is not a published version of the Terms of Use.");
  }
  if (privacyVersion === null || !(LEGAL.privacy.published as ReadonlyArray<string>).includes(privacyVersion)) {
    throw invalid("`acceptance.privacyVersion` is not a published version of the Privacy Policy.");
  }
  if (input.locale !== "en" && input.locale !== "ar") throw invalid("`acceptance.locale` must be \"en\" or \"ar\".");
  const optional = (name: string): string | null => {
    const label = input[name];
    if (label === undefined || label === null) return null;
    if (typeof label !== "string" || !LABEL.test(label)) throw invalid(`\`acceptance.${name}\` is not valid.`);
    return label;
  };
  if (compareVersions(termsVersion, LEGAL.terms.required) < 0) {
    throw new ApiError(409, "terms_outdated", "The Terms of Use have changed. Read and accept the current version.", {
      legal: legalSummary(env),
    });
  }
  return {
    termsVersion,
    privacyVersion,
    locale: input.locale,
    wordingId: optional("wordingId"),
    method: optional("method") ?? DEFAULT_METHOD,
    appVersion: optional("appVersion"),
  };
};

/**
 * The acceptance that came with a request to start signing in, ready to be kept on the attempt.
 * With the switch on, a request without one is refused: no account is created without agreement.
 */
export const acceptanceForSignIn = (env: Env, body: Record<string, unknown>, deletionOnly = false): string | null => {
  const acceptance = parseAcceptance(env, body.acceptance);
  if (acceptance === null) {
    // A sign-in that can only delete the account needs no agreement: leaving must always be possible.
    if (acceptanceRule(env) === "off" || deletionOnly) return null;
    throw new ApiError(
      400,
      "terms_required",
      "Accept the Terms of Use to continue. If DoeDesk shows no box to tick, update DoeDesk first.",
      { legal: legalSummary(env) },
    );
  }
  return JSON.stringify(acceptance);
};

interface AcceptanceRow {
  readonly terms_version: string | null;
  readonly privacy_version: string | null;
  readonly accepted_at: string;
}

const latest = (env: Env, userId: string): Promise<AcceptanceRow | null> =>
  env.DB.prepare(
    "SELECT terms_version, privacy_version, accepted_at FROM acceptances " +
      "WHERE user_id = ? AND document = 'terms' ORDER BY accepted_at DESC LIMIT 1",
  )
    .bind(userId)
    .first<AcceptanceRow>();

const statusOf = (env: Env, row: AcceptanceRow | null) => {
  const outstanding = row === null || row.terms_version === null || compareVersions(row.terms_version, LEGAL.terms.required) < 0;
  return {
    /** The account has not accepted the Terms version that is required now. Show the sheet. */
    outstanding,
    /** With `outstanding`: detection and reading are refused until the account accepts. */
    blocked: outstanding && acceptanceRule(env) === "all",
    requiredTermsVersion: LEGAL.terms.required,
    termsVersion: row?.terms_version ?? null,
    privacyVersion: row?.privacy_version ?? null,
    acceptedAt: row?.accepted_at ?? null,
  };
};

export type AcceptanceStatus = ReturnType<typeof statusOf>;

export const acceptanceStatus = async (env: Env, userId: string): Promise<AcceptanceStatus> =>
  statusOf(env, await latest(env, userId));

interface Circumstances {
  /** How the person was verified when they agreed: by phone or email just now, or by a session. */
  readonly identifierKind: "phone" | "email" | "session";
  readonly client: string;
  readonly loginRequestId: string | null;
  readonly country: string | null;
}

/**
 * Writes an acceptance, unless the account's newest one already names the same Terms version
 * (spec 4.5: same version, nothing new; older or missing, a new record).
 */
export const recordAcceptance = async (
  env: Env,
  userId: string,
  acceptance: Acceptance,
  circumstances: Circumstances,
): Promise<AcceptanceStatus> => {
  const previous = await latest(env, userId);
  if (previous !== null && previous.terms_version === acceptance.termsVersion) return statusOf(env, previous);
  const acceptedAt = nowIso();
  const hashFor = (document: "terms" | "privacy", version: string): string | null =>
    version === LEGAL[document].version ? LEGAL[document].sha256[acceptance.locale] : null;
  await env.DB.prepare(
    "INSERT INTO acceptances (id, user_id, document, decision, terms_version, privacy_version, terms_sha256, privacy_sha256, " +
      "wording_id, locale, method, identifier_kind, client, app_version, accepted_at, login_request_id, country) " +
      "VALUES (?, ?, 'terms', 'accepted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      crypto.randomUUID(),
      userId,
      acceptance.termsVersion,
      acceptance.privacyVersion,
      hashFor("terms", acceptance.termsVersion),
      hashFor("privacy", acceptance.privacyVersion),
      acceptance.wordingId,
      acceptance.locale,
      acceptance.method,
      circumstances.identifierKind,
      circumstances.client,
      acceptance.appVersion,
      acceptedAt,
      circumstances.loginRequestId,
      circumstances.country,
    )
    .run();
  return statusOf(env, { terms_version: acceptance.termsVersion, privacy_version: acceptance.privacyVersion, accepted_at: acceptedAt });
};

/**
 * After a code or link was verified: records the acceptance the attempt carried, if it carried one,
 * and says where the account stands.
 */
export const settleSignInAcceptance = async (
  env: Env,
  userId: string,
  attempt: { readonly id: string; readonly kind: string; readonly client: string; readonly country: string | null; readonly acceptance: string | null },
): Promise<AcceptanceStatus> => {
  if (attempt.acceptance === null) return acceptanceStatus(env, userId);
  return recordAcceptance(env, userId, JSON.parse(attempt.acceptance) as Acceptance, {
    identifierKind: attempt.kind === "phone" ? "phone" : "email",
    client: attempt.client,
    loginRequestId: attempt.id,
    country: attempt.country,
  });
};

/** For detection and reading: refuses an account whose acceptance is outstanding, when the switch says "all". */
export const requireAccepted = async (env: Env, userId: string): Promise<void> => {
  if (acceptanceRule(env) !== "all") return;
  if ((await acceptanceStatus(env, userId)).outstanding) {
    throw new ApiError(403, "terms_update_required", "Read and accept the Terms of Use in DoeDesk to keep using DoeDesk Cloud.", {
      legal: legalSummary(env),
    });
  }
};
