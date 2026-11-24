// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Accelerate Technology Establishment
// Exercises sign-in against a local `wrangler dev --var EXPOSE_LOGIN_SECRETS:1`.
// Usage: node test/auth-flow.mjs http://localhost:8931
const base = process.argv[2] ?? "http://localhost:8931";
const call = async (method, path, body, token, headers = {}) => {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: response.status, json, text };
};
let failures = 0;
const expect = (label, condition, detail = null) => {
  if (!condition) failures += 1;
  console.log(`${condition ? "ok  " : "FAIL"} ${label}${condition ? "" : ` -> ${JSON.stringify(detail).slice(0, 300)}`}`);
};
const phone = `05${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
const email = `person${Date.now()}@example.com`;

const options = await call("GET", "/v1/auth/options");
expect("options answer", options.status === 200 && Array.isArray(options.json.methods), options);
console.log("     country:", options.json?.country, "methods:", options.json?.methods?.join(","));

if (options.json?.methods?.includes("phone")) {
  const start = await call("POST", "/v1/auth/phone/start", { phone, client: "desktop", device: "Mac" });
  expect("phone start", start.status === 200 && start.json.testCode?.length === 6, start);
  const wrong = await call("POST", "/v1/auth/phone/verify", { requestId: start.json.requestId, code: "000000" === start.json.testCode ? "111111" : "000000" });
  expect("wrong code refused", wrong.status === 401 && wrong.json.error.code === "wrong_code", wrong);
  const verify = await call("POST", "/v1/auth/phone/verify", { requestId: start.json.requestId, code: start.json.testCode });
  expect("right code signs in", verify.status === 200 && verify.json.token?.startsWith("dd_") && verify.json.created === true, verify);
  const reuse = await call("POST", "/v1/auth/phone/verify", { requestId: start.json.requestId, code: start.json.testCode });
  expect("code works once", reuse.status === 410, reuse);
  const soon = await call("POST", "/v1/auth/phone/start", { phone });
  expect("resend waits a minute", soon.status === 429, soon);
  const me = await call("GET", "/v1/me", undefined, verify.json.token);
  expect("me hides the number's middle", me.status === 200 && me.json.phone?.includes("•••") && me.json.profileAnswered === false, me);
  const profile = await call("POST", "/v1/me/profile", { field: "legal", workplace: "small_company" }, verify.json.token);
  const after = await call("GET", "/v1/me", undefined, verify.json.token);
  expect("profile saved", profile.status === 200 && after.json.field === "legal" && after.json.profileAnswered === true, after);
} else {
  const refused = await call("POST", "/v1/auth/phone/start", { phone });
  expect("phone refused outside Saudi Arabia", refused.status === 403, refused);
}
const bad = await call("POST", "/v1/auth/phone/start", { phone: "12345" });
expect("bad phone refused", bad.status === 400 || bad.status === 403, bad);

const start = await call("POST", "/v1/auth/email/start", { email: email.toUpperCase(), client: "desktop", device: "DoeDesk on Mac" });
expect("email start", start.status === 200 && typeof start.json.testLink === "string", start);
const poll = () => call("POST", "/v1/auth/email/poll", { requestId: start.json.requestId, pollSecret: start.json.pollSecret });
expect("poll pending", (await poll()).json?.status === "pending");
const link = new URL(start.json.testLink);
const site = { host: "doedesk.com" };
const page = await fetch(`${base}/auth/confirm${link.search}`, { headers: { "x-test-host": "site" } });
const pageText = await page.text();
expect("link page asks, does not approve", pageText.includes("Confirm sign-in") && pageText.includes("DoeDesk on Mac"), pageText.slice(0, 200));
expect("still pending after opening the link", (await poll()).json?.status === "pending");
const wrongPoll = await call("POST", "/v1/auth/email/poll", { requestId: start.json.requestId, pollSecret: "nope" });
expect("poll needs its secret", wrongPoll.status === 401, wrongPoll);
const confirm = await fetch(`${base}/auth/confirm`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", "x-test-host": "site" },
  body: new URLSearchParams({ r: link.searchParams.get("r"), t: link.searchParams.get("t") }),
});
expect("confirm page says signed in", (await confirm.text()).includes("You are signed in"));
const approved = await poll();
expect("poll returns a session", approved.json?.status === "approved" && approved.json.token?.startsWith("dd_"), approved);
expect("session handed out once", (await poll()).status === 410);
const token = approved.json.token;
const jwt = await call("POST", "/v1/auth/token", { audience: "doedesk-relay" }, token);
expect("relay token minted", jwt.status === 200 && jwt.json.token.split(".").length === 3, jwt);
const jwks = await call("GET", "/.well-known/jwks.json");
const [head, payload, signature] = jwt.json.token.split(".");
const key = await crypto.subtle.importKey("jwk", jwks.json.keys[0], { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
const b64 = (value) => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, b64(signature), new TextEncoder().encode(`${head}.${payload}`));
const claims = JSON.parse(new TextDecoder().decode(b64(payload)));
expect("relay token verifies against the published key", valid && claims.aud === "doedesk-relay" && claims.iss === "https://api.doedesk.com", claims);
const badAudience = await call("POST", "/v1/auth/token", { audience: "other" }, token);
expect("unknown audience refused", badAudience.status === 400, badAudience);
const extra = await call("POST", "/v1/auth/sessions", { client: "server" }, token);
expect("extra session", extra.status === 200 && extra.json.token !== token, extra);
const ingest = await call("POST", "/ingest/batch/", { api_key: "doedesk-client", batch: [{ uuid: `u-${Date.now()}`, event: "client.turn.requested", distinct_id: "d1", properties: { installId: "i1", platform: "darwin" }, timestamp: new Date().toISOString() }] });
expect("events accepted", ingest.status === 200 && ingest.json.status === 1, ingest);
const badKey = await call("POST", "/ingest/batch/", { api_key: "x", batch: [] });
expect("events need the client key", badKey.status === 401, badKey);
const out = await call("POST", "/v1/auth/sign-out", undefined, token);
const gone = await call("GET", "/v1/me", undefined, token);
expect("sign-out ends the session", out.status === 200 && gone.status === 401, gone);
const still = await call("GET", "/v1/me", undefined, extra.json.token);
expect("other session survives", still.status === 200, still);
console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
