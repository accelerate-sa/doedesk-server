/**
 * The database binding the handlers in `src/` expect (`env.DB`), over a SQLite file.
 *
 * It covers exactly what the code calls: `prepare`, `bind`, `first`, `all`, `run`, `batch`, with
 * the result shapes and the refusals D1 has. D1 is SQLite, so the SQL itself runs unchanged.
 * `server/test/d1-parity.mjs` runs the same operations against this and against a real local D1
 * and compares the answers.
 *
 * What is the same as D1, on purpose:
 *   - `bind` returns a new statement; the one it was called on is unchanged;
 *   - `undefined` cannot be bound, a boolean is stored as 1 or 0, and a statement takes at most
 *     100 values and needs exactly as many as it has placeholders;
 *   - `first()` gives the first row or null, `first(column)` that column's value;
 *   - `all()` and `run()` give `{ success, results, meta }`, with `meta.changes` the rows the
 *     statement itself changed (0 for a read) and `meta.last_row_id`;
 *   - `batch` runs its statements in order inside one transaction: all of them, or none;
 *   - foreign keys are enforced;
 *   - an error's message starts `D1_ERROR:` and ends with SQLite's result code.
 *
 * What differs, and does not matter to the code: `meta` carries no row or size figures; LIKE patterns
 * are not capped at 50 bytes (the code cuts its search terms shorter than that already).
 */

export type SqlValue = string | number | bigint | boolean | null | ArrayBuffer | ArrayBufferView;

/** The few things the wrapper needs from a SQLite library. One implementation per runtime. */
export interface SqliteDriver {
  /** Runs one statement and returns its rows (none for a statement that returns none). */
  query(sql: string, values: ReadonlyArray<string | number | bigint | null | Uint8Array>): Array<Record<string, unknown>>;
  /** Runs SQL that may hold several statements and takes no values. */
  exec(sql: string): void;
  close(): void;
}

export interface OpenOptions {
  /** How long a statement waits for another process's write lock before failing. */
  readonly busyTimeoutMs?: number;
  readonly readOnly?: boolean;
}

