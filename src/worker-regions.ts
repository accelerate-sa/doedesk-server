// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Accelerate Technology Establishment
/**
 * Where the worker for an account's sealed documents runs. An account has one region, and the
 * region names one upstream: the server that the worker's requests are passed to.
 *
 *   sa       deep.sa, in Saudi Arabia according to deep.sa: Qwen3.8 27B
 *   eu       none. A hosted worker is not offered in this region yet
 *   global   OpenRouter's global endpoint, with no region restriction: Inkling 2 mini
 *
 * The worker is an open-weight model, in every region: one whose weights the customer, or DoeDesk,
 * can run on hardware under their own control. Sealing exists so that a file does not go to an AI
 * company's model, and a closed model can be run nowhere but at its maker's. Only the two models
 * the evaluation measured can be configured (OPEN_WEIGHT_WORKER_MODELS); the server refuses to
 * start with any other, and a region set to one has no worker.
 *
 * Each region's model and how it is asked are the ones the evaluation measured (Round 5,
 * 24 November 2026); the defaults below say which and why. No host in the EU serves either model
 * where the region requires, so the EU has no default: with no address and model set beside its
 * key it has no worker, and its accounts are told so. No other region answers for it.
 *
 * The region decides only that upstream. Accounts, detection, reading and this relay run on the
 * one DoeDesk Cloud server whichever region an account has.
 *
 * A region is never answered by another region's upstream. One without a key answers that the
 * worker is not available (worker-chat.ts): there is no fallback in this file or anywhere else.
 *
 * Each region's upstream is plain settings, named `WORKER_<REGION>_<SETTING>` with the region in
 * capitals (`WORKER_SA_API_KEY`, `WORKER_EU_MODEL`, ...):
 *
 *   API_KEY             sent to the upstream as a bearer token. Unset: the region has no worker.
 *   URL                 the API root; `/chat/completions` is added. Unset: the default below.
 *   MODEL               the one model every request is sent to. Unset: the default below. It
 *                       must be one of the open-weight models named above.
 *   STRUCTURED          how the app should ask this model for JSON: jsonSchema, jsonObject or none.
 *                       Told to the app with the account. Unset: the default below.
 *   REASONING_EFFORT    sent as `reasoning_effort` in place of whatever the caller sent. Unset:
 *                       the default below. "caller": the caller's is passed on.
 *   MIN_OUTPUT_TOKENS   the caller's output limit is raised to this when it is lower. Unset: 4000.
 *   PROVIDER            a JSON object sent as `provider`, which is how OpenRouter is told which
 *                       hosts may serve a request and what they may keep. Unset: the default
 *                       below. "none": nothing is sent.
 *   EXPECTED_PROVIDER   the name the upstream's answer gives in `provider` when it was served
 *                       where it should be. An answer that names another is counted
 *                       (`worker_off_region`). Unset: the default below. "any": not checked.
 *   EXPECTED_DATA_REGION  what OpenRouter's own record of a call (`GET <URL>/generation`) must
 *                       say in `data_region`. Read for one answer a minute; a record that says
 *                       another region or another provider is counted the same way. Unset: the
 *                       default below. "any": not checked.
 *   PARALLEL            requests in flight at once, for all accounts together (worker-queue.ts).
 *                       Set it to what the upstream account allows. Unset: the default below.
 *   PER_MINUTE          requests sent in a clock minute, answered or not. Set it a little under
 *                       what the upstream account allows. 0: no limit. Unset: the default below.
 *   MAX_WAIT_SECONDS    how long a request waits for its turn before it is answered as busy.
 *                       Unset: 20. With the two minutes an upstream may take, it must stay under
 *                       the 150 seconds the server in front waits for an answer.
 *   MAX_WAITING         requests that may wait at once. Unset: 200.
 *   HOSTED_IN           what the upstream's own list of models (`GET <URL>/models`) must say of
 *                       this model in `hosted_in` for the region to be served at all. Unset: the
 *                       default below. "any": not checked.
 */
import { ApiError, type Env } from "./http.ts";
import { type QueueLimits, WorkerQueue } from "./worker-queue.ts";

export const ACCOUNT_REGIONS = ["sa", "eu", "global"] as const;
export type AccountRegion = (typeof ACCOUNT_REGIONS)[number];

