// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Accelerate Technology Establishment
/**
 * Applies the files in `migrations/` that the database has not had yet, in name order.
 *
 * The record of what was applied is the table wrangler keeps in D1 (`d1_migrations`), under the
 * same name and shape, so a database copied from D1 arrives knowing which migrations it has, and
 * the same folder serves both homes.
 *
 * Each file is applied together with its ledger row in one transaction: a file that fails leaves
 * the database as it was.
 *
 * A layer beside the service (server/extension.ts) may bring a folder of its own. Its files are
 * applied after these and recorded in a ledger of its own, so each set knows only its own names.
 *
 *   bun server/migrate.ts            apply what is pending (reads DOEDESK_DATABASE)
 *   bun server/migrate.ts --status   list applied and pending, change nothing
 *   bun server/migrate.ts --layer    apply only what a layer beside the service brings: for a
 *                                    database that arrived with this service's own already applied
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { SqliteDriver } from "./d1.ts";

const MAIN_LEDGER = "d1_migrations";
const ledgerSql = (ledger: string): string =>
  `CREATE TABLE IF NOT EXISTS ${ledger}(\n` +
  "\t\tid         INTEGER PRIMARY KEY AUTOINCREMENT,\n" +
  "\t\tname       TEXT UNIQUE,\n" +
  "\t\tapplied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL\n)";

export interface MigrationState {
  readonly applied: ReadonlyArray<string>;
  readonly pending: ReadonlyArray<string>;
  /** In the ledger and not in the folder: the database is newer than this copy of the code. */
  readonly unknown: ReadonlyArray<string>;
}

const files = (directory: string): Array<string> =>
  readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort();

export const migrationState = (driver: SqliteDriver, directory: string, ledger: string = MAIN_LEDGER): MigrationState => {
  const hasLedger = driver.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [ledger]).length > 0;
  const applied = hasLedger ? driver.query(`SELECT name FROM ${ledger} ORDER BY id`, []).map((row) => String(row.name)) : [];
  const known = files(directory);
  return {
    applied,
    pending: known.filter((name) => !applied.includes(name)),
    unknown: applied.filter((name) => !known.includes(name)),
  };
};

/** Applies every pending file. Returns the names applied. */
export const migrate = (driver: SqliteDriver, directory: string, ledger: string = MAIN_LEDGER): Array<string> => {
  driver.exec(ledgerSql(ledger));
  const done: Array<string> = [];
  for (const name of migrationState(driver, directory, ledger).pending) {
    const sql = readFileSync(join(directory, name), "utf8");
    driver.exec("BEGIN IMMEDIATE");
    try {
      driver.exec(sql);
      driver.query(`INSERT INTO ${ledger} (name) VALUES (?)`, [name]);
      driver.exec("COMMIT");
    } catch (cause) {
      try {
        driver.exec("ROLLBACK");
      } catch {
        // Already rolled back.
      }
      throw new Error(`Migration ${name} failed and was not applied: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    done.push(name);
  }
  return done;
};

const main = async (): Promise<void> => {
  const { loadRuntime } = await import("./runtime/index.ts");
  const { resolve, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const path = (process.env.DOEDESK_DATABASE ?? "").trim();
  if (path === "") {
    console.error("DOEDESK_DATABASE is not set.");
    process.exit(2);
  }
  const directory = resolve(process.env.DOEDESK_MIGRATIONS_DIR ?? join(dirname(dirname(fileURLToPath(import.meta.url))), "migrations"));
  const driver = (await loadRuntime()).openDatabase(resolve(path));
  const { EXTENSION_LEDGER, extensionMigrations } = await import("./extension.ts");
  const layer = extensionMigrations();
  try {
    if (process.argv.includes("--status")) {
      const state = migrationState(driver, directory);
      const extra = layer === null ? null : migrationState(driver, layer, EXTENSION_LEDGER);
      // One line each, the layer's names after the service's own: deploy.sh reads `pending:`.
      console.log(`applied: ${[...state.applied, ...(extra?.applied ?? [])].join(", ") || "none"}`);
      console.log(`pending: ${[...state.pending, ...(extra?.pending ?? [])].join(", ") || "none"}`);
      const unknown = [...state.unknown, ...(extra?.unknown ?? [])];
      if (unknown.length > 0) console.log(`in the database but not in this code: ${unknown.join(", ")}`);
      return;
    }
    const done = [...(process.argv.includes("--layer") ? [] : migrate(driver, directory)), ...(layer === null ? [] : migrate(driver, layer, EXTENSION_LEDGER))];
    console.log(done.length === 0 ? "nothing to apply" : `applied: ${done.join(", ")}`);
  } finally {
    driver.close();
  }
};

if (import.meta.main ?? process.argv[1]?.endsWith("migrate.ts")) await main();
