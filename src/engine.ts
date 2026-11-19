/**
 * Detection and reading by the engine at `ENGINE_URL`, in this service's own format:
 *
 *   POST {ENGINE_URL}/v1/detect   { "texts": string[] }
 *                                 -> { "results": [{ "entities": [{ "start", "end", "kind" }] }] }
 *   POST {ENGINE_URL}/v1/ocr      the file as the body, its media type as content-type
 *                                 -> { "text": string, "pages"?: number }
 *   POST {ENGINE_URL}/v1/ocr?layout=1
 *                                 -> the same, with "layout": where each word of the text is
 *                                    (`EngineLayout` below), when the engine can say
 *   GET  {ENGINE_URL}/v1/health   -> 200 when ready, with { detection, reading: { ready, state? } }
 *
 * Positions are UTF-16 code units, as JavaScript strings and the app count them.
 *
 * In production the engine is detection and reading software on the same machine, behind a small
 * local service, reached on the machine's loopback address. There is no other path: when
 * the engine fails, the request fails; nothing is sent anywhere else.
 */
import { ApiError, type Env } from "./http.ts";

export const engineConfigured = (env: Pick<Env, "ENGINE_URL">): boolean => (env.ENGINE_URL ?? "").trim() !== "";

/**
 * Under the app's own limits (30 s for detection, 120 s for reading), so the app gets our answer,
 * and over the local service's own (25 s and 110 s), so that we get its answer, which says how
 * much work a call that ran out of time had already done.
 */
const DETECT_TIMEOUT_MS = 27_000;
const READ_TIMEOUT_MS = 115_000;

/**
 * The local service answers 503 for two different things. `overloaded`: its queue is full, and the
 * same request will go through shortly; it says when. `unavailable`: the engine cannot serve at
 * all, which waiting does not mend: a person has to look.
 */
const errorCode = (body: unknown): string => {
  const error = (body as { error?: { code?: unknown } } | null)?.error;
  return typeof error?.code === "string" ? error.code : "";
};
const retryAfter = (response: Response): number => {
  const seconds = Number(response.headers.get("retry-after") ?? "");
  return Number.isInteger(seconds) && seconds >= 1 && seconds <= 120 ? seconds : 5;
};

const KINDS = new Set(["PERSON", "ORG", "ADDRESS", "PHONE", "EMAIL", "ID", "IBAN", "ACCOUNT", "URL", "OTHER"]);

export type EngineKind = "PERSON" | "ORG" | "ADDRESS" | "PHONE" | "EMAIL" | "ID" | "IBAN" | "ACCOUNT" | "URL" | "OTHER";

const address = (env: Env, path: string): string => `${(env.ENGINE_URL ?? "").trim().replace(/\/+$/, "")}${path}`;

const authorization = (env: Env): Record<string, string> =>
  (env.ENGINE_TOKEN ?? "") === "" ? {} : { authorization: `Bearer ${env.ENGINE_TOKEN}` };

/**
 * Engine units: the work a call cost the engine, in whatever unit the engine counts it. The service
 * does not know or need that unit's rule; it stores the count the engine reports, in a header on its
 * answer, failed or not. An answer without one counts one unit per text.
 */
const UNITS_HEADER = "x-doedesk-engine-units";
const reportedUnits = (response: Response): number | undefined => {
  const value = Number(response.headers.get(UNITS_HEADER) ?? "");
  return response.headers.has(UNITS_HEADER) && Number.isInteger(value) && value >= 0 ? value : undefined;
};

/**
 * Whether the engine is ready for both detection and reading, for the health answer.
 * Never throws: an engine that cannot be asked is not ready.
 */
export const engineHealth = async (env: Env): Promise<{ readonly ready: boolean; readonly detail: string }> => {
  try {
    const response = await fetch(address(env, "/v1/health"), { headers: authorization(env), signal: AbortSignal.timeout(3_000) });
    const body = (await response.json().catch(() => null)) as Record<string, { ready?: unknown; state?: unknown } | undefined> | null;
    // `state`, when the engine gives one, is a short word of its own ("ready", "starting", "unavailable").
    const state = (name: string): string => {
      const given = body?.[name]?.state;
      return typeof given === "string" && /^[a-z][a-z ]{0,30}$/.test(given) ? given : body?.[name]?.ready === true ? "ready" : "not ready";
    };
    const part = (name: string): string => `${name} ${state(name)}`;
    return { ready: response.ok, detail: body === null ? `answered ${response.status}` : `${part("detection")}; ${part("reading")}` };
  } catch {
    return { ready: false, detail: "could not be reached" };
  }
};

/** A failed call, with the engine units it had used all the same: what the meter counts for it. */
export class EngineError extends ApiError {
  readonly units: number;
  constructor(status: number, code: string, message: string, units = 0, extra: Record<string, unknown> = {}) {
    super(status, code, message, extra);
    this.units = units;
  }
}