/** A region as a caller or a row names it. Null: it is not one. */
export const accountRegion = (value: unknown): AccountRegion | null =>
  ACCOUNT_REGIONS.includes(value as AccountRegion) ? (value as AccountRegion) : null;

const WORKER_SETTINGS = [
  "API_KEY",
  "URL",
  "MODEL",
  "STRUCTURED",
  "REASONING_EFFORT",
  "MIN_OUTPUT_TOKENS",
  "PROVIDER",
  "EXPECTED_PROVIDER",
  "EXPECTED_DATA_REGION",
  "PARALLEL",
  "PER_MINUTE",
  "MAX_WAIT_SECONDS",
  "MAX_WAITING",
  "HOSTED_IN",
] as const;
type WorkerSetting = (typeof WORKER_SETTINGS)[number];
type RegionCode = Uppercase<AccountRegion>;
export type WorkerSettingName = `WORKER_${RegionCode}_${WorkerSetting}`;
export type WorkerRegionEnv = { readonly [Name in WorkerSettingName]?: string };

/** Every setting of every region, for the server to hand to the handlers (server/config.ts). */
export const WORKER_SETTING_NAMES: ReadonlyArray<WorkerSettingName> = ACCOUNT_REGIONS.flatMap((region) =>
  WORKER_SETTINGS.map((setting): WorkerSettingName => `WORKER_${region.toUpperCase() as RegionCode}_${setting}`),
);

export const STRUCTURED_OUTPUTS = ["jsonSchema", "jsonObject", "none"] as const;
export type StructuredOutput = (typeof STRUCTURED_OUTPUTS)[number];

/** Asks OpenRouter to route only to hosts that neither train on nor keep what they are sent. */
const NO_RETENTION = { data_collection: "deny", zdr: true };

/**
 * The models a worker may be: open weights, and measured by the evaluation. A host names a model
 * in its own way (`qwen/qwen3.8-27b`, `Qwen/Qwen3.8-27B`, a suffix for a variant), so each is
 * matched by its family's name inside the identifier.
 */
export const OPEN_WEIGHT_WORKER_MODELS: ReadonlyArray<{ readonly family: string; readonly matches: RegExp }> = [
  { family: "Qwen3.8 27B", matches: /(^|[/:_-])qwen3\.8-27b($|[:_-])/i },
  { family: "Inkling 2 mini", matches: /(^|[/:_-])inkling-2-mini($|[:_-])/i },
];

/** Whether a model may be a worker: for a region here, and for any upstream a layer adds. */
export const isOpenWeightWorkerModel = (model: string): boolean => OPEN_WEIGHT_WORKER_MODELS.some((allowed) => allowed.matches.test(model.trim()));

/** What is wrong with a model that is not one of them, in words for whoever set it. */
export const notOpenWeight = (model: string): string =>
  `"${model}" is not an open-weight model the evaluation measured. A worker is ${OPEN_WEIGHT_WORKER_MODELS.map((allowed) => allowed.family).join(" or ")}`;

interface RegionDefaults {
  /** Null: the region has no upstream of its own until an address and a model are set for it. */
  readonly url: string | null;
  readonly model: string | null;
  /** How the app asks this model for JSON, and the reasoning setting it was measured with. */
  readonly structured: StructuredOutput;
  readonly reasoningEffort: string | null;
  readonly provider: Readonly<Record<string, unknown>> | null;
  /** Who the answer must name in `provider`, and the record's `data_region`. Null: not checked. */
  readonly expectedProvider: string | null;
  readonly expectedDataRegion: string | null;
  /** Who runs the upstream, and where, for the app to show. Null: nobody is named. */
  readonly hostLabel: string | null;
  readonly locationLabel: string | null;
  /** What the upstream account allows: requests at once, and in a clock minute (0: no limit). */
  readonly parallel: number;
  readonly perMinute: number;
  /** What the upstream's model list must say of the model in `hosted_in`. Null: not checked. */
  readonly hostedIn: string | null;
}

