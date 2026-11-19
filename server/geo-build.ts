/**
 * Builds the country file `server/geo.ts` reads, from DB-IP's free database in CSV form.
 *
 *   bun server/geo-build.ts --input dbip-city-lite-2026-11.csv --output country.ddgeo \
 *       --source dbip-city-lite-2026-11 --expect 8.8.8.8=US [--expect ...]
 *
 * Takes either of DB-IP's two free files:
 *   country lite   ip_start,ip_end,country
 *   city lite      ip_start,ip_end,continent,country,stateprov,city,latitude,longitude
 * The city file is the one to use: it also names the region, which two rules need (Quebec for the
 * usage-data default, four regions of Ukraine for the sign-up rule). Regions are kept only for the
 * countries in REGIONS below; everywhere else a range is its country.
 *
 * The file is written beside the output under a temporary name, read back, checked against every
 * `--expect`, and only then moved into place, so the service never sees a half-written or wrong
 * file. If anything fails the old file stays and the exit status is 1.
 */
import { createHash } from "node:crypto";
import { createReadStream, renameSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

import { GEO_MAGIC, openGeo, readGeoFile } from "./geo.ts";
import { parseIp } from "./ip.ts";

export const ATTRIBUTION = "IP Geolocation by DB-IP (https://db-ip.com), licensed CC BY 4.0";

/**
 * Region names as DB-IP writes them, to ISO 3166-2 codes, for the countries where a rule reads the
 * region. Names are compared without case, punctuation or the words "oblast" and "city". A name
 * that is not here leaves the range as its country alone.
 */
export const REGIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  CA: {
    alberta: "AB",
    "british columbia": "BC",
    manitoba: "MB",
    "new brunswick": "NB",
    "newfoundland and labrador": "NL",
    "northwest territories": "NT",
    "nova scotia": "NS",
    nunavut: "NU",
    ontario: "ON",
    "prince edward island": "PE",
    quebec: "QC",
    saskatchewan: "SK",
    yukon: "YT",
  },
  // Only the regions the sign-up rule can name (legal/service-changes-notes.md 2.3).
  UA: {
    crimea: "43",
    "autonomous republic of crimea": "43",
    "republic of crimea": "43",
    sevastopol: "40",
    sebastopol: "40",
    donetsk: "14",
    donetska: "14",
    luhansk: "09",
    luhanska: "09",
  },
};

const regionKey = (name: string): string =>
  name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z ]/g, "")
    .replace(/\b(oblast|city)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** One CSV line into fields. Handles quoted fields with commas and doubled quotes. */
export const splitCsv = (line: string): Array<string> => {
  const fields: Array<string> = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === '"') {
        if (line[index + 1] === '"') {
          field += '"';
          index += 1;
        } else quoted = false;
      } else field += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") {
      fields.push(field);
      field = "";
    } else field += character;
  }
  fields.push(field);
  return fields;
};

interface Range {
  start: Buffer;
  end: Buffer;
  code: number;
}

/** Whether `next` is the address right after `previous`. */
const follows = (previous: Buffer, next: Buffer): boolean => {
  const plusOne = Buffer.from(previous);
  for (let index = plusOne.length - 1; index >= 0; index -= 1) {
    plusOne[index] = ((plusOne[index] ?? 0) + 1) & 0xff;
    if (plusOne[index] !== 0) break;
  }
  return plusOne.equals(next);
};

export interface BuildResult {
  readonly bytes: Buffer;
  readonly v4: number;
  readonly v6: number;
  readonly countries: number;
  readonly codes: ReadonlyArray<string>;
}

