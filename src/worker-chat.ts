// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Accelerate Technology Establishment
/**
 * The worker: a small model that reads sealed documents for the app. A sealed document is one the
 * person has said must never reach their AI company; the app asks the worker about it instead and
 * passes on only the worker's answers. People can run a worker themselves. This is the one DoeDesk
 * Cloud offers. ("Worker" here is that model, not the Cloudflare Worker this code can also run as.)
 *
 *   POST /v1/worker/chat/completions
 *
 * The worker is offered to organizations under an agreement. An account it is not switched on for
 * (extension.ts, `workerDecision`) is answered 403 `worker_not_included`, whatever else is true of the request.
 *
 * The request goes to one upstream: the one for the account's region (worker-regions.ts), and
 * never another. A region whose upstream has no key, fails or is busy is answered for as such;
 * nothing is tried elsewhere. The caller does not name the region and cannot: it is read from
 * the account.
 *
 * A subset of the Chat Completions format is passed on:
 *
 *   taken       messages, each `{ role, content }` with both as text; temperature,
 *               max_completion_tokens, max_tokens, response_format, reasoning_effort
 *   replaced    model: always the region's, whatever the caller names. reasoning_effort, when
 *               the region sets one. An output limit below the region's floor is raised to it.
 *   added       `provider`, where the region has one: for OpenRouter, the request that only hosts
 *               which neither train on nor keep what they are sent may serve it
 *   refused     stream: true, and tools in any form (tools, tool_choice, functions, function_call,
 *               a message from a tool). The worker reads and answers; it must not be able to act.
 *   dropped     every other field, in the request and in each message
 *
 * Requests wait their turn in a queue per region (worker-queue.ts): the upstream account takes
 * only so many at once and so many a minute, and a request it refuses still uses up the minute.
 * Accounts take turns, so one person's folder does not hold up another's question. A request
 * that cannot be sent within the region's wait is answered 429 `worker_busy` with how many are
 * waiting. It is not sent to another region.
 *
 * A region whose upstream must host its model in a named place (Saudi Arabia, for `sa`) is
 * served only while the upstream's own list of models says so (worker-regions.ts).
 *
 * The answer is the upstream's own, byte for byte, with the region that answered
 * (`x-doedesk-worker-region`) so the app can show the person which it was, how long the request
 * waited for its turn (`x-doedesk-worker-queued-ms`) and how many are waiting now
 * (`x-doedesk-worker-waiting`).
 *
 * This server receives the sealed document's text in each request and passes it on. Nothing sent
 * and nothing answered is stored or logged: only counts, per account and day (usage.ts). Nothing
 * that names the account is sent to the upstream. An error message of ours never repeats the
 * request or the upstream's answer. A request the upstream refuses (400, 413, 422) is answered
 * with that status as `worker_rejected`, so the app does not try it again. One refusal is
 * different: the model failing to fit its own answer to the format asked for
 * (`json_validate_failed`), which happens on one identical call in several. The app asks again
 * at once when it sees that code, so the code is passed on, and only the code.
 */
import { requireAccepted } from "./acceptance.ts";
import { authenticate } from "./accounts.ts";
import { ApiError, CORS_HEADERS, type Env, json } from "./http.ts";
import { meter, meterQuietly, MONTHLY_WORKER_INPUT_TOKENS, quotaExceeded, readUsage } from "./usage.ts";
import { extension, workerDecision } from "./extension.ts";
import { forgetHosting, hostingConfirmed, noteLatency, queueFor, recordCheckDue, servedWhereRequired, type WorkerUpstream, workerNotIncluded, workerUpstream } from "./worker-regions.ts";

const MAX_BODY_BYTES = 2_000_000;
/** The worker may think for a while about a long document. The server's own stop waits longer (130 s). */
const TIMEOUT_MS = 120_000;
/** On every answer passed on: the account region whose upstream gave it. */
export const REGION_HEADER = "x-doedesk-worker-region";
/** On every answer passed on: the milliseconds the request waited for its turn, and how many wait now. */
const QUEUED_HEADER = "x-doedesk-worker-queued-ms";
const WAITING_HEADER = "x-doedesk-worker-waiting";
/** A request the upstream refused although it was sent in turn is sent again this many times at most. */
const MAX_RESENDS = 2;

const FORWARDED = ["temperature", "max_completion_tokens", "max_tokens", "response_format", "reasoning_effort"] as const;
const TOOL_FIELDS = ["tools", "tool_choice", "functions", "function_call"] as const;
const TOOL_ROLES = new Set(["tool", "function"]);

const NO_TOOLS = "The worker takes no tools. Send the request without tools, tool_choice, functions or function_call.";

const tooLarge = (): ApiError => new ApiError(413, "too_large", `Send a request of at most ${MAX_BODY_BYTES.toLocaleString("en-US")} bytes.`);

const OUTPUT_LIMITS = ["max_completion_tokens", "max_tokens"] as const;