/** Settings applied to every connection. Journal mode is kept in the file; the rest are per connection. */
export const applyPragmas = (driver: SqliteDriver, options: OpenOptions = {}): void => {
  driver.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(options.busyTimeoutMs ?? 5000))}`);
  // D1 enforces foreign keys. Plain SQLite does not unless told to.
  driver.exec("PRAGMA foreign_keys = ON");
  if (options.readOnly === true) return;
  // Write-ahead logging: readers do not block the writer, and the backup tool follows the log.
  driver.exec("PRAGMA journal_mode = WAL");
  // A commit is on disk before the statement returns, as with D1. The service writes little, so
  // the cost of the sync per commit does not show.
  driver.exec("PRAGMA synchronous = FULL");
  driver.exec("PRAGMA wal_autocheckpoint = 1000");
  // An upper bound on the log file left behind after a checkpoint.
  driver.exec("PRAGMA journal_size_limit = 67108864");
  driver.exec("PRAGMA temp_store = MEMORY");
};

const MAX_BOUND_VALUES = 100;

/** SQLite's primary result codes by number, as D1 names them at the end of a message. */
const RESULT_CODES: Record<number, string> = {
  1: "SQLITE_ERROR",
  2: "SQLITE_INTERNAL",
  3: "SQLITE_PERM",
  4: "SQLITE_ABORT",
  5: "SQLITE_BUSY",
  6: "SQLITE_LOCKED",
  7: "SQLITE_NOMEM",
  8: "SQLITE_READONLY",
  9: "SQLITE_INTERRUPT",
  10: "SQLITE_IOERR",
  11: "SQLITE_CORRUPT",
  13: "SQLITE_FULL",
  14: "SQLITE_CANTOPEN",
  18: "SQLITE_TOOBIG",
  19: "SQLITE_CONSTRAINT",
  20: "SQLITE_MISMATCH",
  21: "SQLITE_MISUSE",
  25: "SQLITE_RANGE",
  26: "SQLITE_NOTADB",
};

/** The extended codes SQLite gives for a broken constraint, which D1 names after the primary one. */
const EXTENDED_CODES: Record<number, string> = {
  275: "SQLITE_CONSTRAINT_CHECK",
  787: "SQLITE_CONSTRAINT_FOREIGNKEY",
  1299: "SQLITE_CONSTRAINT_NOTNULL",
  1555: "SQLITE_CONSTRAINT_PRIMARYKEY",
  1811: "SQLITE_CONSTRAINT_TRIGGER",
  2067: "SQLITE_CONSTRAINT_UNIQUE",
  2579: "SQLITE_CONSTRAINT_ROWID",
  3091: "SQLITE_CONSTRAINT_DATATYPE",
};

/**
 * An error as the code would have met it on D1, for example
 * `D1_ERROR: UNIQUE constraint failed: users.email: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)`.
 * The library's own error is kept as the cause.
 */
export const d1Error = (cause: unknown): Error => {
  if (cause instanceof Error && cause.message.startsWith("D1_")) return cause;
  const raw = cause as { message?: unknown; errno?: unknown; errcode?: unknown; code?: unknown };
  const message = typeof raw?.message === "string" ? raw.message : String(cause);
  const number = typeof raw?.errno === "number" ? raw.errno : typeof raw?.errcode === "number" ? raw.errcode : undefined;
  const named = typeof raw?.code === "string" && raw.code.startsWith("SQLITE_") ? raw.code : undefined;
  const primary = (number !== undefined ? RESULT_CODES[number & 0xff] : undefined) ?? named?.split("_").slice(0, 2).join("_") ?? "SQLITE_ERROR";
  const extended = (number !== undefined ? EXTENDED_CODES[number] : undefined) ?? (named !== undefined && named !== primary ? named : undefined);
  return new Error(`D1_ERROR: ${message}: ${primary}${extended === undefined ? "" : ` (extended: ${extended})`}`, { cause });
};

/**
 * How many values a statement takes: `?` takes the next number, `?N` takes N. Text inside quotes
 * and comments is skipped. Named parameters are not used by the code and are refused.
 */
export const countPlaceholders = (sql: string): number => {
  let highest = 0;
  let index = 0;
  while (index < sql.length) {
    const character = sql[index];
    if (character === "'" || character === '"' || character === "`") {
      index += 1;
      while (index < sql.length) {
        if (sql[index] === character) {
          if (sql[index + 1] === character) index += 1;
          else break;
        }
        index += 1;
      }
    } else if (character === "[") {
      while (index < sql.length && sql[index] !== "]") index += 1;
    } else if (character === "-" && sql[index + 1] === "-") {
      while (index < sql.length && sql[index] !== "\n") index += 1;
    } else if (character === "/" && sql[index + 1] === "*") {
      index = sql.indexOf("*/", index + 2);
      if (index === -1) break;
      index += 1;
    } else if (character === "?") {
      let digits = "";
      while (/[0-9]/.test(sql[index + 1] ?? "")) {
        index += 1;
        digits += sql[index];
      }
      highest = digits === "" ? highest + 1 : Math.max(highest, Number(digits));
    } else if ((character === ":" || character === "@" || character === "$") && /[A-Za-z_]/.test(sql[index + 1] ?? "")) {
      throw new Error("D1_ERROR: Named parameters are not supported; use ? or ?N.");
    }
    index += 1;
  }
  return highest;
};

const READ_ONLY = /^\s*SELECT\b/i;

const PLACEHOLDERS = new Map<string, number>();
const placeholdersOf = (sql: string): number => {
  let count = PLACEHOLDERS.get(sql);
  if (count === undefined) {
    count = countPlaceholders(sql);
    if (PLACEHOLDERS.size >= 2000) PLACEHOLDERS.clear();
    PLACEHOLDERS.set(sql, count);
  }
  return count;
};

interface Meta {
  readonly duration: number;
  readonly changes: number;
  readonly last_row_id: number;
  readonly changed_db: boolean;
  readonly rows_read: number;
  readonly rows_written: number;
  readonly size_after: number;
  readonly served_by: string;
}

interface Result<T = Record<string, unknown>> {
  readonly success: true;
  readonly results: Array<T>;
  readonly meta: Meta;
}

const STATEMENT = Symbol("statement");

interface Statement {
  readonly [STATEMENT]: { readonly sql: string; readonly values: ReadonlyArray<SqlValue> };
  bind(...values: Array<unknown>): Statement;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<Result<T>>;
  run<T = Record<string, unknown>>(): Promise<Result<T>>;
  raw<T = Array<unknown>>(): Promise<Array<T>>;
}

