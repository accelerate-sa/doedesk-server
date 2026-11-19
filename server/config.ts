/**
 * Every setting the server takes, read from the environment. systemd hands them over from a file
 * only root can read (`/etc/doedesk/api.env`); `docs/variables.md` lists each one.
 *
 * Nothing here prints a value. A setting that is missing or wrong is named, and the server does not
 * start.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { priceSetting } from "../src/cost.ts";
import type { SmtpSettings } from "./smtp.ts";

export type Stage = "production" | "rehearsal" | "test";

export interface ServerConfig {
  readonly stage: Stage;
  readonly host: string;
  readonly port: number;
  readonly databasePath: string;
  /** A small second file beside the database: which nightly runs happened. Not account data. */
  readonly jobsPath: string;
  readonly migrationsDir: string;
  /**
   * The folder that holds this release's signed record (RELEASE.json and RELEASE.sigstore.json),
   * written there by server/ops/deploy.sh and served at GET /v1/release. The release's own folder
   * unless DOEDESK_RELEASE_DIR says otherwise. See docs/releases.md.
   */
  readonly releaseDir: string;
  readonly geoFile: string;
  readonly geoMaxAgeDays: number;
  readonly trustedProxies: ReadonlyArray<string>;
  readonly forwardSecret: string;
  readonly maxBodyBytes: number;
  readonly readingAtOnce: number;
  readonly shutdownSeconds: number;
  readonly testHooks: boolean;
  readonly smtp: SmtpSettings | null;
  /** What `src/` reads as `env`, without the bindings (database, mail, assets). */
  readonly vars: Readonly<Record<string, string>>;
}

/** Settings handed to the handlers in `src/` under the same names the Worker uses. */
const PASSED_TO_HANDLERS = [
  "ENGINE_URL",
  "ENGINE_TOKEN",
  "ENGINE_PRICE_PER_1000_UNITS",
  "ENGINE_PRICE_PER_1000_PAGES",
  "AUTHENTICA_API_KEY",
  "JWT_PRIVATE_JWK",
  "ADMIN_KEY",
  "EXPOSE_LOGIN_SECRETS",
  "REQUIRE_ACCEPTANCE",
  "SIGNUP_BLOCKED_COUNTRIES",
  "SIGNUP_BLOCK_EU_UK",
  "USAGE_DATA_RANDOM_IDENTIFIERS_ONLY",
  "MAINTENANCE",
  "CONFIRM_ORIGIN",
  "MAIL_INGEST_KEY",
  // Read by the Worker's mail handler only. Passed so the test double for that handler behaves the same.
  "MAIL_FORWARD_TO",
] as const;