export const WORKER_REGION_DEFAULTS: Readonly<Record<AccountRegion, RegionDefaults>> = {
  sa: {
    url: "https://alapi.deep.sa/v1",
    model: "qwen/qwen3.8-27b",
    // deep.sa refuses one strict-schema call in five (`json_validate_failed`). Asked for a JSON
    // object none was refused, and the model scored 1,496 of 1,496; the app checks every answer.
    structured: "jsonObject",
    reasoningEffort: "none",
    provider: null,
    // A reply of deep.sa's names no host and no place; its model list is what is checked (hostedIn).
    expectedProvider: null,
    expectedDataRegion: null,
    hostLabel: "deep.sa",
    // deep.sa's statement. The city and the operator of the hardware are not confirmed.
    locationLabel: "Saudi Arabia, according to deep.sa",
    // deep.sa's smallest plan: one request at a time and 60 a minute for the whole account.
    parallel: 1,
    perMinute: 55,
    // The same key can call models deep.sa hosts elsewhere. This region may only use one it lists as Saudi.
    hostedIn: "saudi",
  },
  // Not offered yet: no host in the EU serves either measured model, and a closed model is not
  // a worker. With no address and model set, the region has no worker and names no host.
  eu: {
    url: null,
    model: null,
    // A JSON object is what every host takes; a strict schema is for a host measured with one.
    structured: "jsonObject",
    reasoningEffort: "none",
    provider: null,
    expectedProvider: null,
    expectedDataRegion: null,
    hostLabel: null,
    locationLabel: null,
    parallel: 16,
    perMinute: 0,
    hostedIn: null,
  },
  global: {
    url: "https://openrouter.ai/api/v1",
    model: "thinkingmachines/inkling-2-mini",
    structured: "jsonSchema",
    reasoningEffort: "none",
    provider: NO_RETENTION,
    expectedProvider: null,
    expectedDataRegion: null,
    hostLabel: "OpenRouter",
    locationLabel: "No region restriction",
    parallel: 16,
    perMinute: 0,
    hostedIn: null,
  },
};

export const DEFAULT_MIN_OUTPUT_TOKENS = 4000;
const DEFAULT_MAX_WAIT_SECONDS = 20;
const DEFAULT_MAX_WAITING = 200;

export interface WorkerUpstream {
  readonly region: AccountRegion;
  readonly url: string;
  readonly apiKey: string;
  readonly model: string;
  readonly structured: StructuredOutput;
  readonly reasoningEffort: string | null;
  readonly minOutputTokens: number;
  readonly provider: Readonly<Record<string, unknown>> | null;
  readonly expectedProvider: string | null;
  readonly expectedDataRegion: string | null;
  readonly limits: QueueLimits;
  readonly hostedIn: string | null;
  /**
   * Set on an upstream that is not the region's own (src/extension.ts): it has a queue to itself
   * under this name, and the app is told who runs it and where in these words.
   */
  readonly pool?: { readonly id: string; readonly hostLabel: string; readonly locationLabel: string };
}

const read = (env: WorkerRegionEnv, region: AccountRegion, setting: WorkerSetting): string =>
  (env[`WORKER_${region.toUpperCase() as RegionCode}_${setting}`] ?? "").trim();

/** A whole number setting at least `minimum`, or the fallback when it is unset or not one. */
const count = (text: string, fallback: number, minimum: number): number => {
  const value = Number(text);
  return text !== "" && Number.isInteger(value) && value >= minimum ? value : fallback;
};

const providerOf = (text: string, fallback: RegionDefaults["provider"]): WorkerUpstream["provider"] => {
  if (text === "") return fallback;
  if (text === "none") return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // Refused when the server starts (workerSettingProblems); here the default stands.
  }
  return fallback;
};

/**
 * The upstream for one region, from its settings alone. Null: the region has no worker. It has
 * no key, or no address or model (the EU, until both are set), or a model that is not an
 * open-weight one.
 */
