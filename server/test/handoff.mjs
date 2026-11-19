// The days in which both homes exist: the Worker in front, the server behind it.
//   - forwarding: every API request to the Worker is answered by the server, with the caller's
//     country as Cloudflare reports it; the Worker's own database is not touched;
//   - mail: the Worker forwards a message to the owner and hands its copy to the server;
//   - the emailed link: once the API has its own address, the site sends the link there.
//
//   node server/test/handoff.mjs            (DOEDESK_TEST_TARGET=node for the server on Node)
//
// Starts a server and three Workers (wrangler dev), all on this machine.
import { client, startServerService, startWorkerService, TARGET } from "../../test/local-service.mjs";

let failures = 0;
const expect = (label, condition, detail = null) => {
  if (!condition) failures += 1;
  console.log(`${condition ? "ok  " : "FAIL"} ${label}${condition ? "" : ` -> ${JSON.stringify(detail)?.slice(0, 900)}`}`);
};
const same = (label, actual, expected) => expect(label, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
const rawMail = (to, subject) =>
  [
    `Received: from smtp.example.com (127.0.0.1) by cloudflare-email.com (unknown) id 4fwwffRXOpyR for <${to}>; Tue, 27 Aug 2024 15:50:20 +0000`,
    'From: "A Person" <writer@elsewhere.example>',
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset="utf-8"',
    "Date: Tue, 27 Aug 2024 08:49:44 -0700",
    `Message-ID: <${crypto.randomUUID()}@elsewhere.example>`,
    "",
    "Please answer.",
    "",
  ].join("\r\n");
const sendMail = (base, to, subject) => fetch(`${base}/cdn-cgi/handler/email?from=${encodeURIComponent("writer@elsewhere.example")}&to=${encodeURIComponent(to)}`, { method: "POST", body: rawMail(to, subject) });
const form = (values) => ({ raw: new URLSearchParams(values).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });

const forwardSecret = "f".repeat(48);
const mailKey = "m".repeat(48);
const server = await startServerService({ runtime: TARGET === "node" ? "node" : "bun", vars: { FORWARD_SECRET: forwardSecret, MAIL_INGEST_KEY: mailKey } });
const started = [server];
try {
  // --- Forwarding ---------------------------------------------------------------------------------
  const alone = await startWorkerService({});
  started.push(alone);
  const front = await startWorkerService({ vars: { FORWARD_API_TO: `${server.base}/`, FORWARD_SECRET: forwardSecret } });
  started.push(front);
  const call = client(front.base);
  const rows = (service, table) => service.query(`SELECT COUNT(*) AS n FROM ${table}`)[0].n;

  // Where Cloudflare places this machine, as a Worker with no forwarding reports it.
  const cloudflare = (await client(alone.base)("GET", "/v1/auth/options")).json;
  const through = (await call("GET", "/v1/auth/options")).json;
  same("forward: the server answers with the country Cloudflare reported to the Worker, and the same choices follow from it", [through.country, through.methods, through.usageData], [cloudflare.country, cloudflare.methods, cloudflare.usageData]);
  const direct = (await client(server.base)("GET", "/v1/auth/options", { headers: { "x-doedesk-client-country": "SA", "x-doedesk-client-ip": "203.0.113.5" } })).json;
  same("forward: the same claim made to the server without the Worker's secret is ignored", [direct.country, direct.methods], [null, ["email"]]);
  const spoofed = (await call("GET", "/v1/auth/options", { headers: { "x-doedesk-client-country": "KP", "x-doedesk-forward-secret": "guess" } })).json;
  same("forward: a caller cannot state its own country through the Worker either", spoofed.country, cloudflare.country);

  const email = `forwarded${Date.now()}@person.example`;
  const start = await call("POST", "/v1/auth/email/start", { body: { email, client: "desktop", device: "DoeDesk on Mac" } });
  const link = new URL(start.json.testLink);
  const page = await call("GET", `/auth/confirm${link.search}`);
  const confirmed = await call("POST", "/auth/confirm", form({ r: link.searchParams.get("r"), t: link.searchParams.get("t") }));
  const signedIn = await call("POST", "/v1/auth/email/poll", { body: { requestId: start.json.requestId, pollSecret: start.json.pollSecret } });
  const me = await call("GET", "/v1/me", { token: signedIn.json?.token });
  same("forward: a whole sign-in through the Worker: start, the link's page, confirm, the session, the account", [start.status, page.text.includes("DoeDesk on Mac"), confirmed.text.includes("You are signed in"), signedIn.json?.status, me.status, me.json?.email], [200, true, true, "approved", 200, email]);
  const detected = await call("POST", "/v1/detect", { token: signedIn.json?.token, body: { texts: ["Jane Doe"] } });
  const read = await call("POST", "/v1/ocr", { token: signedIn.json?.token, raw: Buffer.from("%PDF-1.7 pages=2"), headers: { "content-type": "application/pdf" } });
  same("forward: detection and a file sent for reading pass through whole", [detected.status, detected.json?.results?.[0]?.entities?.[0]?.kind, read.status, read.json?.pages], [200, "PERSON", 200, 2]);
  same("forward: everything was written at the server, and the Worker's own database holds nothing", [rows(server, "users"), rows(server, "sessions"), rows(server, "usage_daily"), rows(front, "users"), rows(front, "sessions"), rows(front, "login_requests"), rows(front, "rate_limits"), rows(front, "usage_daily")], [1, 1, 1, 0, 0, 0, 0, 0]);
  const account = server.query("SELECT country FROM users WHERE email = ?", email)[0];
  same("forward: the account carries the country the Worker reported", account?.country ?? null, cloudflare.country ?? null);
  const options = await fetch(`${front.base}/v1/me`, { method: "OPTIONS" });
  const unknown = await call("GET", "/v1/nothing-here");
  const unauthenticated = await call("GET", "/v1/me", { token: "dd_not_a_token" });
  same("forward: answers come back as the server gave them: preflight, not found, not signed in", [options.status, options.headers.get("access-control-allow-origin"), unknown.status, unauthenticated.status, unauthenticated.json?.error?.code], [204, "*", 404, 401, "unauthenticated"]);

  await server.end();
  const down = await call("GET", "/v1/me", { token: signedIn.json?.token });
  same("forward: with the server unreachable the Worker answers 503 with a time to retry, never 401", [down.status, down.json?.error?.code, down.headers.get("retry-after")], [503, "maintenance", "60"]);
  await front.stop();
  await alone.stop();

  // --- Mail, and the link, once the server is the home ----------------------------------------------
  const home = await startServerService({ runtime: server.runtime, folder: server.folder, engine: server.engine, vars: { MAIL_INGEST_KEY: mailKey } });
  started.push(home);
  const site = await startWorkerService({
    host: "doedesk.com",
    vars: { MAIL_RELAY_URL: `${home.base}/internal/inbound-mail`, MAIL_RELAY_KEY: mailKey, MAIL_FORWARD_TO: "owner@mailbox.example", CONFIRM_REDIRECT_TO: "https://api.doedesk.com/" },
  });
  started.push(site);
  const delivered = await sendMail(site.base, "privacy@doedesk.com", "Please delete my account");
  const kept = { ...home.query("SELECT address, sender, subject, forwarded_at IS NOT NULL AS forwarded, forward_error, raw LIKE '%Please answer.%' AS whole FROM contact_mail")[0] };
  same("mail: the Worker forwards the message to the owner and the server stores the copy, marked as forwarded", [delivered.status, site.log().includes("rcptTo: owner@mailbox.example"), kept, rows(site, "contact_mail")], [200, true, { address: "privacy@doedesk.com", sender: "writer@elsewhere.example", subject: "Please delete my account", forwarded: 1, forward_error: null, whole: 1 }, 0]);
  const refused = await sendMail(site.base, "sales@doedesk.com", "Hello");
  same("mail: an address that takes no mail is refused at the Worker and nothing reaches the server", [refused.status === 200, rows(home, "contact_mail")], [false, 1]);
  await sendMail(site.base, "e2e-handoff001@doedesk.com", "For a test");
  same("mail: a test mailbox's message is stored at the server and not forwarded", [rows(home, "test_inbox"), site.log().split("rcptTo: owner@mailbox.example").length - 1], [1, 1]);

  const siteCall = client(site.base);
  const get = await siteCall("GET", "/auth/confirm?r=abc&t=def");
  const post = await siteCall("POST", "/auth/confirm", form({ r: "abc", t: "def" }));
  same("link: on the site, the link's page now sends the browser to the API's address, keeping the method and the form", [get.status, get.headers.get("location"), post.status, post.headers.get("location")], [307, "https://api.doedesk.com/auth/confirm?r=abc&t=def", 307, "https://api.doedesk.com/auth/confirm"]);
  expect("mail: the server's log names no sender", !/elsewhere\.example/.test(home.log()), home.log().slice(-300));
} catch (cause) {
  failures += 1;
  console.log(`FAIL the run stopped: ${cause?.stack ?? cause}`);
} finally {
  for (const service of started.reverse()) await service.stop().catch(() => {});
}
console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
