// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Accelerate Technology Establishment
/**
 * The one place another layer of code attaches to this service.
 *
 * The service is complete without one: accounts, detection, reading and the worker's relay run
 * as they are, and every function here has an answer of its own for "nothing attached". A layer
 * lives in its own folder, keeps its own tables under its own migrations, and registers itself
 * with `useExtension` when the server starts (server/extension.ts). It may read what this service
 * exports; nothing in `src/` or `server/` reads from it except through this interface.
 *
 * What a layer can do, and no more:
 *
 *   routes            answer addresses of its own (it is asked before the API says "not found")
 *   adminViews        answer pages under /admin, behind the admin key, and add to its navigation
 *   signedIn          look at an account that has just signed in, and give it back, changed or not
 *   worker            say whether an account has the hosted worker, why not, and through which upstream
 *   allowance         answer for an account whose monthly allowance is not its own
 *   regionChange      refuse a change of region
 *   describe          add fields to what an account is told about itself (GET /v1/me, sign-in)
 *   exportAccount     add to the account's copy of its data
 *   deletionStatements  delete its rows about an account, with the account
 *
 * It is never handed a request's content: not the texts sent for detection, the files sent for
 * reading, or what goes to and from the worker.
 */
import type { Account, SignedIn } from "./accounts.ts";
import type { ApiError, Env } from "./http.ts";
import { type AccountRegion, type WorkerUpstream, workerDescription } from "./worker-regions.ts";

/** Whether an account has the hosted worker, as a layer decides it. */
export interface WorkerDecision {
  readonly included: boolean;
  /** Raised in place of "not included" when the worker is refused for another reason. */
  readonly refusal?: ApiError;
  /**
   * An upstream of the account's own in place of its region's. Null: it has one, and that one is
   * not available. The region's upstream never answers in its place.
   */
  readonly upstream?: WorkerUpstream | null;
}

/** For an account whose allowance is not its own. `refusal`: nothing more may be used this month. */
export interface AllowanceDecision {
  readonly refusal?: ApiError;
}

export type AllowanceKind = "detect" | "ocr" | "worker";

export interface AdminSection {
  readonly id: string;
  readonly href: string;
  readonly label: string;
}

export interface ServiceExtension {
  readonly name: string;
  readonly routes?: (request: Request, env: Env, url: URL) => Promise<Response | null>;
  readonly adminViews?: (request: Request, env: Env, url: URL) => Promise<Response | null>;
  readonly adminSections?: ReadonlyArray<AdminSection>;
  readonly signedIn?: (env: Env, account: Account) => Promise<Account>;
  readonly worker?: (env: Env, account: Account) => Promise<WorkerDecision | null>;
  readonly allowance?: (env: Env, account: SignedIn, kind: AllowanceKind) => Promise<AllowanceDecision | null>;
  readonly regionChange?: (env: Env, account: Account, region: AccountRegion) => Promise<void>;
  readonly describe?: (env: Env, account: Account) => Promise<Record<string, unknown>>;
  readonly exportAccount?: (env: Env, accountId: string) => Promise<Record<string, unknown>>;
  readonly deletionStatements?: (env: Env, accountIds: ReadonlyArray<string>) => ReadonlyArray<D1PreparedStatement>;
}

const NONE: ServiceExtension = { name: "none" };
let attached: ServiceExtension = NONE;

/** Called once, when the server starts and finds a layer beside it. */
export const useExtension = (layer: ServiceExtension | null): void => {
  attached = layer ?? NONE;
};

export const extension = (): ServiceExtension => attached;

/**
 * The worker for an account: the layer's word where it has one. Otherwise the service's one
 * setting decides for every account alike: `WORKER_OPEN=1` gives each signed-in account the
 * worker, and without it no account has it. Who has it one by one is a layer's to say.
 */
export const workerDecision = async (env: Env, account: Account): Promise<WorkerDecision> =>
  (await attached.worker?.(env, account)) ?? { included: (env.WORKER_OPEN ?? "").trim() === "1" };

/**
 * What an account is told of its worker, and what a layer adds beside it. A layer's `worker`
 * fields are added to the worker's own description; its other fields go beside it as they are.
 */
export const describeAccount = async (env: Env, account: Account) => {
  const decision = await workerDecision(env, account);
  const { worker: more, ...beside } = ((await attached.describe?.(env, account)) ?? {}) as { worker?: Record<string, unknown> } & Record<string, unknown>;
  return { worker: { ...workerDescription(env, account.region, decision), ...more }, beside };
};
