// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Accelerate Technology Establishment
/**
 * The nightly job, as its own short-lived process: deletes what is no longer kept and rolls old
 * usage days into months (src/retention.ts), the work Cloudflare's cron trigger used to start.
 *
 *   bun server/nightly.ts            run tonight's job, once (systemd timer, 03:17 UTC)
 *   bun server/nightly.ts --force    run it even if today's run is recorded as done
 *   bun server/nightly.ts --status   print the last run and change nothing
 *
 * "Once" is kept in jobs.sqlite (jobs.ts): a second start on the same UTC day does nothing and
 * exits 0. The job itself is also safe to repeat. A failure exits 1, which systemd reports.
 * While the service is frozen for a move the job does nothing.
 */
import { buildEnv } from "./app.ts";
import { ConfigError, readConfig } from "./config.ts";
import { createDatabase } from "./d1.ts";
import { openGeo } from "./geo.ts";
import { openJobs, runOnce } from "./jobs.ts";
import { loadRuntime } from "./runtime/index.ts";
import { isFrozen } from "../src/maintenance.ts";
import { applyRetention } from "../src/retention.ts";

const main = async (): Promise<void> => {
  let config;
  try {
    config = readConfig(process.env);
  } catch (cause) {
    console.error(cause instanceof ConfigError ? cause.message : String(cause));
    process.exit(78);
  }
  const runtime = await loadRuntime();
  const jobsDriver = runtime.openDatabase(config.jobsPath);
  if (process.argv.includes("--status")) {
    const last = await openJobs(jobsDriver).last("nightly");
    console.log(last === null ? "never run" : `${last.day} ${last.outcome} started=${last.started_at} finished=${last.finished_at ?? "-"} ${last.detail ?? ""}`);
    jobsDriver.close();
    return;
  }
  const driver = runtime.openDatabase(config.databasePath);
  const env = buildEnv({
    config,
    database: createDatabase(driver),
    geo: openGeo(""),
    runtime,
    lastNightly: async () => null,
    log: (line) => console.log(line),
  });
  if (isFrozen(env)) {
    console.log("nightly skipped: the service is frozen for a move");
    return;
  }
  const day = new Date().toISOString().slice(0, 10);
  const work = async (): Promise<string> => {
    const report = await applyRetention(env);
    // Counts per rule, never an identifier.
    const summary = report.rules.map((line) => `${line.id}=${line.error === undefined ? line.rows : "failed"}`).join(" ");
    console.log(`retention ${summary}`);
    const failed = report.rules.filter((line) => line.error !== undefined);
    if (failed.length > 0) throw new Error(`Retention rules failed: ${failed.map((line) => `${line.id} (${line.error})`).join("; ")}`);
    return summary;
  };
  let exit = 0;
  try {
    if (process.argv.includes("--force")) {
      await work();
      console.log("nightly ran (forced)");
    } else {
      const outcome = await runOnce(jobsDriver, "nightly", day, work);
      console.log(outcome === "ran" ? "nightly ran" : `nightly ${outcome.replace(":", ": already ")} for ${day}`);
    }
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    exit = 1;
  } finally {
    driver.close();
    jobsDriver.close();
  }
  process.exit(exit);
};

await main();