export class ConfigError extends Error {
  readonly problems: ReadonlyArray<string>;
  constructor(problems: ReadonlyArray<string>) {
    super(`The server cannot start:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    this.problems = problems;
  }
}

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export const readConfig = (source: Readonly<Record<string, string | undefined>>): ServerConfig => {
  const problems: Array<string> = [];
  const get = (name: string): string => (source[name] ?? "").trim();
  const number = (name: string, fallback: number, minimum: number, maximum: number): number => {
    const raw = get(name);
    if (raw === "") return fallback;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
      problems.push(`${name} must be a whole number from ${minimum} to ${maximum}`);
      return fallback;
    }
    return parsed;
  };

  const stageText = get("DOEDESK_ENV") || "production";
  if (stageText !== "production" && stageText !== "rehearsal" && stageText !== "test") problems.push("DOEDESK_ENV must be production, rehearsal or test");
  const stage = (["production", "rehearsal", "test"] as const).find((candidate) => candidate === stageText) ?? "production";

  const databasePath = get("DOEDESK_DATABASE");
  if (databasePath === "") problems.push("DOEDESK_DATABASE (the path of the SQLite file) is not set");

  const vars: Record<string, string> = {};
  for (const name of PASSED_TO_HANDLERS) if (get(name) !== "") vars[name] = get(name);

  // The signing key and the admin key have no defaults anywhere.
  try {
    const jwk = JSON.parse(vars.JWT_PRIVATE_JWK ?? "") as { kty?: unknown; crv?: unknown; d?: unknown };
    if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.d !== "string") problems.push("JWT_PRIVATE_JWK must be an ES256 private key as a JWK");
  } catch {
    problems.push("JWT_PRIVATE_JWK is not set, or is not JSON");
  }
  if ((vars.ADMIN_KEY ?? "").length < 24) problems.push("ADMIN_KEY must be at least 24 characters");

  // Detection and reading have one place to go: the engine.
  if ((vars.ENGINE_URL ?? "") === "") problems.push("ENGINE_URL (the detection and reading engine) is not set");
  else if (!/^https?:\/\//.test(vars.ENGINE_URL ?? "")) problems.push("ENGINE_URL must start with http:// or https://");
  for (const name of ["ENGINE_PRICE_PER_1000_UNITS", "ENGINE_PRICE_PER_1000_PAGES"] as const) {
    if (vars[name] !== undefined && priceSetting(vars[name]) === undefined) problems.push(`${name} must be a number of US dollars, such as 1.25`);
  }

  const smtpHost = get("SMTP_HOST");
  const smtp: SmtpSettings | null =
    smtpHost === ""
      ? null
      : {
          host: smtpHost,
          port: number("SMTP_PORT", 587, 1, 65535),
          username: get("SMTP_USERNAME"),
          password: source.SMTP_PASSWORD ?? "",
          security: get("SMTP_SECURITY") === "implicit" ? "implicit" : get("SMTP_SECURITY") === "none" ? "none" : "starttls",
          clientName: get("SMTP_CLIENT_NAME") || "api.doedesk.com",
          allowSelfSigned: stage === "test" && get("SMTP_ALLOW_SELF_SIGNED") === "1",
        };

  const testHooks = get("DOEDESK_TEST_HOOKS") === "1";
  if (stage === "production") {
    if (vars.EXPOSE_LOGIN_SECRETS === "1") problems.push("EXPOSE_LOGIN_SECRETS must not be set in production: it returns sign-in codes to the caller");
    if (testHooks) problems.push("DOEDESK_TEST_HOOKS must not be set in production");
    if (smtp === null) problems.push("SMTP_HOST is not set: sign-in links could not be sent");
    else {
      if (smtp.username === "" || smtp.password === "") problems.push("SMTP_USERNAME and SMTP_PASSWORD are not set");
      if (smtp.security === "none") problems.push("SMTP_SECURITY must not be none in production");
    }
    if ((vars.AUTHENTICA_API_KEY ?? "") === "") problems.push("AUTHENTICA_API_KEY is not set: sign-in codes could not be sent by SMS");
  }
  if (testHooks && stage !== "test") problems.push("DOEDESK_TEST_HOOKS is for DOEDESK_ENV=test only");

  const host = get("DOEDESK_HOST") || "127.0.0.1";
  const config: ServerConfig = {
    stage,
    host,
    port: number("DOEDESK_PORT", 8787, 0, 65535),
    databasePath: databasePath === "" ? "" : resolve(databasePath),
    jobsPath: resolve(get("DOEDESK_JOBS_DATABASE") || join(dirname(databasePath || "."), "jobs.sqlite")),
    migrationsDir: resolve(get("DOEDESK_MIGRATIONS_DIR") || join(ROOT, "migrations")),
    releaseDir: resolve(get("DOEDESK_RELEASE_DIR") || ROOT),
    geoFile: get("DOEDESK_GEO_FILE") === "" ? "" : resolve(get("DOEDESK_GEO_FILE")),
    geoMaxAgeDays: number("DOEDESK_GEO_MAX_AGE_DAYS", 100, 1, 3650),
    trustedProxies: get("DOEDESK_TRUSTED_PROXIES").split(/[\s,]+/).filter((entry) => entry !== ""),
    forwardSecret: get("FORWARD_SECRET"),
    // A document may be 20 MB; a megabyte more for anything around it.
    maxBodyBytes: number("DOEDESK_MAX_BODY_BYTES", 21 * 1024 * 1024, 1024, 1024 * 1024 * 1024),
    readingAtOnce: number("DOEDESK_READING_AT_ONCE", 4, 1, 64),
    shutdownSeconds: number("DOEDESK_SHUTDOWN_SECONDS", 130, 1, 600),
    testHooks,
    smtp,
    vars,
  };
  if (config.forwardSecret !== "" && config.forwardSecret.length < 32) problems.push("FORWARD_SECRET must be at least 32 characters");
  if ((vars.MAIL_INGEST_KEY ?? "") !== "" && (vars.MAIL_INGEST_KEY ?? "").length < 32) problems.push("MAIL_INGEST_KEY must be at least 32 characters");
  if (problems.length > 0) throw new ConfigError(problems);
  return config;
};
