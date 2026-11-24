// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Accelerate Technology Establishment
/**
 * Starts the service on this machine.
 *
 *   bun server/main.ts        (or: node server/main.ts)
 *
 * Reads its settings from the environment (config.ts, docs/variables.md), opens the database,
 * refuses to start on a database that still needs a migration, and answers on DOEDESK_HOST:PORT.
 *
 * SIGTERM or SIGINT: stops taking requests, lets the ones in flight finish (up to
 * DOEDESK_SHUTDOWN_SECONDS), folds the write-ahead log into the database file and exits 0.
 * Every write was already on disk when its request was answered, so a kill at any moment loses
 * nothing that was acknowledged.
 * SIGHUP: reads the country file again.
 */
import { createApp } from "./app.ts";
import { ConfigError, readConfig } from "./config.ts";
import { createDatabase } from "./d1.ts";
import { openGeo } from "./geo.ts";
import { EXTENSION_LEDGER, extensionMigrations, loadExtension } from "./extension.ts";
import { openJobs } from "./jobs.ts";
import { migrationState } from "./migrate.ts";
import { ACCOUNT_REGIONS, hostingConfirmed, workerUpstream } from "../src/worker-regions.ts";
import { loadRuntime } from "./runtime/index.ts";

const log = (line: string): void => console.log(line);

const main = async (): Promise<void> => {
  let config;
  try {
    config = readConfig(process.env);
  } catch (cause) {
    console.error(cause instanceof ConfigError ? cause.message : String(cause));
    process.exit(78);
  }
  const runtime = await loadRuntime();
  const driver = runtime.openDatabase(config.databasePath);
  const state = migrationState(driver, config.migrationsDir);
  if (state.pending.length > 0) {
    console.error(`The database needs migrations first: ${state.pending.join(", ")}. Run server/migrate.ts.`);
    driver.close();
    process.exit(78);
  }
  if (state.unknown.length > 0) log(`database_newer_than_code migrations=${state.unknown.join(",")}`);
  // A layer beside the service, when there is one, with its own tables in place first.
  const layerMigrations = extensionMigrations();
  const layerPending = layerMigrations === null ? [] : migrationState(driver, layerMigrations, EXTENSION_LEDGER).pending;
  if (layerPending.length > 0) {
    console.error(`The database needs migrations first: ${layerPending.join(", ")}. Run server/migrate.ts.`);
    driver.close();
    process.exit(78);
  }
  const layer = await loadExtension();
  if (layer !== null) log(`extension name=${layer}`);

  const jobsDriver = runtime.openDatabase(config.jobsPath);
  const jobs = openJobs(jobsDriver);
  const geo = openGeo(config.geoFile, { maxAgeDays: config.geoMaxAgeDays, log });
  if (geo.status().state !== "ok") log(`country_lookup_${geo.status().state}: every request counts as "country not known"`);

  const app = createApp({ config, database: createDatabase(driver), geo, runtime, lastNightly: () => jobs.last("nightly"), log });
  const server = await runtime.serve({ hostname: config.host, port: config.port, maxBodyBytes: config.maxBodyBytes, fetch: app.fetch });
  log(`listening ${config.host}:${server.port} stage=${config.stage} runtime=${runtime.name}-${runtime.version} engine=local`);

  // Each region that requires its model to be hosted in a named place is checked now, so that a
  // wrong setting is in the log at the start and not at the first person's sealed file. A region
  // that is not confirmed is not served; the check is made again with the requests that follow.
  for (const region of ACCOUNT_REGIONS) {
    const upstream = workerUpstream(config.vars, region);
    if (upstream === null || upstream.hostedIn === null) continue;
    void hostingConfirmed(upstream).then((confirmed) => log(`worker_hosting region=${region} hosted_in=${upstream.hostedIn} confirmed=${confirmed}`));
  }

  const geoTimer = setInterval(() => geo.reload(), 5 * 60_000);
  process.on("SIGHUP", () => geo.reload());

  let stopping = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log(`stopping signal=${signal} in_flight=${app.inFlight()}`);
    clearInterval(geoTimer);
    const deadline = new Promise<"late">((resolve) => setTimeout(() => resolve("late"), config.shutdownSeconds * 1000).unref());
    // From here a request that still arrives on a connection kept open is told to try again in a
    // moment, so that steady traffic cannot keep the stop waiting. The listener closes, and the
    // requests already taken get their time.
    app.drain();
    const closed = server.stop();
    const finished = await Promise.race([Promise.all([closed, app.idle()]).then(() => "done" as const), deadline]);
    if (finished === "late") log(`stopped_with_requests_in_flight count=${app.inFlight()}`);
    try {
      driver.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // Another process holds the file (a backup, the nightly job). The log is folded in next time.
    }
    driver.close();
    jobsDriver.close();
    log("stopped");
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
};

await main();
