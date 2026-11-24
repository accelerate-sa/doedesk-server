// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Accelerate Technology Establishment
// The reverse proxy as configured (server/ops/Caddyfile), run for real in front of the server:
//   - the caller's address reaches the API from Caddy and cannot be stated by the caller;
//   - the request log holds no sign-in secret, no account identifier, no address, no cookie and
//     no body, and only the first part of the caller's address;
//   - the size limit, the security headers, and the two paths that are for the machine alone.
//
//   node server/test/proxy.mjs          needs Docker (it runs the official Caddy image)
//
// Without Docker it says so and exits 0, so the other suites are not held up.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256Hex, startServerService, TARGET } from "../../test/local-service.mjs";
import { buildGeo } from "../geo-build.ts";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
if (spawnSync("docker", ["info"], { stdio: "ignore" }).status !== 0) {
  console.log("skipped: Docker is not running here\n\nall passed");
  process.exit(0);
}
let failures = 0;
const expect = (label, condition, detail = null) => {
  if (!condition) failures += 1;
  console.log(`${condition ? "ok  " : "FAIL"} ${label}${condition ? "" : ` -> ${JSON.stringify(detail)?.slice(0, 900)}`}`);
};
const same = (label, actual, expected) => expect(label, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const folder = mkdtempSync(join(tmpdir(), "doedesk-proxy-"));
chmodSync(folder, 0o777);
async function* lines() {
  yield "203.0.113.0,203.0.113.255,AS,SA,Riyadh,Riyadh,0,0";
}
writeFileSync(join(folder, "country.ddgeo"), (await buildGeo(lines(), { source: "proxy-test", minimums: { v4: 1, v6: 0, countries: 1 } })).bytes);
const NOW = new Date().toISOString();
const TOKEN = "dd_proxy_secret_token_value";
const ACCOUNT = "00000000-0000-4000-a000-0000acc0un7d";
const service = await startServerService({
  runtime: TARGET === "node" ? "node" : "bun",
  seedSql:
    `INSERT INTO users (id, email, created_at, country, signup_method) VALUES ('${ACCOUNT}', 'proxied@seeded.example', '${NOW}', 'SA', 'email');` +
    `INSERT INTO sessions (token_hash, user_id, client, device, created_at, last_used_at) VALUES ('${sha256Hex(TOKEN)}', '${ACCOUNT}', 'desktop', 't', '${NOW}', '${NOW}');`,
  // Docker's connection arrives from a private address, not from this machine's loopback: for this
  // test the API listens on every interface and trusts Docker's networks as it trusts Caddy in production.
  vars: { DOEDESK_HOST: "0.0.0.0", DOEDESK_TRUSTED_PROXIES: "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16", DOEDESK_GEO_FILE: join(folder, "country.ddgeo"), EXPOSE_LOGIN_SECRETS: "" },
});
const port = Number(new URL(service.base).port);
const name = `doedesk-proxy-test-${process.pid}`;
const published = 20000 + (process.pid % 20000);
const caddy = spawn(
  "docker",
  ["run", "--rm", "--name", name, "-p", `127.0.0.1:${published}:443`, "-v", `${join(ROOT, "server", "ops", "Caddyfile")}:/etc/caddy/Caddyfile:ro`, "-v", `${folder}:/var/log/caddy`, "-e", "DOEDESK_SITE=api.doedesk.com", "-e", "DOEDESK_TLS=internal", "-e", "ACME_EMAIL=ops@example.com", "-e", `DOEDESK_UPSTREAM=host.docker.internal:${port}`, "caddy:2.11"],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let caddyLog = "";
caddy.stdout.on("data", (chunk) => (caddyLog += chunk));
caddy.stderr.on("data", (chunk) => (caddyLog += chunk));

/**
 * A request to Caddy as api.doedesk.com, accepting the certificate Caddy made for the rehearsal.
 * Run without blocking this process: the stand-in for the engine lives here and must answer meanwhile.
 */
const curl = (path, args = []) =>
  new Promise((resolve) => {
    const child = spawn("curl", ["--silent", "--show-error", "--insecure", "--max-time", "60", "--resolve", `api.doedesk.com:${published}:127.0.0.1`, "--dump-header", "-", ...args, `https://api.doedesk.com:${published}${path}`], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.once("exit", (code) => {
      if (process.env.PROXY_DEBUG === "1" && code !== 0) console.log(`       curl ${path}: exit ${code} ${err.trim().slice(0, 300)}`);
      // Interim answers ("100 Continue") come first; the last block of headers is the answer's.
      const blocks = out.split("\r\n\r\n");
      let index = 0;
      while (index + 1 < blocks.length && /^HTTP\/[\d.]+ 1\d\d/.test(blocks[index])) index += 1;
      const head = blocks[index] ?? "";
      resolve({
        status: Number(/^HTTP\/[\d.]+ (\d+)/.exec(head)?.[1] ?? 0),
        headers: Object.fromEntries(head.split("\r\n").slice(1).map((line) => [line.slice(0, line.indexOf(":")).toLowerCase(), line.slice(line.indexOf(":") + 1).trim()])),
        body: blocks.slice(index + 1).join("\r\n\r\n"),
      });
    });
  });
try {
  for (let attempt = 0; attempt < 60 && (await curl("/v1/health")).status !== 200; attempt += 1) await sleep(500);
  const health = await curl("/v1/health");
  same("proxy: the API answers through Caddy, over TLS", [health.status, health.body], [200, '{"ok":true}']);
  same("proxy: security headers are added and the server's name is not announced", [health.headers["strict-transport-security"], health.headers["x-content-type-options"], health.headers["referrer-policy"], health.headers["content-security-policy"], health.headers.server], ["max-age=63072000", "nosniff", "no-referrer", "frame-ancestors 'none'", undefined]);

  // Whose address: Caddy's word, never the caller's.
  const honest = JSON.parse((await curl("/v1/auth/options")).body);
  const lying = JSON.parse((await curl("/v1/auth/options", ["--header", "X-Forwarded-For: 203.0.113.5", "--header", "CF-Connecting-IP: 203.0.113.5", "--header", "X-Real-IP: 203.0.113.5", "--header", "CF-IPCountry: SA", "--header", "x-doedesk-client-country: SA"])).body);
  same("proxy: a caller that claims a Saudi address in every header it can think of is still where Caddy saw it connect from", [honest.country, honest.methods, lying.country, lying.methods], [null, ["email"], null, ["email"]]);
  await curl("/ingest/crash", ["--request", "POST", "--header", "content-type: application/json", "--header", "X-Forwarded-For: 203.0.113.5", "--data", '{"message":"Boom"}']);
  const key = service.query("SELECT key FROM rate_limits WHERE key LIKE 'crash:%'")[0]?.key ?? "";
  expect("proxy: the API counts the caller under the address Caddy reported, which is one real address", /^crash:(\d{1,3}\.){3}\d{1,3}:3600$/.test(key) && !key.includes("203.0.113.5") && !key.startsWith("crash:127."), key);

  // The machine's own paths, and the size limit.
  same("proxy: the health report and the test triggers are not reachable through Caddy", [(await curl("/internal/health")).status, (await curl("/cdn-cgi/handler/scheduled")).status], [404, 404]);
  writeFileSync(join(folder, "big.bin"), Buffer.alloc(22 * 1024 * 1024, 0x20));
  writeFileSync(join(folder, "fits.pdf"), Buffer.concat([Buffer.from("%PDF-1.7 pages=2 "), Buffer.alloc(18 * 1024 * 1024, 0x20)]));
  const tooBig = await curl("/v1/ocr", ["--request", "POST", "--header", `authorization: Bearer ${TOKEN}`, "--header", "content-type: application/pdf", "--data-binary", `@${join(folder, "big.bin")}`]);
  const fits = await curl("/v1/ocr", ["--request", "POST", "--header", `authorization: Bearer ${TOKEN}`, "--header", "content-type: application/pdf", "--data-binary", `@${join(folder, "fits.pdf")}`]);
  same("proxy: a request over the size limit is refused by Caddy; a document of 18 MB goes through and is read", [tooBig.status, fits.status, JSON.parse(fits.body || "{}").pages], [413, 200, 2]);

  // What the log must not hold.
  const SECRETS = { linkSecret: "a1b2c3d4linksecret9f8e7d", attempt: "11111111-aaaa-4bbb-8ccc-222222222222", email: "searched@person.example", cookie: "1790000000.c0ffeec0ffeec0ffee", body: "body-only-marker-77", adminKey: service.adminKey };
  await curl(`/auth/confirm?r=${SECRETS.attempt}&t=${SECRETS.linkSecret}`);
  await curl(`/admin/accounts/${ACCOUNT}?q=${encodeURIComponent(SECRETS.email)}`, ["--header", `cookie: dd_admin=${SECRETS.cookie}`]);
  await curl("/admin", ["--request", "POST", "--data", `key=${SECRETS.adminKey}`]);
  await curl("/v1/me", ["--header", `authorization: Bearer ${TOKEN}`]);
  await curl("/v1/auth/email/start", ["--request", "POST", "--header", "content-type: application/json", "--data", JSON.stringify({ email: SECRETS.email, device: SECRETS.body })]);
  await sleep(1500);
  const log = readFileSync(join(folder, "doedesk-api.log"), "utf8");
  const entries = log.trim().split("\n").map((line) => JSON.parse(line));
  const uris = entries.map((entry) => entry.request.uri);
  const found = [...Object.entries(SECRETS), ["token", TOKEN], ["account", ACCOUNT], ["seeded email", "proxied@seeded.example"]].filter(([, value]) => log.includes(value)).map(([what]) => what);
  same("log: no sign-in secret, attempt, searched address, cookie, admin key, token, account identifier or body is in it", found, []);
  expect("log: each request is there with its method, its path cut of anything that names someone, its status and its duration", uris.includes("/auth/confirm") && uris.includes("/admin") && uris.includes("/v1/me") && uris.includes("/v1/ocr") && !uris.some((uri) => uri.includes("?") || uri.startsWith("/admin/")) && entries.every((entry) => typeof entry.status === "number" && typeof entry.duration === "number" && typeof entry.request.method === "string"), uris);
  expect("log: no request header and no answer header is kept, and the caller's address has lost its last part", entries.every((entry) => entry.request.headers === undefined && entry.resp_headers === undefined && /\.0$|^[0-9a-f:]+::$/.test(entry.request.remote_ip) && /\.0$|^[0-9a-f:]+::$/.test(entry.request.client_ip)), entries[0]);
  expect("log: the API's own log names nobody either", !Object.values(SECRETS).some((value) => service.log().includes(value)) && !service.log().includes(ACCOUNT), service.log().slice(-300));
} catch (cause) {
  failures += 1;
  console.log(`FAIL the run stopped: ${cause?.stack ?? cause}\n${caddyLog.slice(-1500)}`);
} finally {
  spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
  await service.stop();
  rmSync(folder, { recursive: true, force: true });
}
console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
