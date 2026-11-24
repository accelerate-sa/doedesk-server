// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Accelerate Technology Establishment
/**
 * Which country an address is in, from a file on this machine. The address is never sent anywhere.
 *
 * The file is built by `server/geo-build.ts` from DB-IP's free monthly database (licence: Creative
 * Commons Attribution 4.0, which allows this use with a credit to DB-IP.com, given in `ATTRIBUTION`).
 * It holds address ranges and, for each, a code: a country ("SA"), or a country and one of its
 * regions ("CA-QC") in the few countries where a rule depends on the region.
 *
 * Phone sign-in, the usage-data default and the sign-up rule all read the answer, so a wrong answer
 * matters and no answer must be safe. Every failure here ends as "not known", which the rules treat
 * as: no phone sign-in, usage data waits for agreement:
 *   - no file, a file that is cut short or fails its checksum, or one older than `maxAgeDays`;
 *   - an address that cannot be read, is private or reserved, or is in no range.
 *
 * File layout (all integers big-endian):
 *   8 bytes   "DDGEO01\n"
 *   4 bytes   length of the header
 *   header    JSON: { built, source, attribution, codes: string[], v4: count, v6: count }
 *   v4        count x 4-byte range starts, count x 4-byte range ends, count x 2-byte code indexes
 *   v6        count x 16-byte starts, count x 16-byte ends, count x 2-byte code indexes
 *   32 bytes  SHA-256 of everything before it
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

import { parseIp } from "./ip.ts";

export const GEO_MAGIC = "DDGEO01\n";

export interface GeoHeader {
  /** When the file was built, ISO 8601. */
  readonly built: string;
  /** Which edition of the source data, such as "dbip-city-lite-2026-11". */
  readonly source: string;
  readonly attribution: string;
  readonly codes: ReadonlyArray<string>;
  readonly v4: number;
  readonly v6: number;
}

export interface Place {
  readonly country: string | null;
  readonly region: string | null;
}

const UNKNOWN: Place = { country: null, region: null };

export interface GeoStatus {
  /** ok: answering. missing, invalid, stale: every lookup answers "not known". */
  readonly state: "ok" | "missing" | "invalid" | "stale";
  readonly built: string | null;
  readonly source: string | null;
  readonly ageDays: number | null;
  readonly ranges: number;
}

interface Table {
  readonly header: GeoHeader;
  readonly bytes: Buffer;
  readonly v4: number;
  readonly v6: number;
}

/** Reads and checks a file. Throws with the reason when it cannot be used. */
export const readGeoFile = (path: string): Table => {
  const bytes = readFileSync(path);
  if (bytes.length < 44 || bytes.subarray(0, 8).toString("latin1") !== GEO_MAGIC) throw new Error("not a country file");
  const digest = createHash("sha256").update(bytes.subarray(0, bytes.length - 32)).digest();
  if (!digest.equals(bytes.subarray(bytes.length - 32))) throw new Error("the checksum does not match");
  const headerLength = bytes.readUInt32BE(8);
  const header = JSON.parse(bytes.subarray(12, 12 + headerLength).toString("utf8")) as GeoHeader;
  const v4 = 12 + headerLength;
  const v6 = v4 + header.v4 * 10;
  if (v6 + header.v6 * 34 + 32 !== bytes.length) throw new Error("the length does not match the header");
  if (!Array.isArray(header.codes) || Number.isNaN(Date.parse(header.built))) throw new Error("the header is incomplete");
  return { header, bytes, v4, v6 };
};

/** The greatest index whose range start is not above `address`, or -1. */
const lastStartAtOrBelow = (count: number, compare: (index: number) => number): number => {
  let low = 0;
  let high = count - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (compare(middle) <= 0) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return found;
};

const lookupIn = (table: Table, address: Uint8Array): string | null => {
  const { bytes, header } = table;
  if (address.length === 4) {
    const value = ((address[0] ?? 0) * 0x1000000 + ((address[1] ?? 0) << 16) + ((address[2] ?? 0) << 8) + (address[3] ?? 0)) >>> 0;
    const index = lastStartAtOrBelow(header.v4, (at) => bytes.readUInt32BE(table.v4 + at * 4) - value);
    if (index === -1 || bytes.readUInt32BE(table.v4 + header.v4 * 4 + index * 4) < value) return null;
    return header.codes[bytes.readUInt16BE(table.v4 + header.v4 * 8 + index * 2)] ?? null;
  }
  const target = Buffer.from(address);
  const index = lastStartAtOrBelow(header.v6, (at) => bytes.compare(target, 0, 16, table.v6 + at * 16, table.v6 + at * 16 + 16));
  if (index === -1) return null;
  const end = table.v6 + header.v6 * 16 + index * 16;
  if (bytes.compare(target, 0, 16, end, end + 16) < 0) return null;
  return header.codes[bytes.readUInt16BE(table.v6 + header.v6 * 32 + index * 2)] ?? null;
};

const placeOfCode = (code: string | null): Place => {
  // "ZZ" is the source's word for an address that belongs to no country.
  if (code === null || code === "ZZ" || !/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/.test(code)) return UNKNOWN;
  return { country: code.slice(0, 2), region: code.length > 3 ? code.slice(3) : null };
};

export interface Geo {
  lookup(ip: string): Place;
  status(): GeoStatus;
  /** Loads the file again if it has changed on disk. Called on a timer and on SIGHUP. */
  reload(): void;
}

export const openGeo = (path: string, options: { readonly maxAgeDays?: number; readonly log?: (line: string) => void } = {}): Geo => {
  const maxAgeDays = options.maxAgeDays ?? 100;
  const log = options.log ?? (() => {});
  let table: Table | null = null;
  let problem: "missing" | "invalid" = "missing";
  let loadedVersion = "";

  const reload = (): void => {
    if (path === "") return;
    let version: string;
    try {
      const stat = statSync(path);
      version = `${stat.mtimeMs}:${stat.size}`;
    } catch {
      if (table !== null || loadedVersion !== "gone") log("geo_file_missing");
      table = null;
      problem = "missing";
      loadedVersion = "gone";
      return;
    }
    if (version === loadedVersion) return;
    loadedVersion = version;
    try {
      table = readGeoFile(path);
      log(`geo_loaded ${table.header.source} ranges=${table.header.v4 + table.header.v6}`);
    } catch (cause) {
      // A new file that cannot be used does not replace nothing with something wrong: lookups
      // answer "not known" until a good file is in place.
      table = null;
      problem = "invalid";
      log(`geo_file_invalid ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  };
  reload();

  const ageDays = (): number | null => (table === null ? null : (Date.now() - Date.parse(table.header.built)) / 86_400_000);

  return {
    lookup: (ip) => {
      const age = ageDays();
      if (table === null || age === null || age > maxAgeDays) return UNKNOWN;
      const address = parseIp(ip);
      return address === null ? UNKNOWN : placeOfCode(lookupIn(table, address));
    },
    status: () => {
      const age = ageDays();
      return {
        state: table === null ? problem : age !== null && age > maxAgeDays ? "stale" : "ok",
        built: table?.header.built ?? null,
        source: table?.header.source ?? null,
        ageDays: age === null ? null : Math.floor(age),
        ranges: table === null ? 0 : table.header.v4 + table.header.v6,
      };
    },
    reload,
  };
};