/** What is sent on: the region's model, the messages as role and content, and the few settings taken. */
const outgoing = (body: unknown, upstream: WorkerUpstream): Record<string, unknown> => {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(400, "invalid_request", "Send a JSON object with messages.");
  }
  const given = body as Record<string, unknown>;
  if (given.stream === true) throw new ApiError(400, "invalid_request", "The worker does not stream. Send the request without stream.");
  if (TOOL_FIELDS.some((field) => given[field] !== undefined && given[field] !== null)) throw new ApiError(400, "invalid_request", NO_TOOLS);
  const messages = given.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ApiError(400, "invalid_request", "Send messages: a list with at least one { role, content }.");
  }
  const sent = messages.map((message: unknown) => {
    const { role, content } = (message !== null && typeof message === "object" ? message : {}) as { role?: unknown; content?: unknown };
    if (typeof role !== "string" || typeof content !== "string") {
      throw new ApiError(400, "invalid_request", "Each message needs a role and a content, both as text.");
    }
    if (TOOL_ROLES.has(role)) throw new ApiError(400, "invalid_request", NO_TOOLS);
    return { role, content };
  });
  const request: Record<string, unknown> = { model: upstream.model, messages: sent };
  for (const field of FORWARDED) if (given[field] !== undefined) request[field] = given[field];
  if (upstream.reasoningEffort !== null) request.reasoning_effort = upstream.reasoningEffort;
  // Some models spend the limit on thinking and are cut off before the answer; the region knows its model.
  const limits = OUTPUT_LIMITS.filter((field) => typeof request[field] === "number");
  for (const field of limits) request[field] = Math.max(request[field] as number, upstream.minOutputTokens);
  if (limits.length === 0) request.max_completion_tokens = upstream.minOutputTokens;
  if (upstream.provider !== null) request.provider = upstream.provider;
  return request;
};

/** A token count as the worker reports it; anything that is not a count is none. */
const tokens = (value: unknown): number => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0);

