/**
 * DoeDesk Cloud: accounts, the two services the DoeDesk app needs to mask personal data before a
 * request reaches a model (finding names in text, reading text out of images), usage events, and
 * the public site.
 *
 * Nothing sent for detection or reading is stored. Only counts are kept, per account and day.
 */
import { authenticate, publicAccount, saveProfile } from "./accounts.ts";
import { adminDashboard } from "./admin.ts";
import {
  acceptTerms,
  authOptions,
  confirmLink,
  createExtraSession,
  jwks,
  mintToken,
  pollEmail,
  signOut,
  startEmail,
  startPhone,
  verifyPhone,
} from "./auth.ts";
import { detect } from "./detect.ts";
import { ApiError, CORS_HEADERS, type Env, html, json, readJson } from "./http.ts";
import { acceptanceStatus } from "./acceptance.ts";
import { ingestBatch, ingestChoice, ingestCrash } from "./ingest.ts";
import { legalSummary, legalVersions } from "./legal.ts";
import { receiveMail, receiveRelayedMail } from "./mail.ts";
import { forwardsApi, forwardToOrigin, isFrozen, isMaintenanceError, withMaintenance } from "./maintenance.ts";
import { ocr } from "./ocr.ts";
import { confirmPage } from "./pages.ts";
import { nightly } from "./retention.ts";
import { deleteMe, exportMe } from "./rights.ts";
import { MONTHLY_DETECT_CHARACTERS, MONTHLY_OCR_PAGES, nextMonthStart, readUsage } from "./usage.ts";

const SITE_HOSTS = new Set(["doedesk.com", "www.doedesk.com"]);

/** False on the Cloudflare Worker once its D1 binding is removed (the last stage of the move off it). */
const hasDatabase = (env: Env): boolean => (env as { DB?: unknown }).DB !== undefined;

const api = async (request: Request, env: Env, url: URL): Promise<Response> => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  // PostHog clients post to `/batch/`; accept the path with or without the slash.
  const route = `${request.method} ${url.pathname.replace(/(.)\/$/, "$1")}`;
  switch (route) {
    case "GET /":
      return Response.redirect("https://doedesk.com/", 302);
    case "GET /v1/health":
      return json({ ok: true });
    case "GET /.well-known/jwks.json":
      return jwks(env);
    case "GET /v1/legal":
      return legalVersions(env);
    case "GET /v1/auth/options":
      return authOptions(request, env);
    case "POST /v1/auth/phone/start":
      return startPhone(request, env);
    case "POST /v1/auth/phone/verify":
      return verifyPhone(request, env);
    case "POST /v1/auth/email/start":
      return startEmail(request, env);
    case "POST /v1/auth/email/poll":
      return pollEmail(request, env);
    case "POST /v1/auth/sessions":
      return createExtraSession(request, env);
    case "POST /v1/auth/token":
      return mintToken(request, env);
    case "POST /v1/auth/sign-out":
      return signOut(request, env);
    case "GET /v1/me": {
      const account = await authenticate(request, env, { deletionOnly: true });
      return json({
        ...publicAccount(account),
        field: account.field,
        workplace: account.workplace,
        // Whether this account has accepted the Terms that are required now, and the versions in force.
        acceptance: await acceptanceStatus(env, account.userId),
        legal: legalSummary(env),
        // This month so far (UTC), for the app to show beside the allowance. No prices.
        usage: await readUsage(env, account.userId),
        allowance: {
          detectCharacters: MONTHLY_DETECT_CHARACTERS,
          ocrPages: MONTHLY_OCR_PAGES,
          resetsAt: nextMonthStart(),
        },
      });
    }
    // Saves the two onboarding answers. Sending it again corrects them; sending nulls withdraws them.
    case "POST /v1/me/profile": {
      const account = await authenticate(request, env);
      await saveProfile(env, account.userId, await readJson(request));
      return json({ ok: true });
    }
    case "POST /v1/me/acceptance":
      return acceptTerms(request, env);
    case "GET /v1/me/export":
      return exportMe(request, env);
    case "DELETE /v1/me":
      return deleteMe(request, env);
    case "POST /v1/detect":
      return detect(request, env);
    case "POST /v1/ocr":
      return ocr(request, env);
    case "POST /ingest/batch":
      return ingestBatch(request, env);
    case "POST /ingest/choice":
      return ingestChoice(request, env);
    case "POST /ingest/crash":
      return ingestCrash(request, env);
    case "POST /internal/inbound-mail":
      return receiveRelayedMail(request, env);
    default:
      if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) return adminDashboard(request, env, url);
      return json({ error: { code: "not_found", message: "Not found." } }, 404);
  }
};