export const workerUpstream = (env: WorkerRegionEnv, region: AccountRegion): WorkerUpstream | null => {
  const apiKey = read(env, region, "API_KEY");
  if (apiKey === "") return null;
  const url = read(env, region, "URL") || WORKER_REGION_DEFAULTS[region].url;
  const model = read(env, region, "MODEL") || WORKER_REGION_DEFAULTS[region].model;
  if (url === null || model === null || !isOpenWeightWorkerModel(model)) return null;
  const defaults = WORKER_REGION_DEFAULTS[region];
  const structured = read(env, region, "STRUCTURED");
  const reasoningEffort = read(env, region, "REASONING_EFFORT");
  /** A check's setting: unset is the region's default, "any" switches the check off. */
  const expected = (setting: WorkerSetting, fallback: string | null): string | null => {
    const value = read(env, region, setting);
    return value === "any" ? null : value === "" ? fallback : value;
  };
  return {
    region,
    url: url.replace(/\/+$/, ""),
    apiKey,
    model,
    structured: STRUCTURED_OUTPUTS.find((candidate) => candidate === structured) ?? defaults.structured,
    reasoningEffort: reasoningEffort === "caller" ? null : reasoningEffort || defaults.reasoningEffort,
    minOutputTokens: count(read(env, region, "MIN_OUTPUT_TOKENS"), DEFAULT_MIN_OUTPUT_TOKENS, 1),
    provider: providerOf(read(env, region, "PROVIDER"), defaults.provider),
    expectedProvider: expected("EXPECTED_PROVIDER", defaults.expectedProvider),
    expectedDataRegion: expected("EXPECTED_DATA_REGION", defaults.expectedDataRegion),
    limits: {
      parallel: count(read(env, region, "PARALLEL"), defaults.parallel, 1),
      perMinute: count(read(env, region, "PER_MINUTE"), defaults.perMinute, 0),
      maxWaitMs: count(read(env, region, "MAX_WAIT_SECONDS"), DEFAULT_MAX_WAIT_SECONDS, 1) * 1000,
      maxWaiting: count(read(env, region, "MAX_WAITING"), DEFAULT_MAX_WAITING, 0),
    },
    hostedIn: expected("HOSTED_IN", defaults.hostedIn),
  };
};

// One queue per upstream, for this process: each region's own, and each named upstream beside
// them. None borrows another's.
const queues = new Map<string, WorkerQueue>();
const queueName = (upstream: WorkerUpstream): string => (upstream.pool === undefined ? upstream.region : `pool:${upstream.pool.id}`);

/** The queue in front of this upstream, with its limits as the settings give them now. */
export const queueFor = (upstream: WorkerUpstream): WorkerQueue => {
  const name = queueName(upstream);
  let queue = queues.get(name);
  if (queue === undefined) {
    queue = new WorkerQueue(upstream.limits);
    queues.set(name, queue);
  }
  queue.limits = upstream.limits;
  return queue;
};

/** How long the last answered calls of each upstream took, for whoever shows its capacity. */
const LATENCIES_KEPT = 200;
const latencies = new Map<string, Array<number>>();

export const noteLatency = (upstream: WorkerUpstream, ms: number): void => {
  const name = queueName(upstream);
  const kept = latencies.get(name) ?? [];
  kept.push(Math.round(ms));
  if (kept.length > LATENCIES_KEPT) kept.shift();
  latencies.set(name, kept);
};

/** The median and the 95th percentile of those calls, in milliseconds. Null before the first. */
export const latencyOf = (upstream: WorkerUpstream): { readonly p50Ms: number | null; readonly p95Ms: number | null } => {
  const sorted = [...(latencies.get(queueName(upstream)) ?? [])].sort((left, right) => left - right);
  const at = (share: number): number | null => sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))] ?? null;
  return { p50Ms: at(0.5), p95Ms: at(0.95) };
};

// -----------------------------------------------------------------------------------------------
// Where the upstream says the model is hosted
//
// deep.sa's key also reaches models it hosts outside the Kingdom, and it has pointed retired model
// names at other models. The Saudi region is served only while deep.sa's own list says the
// configured model is hosted in Saudi Arabia. That is deep.sa's statement, read by this server;
// it is not a measurement of where the hardware is.

const HOSTING_CHECK_EVERY_MS = 10 * 60_000;
/** A list that cannot be read is no reason to stop serving a region that was confirmed this recently. */
const HOSTING_TRUSTED_FOR_MS = 60 * 60_000;

interface HostingState {
  readonly key: string;
  readonly ok: boolean;
  /** When the list was last read, and when it last confirmed the model. */
  readonly checkedAt: number;
  readonly confirmedAt: number | null;
}
const hosting = new Map<AccountRegion, HostingState>();

/** After an answer that names another model than the one configured: the list is read again before the next request. */
export const forgetHosting = (region: AccountRegion): void => {
  hosting.delete(region);
};

/**
 * Whether this region may be served: always when nothing is required of its upstream, otherwise
 * only while the upstream's model list says the configured model is hosted where it must be.
 */
