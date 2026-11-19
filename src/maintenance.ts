/**
 * The two switches used while the service moves from one home to another. Both are off unless set.
 *
 * FREEZE (`MAINTENANCE=freeze`)
 * For the minutes in which the database is copied. Nothing is written, so the copy is exact.
 * What each kind of request gets was chosen from how the released apps (0.1.x) treat an error:
 *
 *   - Detection and reading are answered as usual, and not counted. A failed detection makes the
 *     app refuse the person's message to the model, which is the one failure people would notice;
 *     a few minutes of uncounted use costs nobody anything. The log gets the number of such
 *     requests (`freeze_unmetered`), and nothing else.
 *   - Reads are answered: `/v1/me`, `/v1/auth/options`, `/v1/legal`, the relay token, the public
 *     key, the dashboard's pages. A session's date of last use is not moved forward.
 *   - Everything that has to write is refused with 503 `maintenance`, a plain sentence and a
 *     `retry-after`: starting or finishing a sign-in, signing out, the onboarding answers, accepting
 *     the Terms, export, deletion, usage events, error reports. Never 401, which would sign the
 *     apps out. The apps show the sentence where a person is waiting (sign-in), and retry usage
 *     events by themselves for thirty minutes. Nothing is queued anywhere.
 *   - Contact mail is forwarded to the owner and not stored (index.ts).
 *
 * The rule is enforced where the database is reached, so a route added later cannot write by
 * oversight: a statement that is not a plain read is refused.
 *
 * FORWARD (`FORWARD_API_TO`, Worker only)
 * For the days between moving the data and moving the address. The Worker passes every API request
 * to the new origin unchanged and keeps nothing.
 */
import { ApiError, type Env } from "./http.ts";

export const MAINTENANCE_MESSAGE = "DoeDesk Cloud is moving to new servers. It will be back in a few minutes.";
export const MAINTENANCE_RETRY_SECONDS = 300;

export const isFrozen = (env: Pick<Env, "MAINTENANCE">): boolean => env.MAINTENANCE === "freeze";

export const maintenanceError = (): ApiError =>
  new ApiError(503, "maintenance", MAINTENANCE_MESSAGE, { retryAfterSeconds: MAINTENANCE_RETRY_SECONDS });

export const isMaintenanceError = (cause: unknown): boolean => cause instanceof ApiError && cause.code === "maintenance";

/** A statement that only reads: SELECT, or WITH … SELECT. Everything else counts as a write. */
export const isReadOnlySql = (sql: string): boolean => {
  const text = sql.trimStart();
  if (/^SELECT\b/i.test(text)) return true;
  return /^WITH\b/i.test(text) && !/\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(text);
};

const REFUSED = new WeakSet<object>();

/** Stands in for a statement that would write: it can be built and bound, and refuses to run. */
const refusedStatement = (): D1PreparedStatement => {
  const refuse = (): never => {
    throw maintenanceError();
  };
  const statement = {
    bind: () => statement,
    first: async () => refuse(),
    run: async () => refuse(),
    all: async () => refuse(),
    raw: async () => refuse(),
  } as unknown as D1PreparedStatement;
  REFUSED.add(statement);
  return statement;
};

/** The database as the frozen service sees it: reads pass, anything else is refused. */
export const frozenDatabase = (database: D1Database): D1Database =>
  ({
    prepare: (sql: string) => (isReadOnlySql(sql) ? database.prepare(sql) : refusedStatement()),
    batch: async (statements: Array<D1PreparedStatement>) => {
      if (statements.some((statement) => REFUSED.has(statement))) throw maintenanceError();
      return database.batch(statements);
    },
    exec: async () => {
      throw maintenanceError();
    },
  }) as unknown as D1Database;

/** `env` with the freeze applied, when it is set. */
export const withMaintenance = (env: Env): Env => (isFrozen(env) ? { ...env, DB: frozenDatabase(env.DB) } : env);

// ---------------------------------------------------------------------------------------------
// Forwarding

/** The headers the forwarding Worker adds. The origin believes them only with the right secret. */
export const FORWARD_HEADERS = {
  secret: "x-doedesk-forward-secret",
  ip: "x-doedesk-client-ip",
  country: "x-doedesk-client-country",
  region: "x-doedesk-client-region",
} as const;

export const forwardsApi = (env: Pick<Env, "FORWARD_API_TO" | "FORWARD_SECRET">): boolean =>
  (env.FORWARD_API_TO ?? "") !== "" && (env.FORWARD_SECRET ?? "") !== "";

/**
 * Passes one request to the new origin: same method, path, query, headers and body, plus where the
 * caller is, as Cloudflare reports it. The answer is handed back as it came.
 */
export const forwardToOrigin = async (request: Request, env: Env, url: URL): Promise<Response> => {
  const cf = (request as { cf?: { country?: unknown; regionCode?: unknown } }).cf;
  const headers = new Headers(request.headers);
  // A caller cannot state these for itself: whatever it sent under these names is replaced.
  for (const name of Object.values(FORWARD_HEADERS)) headers.delete(name);
  headers.set(FORWARD_HEADERS.secret, env.FORWARD_SECRET ?? "");
  headers.set(FORWARD_HEADERS.ip, request.headers.get("cf-connecting-ip") ?? "");
  if (typeof cf?.country === "string") headers.set(FORWARD_HEADERS.country, cf.country);
  if (typeof cf?.regionCode === "string") headers.set(FORWARD_HEADERS.region, cf.regionCode);
  const target = `${(env.FORWARD_API_TO ?? "").replace(/\/+$/, "")}${url.pathname}${url.search}`;
  try {
    return await fetch(target, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual",
    });
  } catch {
    // Not a 401, and worded like the freeze: the apps keep their sign-in and try again.
    throw new ApiError(503, "maintenance", "DoeDesk Cloud could not be reached. Try again in a minute.", { retryAfterSeconds: 60 });
  }
};
