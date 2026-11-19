// Sample accounts and their usage, for the tests and for screenshots of the dashboard.
// Every person, firm and address here is invented. The same seed always gives the same data, so a
// test can work out what the dashboard should show from the data it put in.
import { createHash } from "node:crypto";

export const COUNTERS = [
  "detect_requests",
  "detect_texts",
  "detect_characters",
  "detect_records",
  "detect_entities",
  "detect_refused",
  "detect_too_large",
  "detect_failed",
  "ocr_files",
  "ocr_pages",
  "ocr_bytes",
  "ocr_pdf_files",
  "ocr_pdf_pages",
  "ocr_pdf_bytes",
  "ocr_refused",
  "ocr_too_large",
  "ocr_failed",
];

const DAY = 86_400_000;
export const dayOf = (offset, now = Date.now()) => new Date(now - offset * DAY).toISOString().slice(0, 10);
export const monthOf = (day) => day.slice(0, 7);

const random = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
};

const uuid = (name) => {
  const hex = createHash("sha256").update(`sample:${name}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

const PEOPLE = [
  "sarah.alharbi", "m.alotaibi", "noura", "khalid.s", "reem.alqahtani", "abdullah", "lama.z", "fahad.aldosari",
  "huda", "yousef.m", "dana.alshehri", "omar", "maha.k", "saad.alghamdi", "layla", "turki.b", "amal.alanazi",
  "faisal", "rana.h", "nasser.almutairi", "jawaher", "ziyad.a", "ghada.alsubaie", "bandar", "hala.t",
  "majed.alshammari", "salma", "rakan.f", "wafa.albalawi", "hamad", "shahad.n", "ibrahim.alzahrani", "lina",
  "sultan.r", "asma.alharthi", "tariq", "j.whitfield", "p.okafor", "emma.lindqvist", "d.moreau",
];
const FIRMS = [
  ["qimmalegal.example", "legal", "small_company"], ["dar-almizan.example", "legal", "small_company"],
  ["rawasi-advisory.example", "consulting", "small_company"], ["tharwa-finance.example", "finance", "large_company"],
  ["wateen-hr.example", "hr", "large_company"], ["masar-properties.example", "real_estate", "small_company"],
  ["shifa-clinics.example", "healthcare", "large_company"], ["bayan-research.example", "research", "small_company"],
  ["nokhba-eng.example", "engineering", "large_company"], ["personal-mail.example", "legal", "self"], ["webmail.example", "other", "self"],
  ["amanah-services.gov.example", "government", "government"],
];
const COUNTRIES = ["SA", "SA", "SA", "SA", "SA", "SA", "SA", "AE", "EG", "GB", "US", "JO"];
const OTHER_FIELDS = ["Translation", "Notary, private practice", "Insurance claims"];

/** How much of the monthly allowance an account of each kind uses, as a range. */
const PROFILES = [
  { share: [0, 0], weight: 0.22 },
  { share: [0.001, 0.02], weight: 0.3 },
  { share: [0.02, 0.15], weight: 0.26 },
  { share: [0.15, 0.55], weight: 0.15 },
  { share: [0.55, 0.98], weight: 0.07 },
];

/**
 * @returns {{ users: object[], sessions: object[], daily: object[], monthly: object[] }}
 * `daily` rows are keyed by user, UTC day and client; `monthly` rows are totals with no daily rows
 * behind them, the way months from before daily metering look.
 */
export const sampleData = ({ accounts = 64, now = Date.now(), seed = 7 } = {}) => {
  const next = random(seed);
  const between = (low, high) => low + (high - low) * next();
  const whole = (low, high) => Math.floor(between(low, high + 1));
  const pick = (list) => list[Math.floor(next() * list.length)];
  const users = [];
  const sessions = [];
  const daily = [];
  const monthly = [];
  const thisMonth = monthOf(dayOf(0, now));

  for (let index = 0; index < accounts; index += 1) {
    const [domain, field, workplace] = FIRMS[index % FIRMS.length];
    const byPhone = index % 6 === 5;
    const email = byPhone ? null : `${PEOPLE[index % PEOPLE.length]}${index >= PEOPLE.length ? index : ""}@${domain}`;
    const phone = byPhone ? `+9665${String(10_000_000 + index * 1_370_001).slice(0, 8)}` : null;
    const id = uuid(email ?? phone);
    const joinedOffset = whole(0, 130);
    const answered = next() > 0.12;
    users.push({
      id,
      email,
      phone,
      created_at: new Date(now - joinedOffset * DAY - whole(0, DAY - 1)).toISOString(),
      country: byPhone ? "SA" : pick(COUNTRIES),
      signup_method: byPhone ? "phone" : "email",
      field: answered ? field : null,
      field_other: answered && field === "other" ? pick(OTHER_FIELDS) : null,
      workplace: answered ? workplace : null,
      profile_at: answered ? new Date(now - joinedOffset * DAY).toISOString() : null,
    });

    let roll = next();
    const profile = PROFILES.find((item) => (roll -= item.weight) < 0) ?? PROFILES[0];
    const clients = next() < 0.25 ? ["server", "mobile"] : ["server"];
    for (const client of ["desktop", ...clients]) {
      sessions.push({
        token_hash: createHash("sha256").update(`sample-session:${id}:${client}`).digest("hex"),
        user_id: id,
        client,
        device: client === "mobile" ? "iPhone" : "DoeDesk on Mac",
        created_at: users.at(-1).created_at,
        last_used_at: new Date(now - (profile.share[1] === 0 ? joinedOffset : whole(0, Math.min(joinedOffset, 9))) * DAY).toISOString(),
      });
    }
    if (profile.share[1] === 0) continue;

    // Days of use since joining, heavier accounts on more of them. Each month's days share out that
    // month's portion of the allowance, so no month goes over it.
    const activeDays = [];
    for (let offset = Math.min(joinedOffset, 100); offset >= 0; offset -= 1) {
      if (next() < 0.15 + profile.share[1] * 0.6) activeDays.push(dayOf(offset, now));
    }
    const months = [...new Set(activeDays.map(monthOf))];
    for (const month of months) {
      const days = activeDays.filter((day) => monthOf(day) === month);
      const weights = days.map(() => between(0.2, 1));
      const total = weights.reduce((sum, weight) => sum + weight, 0);
      // The month in progress has had less time to fill.
      const elapsed = month === thisMonth ? Number(dayOf(0, now).slice(8)) / 30 : 1;
      const characters = between(...profile.share) * 3_000_000 * Math.min(1, elapsed + 0.2);
      const pages = next() < 0.7 ? between(...profile.share) * 200 * Math.min(1, elapsed + 0.2) : 0;
      days.forEach((day, position) => {
        const part = weights[position] / total;
        const dayCharacters = Math.round(characters * part);
        const dayPages = Math.round(pages * part);
        const texts = Math.max(1, Math.round(dayCharacters / between(400, 2600)));
        const files = dayPages === 0 ? 0 : Math.max(1, Math.round(dayPages / between(1, 9)));
        const pdfFiles = files === 0 ? 0 : Math.round(files * between(0.5, 1));
        const pdfPages = files === 0 ? 0 : Math.min(dayPages, Math.round((dayPages * pdfFiles) / files));
        const bytes = dayPages * whole(90_000, 420_000);
        const row = {
          user_id: id,
          day,
          client: clients.includes("mobile") && next() < 0.2 ? "mobile" : "server",
          detect_requests: Math.max(1, Math.round(texts / between(1, 6))),
          detect_texts: texts,
          detect_characters: dayCharacters,
          // Engine units: an arbitrary figure, as an engine might report.
          detect_records: texts * whole(1, 3),
          detect_entities: Math.round(dayCharacters / between(120, 260)),
          detect_refused: 0,
          detect_too_large: next() < 0.03 ? 1 : 0,
          detect_failed: next() < 0.04 ? whole(1, 2) : 0,
          ocr_files: files,
          ocr_pages: dayPages,
          ocr_bytes: bytes,
          ocr_pdf_files: pdfFiles,
          ocr_pdf_pages: pdfPages,
          ocr_pdf_bytes: dayPages === 0 ? 0 : Math.round((bytes * pdfPages) / dayPages),
          ocr_refused: 0,
          ocr_too_large: next() < 0.02 ? 1 : 0,
          ocr_failed: files > 0 && next() < 0.05 ? 1 : 0,
        };
        if (dayCharacters > 0 || dayPages > 0) daily.push(row);
      });
    }
  }

  // Two accounts that have reached the allowance this month and been refused since.
  const heaviest = [...new Set(daily.filter((row) => monthOf(row.day) === thisMonth).map((row) => row.user_id))]
    .map((id) => ({
      id,
      characters: daily.filter((row) => row.user_id === id && monthOf(row.day) === thisMonth).reduce((sum, row) => sum + row.detect_characters, 0),
    }))
    .sort((left, right) => right.characters - left.characters)
    .slice(0, 2);
  for (const { id, characters } of heaviest) {
    const last = daily.findLast((row) => row.user_id === id && monthOf(row.day) === thisMonth);
    const more = 3_000_000 - characters;
    last.detect_characters += more;
    last.detect_records += 90;
    last.detect_texts += 40;
    last.detect_requests += 12;
    last.detect_refused += 7;
  }

  // One account that was using the service before daily metering: a month known only as a total.
  const veteran = users[0];
  monthly.push({
    user_id: veteran.id,
    month: monthOf(dayOf(200, now)),
    ...Object.fromEntries(COUNTERS.map((counter) => [counter, 0])),
    detect_characters: 412_300,
    detect_records: 240,
    ocr_pages: 37,
  });
  return { users, sessions, daily, monthly };
};

const literal = (value) => (value === null || value === undefined ? "NULL" : typeof value === "number" ? String(value) : `'${String(value).replace(/'/g, "''")}'`);
const insert = (table, rows) => {
  if (rows.length === 0) return "";
  const columns = Object.keys(rows[0]);
  // A few rows per statement keeps each one well inside what the local database accepts.
  const statements = [];
  for (let start = 0; start < rows.length; start += 40) {
    statements.push(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES\n${rows
        .slice(start, start + 40)
        .map((row) => `(${columns.map((column) => literal(row[column])).join(", ")})`)
        .join(",\n")};`,
    );
  }
  return statements.join("\n");
};

/** The data as SQL, for `wrangler d1 execute --file`. */
export const sampleSql = (data) =>
  [insert("users", data.users), insert("sessions", data.sessions), insert("usage_daily", data.daily), insert("usage", data.monthly)]
    .filter((part) => part !== "")
    .join("\n");
