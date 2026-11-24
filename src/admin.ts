// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Accelerate Technology Establishment
import { dashboardPage, MAIL_BADGE } from "./dashboard.ts";
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

const KEY_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>DoeDesk</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px ui-sans-serif,system-ui,sans-serif;background:Canvas;color:CanvasText}
form{display:flex;gap:.5rem}input{font:inherit;padding:.6rem .75rem;border:1px solid #8F8A7D;border-radius:10px;min-width:16rem;background:transparent;color:inherit}
button{font:inherit;padding:.6rem 1rem;border:0;border-radius:10px;background:#96531F;color:#fff;cursor:pointer}</style></head>
<body><form method="post" action="/admin"><input type="password" name="key" aria-label="Admin key" placeholder="Admin key" autofocus required><button>Open</button></form></body></html>`;

const setCookie = (value: string, maxAge: number): string => `${COOKIE}=${value}; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

/** Puts the count of unread mail beside "Mail" in the page's navigation. */
const withMailBadge = async (env: Env, response: Response): Promise<Response> => {
  if (!(response.headers.get("content-type") ?? "").startsWith("text/html")) return response;
  const body = await response.text();
  if (!body.includes(MAIL_BADGE)) return new Response(body, response);
  const { unread } = await mailCounts(env);
  return new Response(body.replaceAll(MAIL_BADGE, unread === 0 ? "" : `<span class="badge">${unread}</span>`), response);
};

export const adminDashboard = async (request: Request, env: Env, url: URL): Promise<Response> => {
  if (request.method === "POST" && url.pathname === "/admin") {
    const key = String((await request.formData()).get("key") ?? "");
    if (!timingSafeEqual(key, env.ADMIN_KEY)) return html(KEY_PAGE, 401);
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
    if (url.pathname === "/admin") return html(KEY_PAGE, 401);
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
  const view = (await usageViews(request, env, url)) ?? (await privacyViews(request, env, url)) ?? (await extension().adminViews?.(request, env, url)) ?? html(await dashboardPage(env, url));
  return withMailBadge(env, view);
};
