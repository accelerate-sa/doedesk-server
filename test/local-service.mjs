// Runs the service on this machine for a test: a throwaway local database with every migration
// applied, a stand-in for the detection and reading engine, and the service pointed at both.
//
// The service is started in one of its two forms, chosen by DOEDESK_TEST_TARGET:
//   worker (default)   the Cloudflare Worker, under `wrangler dev`, on a local D1 database
//   bun, node          the server adapter (`server/main.ts`) on that runtime, on a SQLite file
// The suites are the same for all three; that is the point.
//
// Nothing here reaches a real engine, the production database or `.dev.vars`: wrangler is given its own
// env file (which stops it loading `.dev.vars`), and the server its own environment, made up for
// the run and deleted with it.
import { spawn, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATABASE = "doedesk-cloud";

export const sha256Hex = (value) => createHash("sha256").update(value).digest("hex");

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

const readBody = (request) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });

/**
 * The engine units the stand-in reports for a call: two per text, an arbitrary rule of its own. The
 * service stores whatever the engine reports and knows no rule (src/engine.ts); with no report it
 * counts one per text, so the two are told apart.
 */
export const engineUnits = (texts) => 2 * texts.length;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The bearer token the services started here give the stand-in engine. */
export const ENGINE_TOKEN = "stub-engine-token";

/**
 * Stands in for the detection and reading engine, speaking the service's own format (src/engine.ts).
 * What it answers is decided by markers in what it is sent, since the service forwards nothing else:
 *   text    "Jane Doe" is a PERSON, anything@with.dots an EMAIL. It reports the work done in
 *           engine units in the x-doedesk-engine-units header; "[[no-count]]" leaves that out.
 *           "[[engine-down]]" fails the call (500); "[[used-then-failed]]" fails having used 3;
 *           "[[busy]]" is 503 overloaded, "[[unavailable]]" 503 unavailable, "[[out-of-time]]" 504
 *           having used 2; "[[says-seven]]" reports 7; "[[short-answer]]" skips the texts; "[[odd]]"
 *           adds entities a faulty engine might send.
 *   files   "pages=N" sets the page count (none given otherwise, which counts as one).
 *           "[[reader-down]]" fails (500); "[[unreadable]]" is 422; "[[slow]]" answers after 600 ms.
 */
