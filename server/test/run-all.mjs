// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Accelerate Technology Establishment
// Runs every suite against every form of the service and prints one line per run.
//
//   node server/test/run-all.mjs                 everything (about ten minutes)
//   node server/test/run-all.mjs bun node        only those targets (worker, bun, node)
//
// The four suites that existed before the move run unchanged against the Worker and against the
// server on Bun and on Node. The suites written for the move run where they apply.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { startServerService, startWorkerService } from "../../test/local-service.mjs";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const wanted = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const targets = ["worker", "bun", "node"].filter((target) => wanted.length === 0 || wanted.includes(target));
const NODE = ["node", "--disable-warning=ExperimentalWarning"];

const run = (command, args, env = {}) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.once("exit", (code) => resolve({ code, passed: (out.match(/^ok {2}/gm) ?? []).length, failed: out.match(/^FAIL.*$/gm) ?? [], out }));
  });

const results = [];
const record = async (suite, target, work) => {
  const started = Date.now();
  const result = await work();
  results.push({ suite, target, ...result, seconds: Math.round((Date.now() - started) / 1000) });
  console.log(`${result.code === 0 ? "pass" : "FAIL"}  ${suite.padEnd(28)} ${target.padEnd(7)} ${String(result.passed).padStart(4)} checks  ${Math.round((Date.now() - started) / 1000)} s`);
  for (const line of result.failed.slice(0, 8)) console.log(`      ${line.slice(0, 400)}`);
  if (result.code !== 0 && result.failed.length === 0) console.log(result.out.split("\n").slice(-12).map((line) => `      ${line.slice(0, 300)}`).join("\n"));
};

// Needs no service. The legal documents are not in the public repository; the check runs where they are.
if (existsSync(join(ROOT, "legal")) || process.env.DOEDESK_LEGAL_DIR !== undefined) {
  await record("legal-versions", "-", () => run(NODE[0], [...NODE.slice(1), "test/legal-versions.mjs"]));
} else {
  console.log("skip  legal-versions                -        no legal/ folder here (it is not published)");
}
await record("d1-parity", "all", () => run(NODE[0], [...NODE.slice(1), "server/test/d1-parity.mjs"]));
if (targets.includes("bun")) await record("unit", "bun", () => run("bun", ["server/test/unit.ts"]));
if (targets.includes("node")) await record("unit", "node", () => run(NODE[0], [...NODE.slice(1), "server/test/unit.ts"]));

for (const target of targets) {
  const env = { DOEDESK_TEST_TARGET: target };
  // auth-flow takes the address of a service that is already running.
  const start = (options = {}) => (target === "worker" ? startWorkerService(options) : startServerService({ ...options, runtime: target }));
  await record("auth-flow", target, async () => {
    const service = await start();
    try {
      const result = await run(NODE[0], [...NODE.slice(1), "test/auth-flow.mjs", service.base]);
      // On the server this machine's own address is in no country: the email-only branch runs.
      if (target !== "worker" && !/country: null methods: email/.test(result.out)) return { ...result, code: 1, failed: [...result.failed, "FAIL the caller's country should not be known here"] };
      return result;
    } finally {
      await service.stop();
    }
  });
  if (target !== "worker") {
    // The same flow for a caller in Saudi Arabia, which takes the phone branch: here the country
    // comes from the country file, with this machine's own address placed in Saudi Arabia.
    await record("auth-flow (from SA)", target, async () => {
      const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { buildGeo } = await import("../geo-build.ts");
      const folder = mkdtempSync(join(tmpdir(), "doedesk-sa-"));
      async function* lines() {
        yield "127.0.0.0,127.255.255.255,AS,SA,Riyadh,Riyadh,0,0";
        yield "::1,::1,AS,SA,Riyadh,Riyadh,0,0";
      }
      writeFileSync(join(folder, "country.ddgeo"), (await buildGeo(lines(), { source: "loopback-in-sa", minimums: { v4: 1, v6: 1, countries: 1 } })).bytes);
      const service = await start({ vars: { DOEDESK_GEO_FILE: join(folder, "country.ddgeo") } });
      try {
        const result = await run(NODE[0], [...NODE.slice(1), "test/auth-flow.mjs", service.base]);
        if (!/country: SA methods: phone,email/.test(result.out)) return { ...result, code: 1, failed: [...result.failed, "FAIL the phone branch did not run: the country was not SA"] };
        return result;
      } finally {
        await service.stop();
        rmSync(folder, { recursive: true, force: true });
      }
    });
  }
  await record("usage-metering", target, () => run(NODE[0], [...NODE.slice(1), "test/usage-metering.mjs"], env));
  await record("worker-chat", target, () => run(NODE[0], [...NODE.slice(1), "test/worker-chat.mjs"], env));
  await record("privacy-promises", target, () => run(NODE[0], [...NODE.slice(1), "test/privacy-promises.mjs"], env));
  await record("ocr-layout", target, () => run(NODE[0], [...NODE.slice(1), "test/ocr-layout.mjs"], env));
  await record("features", target, () => run(NODE[0], [...NODE.slice(1), "server/test/features.mjs"], env));
  // The site is served by the Worker only.
  if (target === "worker") {
    // The site is not published with the server code: without web/ there is nothing to check.
    if (existsSync(join(ROOT, "web"))) await record("site-routes", target, () => run(NODE[0], [...NODE.slice(1), "test/site-routes.mjs"], env));
    else console.log("skip  site-routes                   worker   no web/ folder here (it is not published)");
  }
  if (target !== "worker") {
    await record("lifecycle", target, () => run(NODE[0], [...NODE.slice(1), "server/test/lifecycle.mjs"], env));
    await record("handoff (worker + server)", target, () => run(NODE[0], [...NODE.slice(1), "server/test/handoff.mjs"], env));
    await record("migration", target, () => run(NODE[0], [...NODE.slice(1), "server/test/migration.mjs"], env));
    await record("release", target, () => run(NODE[0], [...NODE.slice(1), "server/test/release.mjs"], env));
    await record("nothing-kept", target, () => run(NODE[0], [...NODE.slice(1), "server/test/nothing-kept.mjs"], env));
  }
}

const failed = results.filter((result) => result.code !== 0);
console.log(`\n${results.length} runs, ${results.reduce((total, result) => total + result.passed, 0)} checks, ${failed.length} runs failed`);
process.exit(failed.length === 0 ? 0 : 1);
