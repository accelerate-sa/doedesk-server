/**
 * Writes a consistent copy of the database to a new file, while the service keeps running.
 *
 *   bun server/snapshot.ts <output file>          (reads DOEDESK_DATABASE)
 *
 * `VACUUM INTO` copies the database as one read transaction: the copy is the database as it was at
 * one moment, whatever is written meanwhile. The copy is then opened and checked (SQLite's own
 * integrity check, and that every reference points at a row), and one line is printed with its
 * size, the number of tables and rows, and nothing from any row.
 */
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { loadRuntime } from "./runtime/index.ts";

const source = (process.env.DOEDESK_DATABASE ?? "").trim();
const target = process.argv[2];
if (source === "" || target === undefined) {
  console.error("usage: DOEDESK_DATABASE=<database> snapshot.ts <output file>");
  process.exit(2);
}
if (existsSync(target)) {
  console.error(`${target} exists.`);
  process.exit(2);
}
const runtime = await loadRuntime();
const database = runtime.openDatabase(resolve(source), { readOnly: true, busyTimeoutMs: 30_000 });
try {
  database.exec(`VACUUM INTO '${resolve(target).replace(/'/g, "''")}'`);
} finally {
  database.close();
}
const copy = runtime.openDatabase(resolve(target), { readOnly: true });
try {
  const integrity = copy.query("PRAGMA integrity_check", []).map((row) => String(row.integrity_check)).join(", ");
  const dangling = copy.query("PRAGMA foreign_key_check", []).length;
  if (integrity !== "ok" || dangling !== 0) {
    console.error(`The snapshot is not sound: integrity ${integrity}, ${dangling} rows point at nothing.`);
    process.exit(1);
  }
  const tables = copy.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'", []).map((row) => String(row.name));
  const rows = tables.reduce((total, table) => total + Number(copy.query(`SELECT COUNT(*) AS n FROM "${table.replace(/"/g, '""')}"`, [])[0]?.n ?? 0), 0);
  console.log(`snapshot ok bytes=${statSync(target).size} tables=${tables.length} rows=${rows}`);
} finally {
  copy.close();
}
