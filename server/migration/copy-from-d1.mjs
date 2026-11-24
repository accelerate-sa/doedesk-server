// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Accelerate Technology Establishment
// Copies the D1 database into a new SQLite file and proves the copy is exact.
//
//   node server/migration/copy-from-d1.mjs --out <private folder> [--from d1:remote] [--name doedesk.sqlite]
//
// Three steps, each timed:
//   1. export   wrangler writes the whole database as SQL to <folder>/d1-export.sql (read-only on D1)
//   2. import   that file is loaded into <folder>/<name>, which must not exist, and checked for soundness
//   3. verify   every table's row count and checksum, and the schema, are read from D1 and from the
//               file and compared. Any difference: exit 1, and the file must not be used.
//
// The folder must be outside every git repository and readable by you alone (mode 700): the export
// and the file hold real accounts. Nothing printed here contains a row.
// `--from d1:local:<folder>` copies from a local D1, for tests and rehearsals.
//
// For the final copy the service must be frozen first (MAINTENANCE=freeze): step 3 reads D1 again,
// and a write between steps 1 and 3 shows up as a difference.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { args, assertPrivateFolder, compare, exportD1, fingerprint, importExport, openSource, report, sha256File } from "./lib.mjs";

const options = args(process.argv.slice(2));
if (typeof options.out !== "string") {
  console.error("usage: copy-from-d1.mjs --out <private folder> [--from d1:remote|d1:local:<folder>] [--name doedesk.sqlite]");
  process.exit(2);
}
const from = typeof options.from === "string" ? options.from : "d1:remote";
const folder = resolve(options.out);
if (!existsSync(folder)) mkdirSync(folder, { recursive: true, mode: 0o700 });
const exportFile = join(folder, "d1-export.sql");
const databaseFile = join(folder, typeof options.name === "string" ? options.name : "doedesk.sqlite");
const seconds = (since) => `${((Date.now() - since) / 1000).toFixed(1)} s`;

try {
  assertPrivateFolder(folder);
  let since = Date.now();
  const exported = exportD1(from, exportFile);
  console.log(`1. export   ${from} -> d1-export.sql, ${exported} bytes, ${seconds(since)}`);

  since = Date.now();
  const imported = importExport(exportFile, databaseFile);
  console.log(`2. import   -> ${databaseFile}, ${imported} bytes, sound, ${seconds(since)}`);

  since = Date.now();
  const source = openSource(from);
  const copy = openSource(`sqlite:${databaseFile}`);
  const a = fingerprint(source);
  const b = fingerprint(copy);
  copy.close();
  const result = compare(a, b);
  console.log(`3. verify   ${a.tables.length} tables, ${a.tables.reduce((total, table) => total + table.rows, 0)} rows, ${seconds(since)}`);
  for (const line of report(a, b)) console.log(`   ${line}`);
  // Kept beside the copy: what was compared and when, with no row in it.
  writeFileSync(join(folder, "verify.json"), JSON.stringify({ at: new Date().toISOString(), from, same: result.same, problems: result.problems, fileSha256: sha256File(databaseFile), d1: a, copy: b }, null, 2), { mode: 0o600 });
  if (!result.same) {
    console.error(`\nNOT THE SAME. Do not use this file.\n${result.problems.map((problem) => `  - ${problem}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`\nThe copy is exact. sha256 of the file: ${sha256File(databaseFile)}`);
} catch (cause) {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exit(1);
}
