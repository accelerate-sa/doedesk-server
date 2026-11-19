// Compares two databases: schema, and every table's row count and checksum.
//
//   node server/migration/verify.mjs --a d1:remote --b sqlite:/private/folder/doedesk.sqlite
//   node server/migration/verify.mjs --a sqlite:before.sqlite --b sqlite:restored.sqlite
//
// A source is d1:remote, d1:local:<folder> or sqlite:<file>. Exit 0 when they are the same, 1 when
// they differ. Prints table names, counts and checksums; never a row. `--json` prints the same as JSON.
import { args, compare, fingerprint, openSource, report } from "./lib.mjs";

const options = args(process.argv.slice(2));
if (typeof options.a !== "string" || typeof options.b !== "string") {
  console.error("usage: verify.mjs --a <source> --b <source> [--json]");
  process.exit(2);
}
try {
  const first = openSource(options.a);
  const second = openSource(options.b);
  const a = fingerprint(first);
  const b = fingerprint(second);
  first.close();
  second.close();
  const result = compare(a, b);
  if (options.json === true) console.log(JSON.stringify({ same: result.same, problems: result.problems, a, b }, null, 2));
  else {
    for (const line of report(a, b)) console.log(line);
    console.log(result.same ? "\nthe same" : `\nDIFFERENT\n${result.problems.map((problem) => `  - ${problem}`).join("\n")}`);
  }
  process.exit(result.same ? 0 : 1);
} catch (cause) {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exit(2);
}