const site = async (request: Request, env: Env, url: URL): Promise<Response> => {
  if (url.hostname === "www.doedesk.com") {
    return Response.redirect(`https://doedesk.com${url.pathname}${url.search}`, 301);
  }
  // One address for the installer, so the site and the app never carry a version number.
  if (url.pathname === "/download") {
    return Response.redirect("https://github.com/accelerate-sa/doedesk/releases/latest/download/DoeDesk-arm64.dmg", 302);
  }
  if (url.pathname === "/mobile") return Response.redirect("https://doedesk.com/", 302);
  return env.ASSETS.fetch(request);
};

/** What an error becomes. A refusal for maintenance says when to try again, and is a page where a person is looking at one. */
const failure = (request: Request, url: URL, cause: unknown): Response => {
  if (cause instanceof ApiError) {
    if (isMaintenanceError(cause) && url.pathname === "/auth/confirm") {
      const locale = request.headers.get("accept-language")?.toLowerCase().startsWith("ar") ? "ar" : "en";
      return html(confirmPage({ state: "moving", locale }), 503, { "retry-after": String(cause.extra.retryAfterSeconds ?? 300) });
    }
    const response = json({ error: { code: cause.code, message: cause.message, ...cause.extra } }, cause.status);
    // "Try again later" says when, in the header software reads as well as in the body.
    if (cause.status === 503 && typeof cause.extra.retryAfterSeconds === "number") response.headers.set("retry-after", String(cause.extra.retryAfterSeconds));
    return response;
  }
  console.error("unhandled", request.method, url.pathname, cause instanceof Error ? cause.message : String(cause));
  return json({ error: { code: "internal", message: "Something went wrong on our side." } }, 500);
};

export default {
  async fetch(request: Request, settings: Env): Promise<Response> {
    const env = withMaintenance(settings);
    const url = new URL(request.url);
    try {
      const confirming = url.pathname === "/auth/confirm" && (request.method === "GET" || request.method === "POST");
      const onSite = SITE_HOSTS.has(url.hostname);
      // While the data has moved and the address has not: the API, and the emailed link's page, are
      // passed to the new origin (maintenance.ts).
      if (forwardsApi(env) && (!onSite || confirming)) return await forwardToOrigin(request, env, url);
      // Once the API has its own address: links that still open on the site are sent there. 307
      // keeps the method and the form, so a page opened before the change still works.
      if (confirming && onSite && (env.CONFIRM_REDIRECT_TO ?? "") !== "") {
        return new Response(null, {
          status: 307,
          headers: { location: `${(env.CONFIRM_REDIRECT_TO ?? "").replace(/\/+$/, "")}/auth/confirm${url.search}`, "cache-control": "no-store" },
        });
      }
      // The Worker without a database (after the API moved to Jeddah): the site, its redirects and
      // contact mail only. Every API address there is gone, and nothing reads or writes data.
      if (!hasDatabase(settings)) {
        return onSite && !confirming ? await site(request, env, url) : json({ error: { code: "not_found", message: "Not found." } }, 404);
      }
      // The emailed link lands on the site; any host answers it so a local run can be tested.
      if (confirming) return await confirmLink(request, env);
      return onSite ? await site(request, env, url) : await api(request, env, url);
    } catch (cause) {
      return failure(request, url, cause);
    }
  },
  /** Mail to the domain: the public contact addresses, forwarded to the owner, and test mailboxes. */
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    await receiveMail(message, withMaintenance(env));
  },
  /** Every night at 03:17 UTC: deletes what is no longer kept, and rolls old usage days into months. */
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    // Frozen for a move: nothing may be written, and the job runs again tomorrow. Without a
    // database (the Worker after the move) there is nothing to do.
    if (isFrozen(env) || !hasDatabase(env)) return;
    await nightly(env);
  },
} satisfies ExportedHandler<Env>;
