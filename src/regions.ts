/**
 * The two rules that depend on the country a request comes from:
 *   - whether usage data may be on by default there, or must wait for the person's agreement;
 *   - whether a new account may be created from there.
 *
 * Countries are ISO 3166-1 alpha-2 codes, as Cloudflare reports them from the IP address.
 */
import { type Env, type Place } from "./http.ts";

// ---------------------------------------------------------------------------------------------
// Usage data: where it must be off until the person agrees
//
// The owner's rule: usage data is on by default, except where the law requires it to be off by
// default. This is the list of those places, copied from `legal/consent-spec.md` version 1.1,
// section 11.2. The Privacy Policy (section 4.5) names the same countries: change the three together.

/** Group A: the rule is clear. EU e-privacy rules and their UK counterpart. */
export const CONSENT_REGIONS_EU_EEA_UK = [
  // European Union
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU",
  "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
  // Rest of the European Economic Area
  "IS", "LI", "NO",
  // Territories with their own codes where EU law applies
  "AX", "GF", "GP", "MQ", "YT", "RE", "MF",
  // United Kingdom and its related territories
  "GB", "GI", "JE", "GG", "IM",
] as const;

/** Group B: consent-first laws, or regulator guidance that analytics need consent. A lawyer may trim it. */
export const CONSENT_REGIONS_OTHER = ["TR", "RS", "CN", "KR", "AE", "OM", "IN", "VN"] as const;

/**
 * Countries where only one subdivision is a consent region. Without the subdivision's code the
 * whole country counts as one (spec 11.3: "Canada without a region code: consent region").
 */
export const CONSENT_SUBDIVISIONS: Readonly<Record<string, ReadonlyArray<string>>> = { CA: ["QC"] };

/** What Cloudflare reports when it does not know: no country, an anonymous proxy, or Tor. */
const UNKNOWN_COUNTRIES = new Set(["XX", "T1", "A1", "A2"]);

const CONSENT_COUNTRIES: ReadonlySet<string> = new Set([...CONSENT_REGIONS_EU_EEA_UK, ...CONSENT_REGIONS_OTHER]);

/** The list in the form the apps keep a copy of: country codes, and `CA-QC` for a subdivision. */
export const CONSENT_REGION_CODES: ReadonlyArray<string> = [
  ...CONSENT_COUNTRIES,
  ...Object.entries(CONSENT_SUBDIVISIONS).flatMap(([country, parts]) => parts.map((part) => `${country}-${part}`)),
];

export type UsageDataRule = "ask" | "notice";

/**
 * "ask": usage data stays off until the person ticks the choice. "notice": it may be on by default,
 * with the notice and the switch shown at first run. An unknown country is "ask".
 */
export const usageDataRule = (place: Pick<Place, "country" | "region">): UsageDataRule => {
  const country = place.country;
  if (country === null || UNKNOWN_COUNTRIES.has(country)) return "ask";
  if (CONSENT_COUNTRIES.has(country)) return "ask";
  const subdivisions = CONSENT_SUBDIVISIONS[country];
  if (subdivisions !== undefined) return place.region === null || subdivisions.includes(place.region) ? "ask" : "notice";
  return "notice";
};

// ---------------------------------------------------------------------------------------------
// New accounts: where none may be created
//
// Nothing is blocked unless the orchestrator sets it at deploy time:
//   SIGNUP_BLOCKED_COUNTRIES   codes separated by commas or spaces: a country ("IR"), or one
//                              subdivision of a country as ISO 3166-2 writes it ("UA-43").
//                              Meant for comprehensively sanctioned places, which the service's
//                              providers (its software and hosting suppliers) cannot serve. The
//                              recommended value and its source are in
//                              legal/service-changes-notes.md; no place is listed in the code.
//   SIGNUP_BLOCK_EU_UK         "1" adds the EU, the EEA and the United Kingdom (group A above), for
//                              the time before the operator has appointed its representatives there.
//
// Only the creation of an account is refused. An account that exists can still sign in from
// anywhere, and a request whose country is unknown is allowed.

export type SignUpBlock = "country" | "representative";

/** The places named in `SIGNUP_BLOCKED_COUNTRIES`, upper case. Anything that is not a code is ignored. */
export const blockedPlaces = (env: Pick<Env, "SIGNUP_BLOCKED_COUNTRIES">): ReadonlyArray<string> =>
  (env.SIGNUP_BLOCKED_COUNTRIES ?? "")
    .toUpperCase()
    .split(/[\s,]+/)
    .filter((code) => /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/.test(code));

export const signUpBlock = (
  env: Pick<Env, "SIGNUP_BLOCKED_COUNTRIES" | "SIGNUP_BLOCK_EU_UK">,
  place: Pick<Place, "country" | "region">,
): SignUpBlock | null => {
  const country = place.country;
  if (country === null || UNKNOWN_COUNTRIES.has(country)) return null;
  const listed = blockedPlaces(env);
  if (listed.includes(country) || (place.region !== null && listed.includes(`${country}-${place.region}`))) return "country";
  if (env.SIGNUP_BLOCK_EU_UK === "1" && (CONSENT_REGIONS_EU_EEA_UK as ReadonlyArray<string>).includes(country)) return "representative";
  return null;
};

/** What the app shows when a new account cannot be created. The same words whichever reason applies. */
export const SIGN_UP_UNAVAILABLE_MESSAGE =
  "New DoeDesk Cloud accounts cannot be created from your country yet. If you already have an account, sign in as usual. " +
  "You can also use DoeDesk with your own detection service, which needs no account.";
