/** Internet addresses as bytes: four for IPv4, sixteen for IPv6. Null for anything else. */

const parseV4 = (text: string): Uint8Array | null => {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let index = 0; index < 4; index += 1) {
    const part = parts[index] ?? "";
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    bytes[index] = Number(part);
  }
  return bytes;
};

const parseV6 = (text: string): Uint8Array | null => {
  let source = text;
  const groups: Array<number> = [];
  // An IPv4 tail, as in ::ffff:192.0.2.1, is two groups.
  const lastColon = source.lastIndexOf(":");
  if (source.includes(".")) {
    const tail = parseV4(source.slice(lastColon + 1));
    if (tail === null) return null;
    source = `${source.slice(0, lastColon + 1)}${(((tail[0] ?? 0) << 8) | (tail[1] ?? 0)).toString(16)}:${(((tail[2] ?? 0) << 8) | (tail[3] ?? 0)).toString(16)}`;
  }
  const halves = source.split("::");
  if (halves.length > 2) return null;
  const read = (half: string): Array<number> | null => {
    if (half === "") return [];
    const out: Array<number> = [];
    for (const group of half.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      out.push(Number.parseInt(group, 16));
    }
    return out;
  };
  const head = read(halves[0] ?? "");
  const tail = halves.length === 2 ? read(halves[1] ?? "") : [];
  if (head === null || tail === null) return null;
  if (halves.length === 1 ? head.length !== 8 : head.length + tail.length > 7) return null;
  groups.push(...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail);
  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    bytes[index * 2] = group >> 8;
    bytes[index * 2 + 1] = group & 0xff;
  });
  return bytes;
};

/**
 * Four bytes for an IPv4 address, sixteen for IPv6. An IPv4 address written as IPv6
 * (`::ffff:192.0.2.1`) comes back as the four. A zone (`%eth0`) and brackets are dropped.
 */
export const parseIp = (value: string): Uint8Array | null => {
  let text = value.trim();
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  if (text === "" || text.length > 45) return null;
  if (!text.includes(":")) return parseV4(text);
  const bytes = parseV6(text);
  if (bytes === null) return null;
  const mapped = bytes.subarray(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  return mapped ? bytes.slice(12) : bytes;
};

/** The address in one canonical spelling, so that a rate-limit counter has one key per address. */
export const formatIp = (bytes: Uint8Array): string => {
  if (bytes.length === 4) return [...bytes].join(".");
  const groups: Array<string> = [];
  for (let index = 0; index < 16; index += 2) groups.push((((bytes[index] ?? 0) << 8) | (bytes[index + 1] ?? 0)).toString(16));
  return groups.join(":");
};

export const isLoopback = (bytes: Uint8Array): boolean =>
  bytes.length === 4 ? bytes[0] === 127 : bytes.subarray(0, 15).every((byte) => byte === 0) && bytes[15] === 1;

/** Whether `bytes` is inside `range`, written as an address (`10.0.0.1`) or a block (`10.0.0.0/8`). */
export const inRange = (bytes: Uint8Array, range: string): boolean => {
  const [base, length] = range.split("/");
  const start = parseIp(base ?? "");
  if (start === null || start.length !== bytes.length) return false;
  const bits = length === undefined ? start.length * 8 : Number(length);
  if (!Number.isInteger(bits) || bits < 0 || bits > start.length * 8) return false;
  for (let bit = 0; bit < bits; bit += 8) {
    const mask = bits - bit >= 8 ? 0xff : (0xff << (8 - (bits - bit))) & 0xff;
    if (((bytes[bit / 8] ?? 0) & mask) !== ((start[bit / 8] ?? 0) & mask)) return false;
  }
  return true;
};
