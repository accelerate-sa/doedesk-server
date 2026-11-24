// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Accelerate Technology Establishment
/**
 * Checks a database file and describes it without printing a row.
 *
 *   bun server/check-database.ts <file>
 *
 * Exit 0 when SQLite's integrity check passes and every reference points at a row.
 */
import { statSync } from "node:fs";
import { resolve } from "node:path";

import { loadRuntime } from "./runtime/index.ts";

const file = process.argv[2];
if (file === undefined) {
  console.error("usage: check-database.ts <file>");
  process.exit(2);
}
const database = (await loadRuntime()).openDatabase(resolve(file), { readOnly: true });
try {
  const integrity = database.query("PRAGMA integrity_check", []).map((row) => String(row.integrity_check)).join(", ");
  const dangling = database.query("PRAGMA foreign_key_check", []).length;
  const tables = database.query("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'", [])[0]?.n;
  const accounts = database.query("SELECT COUNT(*) AS n FROM users", [])[0]?.n;
  if (integrity !== "ok" || dangling !== 0) {
    console.error(`restore: the file is not sound (integrity: ${integrity}, dangling references: ${dangling})`);
    process.exit(1);
  }
  console.log(`restored ${file}: sound, ${tables} tables, ${accounts} accounts, ${statSync(file).size} bytes`);
} finally {
  database.close();
}