/** Builds the file's bytes from CSV lines. Throws when the data does not look like the real thing. */
export const buildGeo = async (
  lines: AsyncIterable<string>,
  options: { readonly source: string; readonly built?: string; readonly minimums?: { readonly v4: number; readonly v6: number; readonly countries: number } },
): Promise<BuildResult> => {
  const codes: Array<string> = [];
  const codeIndex = new Map<string, number>();
  const indexOf = (code: string): number => {
    let index = codeIndex.get(code);
    if (index === undefined) {
      index = codes.push(code) - 1;
      codeIndex.set(code, index);
    }
    return index;
  };
  const v4: Array<Range> = [];
  const v6: Array<Range> = [];
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (line.trim() === "") continue;
    const fields = splitCsv(line);
    const country = (fields.length >= 8 ? fields[3] : fields[2])?.trim().toUpperCase() ?? "";
    const start = parseIp(fields[0] ?? "");
    const end = parseIp(fields[1] ?? "");
    // `::ffff:…` ranges repeat the IPv4 table inside IPv6; a range must keep one family.
    if (start === null || end === null || !/^[A-Z]{2}$/.test(country)) throw new Error(`line ${lineNumber} is not a range`);
    if (start.length !== end.length) continue;
    const region = fields.length >= 8 ? REGIONS[country]?.[regionKey(fields[4] ?? "")] : undefined;
    const code = indexOf(region === undefined ? country : `${country}-${region}`);
    const list = start.length === 4 ? v4 : v6;
    const startBytes = Buffer.from(start);
    const endBytes = Buffer.from(end);
    if (startBytes.compare(endBytes) > 0) throw new Error(`line ${lineNumber}: the range ends before it starts`);
    const previous = list.at(-1);
    if (previous !== undefined) {
      if (previous.end.compare(startBytes) >= 0) throw new Error(`line ${lineNumber}: ranges overlap or are out of order`);
      if (previous.code === code && follows(previous.end, startBytes)) {
        previous.end = endBytes;
        continue;
      }
    }
    list.push({ start: startBytes, end: endBytes, code });
  }

  const countries = new Set(codes.map((code) => code.slice(0, 2)).filter((code) => code !== "ZZ")).size;
  const minimums = options.minimums ?? { v4: 100_000, v6: 50_000, countries: 200 };
  if (v4.length < minimums.v4 || v6.length < minimums.v6 || countries < minimums.countries) {
    throw new Error(`the data is too small to be the whole database: ${v4.length} IPv4 ranges, ${v6.length} IPv6 ranges, ${countries} countries`);
  }

  const header = Buffer.from(
    JSON.stringify({ built: options.built ?? new Date().toISOString(), source: options.source, attribution: ATTRIBUTION, codes, v4: v4.length, v6: v6.length }),
    "utf8",
  );
  const table = (list: ReadonlyArray<Range>, width: number): Buffer => {
    const out = Buffer.alloc(list.length * (width * 2 + 2));
    list.forEach((range, index) => {
      range.start.copy(out, index * width);
      range.end.copy(out, list.length * width + index * width);
      out.writeUInt16BE(range.code, list.length * width * 2 + index * 2);
    });
    return out;
  };
  const length = Buffer.alloc(4);
  length.writeUInt32BE(header.length);
  const body = Buffer.concat([Buffer.from(GEO_MAGIC, "latin1"), length, header, table(v4, 4), table(v6, 16)]);
  return { bytes: Buffer.concat([body, createHash("sha256").update(body).digest()]), v4: v4.length, v6: v6.length, countries, codes };
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const value = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  const input = value("--input");
  const output = value("--output");
  const source = value("--source");
  if (input === undefined || output === undefined || source === undefined) {
    console.error("usage: geo-build.ts --input FILE.csv --output FILE.ddgeo --source NAME [--expect IP=CC ...]");
    process.exit(2);
  }
  const expectations = args.flatMap((arg, index) => (arg === "--expect" ? [args[index + 1] ?? ""] : []));
  const temporary = `${output}.new`;
  try {
    const built = await buildGeo(createInterface({ input: createReadStream(input, "utf8"), crlfDelay: Number.POSITIVE_INFINITY }), { source });
    writeFileSync(temporary, built.bytes, { mode: 0o644 });
    readGeoFile(temporary);
    const geo = openGeo(temporary);
    for (const expectation of expectations) {
      const [ip, code] = expectation.split("=");
      const place = geo.lookup(ip ?? "");
      const found = place.country === null ? "unknown" : place.region === null ? place.country : `${place.country}-${place.region}`;
      if (found !== code) throw new Error(`${ip} should be ${code} and is ${found}`);
    }
    renameSync(temporary, output);
    console.log(`built ${output}: ${built.v4} IPv4 ranges, ${built.v6} IPv6 ranges, ${built.countries} countries, ${built.bytes.length} bytes, source ${source}`);
  } catch (cause) {
    rmSync(temporary, { force: true });
    console.error(`not replaced: ${cause instanceof Error ? cause.message : String(cause)}`);
    process.exit(1);
  }
};

if (import.meta.main ?? process.argv[1]?.endsWith("geo-build.ts")) await main();
