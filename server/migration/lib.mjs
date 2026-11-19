// Copying the database from Cloudflare D1 to a SQLite file, and proving the copy is exact.
// Used by the three commands in this folder; each says when it is run.
//
// A database is reached in one of three ways, written as a "source":
//   d1:remote            the production D1, through wrangler (read-only statements only)
//   d1:local:<folder>    a local D1 kept by wrangler in <folder> (tests and rehearsals)
//   sqlite:<file>        a SQLite file
//
// Nothing here prints a row. What is printed is a table's name, how many rows it has, and a
// checksum.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const DATABASE_NAME = "doedesk-cloud";

/** Tables that belong to Cloudflare or to SQLite itself and are not part of the data. */
// Not the service's data: Cloudflare's and SQLite's own tables, and the two Litestream keeps in the
// database it copies (they change with every copy, and D1 never has them).
const INTERNAL =
  "name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_litestream\\_%' ESCAPE '\\'";

const quoteName = (name) => `"${String(name).replace(/"/g, '""')}"`;

const wrangler = (args, { cwd = ROOT } = {}) => {
  // Run from the repository so that `npx` finds the project's own wrangler, whatever folder it then works in.
  const result = spawnSync(join(ROOT, "node_modules", ".bin", "wrangler"), args, { cwd, encoding: "utf8", maxBuffer: 1024 * 1024 * 1024, env: { ...process.env, CI: "1", NO_COLOR: "1" } });
  if (result.status !== 0) {
    // wrangler's own words, which name the command and the error and hold no row.
    throw new Error(`wrangler ${args.slice(0, 3).join(" ")} failed: ${(result.stderr || result.stdout).split("\n").filter((line) => line.trim() !== "").slice(-4).join(" | ").slice(0, 600)}`);
  }
  return result.stdout;
};

/** Opens a source. `query(statements)` runs read-only statements and gives one array of rows per statement. */
export const openSource = (spec) => {
  if (spec.startsWith("sqlite:")) {
    const file = resolve(spec.slice(7));
    if (!existsSync(file)) throw new Error(`No such file: ${file}`);
    const database = new DatabaseSync(file, { readOnly: true });
    return {
      spec,
      kind: "sqlite",
      query: (statements) => statements.map((sql) => database.prepare(sql).all().map((row) => ({ ...row }))),
      close: () => database.close(),
    };
  }
  const local = spec.startsWith("d1:local:") ? resolve(spec.slice(9)) : null;
  if (spec !== "d1:remote" && local === null) throw new Error(`Not a source: ${spec}. Use d1:remote, d1:local:<folder> or sqlite:<file>.`);
  const where = local === null ? ["--remote"] : ["--local", "--persist-to", local];
  return {
    spec,
    kind: "d1",
    query: (statements) => {
      for (const sql of statements) if (!/^\s*SELECT\b/i.test(sql) || sql.includes(";")) throw new Error("Only single SELECT statements are sent to D1.");
      const out = wrangler(["d1", "execute", DATABASE_NAME, ...where, "--json", "--command", statements.join("; ")]);
      const parsed = JSON.parse(out.slice(out.indexOf("[")));
      if (!Array.isArray(parsed) || parsed.length !== statements.length) throw new Error("D1 answered with a different number of results than statements.");
      return parsed.map((entry) => entry.results ?? []);
    },
    close: () => {},
  };
};

/**
 * What a database holds, reduced to what can be compared and printed: its schema, and for every
 * table the number of rows and a SHA-256 over all of them.
 *
 * A row enters the checksum as SQLite itself writes its values (`quote()`: text in quotes, numbers
 * as digits, NULL, blobs in hex), so a text '1' and a number 1 differ, and so do NULL and ''.
 * Rows go in primary-key order, or in order of all columns for a table with no key.
 */