export const workerChat = async (request: Request, env: Env): Promise<Response> => {
  const account = await authenticate(request, env);
  // First of all: an account the worker is not included for is refused before its request is
  // read, and before anything says whether its region has a worker. Nothing is counted.
  const decision = await workerDecision(env, account);
  if (!decision.included) throw decision.refusal ?? workerNotIncluded();
  await requireAccepted(env, account.userId);
  // The account's region and no other: a region without a worker is not answered for by another.
  // An account with an upstream of its own (src/extension.ts) is held to that one the same way.
  const upstream = decision.upstream === undefined ? workerUpstream(env, account.region) : decision.upstream;
  if (upstream === null) {
    console.error("worker_not_configured", account.region);
    throw new ApiError(503, "worker_unavailable", "DoeDesk Cloud's worker is not available in your region yet. Sealed files are not sent to another region. Connect your own server to read them.", { region: account.region, offered: false });
  }
  // The upstream's own word that the model is hosted where this region requires. Without it the
  // region is not served, by this upstream or by any other.
  if (!(await hostingConfirmed(upstream))) {
    throw new ApiError(503, "worker_unavailable", "The worker for your region is not available. DoeDesk does not route sealed files to another region.", { region: account.region });
  }
  const who = { userId: account.userId, client: account.client };
  // How many tokens a request holds is known only from the worker's answer, so the request that
  // crosses the allowance is answered and the next one is refused, as with pages.
  // An allowance that is not the account's own is answered for by the layer that holds it.
  const shared = await extension().allowance?.(env, account, "worker");
  if (shared?.refusal !== undefined) {
    await meterQuietly(env, who, { worker_refused: 1 });
    throw shared.refusal;
  }
  if (shared === null || shared === undefined) {
    const usage = await readUsage(env, account.userId);
    if (usage.workerInputTokens >= MONTHLY_WORKER_INPUT_TOKENS) {
      await meterQuietly(env, who, { worker_refused: 1 });
      throw quotaExceeded();
    }
  }

  // Read whole and then measured, as a file for reading is: a caller that is still sending gets
  // its answer, and the server in front takes no body larger than a document anyway.
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAX_BODY_BYTES) {
    await meterQuietly(env, who, { worker_too_large: 1 });
    throw tooLarge();
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ApiError(400, "invalid_request", "Send a JSON object with messages.");
  }
  const sent = outgoing(body, upstream);

  const failed = async (message: string): Promise<never> => {
    await meterQuietly(env, who, { worker_failed: 1 });
    throw new ApiError(502, "worker_failed", message);
  };

  const queue = queueFor(upstream);
  const busy = async (waiting: number, retryAfterSeconds: number): Promise<Response> => {
    await meterQuietly(env, who, { worker_failed: 1 });
    const response = json(
      { error: { code: "worker_busy", message: "The worker for your region is busy. DoeDesk does not route sealed files to another region. Try again in a moment.", waiting, region: upstream.region } },
      429,
    );
    response.headers.set("retry-after", String(retryAfterSeconds));
    return response;
  };
  // Nobody is listening for an answer: nothing is counted, and the caller's place is given up.
  const gone = (): Response => new Response(null, { status: 499 });

  const deadlineAt = Date.now() + upstream.limits.maxWaitMs;
  let queuedMs = 0;
  let response: Response;
  let answer: ArrayBuffer;
  for (let sends = 0; ; sends += 1) {
    // A request the upstream refused in its turn goes first when it is sent again, within the same wait.
    const admission = await queue.enter(account.userId, { signal: request.signal, deadlineAt, front: sends > 0 });
    if (!admission.admitted) return admission.reason === "gone" ? gone() : busy(admission.waiting, admission.retryAfterSeconds);
    queuedMs += admission.waitedMs;
    const sentAt = Date.now();
    try {
      response = await fetch(`${upstream.url}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${upstream.apiKey}` },
        body: JSON.stringify(sent),
        signal: AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), request.signal]),
      });
      answer = await response.arrayBuffer();
      if (response.ok) noteLatency(upstream, Date.now() - sentAt);
    } catch (cause) {
      if (request.signal.aborted) return gone();
      if (cause instanceof Error && cause.name === "TimeoutError") return failed("The worker took too long to answer.");
      console.error("worker_unreachable");
      return failed("The worker could not be reached.");
    } finally {
      admission.release();
    }
    if (response.status !== 429) break;
    // The upstream refused it all the same: someone else is using the account, or its limits are
    // lower than the settings say. Nothing is sent to it until the time it names.
    const stated = Number(response.headers.get("retry-after"));
    const retryAfterSeconds = Number.isFinite(stated) && stated > 0 ? Math.ceil(stated) : 1;
    console.error("worker_upstream_refused", upstream.region);
    queue.blockFor(retryAfterSeconds * 1000);
    if (sends >= MAX_RESENDS || Date.now() + retryAfterSeconds * 1000 >= deadlineAt) return busy(queue.state().waiting + 1, retryAfterSeconds);
  }

  // A request the worker will not take is the caller's to change, not an outage to try again:
  // a document longer than the model reads, or an answer format it does not know.
  if (response.status === 400 || response.status === 413 || response.status === 422) {
    await meterQuietly(env, who, { worker_failed: 1 });
    // Only the code is read from the worker's refusal; its message can repeat the document.
    let code: unknown;
    try {
      code = (JSON.parse(new TextDecoder().decode(answer)) as { error?: { code?: unknown } } | null)?.error?.code;
    } catch {
      code = undefined;
    }
    if (response.status === 400 && code === "json_validate_failed") {
      throw new ApiError(400, "json_validate_failed", "The worker could not fit its answer to the format asked for. The same request may work if sent again.");
    }
    throw new ApiError(response.status, "worker_rejected", "The worker did not take this request. The document may be too long for it.");
  }
  if (!response.ok) {
    console.error("worker_answered", response.status);
    return failed(`The worker answered ${response.status}.`);
  }
  let completion: { id?: unknown; provider?: unknown; model?: unknown; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } | null } | null = null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(answer)) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) completion = parsed;
  } catch {
    completion = null;
  }
  if (completion === null) return failed("The worker's answer could not be read.");

  // An upstream that routes among hosts names the one that served the answer. Counted when it is
  // not the one this region expects; the answer is passed on either way, since it was already given.
  const servedBy = typeof completion.provider === "string" ? completion.provider.trim().toLowerCase() : null;
  // Where the model's place is required, an answer that names another model than the one asked
  // for is counted too, and the upstream's list is read again before the next request is sent.
  const otherModel = upstream.hostedIn !== null && typeof completion.model === "string" && completion.model !== upstream.model;
  if (otherModel) forgetHosting(upstream.region);
  const offRegion = otherModel || (upstream.expectedProvider !== null && servedBy !== null && servedBy !== upstream.expectedProvider.toLowerCase());
  if (offRegion) console.error("worker_off_region", upstream.region);
  // Where the upstream keeps a record of each call, one answer a minute is held to it as well:
  // the record names the data region, which the answer does not. It is read after the answer has
  // gone, so nobody waits for it, and a record that names another place is counted like the rest.
  const generationId = response.headers.get("x-generation-id") ?? (typeof completion.id === "string" ? completion.id : null);
  if (!offRegion && generationId !== null && recordCheckDue(upstream)) {
    void servedWhereRequired(upstream, generationId).then(async (asRequired) => {
      if (asRequired === true) return;
      console.error(asRequired === null ? "worker_record_unread" : "worker_off_region", upstream.region);
      if (asRequired === false) await meterQuietly(env, who, { worker_off_region: 1 });
    });
  }

  await meter(env, who, {
    worker_requests: 1,
    worker_input_tokens: tokens(completion.usage?.prompt_tokens),
    worker_output_tokens: tokens(completion.usage?.completion_tokens),
    worker_off_region: offRegion ? 1 : 0,
  });
  return new Response(answer, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...CORS_HEADERS,
      // A browser lets a page on another origin read only the headers named here.
      "access-control-expose-headers": [REGION_HEADER, QUEUED_HEADER, WAITING_HEADER].join(", "),
      [REGION_HEADER]: upstream.region,
      [QUEUED_HEADER]: String(Math.round(queuedMs)),
      [WAITING_HEADER]: String(queue.state().waiting),
    },
  });
};