export const hostingConfirmed = async (upstream: WorkerUpstream, now: number = Date.now()): Promise<boolean> => {
  if (upstream.hostedIn === null) return true;
  const key = `${upstream.url}\n${upstream.model}\n${upstream.hostedIn}`;
  const known = hosting.get(upstream.region);
  if (known !== undefined && known.key === key && now - known.checkedAt < HOSTING_CHECK_EVERY_MS) return known.ok;
  let listed: string | null | undefined;
  try {
    const response = await fetch(`${upstream.url}/models`, { headers: { authorization: `Bearer ${upstream.apiKey}` }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(String(response.status));
    const body = (await response.json()) as { data?: unknown } | null;
    const models = Array.isArray(body?.data) ? (body.data as Array<{ id?: unknown; hosted_in?: unknown } | null>) : [];
    const model = models.find((entry) => entry?.id === upstream.model);
    // Not listed, or listed without the mark: not confirmed.
    listed = model === undefined ? null : typeof model?.hosted_in === "string" ? model.hosted_in : null;
  } catch {
    listed = undefined;
  }
  if (listed === undefined) {
    // The list could not be read. A confirmation from within the hour still stands; nothing older does.
    const confirmedAt = known !== undefined && known.key === key ? known.confirmedAt : null;
    const ok = confirmedAt !== null && now - confirmedAt < HOSTING_TRUSTED_FOR_MS;
    console.error("worker_hosting_unreadable", upstream.region);
    hosting.set(upstream.region, { key, ok, checkedAt: now, confirmedAt });
    return ok;
  }
  const ok = listed !== null && listed.toLowerCase() === upstream.hostedIn.toLowerCase();
  if (!ok) console.error("worker_hosting_not_confirmed", upstream.region);
  hosting.set(upstream.region, { key, ok, checkedAt: now, confirmedAt: ok ? now : null });
  return ok;
};

// -----------------------------------------------------------------------------------------------
// Where OpenRouter says an answer was served
//
// An answer names the host that served it (`provider`) and not where. OpenRouter's own record of
// the call names both (`provider_name`, `data_region`), so it is read for one answer a minute per
// region. Like the model list above, it is the upstream's statement and not a measurement.

const RECORD_CHECK_EVERY_MS = 60_000;
/** The record of a call is written some seconds after its answer (about ten, measured): three tries. */
const RECORD_WAITS_MS = [2000, 6000, 15_000];
const recordCheckedAt = new Map<AccountRegion, number>();

/** Whether this answer is the one whose record is read: the first, then one a minute. */
export const recordCheckDue = (upstream: WorkerUpstream, now: number = Date.now()): boolean => {
  if (upstream.expectedDataRegion === null) return false;
  const last = recordCheckedAt.get(upstream.region);
  if (last !== undefined && now - last < RECORD_CHECK_EVERY_MS) return false;
  recordCheckedAt.set(upstream.region, now);
  return true;
};

/**
 * What the upstream's record of one call says: true when it names the data region (and the
 * provider, when one is expected) this region requires, false when it names another, null when
 * the record could not be read.
 */
export const servedWhereRequired = async (upstream: WorkerUpstream, generationId: string, waits: ReadonlyArray<number> = RECORD_WAITS_MS): Promise<boolean | null> => {
  for (const wait of waits) {
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    try {
      const response = await fetch(`${upstream.url}/generation?id=${encodeURIComponent(generationId)}`, {
        headers: { authorization: `Bearer ${upstream.apiKey}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) continue;
      const record = ((await response.json()) as { data?: { provider_name?: unknown; data_region?: unknown } | null } | null)?.data;
      if (typeof record?.data_region !== "string") continue;
      const same = (said: unknown, required: string | null) => required === null || (typeof said === "string" && said.trim().toLowerCase() === required.toLowerCase());
      return same(record.data_region, upstream.expectedDataRegion) && same(record.provider_name, upstream.expectedProvider);
    } catch {
      // Asked again below; a record that never comes is reported as unread.
    }
  }
  return null;
};

/** What an account without the worker is told, by the worker and by the change of region. */
export const workerNotIncluded = (): ApiError =>
  new ApiError(
    403,
    "worker_not_included",
    "DoeDesk Cloud's worker for sealed files is offered to organizations under an agreement and is not included in this account. Connect your own server to read sealed files, or write to hello@doedesk.com.",
  );

/**
 * What the app is told about the worker for an account's region. Never the address or the key.
 * An account the worker is not included for (extension.ts, `workerDecision`) is told that and
 * nothing else of it: not the model, the host or the queue.
 */
export const workerDescription = (env: WorkerRegionEnv, region: AccountRegion, decision: { readonly included: boolean; readonly upstream?: WorkerUpstream | null }) => {
  if (!decision.included) return { region, entitled: false, available: false };
  // An upstream of the account's own is described in place of the region's, never beside it.
  const upstream = decision.upstream === undefined ? workerUpstream(env, region) : decision.upstream;
  const defaults = upstream?.pool ?? WORKER_REGION_DEFAULTS[region];
  const queue = upstream === null ? null : queueFor(upstream).state();
  return {
    region,
    entitled: true,
    /**
     * False: this region has no worker now, and no other region answers for it. Either it has no
     * key, or its upstream's list last said the model is not hosted where the region requires.
     */
    available: upstream !== null && (upstream.pool !== undefined || hosting.get(region)?.ok !== false),
    model: upstream?.model ?? null,
    structured: upstream?.structured ?? null,
    hostLabel: defaults.hostLabel,
    locationLabel: defaults.locationLabel,
    /** Requests the region takes at once, for all accounts together: the app sends no more than this. */
    parallel: upstream?.limits.parallel ?? null,
    /** The longest a request waits for its turn here before it is answered as busy. */
    maxWaitSeconds: upstream === null ? null : upstream.limits.maxWaitMs / 1000,
    /** Requests in flight and waiting now, over all accounts. */
    queue: queue === null ? null : { active: queue.active, waiting: queue.waiting },
  };
};

/** What is wrong with the worker's settings, for the server to refuse to start with. */
export const workerSettingProblems = (env: WorkerRegionEnv): Array<string> => {
  const problems: Array<string> = [];
  for (const region of ACCOUNT_REGIONS) {
    const name = (setting: WorkerSetting) => `WORKER_${region.toUpperCase()}_${setting}`;
    const url = read(env, region, "URL");
    // The address is where sealed documents are sent: one that is not an address is refused at the start.
    if (url !== "" && !/^https?:\/\//.test(url)) problems.push(`${name("URL")} must start with http:// or https://`);
    // A worker is an open-weight model. A closed one cannot be set, by mistake or otherwise.
    const model = read(env, region, "MODEL");
    if (model !== "" && !isOpenWeightWorkerModel(model)) problems.push(`${name("MODEL")}: ${notOpenWeight(model)}`);
    // A key for a region with no address or model would look like a worker and be none.
    const defaults = WORKER_REGION_DEFAULTS[region];
    if (read(env, region, "API_KEY") !== "" && ((url === "" && defaults.url === null) || (model === "" && defaults.model === null)))
      problems.push(`${name("API_KEY")} is set, and this region has no worker of its own: set ${name("URL")} and ${name("MODEL")} with it, or remove the key`);
    const structured = read(env, region, "STRUCTURED");
    if (structured !== "" && !STRUCTURED_OUTPUTS.some((candidate) => candidate === structured)) problems.push(`${name("STRUCTURED")} must be jsonSchema, jsonObject or none`);
    const floor = read(env, region, "MIN_OUTPUT_TOKENS");
    if (floor !== "" && !/^[1-9]\d{0,5}$/.test(floor)) problems.push(`${name("MIN_OUTPUT_TOKENS")} must be a whole number from 1 to 999999`);
    for (const [setting, least] of [["PARALLEL", 1], ["PER_MINUTE", 0], ["MAX_WAIT_SECONDS", 1], ["MAX_WAITING", 0]] as const) {
      const value = read(env, region, setting);
      if (value !== "" && !(/^\d{1,6}$/.test(value) && Number(value) >= least)) problems.push(`${name(setting)} must be a whole number of at least ${least}`);
    }
    // With the two minutes an upstream may take, a longer wait would outlast the server in front.
    if (/^\d+$/.test(read(env, region, "MAX_WAIT_SECONDS")) && Number(read(env, region, "MAX_WAIT_SECONDS")) > 25) problems.push(`${name("MAX_WAIT_SECONDS")} must be at most 25`);
    const provider = read(env, region, "PROVIDER");
    if (provider !== "" && provider !== "none") {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(provider);
      } catch {
        parsed = null;
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) problems.push(`${name("PROVIDER")} must be a JSON object, or none`);
    }
  }
  return problems;
};