export const fingerprint = (source, { pageBytes = 1_500_000 } = {}) => {
  const [objects] = source.query([`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE ${INTERNAL} ORDER BY type, name`]);
  const tables = objects.filter((object) => object.type === "table").map((object) => object.name);
  // wrangler's export writes the migrations ledger as `CREATE TABLE IF NOT EXISTS "d1_migrations"`,
  // which SQLite then stores with the quotes. The table is the same; the spelling is evened out.
  const schema = objects.map(
    (object) =>
      `${object.type} ${object.name} on ${object.tbl_name}: ${String(object.sql ?? "")
        .replace(/\s+/g, " ")
        .replace(/^CREATE TABLE (IF NOT EXISTS )?"?([A-Za-z0-9_]+)"? ?\(/, "CREATE TABLE $2(")
        .trim()}`,
  );

  const columnRows = tables.length === 0 ? [] : source.query(tables.map((table) => `SELECT name, pk FROM pragma_table_info('${table.replace(/'/g, "''")}') ORDER BY cid`));
  const plans = tables.map((table, index) => {
    const columns = columnRows[index].map((column) => column.name);
    const key = columnRows[index].filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name);
    const row = columns.map((column) => `quote(${quoteName(column)})`).join(" || ',' || ");
    return { table, columns, row, order: (key.length > 0 ? key : columns).map(quoteName).join(", ") };
  });
  const sizes = plans.length === 0 ? [] : source.query(plans.map((plan) => `SELECT COUNT(*) AS n, COALESCE(MAX(length(${plan.row})), 0) AS widest FROM ${quoteName(plan.table)}`));

  // Pages are packed into as few calls as fit the budget; each wrangler call costs seconds.
  const pages = [];
  plans.forEach((plan, index) => {
    const { n, widest } = sizes[index][0];
    plan.rows = n;
    // Characters, where the budget is bytes: text in Arabic takes two bytes a character.
    const perPage = Math.max(1, Math.min(2000, Math.floor(pageBytes / Math.max(1, widest * 2))));
    for (let offset = 0; offset < n; offset += perPage) pages.push({ plan, limit: perPage, offset, estimate: Math.min(perPage, n - offset) * widest * 2 });
  });
  const hashes = new Map(plans.map((plan) => [plan.table, createHash("sha256")]));
  const counted = new Map(plans.map((plan) => [plan.table, 0]));
  let group = [];
  let groupBytes = 0;
  const flush = () => {
    if (group.length === 0) return;
    const results = source.query(group.map((page) => `SELECT ${page.plan.row} AS r FROM ${quoteName(page.plan.table)} ORDER BY ${page.plan.order} LIMIT ${page.limit} OFFSET ${page.offset}`));
    group.forEach((page, index) => {
      for (const row of results[index]) {
        hashes.get(page.plan.table).update(`${row.r}\n`);
        counted.set(page.plan.table, counted.get(page.plan.table) + 1);
      }
    });
    group = [];
    groupBytes = 0;
  };
  for (const page of pages) {
    if (group.length > 0 && (groupBytes + page.estimate > pageBytes || group.length >= 40)) flush();
    group.push(page);
    groupBytes += page.estimate;
  }
  flush();

  return {
    source: source.spec,
    schema,
    schemaSha256: createHash("sha256").update(schema.join("\n")).digest("hex"),
    tables: plans.map((plan) => {
      if (counted.get(plan.table) !== plan.rows) throw new Error(`${plan.table} changed while it was being read: ${plan.rows} rows counted, ${counted.get(plan.table)} read. Is the service frozen?`);
      return { table: plan.table, rows: plan.rows, sha256: hashes.get(plan.table).digest("hex") };
    }),
  };
};

/** Compares two fingerprints. `same` is true only when the schema, every count and every checksum agree. */
export const compare = (a, b) => {
  const problems = [];
  if (a.schemaSha256 !== b.schemaSha256) {
    const inB = new Set(b.schema);
    const inA = new Set(a.schema);
    for (const line of a.schema) if (!inB.has(line)) problems.push(`schema: only in ${a.source}: ${line.slice(0, 160)}`);
    for (const line of b.schema) if (!inA.has(line)) problems.push(`schema: only in ${b.source}: ${line.slice(0, 160)}`);
  }
  const other = new Map(b.tables.map((table) => [table.table, table]));
  for (const table of a.tables) {
    const match = other.get(table.table);
    if (match === undefined) problems.push(`${table.table}: missing from ${b.source}`);
    else if (match.rows !== table.rows) problems.push(`${table.table}: ${table.rows} rows in ${a.source}, ${match.rows} in ${b.source}`);
    else if (match.sha256 !== table.sha256) problems.push(`${table.table}: same number of rows (${table.rows}), different contents`);
    other.delete(table.table);
  }
  for (const table of other.keys()) problems.push(`${table}: missing from ${a.source}`);
  return { same: problems.length === 0, problems };
};

