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
 *   bun server/migrate.ts            apply what is pending (reads DOEDESK_DATABASE)
 *   bun server/migrate.ts --status   list applied and pending, change nothing
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { SqliteDriver } from "./d1.ts";

const LEDGER =
  "CREATE TABLE IF NOT EXISTS d1_migrations(\n" +
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

export const migrationState = (driver: SqliteDriver, directory: string): MigrationState => {
  const hasLedger = driver.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations'", []).length > 0;
  const applied = hasLedger ? driver.query("SELECT name FROM d1_migrations ORDER BY id", []).map((row) => String(row.name)) : [];
  const known = files(directory);
  return {
    applied,
    pending: known.filter((name) => !applied.includes(name)),
    unknown: applied.filter((name) => !known.includes(name)),
  };
};

/** Applies every pending file. Returns the names applied. */
export const migrate = (driver: SqliteDriver, directory: string): Array<string> => {
  driver.exec(LEDGER);
  const done: Array<string> = [];
  for (const name of migrationState(driver, directory).pending) {
    const sql = readFileSync(join(directory, name), "utf8");
    driver.exec("BEGIN IMMEDIATE");
    try {
      driver.exec(sql);
      driver.query("INSERT INTO d1_migrations (name) VALUES (?)", [name]);
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
  try {
    if (process.argv.includes("--status")) {
      const state = migrationState(driver, directory);
      console.log(`applied: ${state.applied.join(", ") || "none"}`);
      console.log(`pending: ${state.pending.join(", ") || "none"}`);
      if (state.unknown.length > 0) console.log(`in the database but not in this code: ${state.unknown.join(", ")}`);
      return;
    }
    const done = migrate(driver, directory);
    console.log(done.length === 0 ? "nothing to apply" : `applied: ${done.join(", ")}`);
  } finally {
    driver.close();
  }
};

if (import.meta.main ?? process.argv[1]?.endsWith("migrate.ts")) await main();