export interface Database {
  prepare(sql: string): Statement;
  batch<T = Record<string, unknown>>(statements: ReadonlyArray<Statement>): Promise<Array<Result<T>>>;
  exec(sql: string): Promise<{ count: number; duration: number }>;
}

const toDriverValue = (value: SqlValue): string | number | bigint | null | Uint8Array => {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return value;
};

const checkValues = (values: ReadonlyArray<unknown>): ReadonlyArray<SqlValue> => {
  if (values.length > MAX_BOUND_VALUES) {
    throw new Error("D1_ERROR: too many SQL variables: SQLITE_ERROR");
  }
  values.forEach((value) => {
    const kind = typeof value;
    const allowed =
      value === null ||
      kind === "string" ||
      kind === "boolean" ||
      (kind === "number" && Number.isFinite(value as number)) ||
      value instanceof ArrayBuffer ||
      ArrayBuffer.isView(value);
    if (!allowed) {
      throw new Error(`D1_TYPE_ERROR: Type '${value === undefined ? "undefined" : kind}' not supported for value '${String(value)}'`);
    }
  });
  return values as ReadonlyArray<SqlValue>;
};

/** The binding. `driver` is an open connection that `applyPragmas` has been run on. */
export const createDatabase = (driver: SqliteDriver): Database => {
  const counters = (): { changes: number; row: number } => {
    const row = driver.query("SELECT total_changes() AS changes, last_insert_rowid() AS row", [])[0] ?? {};
    return { changes: Number(row.changes ?? 0), row: Number(row.row ?? 0) };
  };

  const execute = (statement: Statement): Result => {
    const { sql, values } = statement[STATEMENT];
    const started = performance.now();
    const expected = placeholdersOf(sql);
    if (expected !== values.length) {
      throw new Error("D1_ERROR: Wrong number of parameter bindings for SQL query.");
    }
    const reads = READ_ONLY.test(sql);
    try {
      const before = reads ? null : counters();
      const results = driver.query(sql, values.map(toDriverValue));
      const after = before === null ? null : counters();
      const changes = before === null || after === null ? 0 : after.changes - before.changes;
      return {
        success: true,
        results,
        meta: {
          duration: performance.now() - started,
          changes,
          last_row_id: after?.row ?? 0,
          changed_db: changes > 0,
          rows_read: 0,
          rows_written: changes,
          size_after: 0,
          served_by: "sqlite",
        },
      };
    } catch (cause) {
      throw d1Error(cause);
    }
  };

  const make = (sql: string, values: ReadonlyArray<SqlValue>): Statement => {
    const statement: Statement = {
      [STATEMENT]: { sql, values },
      bind: (...next) => make(sql, checkValues(next)),
      first: async <T>(column?: string) => {
        const row = execute(statement).results[0];
        if (row === undefined) return null;
        if (column === undefined) return row as T;
        if (!(column in row)) throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${column})`);
        return row[column] as T;
      },
      all: async <T>() => execute(statement) as unknown as Result<T>,
      run: async <T>() => execute(statement) as unknown as Result<T>,
      raw: async <T>() => execute(statement).results.map((row) => Object.values(row)) as Array<T>,
    };
    return statement;
  };

  return {
    prepare: (sql) => {
      if (typeof sql !== "string" || sql.trim() === "") throw new Error("D1_ERROR: A statement needs its SQL.");
      return make(sql, []);
    },
    batch: async <T>(statements: ReadonlyArray<Statement>) => {
      if (statements.length === 0) throw new Error("D1_ERROR: No SQL statements detected.");
      // The library is synchronous and this function does not wait between statements, so no other
      // request's statement can run in the middle. IMMEDIATE takes the write lock at the start, so
      // another process (the nightly job, a backup) cannot make the batch fail half-way.
      try {
        driver.exec("BEGIN IMMEDIATE");
      } catch (cause) {
        throw d1Error(cause);
      }
      try {
        const results = statements.map((statement) => execute(statement));
        driver.exec("COMMIT");
        return results as unknown as Array<Result<T>>;
      } catch (cause) {
        try {
          driver.exec("ROLLBACK");
        } catch {
          // A failed COMMIT has already rolled back.
        }
        throw d1Error(cause);
      }
    },
    exec: async (sql) => {
      const started = performance.now();
      try {
        driver.exec(sql);
      } catch (cause) {
        throw d1Error(cause);
      }
      return { count: sql.split("\n").filter((line) => line.trim() !== "").length, duration: performance.now() - started };
    },
  };
};
