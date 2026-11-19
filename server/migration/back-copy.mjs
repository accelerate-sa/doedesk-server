// For going back: writes the whole of a SQLite file as SQL that D1 can load over what it holds.
//
//   node server/migration/back-copy.mjs --sqlite <file> --out <private folder>
//
// Writes <folder>/back-copy.sql and prints the two commands that follow: loading it into D1, and
// verifying D1 against the file. It does not touch D1 itself. Loading the file REPLACES every table
// in D1, so it is for one case only: returning to Cloudflare after the server has taken writes.
//
// Take the file from a server that is frozen or stopped, so nothing is written after the copy.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { args, assertPrivateFolder, backCopySql, D1_STATEMENT_BYTES } from "./lib.mjs";

const options = args(process.argv.slice(2));
if (typeof options.sqlite !== "string" || typeof options.out !== "string") {
  console.error("usage: back-copy.mjs --sqlite <file> --out <private folder>");
  process.exit(2);
}
try {
  const folder = resolve(options.out);
  if (!existsSync(folder)) mkdirSync(folder, { recursive: true, mode: 0o700 });
  assertPrivateFolder(folder);
  const statements = backCopySql(resolve(options.sqlite));
  const file = join(folder, "back-copy.sql");
  writeFileSync(file, `${statements.map((statement) => `${statement};`).join("\n")}\n`, { mode: 0o600 });
  const longest = statements.reduce((most, statement) => Math.max(most, Buffer.byteLength(statement, "utf8")), 0);
  console.log(`wrote ${file}: ${statements.length} statements, the longest ${longest} bytes (D1 takes up to ${D1_STATEMENT_BYTES})`);
  console.log("\nTo load it into D1, replacing what D1 holds, and check the result:");
  console.log(`  npx wrangler d1 execute doedesk-cloud --remote --file ${file} --yes`);
  console.log(`  node server/migration/verify.mjs --a sqlite:${resolve(options.sqlite)} --b d1:remote`);
} catch (cause) {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exit(1);
}