/** The comparison as lines for a person: one per table. No row is in it. */
export const report = (a, b) => {
  const other = new Map(b.tables.map((table) => [table.table, table]));
  const lines = a.tables.map((table) => {
    const match = other.get(table.table);
    const same = match !== undefined && match.rows === table.rows && match.sha256 === table.sha256;
    return `${same ? "same" : "DIFF"}  ${table.table.padEnd(22)} ${String(table.rows).padStart(8)} rows  ${table.sha256.slice(0, 16)}${same ? "" : `  vs ${match === undefined ? "missing" : `${match.rows} rows ${match.sha256.slice(0, 16)}`}`}`;
  });
  lines.push(`${a.schemaSha256 === b.schemaSha256 ? "same" : "DIFF"}  schema (${a.schema.length} tables and indexes)  ${a.schemaSha256.slice(0, 16)}`);
  return lines;
};

/** Refuses a folder inside a git repository: an export holds real accounts and must not be committed by accident. */
export const assertPrivateFolder = (folder) => {
  const inside = spawnSync("git", ["-C", folder, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
  if (inside.status === 0 && inside.stdout.trim() === "true") throw new Error(`${folder} is inside a git repository. Keep the copy somewhere else.`);
  const mode = statSync(folder).mode & 0o777;
  if ((mode & 0o077) !== 0) throw new Error(`${folder} can be read by other users (mode ${mode.toString(8)}). Make it 700 first: chmod 700 ${folder}`);
};

/** Asks wrangler for the whole database as SQL, into `file`. Read-only on D1. */
export const exportD1 = (spec, file) => {
  if (spec === "d1:remote") wrangler(["d1", "export", DATABASE_NAME, "--remote", "--output", file]);
  else {
    // `wrangler d1 export --local` reads only the state folder beside its configuration, so a
    // configuration is made for the occasion with that folder linked beside it.
    const project = mkdtempSync(join(tmpdir(), "doedesk-local-export-"));
    try {
      const id = /"database_id":\s*"([^"]+)"/.exec(readFileSync(join(ROOT, "wrangler.jsonc"), "utf8"))?.[1];
      mkdirSync(join(project, ".wrangler"));
      symlinkSync(resolve(spec.slice(9)), join(project, ".wrangler", "state"));
      writeFileSync(join(project, "wrangler.jsonc"), JSON.stringify({ name: "local-export", compatibility_date: "2026-11-01", d1_databases: [{ binding: "DB", database_name: DATABASE_NAME, database_id: id }] }));
      wrangler(["d1", "export", DATABASE_NAME, "--local", "--config", join(project, "wrangler.jsonc"), "--output", file], { cwd: project });
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  }
  chmodSync(file, 0o600);
  return statSync(file).size;
};

/**
 * Loads an export into a new SQLite file. Fails if the file exists. The file is checked (SQLite's
 * own integrity check, and that every reference points at a row) before the function returns.
 */
export const importExport = (exportFile, databaseFile) => {
  if (existsSync(databaseFile)) throw new Error(`${databaseFile} exists. Import into a new file.`);
  const database = new DatabaseSync(databaseFile);
  try {
    chmodSync(databaseFile, 0o600);
    // An export lists tables in an order of its own; references are checked once everything is in.
    database.exec("PRAGMA foreign_keys = OFF");
    database.exec("BEGIN");
    database.exec(readFileSync(exportFile, "utf8"));
    database.exec("COMMIT");
    const integrity = database.prepare("PRAGMA integrity_check").all().map((row) => row.integrity_check).join(", ");
    const dangling = database.prepare("PRAGMA foreign_key_check").all().length;
    if (integrity !== "ok" || dangling !== 0) throw new Error(`The imported file is not sound: integrity ${integrity}, ${dangling} rows point at nothing.`);
  } finally {
    database.close();
  }
  // The journal mode is kept in the file. Set on a connection of its own: SQLite will not change it
  // while a statement from the checks above is still held.
  const settled = new DatabaseSync(databaseFile);
  try {
    settled.exec("PRAGMA journal_mode = WAL");
    settled.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    settled.close();
  }
  for (const suffix of ["-wal", "-shm"]) if (existsSync(databaseFile + suffix)) chmodSync(databaseFile + suffix, 0o600);
  return statSync(databaseFile).size;
};

/** D1 refuses a statement longer than 100,000 bytes. Statements written for it stay well under. */
export const D1_STATEMENT_BYTES = 100_000;
const CHUNK_CHARACTERS = 20_000;

/**
 * The whole of a SQLite file as SQL that D1 can load over what it holds: for going back.
 * Every table is dropped and made again, then filled. A value too long for one statement is
 * written in pieces: the row first with the start of the value, then the rest appended.
 * Returns the SQL as a list of statements.
 */
export const backCopySql = (databaseFile) => {
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const objects = database.prepare(`SELECT type, name, sql FROM sqlite_master WHERE ${INTERNAL} AND sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, rowid`).all();
    const tables = objects.filter((object) => object.type === "table");
    const statements = ["PRAGMA defer_foreign_keys = TRUE"];
    for (const table of [...tables].reverse()) statements.push(`DROP TABLE IF EXISTS ${quoteName(table.name)}`);
    for (const table of tables) statements.push(String(table.sql));
    for (const table of tables) {
      const info = database.prepare(`SELECT name, pk FROM pragma_table_info(?) ORDER BY cid`).all(table.name);
      const columns = info.map((column) => column.name);
      const key = info.filter((column) => column.pk > 0).map((column) => column.name);
      const withoutRowid = /WITHOUT\s+ROWID/i.test(String(table.sql));
      // How to find the row again when a long value is appended to it.
      const locator = key.length > 0 ? key : withoutRowid ? columns : ["rowid"];
      const select = `SELECT ${locator.includes("rowid") && key.length === 0 ? "rowid AS \"rowid\", " : ""}${columns.map((column) => `quote(${quoteName(column)}) AS ${quoteName(`q:${column}`)}, typeof(${quoteName(column)}) AS ${quoteName(`t:${column}`)}, CASE WHEN typeof(${quoteName(column)}) = 'text' THEN ${quoteName(column)} END AS ${quoteName(`v:${column}`)}`).join(", ")} FROM ${quoteName(table.name)} ORDER BY ${(key.length > 0 ? key : columns).map(quoteName).join(", ")}`;
      for (const row of database.prepare(select).all()) {
        const long = columns.filter((column) => row[`t:${column}`] === "text" && String(row[`v:${column}`]).length > CHUNK_CHARACTERS);
        const literal = (column) => (long.includes(column) ? `'${String(row[`v:${column}`]).slice(0, CHUNK_CHARACTERS).replace(/'/g, "''")}'` : row[`q:${column}`]);
        const rowidPart = locator[0] === "rowid" && key.length === 0 ? { names: ["rowid"], values: [String(row.rowid)] } : { names: [], values: [] };
        statements.push(`INSERT INTO ${quoteName(table.name)} (${[...rowidPart.names, ...columns.map(quoteName)].join(", ")}) VALUES (${[...rowidPart.values, ...columns.map(literal)].join(", ")})`);
        if (long.length === 0) continue;
        const where = locator[0] === "rowid" && key.length === 0 ? `rowid = ${row.rowid}` : locator.map((column) => `${quoteName(column)} IS ${row[`q:${column}`]}`).join(" AND ");
        for (const column of long) {
          const value = String(row[`v:${column}`]);
          for (let start = CHUNK_CHARACTERS; start < value.length; start += CHUNK_CHARACTERS) {
            statements.push(`UPDATE ${quoteName(table.name)} SET ${quoteName(column)} = ${quoteName(column)} || '${value.slice(start, start + CHUNK_CHARACTERS).replace(/'/g, "''")}' WHERE ${where}`);
          }
        }
      }
    }
    for (const object of objects.filter((entry) => entry.type !== "table")) statements.push(String(object.sql));
    const sequences = database.prepare("SELECT name FROM sqlite_master WHERE name = 'sqlite_sequence'").all().length > 0 ? database.prepare("SELECT name, seq FROM sqlite_sequence").all() : [];
    for (const sequence of sequences) {
      statements.push(`DELETE FROM sqlite_sequence WHERE name = '${String(sequence.name).replace(/'/g, "''")}'`);
      statements.push(`INSERT INTO sqlite_sequence (name, seq) VALUES ('${String(sequence.name).replace(/'/g, "''")}', ${Number(sequence.seq)})`);
    }
    const tooLong = statements.filter((statement) => Buffer.byteLength(statement, "utf8") >= D1_STATEMENT_BYTES);
    if (tooLong.length > 0) throw new Error(`${tooLong.length} statements are longer than D1 takes. A row has too many long values for this tool.`);
    return statements;
  } finally {
    database.close();
  }
};

export const sha256File = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
export const args = (argv) => {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) if (argv[index].startsWith("--")) out[argv[index].slice(2)] = argv[index + 1] !== undefined && !argv[index + 1].startsWith("--") ? argv[(index += 1)] : true;
  return out;
};
export const privateJoin = join;