export const startEngineStub = async () => {
  const seen = { detect: [], ocr: [], authorization: new Set() };
  const server = createServer(async (request, response) => {
    const send = (status, value, headers = {}) => {
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end(JSON.stringify(value));
    };
    try {
      const body = await readBody(request);
      seen.authorization.add(request.headers.authorization ?? "");
      if (request.method === "POST" && request.url === "/v1/detect") {
        const { texts } = JSON.parse(body.toString("utf8"));
        seen.detect.push(texts);
        const has = (marker) => texts.some((text) => text.includes(marker));
        if (has("[[engine-down]]")) return send(500, { error: { message: "stub engine down" } });
        if (has("[[used-then-failed]]")) return send(502, { error: { code: "detector_failed", message: "half done" } }, { "x-doedesk-engine-units": "3" });
        if (has("[[busy]]")) return send(503, { error: { code: "overloaded", message: "queue full" } }, { "retry-after": "7" });
        if (has("[[unavailable]]")) return send(503, { error: { code: "unavailable", message: "engine unavailable" } }, { "retry-after": "30" });
        if (has("[[out-of-time]]")) return send(504, { error: { code: "detector_timeout", message: "too long" } }, { "x-doedesk-engine-units": "2" });
        if (has("[[says-seven]]")) return send(200, { results: texts.map(() => ({ entities: [] })) }, { "x-doedesk-engine-units": "7" });
        if (has("[[short-answer]]")) return send(200, { results: [] });
        const reported = has("[[no-count]]") ? {} : { "x-doedesk-engine-units": String(engineUnits(texts)) };
        return send(
          200,
          {
            results: texts.map((text) => ({
              entities: [
                ...[...text.matchAll(/Jane Doe/g)].map((match) => ({ start: match.index, end: match.index + 8, kind: "PERSON" })),
                ...[...text.matchAll(/[\w.]+@[\w-]+\.[\w.]+/g)].map((match) => ({ start: match.index, end: match.index + match[0].length, kind: "EMAIL" })),
                // What a faulty engine might send: a kind the app does not know, and spans that are not spans.
                ...(text.includes("[[odd]]") ? [{ start: 0, end: 3, kind: "PASSPORT" }, { start: 5, end: 2, kind: "PERSON" }, { start: 0, end: 99_999, kind: "PERSON" }, { start: "0", end: 2, kind: "PERSON" }] : []),
              ],
            })),
          },
          reported,
        );
      }
      if (request.method === "POST" && request.url === "/v1/ocr") {
        const head = body.subarray(0, 400).toString("latin1");
        seen.ocr.push({ type: request.headers["content-type"], bytes: body.length });
        if (head.includes("[[reader-down]]")) return send(500, { error: { message: "stub reader down" } });
        if (head.includes("[[unreadable]]")) return send(422, { error: { message: "stub could not read this file" } });
        if (head.includes("[[slow]]")) await sleep(600);
        const pages = /pages=(\d+)/.exec(head)?.[1];
        return send(200, { text: `text${pages === undefined ? "" : ` of ${pages} page(s)`}`, ...(pages === undefined ? {} : { pages: Number(pages) }) });
      }
      if (request.method === "GET" && request.url === "/v1/health") {
        return send(200, { ok: true, detection: { ready: true, state: "ready" }, reading: { ready: true }, uptimeSeconds: 1 });
      }
      send(404, { error: { message: "stub has no such route" } });
    } catch (cause) {
      send(500, { error: { message: String(cause) } });
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const stop = () =>
    new Promise((resolve) => {
      server.close(resolve);
      // The service keeps connections open between calls; without this, close waits for them.
      server.closeAllConnections();
    });
  return { origin: `http://127.0.0.1:${server.address().port}`, seen, stop };
};

const wrangler = (args, options = {}) => {
  const result = spawnSync("npx", ["wrangler", ...args], { cwd: ROOT, encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(`wrangler ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
};

/**
 * Starts everything. `seedSql`, when given, is run against the local database after the migrations
 * and before the service starts. `vars` are extra settings for the service, such as
 * `{ REQUIRE_ACCEPTANCE: "signup" }`; a test that needs two settings starts two services.
 */
export const TARGET = process.env.DOEDESK_TEST_TARGET ?? "worker";

export const startLocalService = (options = {}) => (TARGET === "worker" ? startWorkerService(options) : startServerService(options));

/**
 * The server adapter on Bun or Node. `vars` may also carry the server's own settings (DOEDESK_…).
 * The answer has the same shape as the Worker's, plus `child`, `folder` and `databaseFile` for
 * tests of things only the server has (shutdown, restart).
 */
export const startServerService = async ({ seedSql, vars = {}, runtime = TARGET === "node" ? "node" : "bun", port, folder: given, engine: givenEngine } = {}) => {
  const folder = given ?? mkdtempSync(join(process.env.DOEDESK_TEST_DIR ?? tmpdir(), "doedesk-server-"));
  const databaseFile = join(folder, "doedesk.sqlite");
  const adminKey = `test-admin-${randomBytes(12).toString("hex")}`;
  const engine = givenEngine ?? (await startEngineStub());
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const environment = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    DOEDESK_ENV: "test",
    DOEDESK_TEST_HOOKS: "1",
    DOEDESK_DATABASE: databaseFile,
    DOEDESK_HOST: "127.0.0.1",
    DOEDESK_PORT: String(port ?? (await freePort())),
    DOEDESK_SHUTDOWN_SECONDS: "20",
    ADMIN_KEY: adminKey,
    EXPOSE_LOGIN_SECRETS: "1",
    JWT_PRIVATE_JWK: JSON.stringify({ ...privateKey.export({ format: "jwk" }), kid: "test" }),
    ENGINE_URL: engine.origin,
    ENGINE_TOKEN,
    AUTHENTICA_API_KEY: "stub",
    ...vars,
  };
  const command = runtime === "node" ? ["node", "--disable-warning=ExperimentalWarning"] : ["bun"];
  const run = (script, args = []) => {
    const result = spawnSync(command[0], [...command.slice(1), join(ROOT, "server", script), ...args], { cwd: ROOT, encoding: "utf8", env: environment });
    if (result.status !== 0) throw new Error(`${script} failed:\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  if (given === undefined) {
    // DOEDESK_TEST_BASE_DB: start from a copy of an existing database (a rehearsal on a copy of
    // production) instead of an empty one. The suites' own rows are then added on top of it.
    if (process.env.DOEDESK_TEST_BASE_DB) copyFileSync(process.env.DOEDESK_TEST_BASE_DB, databaseFile);
    run("migrate.ts");
    if (seedSql !== undefined) {
      const database = new DatabaseSync(databaseFile);
      try {
        database.exec("PRAGMA foreign_keys = ON");
        database.exec(seedSql);
      } finally {
        database.close();
      }
    }
  }
  const child = spawn(command[0], [...command.slice(1), join(ROOT, "server", "main.ts")], { cwd: ROOT, env: environment, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (chunk) => (log += chunk));
  child.stderr.on("data", (chunk) => (log += chunk));
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));

  const base = `http://127.0.0.1:${environment.DOEDESK_PORT}`;
  /** Ends the service the polite way and waits for it; `signal` may be SIGKILL to end it the other way. */
  const end = async (signal = "SIGTERM") => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    return exited;
  };
  const stop = async () => {
    await end();
    if (givenEngine === undefined) await engine.stop();
    if (process.env.DOEDESK_TEST_KEEP !== "1") rmSync(folder, { recursive: true, force: true });
  };
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null || Date.now() > deadline) {
      await stop();
      throw new Error(`The service did not start:\n${log}`);
    }
    const ready = await fetch(`${base}/v1/health`).then((response) => response.ok, () => false);
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  /** Reads the database file directly, so a test checks the rows and not the service's word. */
  const query = (sql, ...values) => {
    const database = new DatabaseSync(databaseFile, { readOnly: true });
    try {
      return database.prepare(sql).all(...values);
    } finally {
      database.close();
    }
  };
  return { base, adminKey, engine, query, stop, log: () => log, child, end, exited, folder, databaseFile, environment, run, runtime };
};

/** The Worker under `wrangler dev`. `host` is the name it believes it is answering as. */
export const startWorkerService = async ({ seedSql, vars = {}, host = "api.doedesk.com" } = {}) => {
  const folder = mkdtempSync(join(process.env.DOEDESK_TEST_DIR ?? tmpdir(), "doedesk-usage-"));
  const state = join(folder, "state");
  const adminKey = `test-admin-${randomBytes(12).toString("hex")}`;
  const engine = await startEngineStub();
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const envFile = join(folder, "service.env");
  writeFileSync(
    envFile,
    [
      `ADMIN_KEY=${adminKey}`,
      "EXPOSE_LOGIN_SECRETS=1",
      `JWT_PRIVATE_JWK='${JSON.stringify({ ...privateKey.export({ format: "jwk" }), kid: "test" })}'`,
      "AUTHENTICA_API_KEY=stub",
      // A test may point the service at an engine of its own.
      ...Object.entries({ ENGINE_URL: engine.origin, ENGINE_TOKEN, ...vars }).map(([name, value]) => `${name}=${value}`),
      "",
    ].join("\n"),
  );

  wrangler(["d1", "migrations", "apply", DATABASE, "--local", "--persist-to", state], { env: { ...process.env, CI: "1" } });
  if (seedSql !== undefined) {
    const seedFile = join(folder, "seed.sql");
    writeFileSync(seedFile, seedSql);
    wrangler(["d1", "execute", DATABASE, "--local", "--persist-to", state, "--file", seedFile, "--yes"]);
  }

  const port = await freePort();
  const child = spawn(
    "npx",
    [
      "wrangler",
      "dev",
      // The routes are custom domains; without the host wrangler answers as the site.
      "--host",
      host,
      "--port",
      String(port),
      "--inspector-port",
      String(await freePort()),
      "--persist-to",
      state,
      "--env-file",
      envFile,
      "--show-interactive-dev-session=false",
    ],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  let log = "";
  child.stdout.on("data", (chunk) => (log += chunk));
  child.stderr.on("data", (chunk) => (log += chunk));

  const base = `http://127.0.0.1:${port}`;
  const stop = async () => {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
    await engine.stop();
    if (process.env.DOEDESK_TEST_KEEP !== "1") rmSync(folder, { recursive: true, force: true });
  };
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (child.exitCode !== null || Date.now() > deadline) {
      await stop();
      throw new Error(`The service did not start:\n${log}`);
    }
    // Answering as the site, the Worker has no health route: any answer means it is up.
    const ready = await fetch(`${base}/v1/health`).then((response) => response.ok || host !== "api.doedesk.com", () => false);
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  /** Reads the local database file directly, so a test checks the rows and not the service's word. */
  const query = (sql, ...values) => {
    const directory = join(state, "v3", "d1", "miniflare-D1DatabaseObject");
    const file = readdirSync(directory).find((name) => name.endsWith(".sqlite") && name !== "metadata.sqlite");
    const database = new DatabaseSync(join(directory, file), { readOnly: true });
    try {
      return database.prepare(sql).all(...values);
    } finally {
      database.close();
    }
  };

  return { base, adminKey, engine, query, stop, log: () => log };
};

/** A request helper in the shape `test/auth-flow.mjs` uses. */
export const client = (base) => async (method, path, { body, token, headers = {}, raw } = {}) => {
  const response = await fetch(base + path, {
    method,
    redirect: "manual",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: response.status, json, text, headers: response.headers };
};