/** One call for all the texts. The answer has one result per text, in order. */
export const engineDetect = async (env: Env, texts: ReadonlyArray<string>) => {
  if (!engineConfigured(env)) {
    console.error("engine_not_configured detect");
    throw new EngineError(502, "detector_failed", "The detection engine is not available.");
  }
  let response: Response;
  try {
    response = await fetch(address(env, "/v1/detect"), {
      method: "POST",
      headers: { "content-type": "application/json", ...authorization(env) },
      body: JSON.stringify({ texts }),
      signal: AbortSignal.timeout(DETECT_TIMEOUT_MS),
    });
  } catch (cause) {
    if (cause instanceof Error && cause.name === "TimeoutError") {
      throw new EngineError(504, "detector_timeout", "Checking the text took too long.");
    }
    console.error("engine_unreachable detect");
    throw new EngineError(502, "detector_failed", "The detection engine could not be reached.");
  }
  const body = (await response.json().catch(() => null)) as { results?: unknown } | null;
  if (response.status === 503) {
    if (errorCode(body) === "unavailable") {
      console.error("engine_unavailable detect");
      throw new EngineError(502, "detector_failed", "The detection engine is not available.", reportedUnits(response) ?? 0);
    }
    throw new EngineError(503, "detector_busy", "The detection engine is busy. Try again in a moment.", reportedUnits(response) ?? 0, {
      retryAfterSeconds: retryAfter(response),
    });
  }
  if (response.status === 504) throw new EngineError(504, "detector_timeout", "Checking the text took too long.", reportedUnits(response) ?? 0);
  if (!response.ok) throw new EngineError(502, "detector_failed", `The detection engine answered ${response.status}.`, reportedUnits(response) ?? 0);
  const results = body?.results;
  if (!Array.isArray(results) || results.length !== texts.length) {
    throw new EngineError(502, "detector_failed", "The detection engine skipped one of the texts.", reportedUnits(response) ?? 0);
  }
  return {
    results: results.map((result: { entities?: unknown } | null, index) => {
      const length = texts[index]?.length ?? 0;
      const entities: Array<{ start: number; end: number; kind: EngineKind }> = [];
      for (const entity of Array.isArray(result?.entities) ? (result.entities as ReadonlyArray<Record<string, unknown>>) : []) {
        const { start, end, kind } = entity ?? {};
        if (typeof start !== "number" || typeof end !== "number" || !Number.isInteger(start) || !Number.isInteger(end)) continue;
        if (start < 0 || end > length || start >= end) continue;
        entities.push({ start, end, kind: typeof kind === "string" && KINDS.has(kind) ? (kind as EngineKind) : "OTHER" });
      }
      return { entities };
    }),
    // The units the engine reports; when it reports none, one per text.
    units: reportedUnits(response) ?? texts.length,
  };
};

/**
 * Where each word of a read file is, in this service's own format: the engine answers in it and the app reads it (its
 * `packages/privacy-gateway/src/redaction/layout.ts`):
 *
 *   { "pages": [{ "page", "width", "height", "unit", "angle", "words": [...], "lines": [...] }],
 *     "handwritten": [{ "offset", "length", "confidence" }] }
 *
 * Each word has its text, its four corners on the page, the engine's confidence in it, and its
 * `offset` and `length` in the answer's text. The service passes it on as the engine gave it,
 * neither changed nor repaired: the app checks every word against the text, and does not send an
 * image whose words do not add up. Here only its outline is checked.
 */
export type EngineLayout = { readonly pages: ReadonlyArray<unknown> } & Readonly<Record<string, unknown>>;

const layoutIn = (value: unknown): EngineLayout | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Array.isArray((value as { pages?: unknown }).pages) ? (value as EngineLayout) : undefined;

/**
 * The text of one file, and the pages read. A service that gives no page count is taken as one page.
 * With `withLayout`, the engine is asked where each word is too; `layout` is absent when it cannot say.
 */
export const engineRead = async (
  env: Env,
  bytes: ArrayBuffer,
  contentType: string,
  withLayout = false,
): Promise<{ readonly text: string; readonly pages: number; readonly layout?: EngineLayout | undefined }> => {
  if (!engineConfigured(env)) {
    console.error("engine_not_configured read");
    throw new ApiError(502, "reader_failed", "The document reader is not available.");
  }
  let response: Response;
  try {
    response = await fetch(address(env, withLayout ? "/v1/ocr?layout=1" : "/v1/ocr"), {
      method: "POST",
      headers: { "content-type": contentType, ...authorization(env) },
      body: bytes,
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
  } catch (cause) {
    if (cause instanceof Error && cause.name === "TimeoutError") {
      throw new ApiError(504, "reader_timeout", "Reading the document took too long.");
    }
    console.error("engine_unreachable read");
    throw new ApiError(502, "reader_failed", "The document reader could not be reached.");
  }
  const body = (await response.json().catch(() => null)) as {
    text?: unknown;
    pages?: unknown;
    layout?: unknown;
  } | null;
  if (response.ok && typeof body?.text === "string") {
    const pages = typeof body.pages === "number" && Number.isInteger(body.pages) && body.pages > 0 ? body.pages : 1;
    const layout = withLayout ? layoutIn(body.layout) : undefined;
    return { text: body.text, pages, ...(layout === undefined ? {} : { layout }) };
  }
  // The engine looked at the file and could not read it: the person's file is the problem, not us.
  // The message is ours: the engine's own wording is not passed on.
  if (response.status === 400 || response.status === 415 || response.status === 422) {
    throw new ApiError(422, "unreadable", "The document could not be read.");
  }
  if (response.status === 413) throw new ApiError(413, "too_large", "Send one image or PDF of at most 20 MB.");
  if (response.status === 504) throw new ApiError(504, "reader_timeout", "Reading the document took too long.");
  if (response.status === 503) {
    if (errorCode(body) === "unavailable") {
      console.error("engine_unavailable read");
      throw new ApiError(502, "reader_failed", "The document reader is not available.");
    }
    throw new ApiError(503, "reader_busy", "The document reader is busy. Try again in a moment.", { retryAfterSeconds: retryAfter(response) });
  }
  throw new ApiError(502, "reader_failed", `The document reader answered ${response.status}.`);
};
