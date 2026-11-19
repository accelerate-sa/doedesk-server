/**
 * The one place that says which Terms of Use and Privacy Policy are in force.
 *
 * To publish a new version of either document:
 *   1. Add it to `published`, and set `version` to it.
 *   2. If the change is material (Terms section 21: price, what the service does with data,
 *      liability, governing law and the like), set `required` to it as well. Every account then
 *      has to accept again; a change that is not material leaves `required` alone.
 *   3. Set `effective`, and the hash of each language's published text in `sha256`
 *      (`node test/legal-versions.mjs --print` prints them from the files in `legal/`).
 * `node test/legal-versions.mjs` checks this file against the documents in `legal/`.
 */
import { type Env, json, SITE_ORIGIN } from "./http.ts";

export type Locale = "en" | "ar";

interface PublishedDocument {
  /** The version on the site now. */
  readonly version: string;
  /** The oldest version an account may have accepted and still be up to date. Terms only. */
  readonly required: string;
  /** Every version that was ever published, oldest first. An acceptance may name only one of these. */
  readonly published: ReadonlyArray<string>;
  /** The day the current version takes effect, YYYY-MM-DD. Null until it is set. */
  readonly effective: string | null;
  /** sha256 of the published text of the current version, per language. Null until it is published. */
  readonly sha256: Readonly<Record<Locale, string | null>>;
  readonly url: Readonly<Record<Locale, string>>;
}

export const LEGAL = {
  terms: {
    version: "1.2",
    required: "1.2",
    published: ["1.1", "1.2"],
    effective: null,
    sha256: { en: null, ar: null },
    url: { en: `${SITE_ORIGIN}/terms`, ar: `${SITE_ORIGIN}/ar/terms` },
  },
  privacy: {
    version: "1.2",
    required: "1.2",
    published: ["1.1", "1.2"],
    effective: null,
    sha256: { en: null, ar: null },
    url: { en: `${SITE_ORIGIN}/privacy`, ar: `${SITE_ORIGIN}/ar/privacy` },
  },
} as const satisfies Record<"terms" | "privacy", PublishedDocument>;

export const SUBPROCESSORS_URL = `${SITE_ORIGIN}/subprocessors`;

/** Compares versions written as numbers and dots: negative when `left` is older than `right`. */
export const compareVersions = (left: string, right: string): number => {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

export type AcceptanceRule = "off" | "signup" | "all";

/** The `REQUIRE_ACCEPTANCE` switch. Anything it does not recognise counts as off. */
export const acceptanceRule = (env: Pick<Env, "REQUIRE_ACCEPTANCE">): AcceptanceRule => {
  const value = env.REQUIRE_ACCEPTANCE?.trim().toLowerCase();
  return value === "signup" || value === "all" ? value : "off";
};

/** What the apps need to show the right links and to notice a change. Public. */
export const legalSummary = (env: Pick<Env, "REQUIRE_ACCEPTANCE">) => {
  const rule = acceptanceRule(env);
  return {
    terms: {
      version: LEGAL.terms.version,
      requiredVersion: LEGAL.terms.required,
      effective: LEGAL.terms.effective,
      url: LEGAL.terms.url,
      sha256: LEGAL.terms.sha256,
    },
    privacy: {
      version: LEGAL.privacy.version,
      effective: LEGAL.privacy.effective,
      url: LEGAL.privacy.url,
      sha256: LEGAL.privacy.sha256,
    },
    subprocessors: { url: SUBPROCESSORS_URL },
    acceptance: {
      /** Starting a sign-in without an `acceptance` object is refused. */
      requiredToSignIn: rule !== "off",
      /** Detection and reading are refused for an account whose acceptance is outstanding. */
      requiredToUse: rule === "all",
    },
  };
};

export const legalVersions = (env: Env): Response => json(legalSummary(env));
