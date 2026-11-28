// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Accelerate Technology Establishment
import { MARK_SVG } from "./brand.ts";
import { dashboardPage, FEEDBACK_BADGE, MAIL_BADGE } from "./dashboard.ts";
import { feedbackCounts, feedbackViews } from "./feedback-views.ts";
import { ApiError, type Env, html, json, timingSafeEqual, toHex } from "./http.ts";
import { mailCounts } from "./mail.ts";
import { privacyViews } from "./privacy-views.ts";
import { extension } from "./extension.ts";
import { usageViews } from "./usage-views.ts";

const COOKIE = "dd_admin";
/**
 * How long the dashboard stays open after the key is typed. The cookie carries its own end time,
 * signed with the key, so it stops working then whatever the browser does with it.
 */
const COOKIE_HOURS = 12;

const sign = async (env: Env, expires: number): Promise<string> => {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.ADMIN_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`admin-cookie:${expires}`)));
};

/** The cookie's value: when it ends (seconds since 1970), and the signature over that. */
const cookieValue = async (env: Env, expires: number): Promise<string> => `${expires}.${await sign(env, expires)}`;

const cookieStands = async (env: Env, value: string): Promise<boolean> => {
  const [expires, signature] = value.split(".");
  if (expires === undefined || signature === undefined || !/^\d{1,12}$/.test(expires)) return false;
  if (Number(expires) * 1000 <= Date.now()) return false;
  return timingSafeEqual(signature, await sign(env, Number(expires)));
};

const isAdmin = async (request: Request, env: Env): Promise<boolean> => {
  const bearer = request.headers.get("authorization") ?? "";
  if (bearer.startsWith("Bearer ") && timingSafeEqual(bearer.slice(7).trim(), env.ADMIN_KEY)) return true;
  const cookie = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE}=`));
  return cookie !== undefined && (await cookieStands(env, cookie.slice(COOKIE.length + 1)));
};

/**
 * The page that asks for the key. Its colours come from `light-dark()`, so the page holds no
 * at-sign: a refused request is checked for carrying nobody's address, and this keeps that simple.
 */
const keyPage = (refused: boolean): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>DoeDesk</title><link rel="icon" href="https://doedesk.com/favicon.svg">
<style>:root{color-scheme:light dark;--paper:light-dark(#f5f3ee,#121311);--card:light-dark(#fff,#1a1c19);--ink:light-dark(#171815,#eceae3);--muted:light-dark(#5c5e56,#a2a599);--border:light-dark(#ddd9cf,#2b2e29);--accent:light-dark(#96531f,#e2a674);--on-accent:light-dark(#fff,#1d1309);--bad:light-dark(#a11c12,#ff8b80)}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:1rem;font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--paper);color:var(--ink);-webkit-font-smoothing:antialiased}
main{inline-size:min(22rem,100%);padding:1.5rem;border:1px solid var(--border);border-radius:.9rem;background:var(--card)}
.brand{display:flex;align-items:center;gap:.5rem;margin-bottom:1.25rem;font-weight:600}.brand svg{width:1.5rem;height:1.5rem}
form{display:flex;gap:.5rem}
input,button{font:inherit;block-size:2.5rem;border-radius:.6rem}
input{flex:1;min-width:0;padding:0 .75rem;border:1px solid var(--border);background:transparent;color:inherit;font-size:1rem}
input::placeholder{color:var(--muted)}
input[aria-invalid]{border-color:var(--bad)}
button{flex:none;padding:0 1rem;border:0;background:var(--accent);color:var(--on-accent);font-size:.875rem;font-weight:500;cursor:pointer}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
p{margin:.6rem 0 0;font-size:.8125rem;color:var(--bad)}</style></head>
<body><main><div class="brand">${MARK_SVG}<span>DoeDesk</span></div><form method="post" action="/admin"><input type="password" name="key" aria-label="Admin key" placeholder="Admin key" autocomplete="current-password" autofocus required${refused ? ' aria-invalid="true" aria-describedby="refused"' : ""}><button>Sign in</button></form>${refused ? '<p id="refused" role="alert">Wrong key</p>' : ""}</main></body></html>`;

const setCookie = (value: string, maxAge: number): string => `${COOKIE}=${value}; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

/** Puts the unread counts beside "Mail" and "Feedback" in the page's navigation. */
const withNavBadges = async (env: Env, response: Response): Promise<Response> => {
  if (!(response.headers.get("content-type") ?? "").startsWith("text/html")) return response;
  const body = await response.text();
  const wantsMail = body.includes(MAIL_BADGE);
  const wantsFeedback = body.includes(FEEDBACK_BADGE);
  if (!wantsMail && !wantsFeedback) return new Response(body, response);
  const [mail, feedback] = await Promise.all([
    wantsMail ? mailCounts(env) : Promise.resolve({ unread: 0 }),
    wantsFeedback ? feedbackCounts(env) : Promise.resolve({ unread: 0 }),
  ]);
  const updated = body
    .replaceAll(MAIL_BADGE, mail.unread === 0 ? "" : `<span class="badge">${mail.unread}</span>`)
    .replaceAll(FEEDBACK_BADGE, feedback.unread === 0 ? "" : `<span class="badge">${feedback.unread}</span>`);
  return new Response(updated, response);
};

export const adminDashboard = async (request: Request, env: Env, url: URL): Promise<Response> => {
  if (request.method === "POST" && url.pathname === "/admin") {
    const key = String((await request.formData()).get("key") ?? "");
    if (!timingSafeEqual(key, env.ADMIN_KEY)) return html(keyPage(true), 401);
    const expires = Math.floor(Date.now() / 1000) + COOKIE_HOURS * 3600;
    return new Response(null, {
      status: 303,
      headers: { location: "/admin", "set-cookie": setCookie(await cookieValue(env, expires), COOKIE_HOURS * 3600) },
    });
  }
  // Signing out needs no key: all it does is tell the browser to drop the cookie.
  if (request.method === "POST" && url.pathname === "/admin/sign-out") {
    return new Response(null, { status: 303, headers: { location: "/admin", "set-cookie": setCookie("", 0) } });
  }
  if (!(await isAdmin(request, env))) {
    if (url.pathname === "/admin") return html(keyPage(false), 401);
    throw new ApiError(401, "unauthenticated", "Admin key required.");
  }
  if (url.pathname === "/admin/test-inbox") {
    const address = (url.searchParams.get("address") ?? "").toLowerCase();
    const rows = await env.DB.prepare(
      "SELECT received_at, raw FROM test_inbox WHERE address = ? ORDER BY received_at DESC LIMIT 5",
    )
      .bind(address)
      .all<{ received_at: string; raw: string }>();
    return json({ messages: rows.results });
  }
  const view =
    (await usageViews(request, env, url)) ??
    (await privacyViews(request, env, url)) ??
    (await feedbackViews(request, env, url)) ??
    (await extension().adminViews?.(request, env, url)) ??
    html(await dashboardPage(env, url));
  return withNavBadges(env, view);
};
