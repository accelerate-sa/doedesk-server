// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Accelerate Technology Establishment
/**
 * What the engine and the worker cost for the work behind each account, for the owner's dashboard
 * only. An estimate for planning prices: it is never shown to the people who use the service, and
 * it is not what anyone is charged.
 *
 * The prices are settings, in US dollars, because they are the operator's own and they change:
 *   ENGINE_PRICE_PER_1000_UNITS         per 1,000 engine units of detection (`detect_records`: the
 *                                       units the engine reported for each call; see engine.ts)
 *   ENGINE_PRICE_PER_1000_PAGES         per 1,000 pages read (`ocr_pages`)
 *   WORKER_PRICE_PER_1M_INPUT_TOKENS    per million tokens sent to the worker (`worker_input_tokens`:
 *                                       the tokens its answers reported; see worker-chat.ts)
 *   WORKER_PRICE_PER_1M_OUTPUT_TOKENS   per million tokens it answered with (`worker_output_tokens`)
 * With none set, there is no estimate and the dashboard shows no cost anywhere. With some set, the
 * others count as free. Volume discounts, tax and what the machine itself costs are not modelled.
 */
import type { Env } from "./http.ts";

export interface UnitCosts {
  /** US dollars per engine unit, per page, and per token sent to and answered by the worker. */
  readonly perUnit: number;
  readonly perPage: number;
  readonly perInputToken: number;
  readonly perOutputToken: number;
}

export const PRICE_SETTINGS = [
  "ENGINE_PRICE_PER_1000_UNITS",
  "ENGINE_PRICE_PER_1000_PAGES",
  "WORKER_PRICE_PER_1M_INPUT_TOKENS",
  "WORKER_PRICE_PER_1M_OUTPUT_TOKENS",
] as const;

/** A price as a setting gives it: a non-negative number, or nothing when unset or not a number. */
export const priceSetting = (value: string | undefined): number | undefined => {
  const text = (value ?? "").trim();
  if (text === "" || !/^\d+(\.\d+)?$/.test(text)) return undefined;
  return Number(text);
};

/** The prices from the settings, or null when none is set (the dashboard then shows no cost). */
export const unitCosts = (env: Pick<Env, (typeof PRICE_SETTINGS)[number]>): UnitCosts | null => {
  const units = priceSetting(env.ENGINE_PRICE_PER_1000_UNITS);
  const pages = priceSetting(env.ENGINE_PRICE_PER_1000_PAGES);
  const input = priceSetting(env.WORKER_PRICE_PER_1M_INPUT_TOKENS);
  const output = priceSetting(env.WORKER_PRICE_PER_1M_OUTPUT_TOKENS);
  if (units === undefined && pages === undefined && input === undefined && output === undefined) return null;
  return { perUnit: (units ?? 0) / 1000, perPage: (pages ?? 0) / 1000, perInputToken: (input ?? 0) / 1_000_000, perOutputToken: (output ?? 0) / 1_000_000 };
};

export const estimatedCostUsd = (
  used: { readonly units: number; readonly pages: number; readonly inputTokens: number; readonly outputTokens: number },
  costs: UnitCosts,
): number => used.units * costs.perUnit + used.pages * costs.perPage + used.inputTokens * costs.perInputToken + used.outputTokens * costs.perOutputToken;
