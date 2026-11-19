/**
 * The service on a machine of its own: the same handlers as the Cloudflare Worker (`src/index.ts`),
 * given by this file what Cloudflare gave them.
 *
 *   Cloudflare gave                    here
 *   env.DB (D1)                        the same interface over a SQLite file (d1.ts)
 *   env.EMAIL.send                     SMTP through Oracle Email Delivery (smtp.ts)
 *   request.cf.country, regionCode     a lookup in a file on this machine (geo.ts)
 *   cf-connecting-ip                   the address the reverse proxy reports (client-address.ts)
 *   the cron trigger                   a systemd timer that runs nightly.ts
 *   the email handler                  POST /internal/inbound-mail, in src/mail.ts
 *   env.ASSETS, the site               not here: the site stays on Cloudflare
 *
 * Nothing in a request or an answer is changed apart from that. One route exists here only:
 * GET /v1/release, the signed record of the release this process runs (docs/releases.md).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import worker from "../src/index.ts";
import { engineHealth } from "../src/engine.ts";
import type { Env } from "../src/http.ts";
import { FORWARD_HEADERS } from "../src/maintenance.ts";
import { resolveCaller } from "./client-address.ts";
import type { ServerConfig } from "./config.ts";
import type { Database } from "./d1.ts";
import type { Geo } from "./geo.ts";
import type { JobRun } from "./jobs.ts";
import { sendMail, SmtpError } from "./smtp.ts";

export interface AppDependencies {
  readonly config: ServerConfig;
  readonly database: Database;
  readonly geo: Geo;
  readonly runtime: { readonly name: string; readonly version: string };
  /** The newest nightly run, for the health answer. */
  readonly lastNightly: () => Promise<JobRun | null>;
  readonly log: (line: string) => void;
}

const jsonResponse = (body: unknown, status: number, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });

/** The two files deploy.sh writes beside the release: the record, and its signature bundle. */
export const RELEASE_FILES = { record: "RELEASE.json", signature: "RELEASE.sigstore.json" } as const;

/**
 * GET /v1/release and GET /v1/release/signature: the files exactly as deploy.sh wrote them, byte for
 * byte, because the signature is over those bytes. Read on every request (they are small), so a
 * record signed after an emergency deploy is served without a restart. Anyone may ask.
 */
const releaseFile = (folder: string, which: keyof typeof RELEASE_FILES): Response => {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(join(folder, RELEASE_FILES[which]));
  } catch {
    const message = which === "record" ? "This server has no release record (it was not started by a deploy)." : "This release record is not signed.";
    return jsonResponse({ error: { code: which === "record" ? "no_release_record" : "not_signed", message } }, 404, { "access-control-allow-origin": "*" });
  }
  return new Response(bytes, {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" },
  });
};

/** What `env.EMAIL.send` takes on Cloudflare: the fields auth.ts passes. */
interface WorkerMail {
  readonly to: string;
  readonly from: { readonly email: string; readonly name?: string };
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
}

export const buildEnv = (dependencies: AppDependencies): Env => {
  const { config } = dependencies;
  const email = {
    send: async (message: unknown): Promise<{ messageId: string }> => {
      if (config.smtp === null) throw new SmtpError("smtp_not_configured", "No mail server is set.");
      return sendMail(config.smtp, message as WorkerMail);
    },
  };
  const assets = { fetch: async () => jsonResponse({ error: { code: "not_found", message: "Not found." } }, 404) };
  return { ...config.vars, DB: dependencies.database, EMAIL: email, ASSETS: assets } as unknown as Env;
};

export interface App {
  /** Answers one request. `peer` is the address on the other end of the connection. */
  fetch(request: Request, peer: string): Promise<Response>;
  /** Requests being answered now. */
  inFlight(): number;
  /** Resolves when no request is being answered. */
  idle(): Promise<void>;
  /** From now on new requests are refused, so that the ones in flight can finish and the process can end. */
  drain(): void;
}

