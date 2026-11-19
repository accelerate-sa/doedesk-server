/**
 * What the engine costs for the work behind each account, for the owner's dashboard only.
 * An estimate for planning prices: it is never shown to the people who use the service, and it is
 * not what anyone is charged.
 *
 * The prices are settings, in US dollars, because they are the operator's own and they change:
 *   ENGINE_PRICE_PER_1000_UNITS   per 1,000 engine units of detection (`detect_records`: the units
 *                                 the engine reported for each call; see engine.ts)
 *   ENGINE_PRICE_PER_1000_PAGES   per 1,000 pages read (`ocr_pages`)
 * With neither set, there is no estimate and the dashboard shows no cost anywhere. With one set,
 * the other counts as free. Volume discounts, tax and what the machine itself costs are not
 * modelled.
 */
import type { Env } from "./http.ts";

export interface UnitCosts {
  /** US dollars per engine unit and per page. */
  readonly perUnit: number;
  readonly perPage: number;
}

/** A price as a setting gives it: a non-negative number, or nothing when unset or not a number. */
export const priceSetting = (value: string | undefined): number | undefined => {
  const text = (value ?? "").trim();
  if (text === "" || !/^\d+(\.\d+)?$/.test(text)) return undefined;
  return Number(text);
};

/** The prices from the settings, or null when none is set (the dashboard then shows no cost). */
export const unitCosts = (env: Pick<Env, "ENGINE_PRICE_PER_1000_UNITS" | "ENGINE_PRICE_PER_1000_PAGES">): UnitCosts | null => {
  const units = priceSetting(env.ENGINE_PRICE_PER_1000_UNITS);
  const pages = priceSetting(env.ENGINE_PRICE_PER_1000_PAGES);
  if (units === undefined && pages === undefined) return null;
  return { perUnit: (units ?? 0) / 1000, perPage: (pages ?? 0) / 1000 };
};

export const estimatedCostUsd = (
  used: { readonly units: number; readonly pages: number },
  costs: UnitCosts,
): number => used.units * costs.perUnit + used.pages * costs.perPage;
