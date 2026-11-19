// The server's database wrapper against a real local D1, on the operations the code makes.
//
//   node server/test/d1-parity.mjs
//
// The same script of operations (d1-ops.mjs) runs three times: against Cloudflare's own D1 as
// wrangler runs it on this machine (Miniflare, the engine `wrangler dev` uses), and against the
// wrapper in `server/d1.ts` on Bun and on Node. Every answer must be the same: rows, counts of
// changed rows, what a batch keeps when it fails, and which operations are refused.
//
// Error messages are compared by what they say, not letter for letter: D1 words some of its own
// refusals differently from one release to the next. Each is reduced to the kind of refusal.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runOps } from "./d1-ops.mjs";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
let failures = 0;
const expect = (label, condition, detail = null) => {
  if (!condition) failures += 1;
  console.log(`${condition ? "ok  " : "FAIL"} ${label}${condition ? "" : ` -> ${JSON.stringify(detail)?.slice(0, 900)}`}`);
};

/** What kind of refusal a message is. The wording around it differs between D1 and SQLite libraries. */
const kindOf = (message) => {
  const text = String(message);
  for (const [kind, pattern] of [
    ["unique", /UNIQUE constraint failed: ([\w.]+)/],
    ["foreign key", /FOREIGN KEY constraint failed/],
    ["no such table", /no such table: (\w+)/],
    ["type", /D1_TYPE_ERROR|Type 'undefined' not supported/],
    ["binding count", /Wrong number of parameter bindings|too many SQL variables/],
    ["column not found", /D1_COLUMN_NOTFOUND/],
    ["syntax", /syntax error/],
    ["nothing to run", /No SQL statements detected/],
  ]) {
    const match = pattern.exec(text);
    if (match !== null) return `${kind}${match[1] === undefined ? "" : ` ${match[1]}`}`;
  }
  return `other: ${text.slice(0, 80)}`;
};
const reduce = (value) => {
  if (Array.isArray(value)) return value.map(reduce);
  if (value !== null && typeof value === "object") {
    if (typeof value.threw === "string") return { threw: kindOf(value.threw) };
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, reduce(inner)]));
  }
  return value;
};

const folder = mkdtempSync(join(tmpdir(), "doedesk-d1-parity-"));
try {
  // A real local D1 with the migrations applied by wrangler itself.
  const config = join(folder, "wrangler.jsonc");
  writeFileSync(
    config,
    JSON.stringify({
      name: "d1-parity",
      main: join(ROOT, "src", "index.ts"),
      compatibility_date: "2026-11-01",
      d1_databases: [{ binding: "DB", database_name: "doedesk-cloud", database_id: "00000000-0000-0000-0000-000000000000", migrations_dir: join(ROOT, "migrations") }],
    }),
  );
  const state = join(folder, "state");
  const applied = spawnSync("npx", ["wrangler", "d1", "migrations", "apply", "doedesk-cloud", "--local", "--persist-to", state, "--config", config], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
  });
  if (applied.status !== 0) throw new Error(`wrangler could not apply the migrations:\n${applied.stdout}\n${applied.stderr}`);
  const { getPlatformProxy } = await import("wrangler");
  const proxy = await getPlatformProxy({ configPath: config, persist: { path: join(state, "v3") } });
  let d1;
  try {
    const tables = (await proxy.env.DB.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'usage_daily'").first()).n;
    if (tables !== 1) throw new Error("The local D1 does not hold the schema: the migrations went somewhere else.");
    d1 = await runOps(proxy.env.DB);
  } finally {
    await proxy.dispose();
  }

  const wrapper = (command, args) => {
    const result = spawnSync(command, [...args, join(ROOT, "server", "test", "d1-ops-run.ts")], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`${command} could not run the operations:\n${result.stdout}\n${result.stderr}`);
    return JSON.parse(result.stdout.trim().split("\n").at(-1));
  };
  const onBun = wrapper("bun", []);
  const onNode = wrapper("node", ["--disable-warning=ExperimentalWarning"]);

  expect(`all three ran the same ${d1.length} operations`, d1.length > 30 && onBun.length === d1.length && onNode.length === d1.length, [d1.length, onBun.length, onNode.length]);
  const raw = process.argv.includes("--print");
  // The one known difference, on Bun only: a whole number is handed to SQLite as an integer, where
  // D1 and Node hand every number over as a float (server/runtime/bun.ts). It may show in these two
  // steps and nowhere else, and only as the number's type.
  const BUN_NUMBER_TYPE = new Map([
    ["a boolean is stored as 1 or 0", (text) => text.replace('"kind":"integer"', '"kind":"real"')],
    ["a whole number is an integer, a fraction a real, and joins to text as written", (text) => text.replace('"whole":"integer"', '"whole":"real"').replace('"joined":"k:60"', '"joined":"k:60.0"')],
  ]);
  const differsOnBun = [];
  d1.forEach((step, index) => {
    const want = JSON.stringify(reduce(step.answer));
    let bun = JSON.stringify(reduce(onBun[index]?.answer));
    const node = JSON.stringify(reduce(onNode[index]?.answer));
    if (bun !== want && BUN_NUMBER_TYPE.has(step.name) && BUN_NUMBER_TYPE.get(step.name)(bun) === want) {
      differsOnBun.push(step.name);
      bun = want;
    }
    expect(`${step.name}`, want === bun && want === node, { d1: want, bun: bun === want ? "same" : bun, node: node === want ? "same" : node });
    if (raw) console.log(`       d1   ${JSON.stringify(step.answer).slice(0, 300)}\n       bun  ${JSON.stringify(onBun[index]?.answer).slice(0, 300)}`);
  });
  expect("on Node the wrapper answers exactly as D1 does; on Bun the only difference is the type of a bound whole number", differsOnBun.length === 2, differsOnBun);
  // The refusals themselves, so a reader can see D1's words beside the wrapper's.
  const refusals = d1.flatMap((step, index) => {
    const find = (value) => (value && typeof value === "object" ? (typeof value.threw === "string" ? [value.threw] : Object.values(value).flatMap(find)) : []);
    const [a] = find(step.answer);
    const [b] = find(onBun[index]?.answer);
    return a === undefined ? [] : [{ a, b }];
  });
  expect("every refusal from the wrapper carries D1's own words (bar the position D1 adds to a syntax error)", refusals.every(({ a, b }) => (b ?? "").split(":")[0] === a.split(":")[0] && b.replace(/ at offset \d+/, "") === a.replace(/ at offset \d+/, "")), refusals.map(({ b }) => b));
  if (raw) for (const { a, b } of refusals) console.log(`       d1: ${a}\n       us: ${b}`);
} finally {
  rmSync(folder, { recursive: true, force: true });
}
console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