export const createApp = (dependencies: AppDependencies): App => {
  const { config, geo, log } = dependencies;
  const env = buildEnv(dependencies);
  const started = Date.now();
  let active = 0;
  let draining = false;
  let reading = 0;
  let whenIdle: Array<() => void> = [];

  const health = async (): Promise<Response> => {
    let databaseOk = false;
    let accounts: number | null = null;
    try {
      accounts = (await dependencies.database.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>())?.n ?? null;
      databaseOk = true;
    } catch {
      databaseOk = false;
    }
    const nightly = await dependencies.lastNightly().catch(() => null);
    const geoStatus = geo.status();
    // Asked of the engine each time: an engine that is down or unavailable fails every request to
    // detect or read, and nothing else on this machine would say so.
    const engineState = await engineHealth(env);
    return jsonResponse(
      {
        ok: databaseOk,
        stage: config.stage,
        runtime: `${dependencies.runtime.name} ${dependencies.runtime.version}`,
        uptimeSeconds: Math.floor((Date.now() - started) / 1000),
        inFlight: active,
        database: { ok: databaseOk, accounts },
        country: geoStatus,
        nightly: nightly === null ? null : { day: nightly.day, outcome: nightly.outcome, finishedAt: nightly.finished_at },
        engine: "local",
        engineReady: engineState.ready,
        engineState: engineState.detail,
        mail: config.smtp === null ? "not configured" : "smtp",
        frozen: config.vars.MAINTENANCE === "freeze",
      },
      databaseOk ? 200 : 503,
    );
  };

  /** Stand-ins for wrangler's local triggers, so the same test suites run here. Test stage only. */
  const testHook = async (request: Request, url: URL): Promise<Response | null> => {
    if (url.pathname === "/cdn-cgi/handler/scheduled") {
      await worker.scheduled({} as ScheduledController, env);
      return new Response("ok");
    }
    if (url.pathname === "/cdn-cgi/handler/email" && request.method === "POST") {
      const raw = await request.text();
      const headers = new Headers();
      for (const line of raw.split(/\r?\n\r?\n/)[0]?.split(/\r?\n/) ?? []) {
        const colon = line.indexOf(":");
        if (colon > 0) headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
      }
      let rejected: string | null = null;
      const message = {
        from: url.searchParams.get("from") ?? "",
        to: url.searchParams.get("to") ?? "",
        headers,
        raw: new Response(raw).body,
        rawSize: raw.length,
        setReject: (reason: string) => {
          rejected = reason;
        },
        // wrangler prints the destination when a local Worker forwards mail; the suites look for it.
        forward: async (destination: string) => log(`email forward rcptTo: ${destination}`),
        reply: async () => {},
      };
      await worker.email(message as unknown as ForwardableEmailMessage, env);
      return new Response(rejected === null ? "Worker successfully processed email" : `Worker rejected email with the following reason: ${rejected}`, {
        status: rejected === null ? 200 : 400,
      });
    }
    return null;
  };

  const answer = async (request: Request, peer: string): Promise<Response> => {
    const url = new URL(request.url);
    const caller = resolveCaller(request.headers, peer, config);

    // Health, for the machine itself: asked directly, not through the reverse proxy.
    if (url.pathname === "/internal/health") {
      const direct = request.headers.get("x-forwarded-for") === null && (caller.ip === "127.0.0.1" || caller.ip === "0:0:0:0:0:0:0:1");
      return direct && request.method === "GET" ? health() : jsonResponse({ error: { code: "not_found", message: "Not found." } }, 404);
    }
    if (url.pathname.startsWith("/cdn-cgi/")) {
      const hooked = config.testHooks ? await testHook(request, url) : null;
      return hooked ?? jsonResponse({ error: { code: "not_found", message: "Not found." } }, 404);
    }

    if (request.method === "GET" && url.pathname === "/v1/release") return releaseFile(config.releaseDir, "record");
    if (request.method === "GET" && url.pathname === "/v1/release/signature") return releaseFile(config.releaseDir, "signature");

    const place = caller.stated ?? geo.lookup(caller.ip);
    const headers = new Headers(request.headers);
    // What Cloudflare used to state about the caller is stated here, and nothing the caller sent
    // under those names survives.
    for (const name of Object.values(FORWARD_HEADERS)) headers.delete(name);
    headers.set("cf-connecting-ip", caller.ip);
    const passed = new Request(request, { headers });
    Object.defineProperty(passed, "cf", { value: { country: place.country ?? undefined, regionCode: place.region ?? undefined } });

    // Each file being read is held in memory while the reader works. A bound keeps a burst of large
    // files from taking the machine's memory; past it the app is told to try again.
    const isReading = request.method === "POST" && url.pathname === "/v1/ocr";
    if (isReading) {
      if (reading >= config.readingAtOnce) {
        return jsonResponse({ error: { code: "busy", message: "DoeDesk Cloud is reading other documents. Try again in a moment." } }, 503, {
          "retry-after": "5",
          "access-control-allow-origin": "*",
        });
      }
      reading += 1;
    }
    try {
      return await worker.fetch(passed, env);
    } finally {
      if (isReading) reading -= 1;
    }
  };

  return {
    fetch: async (request, peer) => {
      if (draining) {
        return jsonResponse({ error: { code: "maintenance", message: "DoeDesk Cloud is restarting. Try again in a moment." } }, 503, {
          "retry-after": "5",
          connection: "close",
        });
      }
      active += 1;
      try {
        return await answer(request, peer);
      } catch (cause) {
        log(`unhandled_adapter ${cause instanceof Error ? cause.message : String(cause)}`);
        return jsonResponse({ error: { code: "internal", message: "Something went wrong on our side." } }, 500);
      } finally {
        active -= 1;
        if (active === 0) {
          for (const resolve of whenIdle) resolve();
          whenIdle = [];
        }
      }
    },
    inFlight: () => active,
    idle: () => (active === 0 ? Promise.resolve() : new Promise<void>((resolve) => whenIdle.push(resolve))),
    drain: () => {
      draining = true;
    },
  };
};
