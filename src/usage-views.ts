// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Accelerate Technology Establishment
/**
 * The owner's views of usage per account: the accounts table, one account, how usage spreads across
 * accounts, and the CSV exports. All of it sits behind the admin key (see admin.ts).
 *
 * An account is addressed by its opaque id only. A search term can be an email or a phone number, so
 * it travels in a form body and never in an address, where it would be logged.
 */
import { estimatedCostUsd, unitCosts, type UnitCosts } from "./cost.ts";
import {
  breakdown,
  type Count,
  dailyChart,
  dayLabel,
  dayOf,
  FIELD_LABELS,
  number,
  one,
  rows,
  shell,
  WORKPLACE_LABELS,
} from "./dashboard.ts";
import { type Env, escapeHtml, html } from "./http.ts";
import { accountPrivacyCard } from "./privacy-views.ts";
import {
  COUNTERS,
  type Counter,
  MONTHLY_DETECT_CHARACTERS,
  MONTHLY_OCR_PAGES,
  MONTHLY_WORKER_INPUT_TOKENS,
  monthRows,
  previousMonth,
  utcMonth,
} from "./usage.ts";

const PAGE_SIZE = 50;
/** D1 refuses LIKE patterns over 50 bytes; the term is cut well short of that. */
const MAX_SEARCH = 40;

const CLIENT_LABELS: Record<string, string> = {
  desktop: "Desktop",
  web: "Web",
  mobile: "Phone",
  server: "Local service",
  site: "Site",
};

const ICON = {
  download: '<path d="M12 4v11m0 0-4-4m4 4 4-4M5 19.5h14"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>',
  previous: '<path d="m14.5 6-6 6 6 6"/>',
  next: '<path d="m9.5 6 6 6-6 6"/>',
  down: '<path d="M12 5v14m0 0-5-5m5 5 5-5"/>',
  up: '<path d="M12 19V5m0 0-5 5m5-5 5 5"/>',
} as const;
const icon = (name: keyof typeof ICON): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;

const compact = (value: number): string =>
  new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
const usd = (value: number): string =>
  value > 0 && value < 0.005
    ? "&lt;$0.01"
    : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
const percent = (share: number): string => `${Math.round(share * 100)}%`;
const monthLabel = (month: string): string =>
  new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const shortMonth = (month: string): string =>
  new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
/** A date as the owner reads it: the year only when it is not this one. */
const dateLabel = (iso: string): string =>
  iso.slice(0, 4) === utcMonth().slice(0, 4) ? dayLabel(iso.slice(0, 10)) : `${dayLabel(iso.slice(0, 10))} ${iso.slice(0, 4)}`;
const fieldLabel = (field: string | null, other: string | null): string =>
  field === null ? "" : field === "other" && other !== null ? other : (FIELD_LABELS[field] ?? field);
const allowanceShare = (characters: number, pages: number, tokens: number): number =>
  Math.max(characters / MONTHLY_DETECT_CHARACTERS, pages / MONTHLY_OCR_PAGES, tokens / MONTHLY_WORKER_INPUT_TOKENS);
const meterBar = (share: number): string =>
  `<span class="meter"><i style="inline-size:${Math.min(100, share * 100).toFixed(1)}%"></i></span>`;

// ---------------------------------------------------------------------------------------------
// CSV

/**
 * One CSV cell. A value that a spreadsheet would run as a formula is made plain text: an email
 * address is chosen by whoever signed up, and may begin with `=`. Numbers written with a sign
 * (a phone number, a negative figure) are left as they are.
 */
const cell = (value: string | number | null): string => {
  if (value === null) return "";
  if (typeof value === "number") return String(value);
  const risky = /^[=@\t\r]/.test(value) || (/^[+-]/.test(value) && !/^[+-]?\d+(\.\d+)?$/.test(value));
  const text = risky ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const csvResponse = (name: string, lines: ReadonlyArray<ReadonlyArray<string | number | null>>): Response =>
  // The byte-order mark is what makes a spreadsheet read the file as UTF-8.
  new Response(`﻿${lines.map((line) => line.map(cell).join(",")).join("\r\n")}\r\n`, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${name}"`,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });

// ---------------------------------------------------------------------------------------------
// Accounts table

interface AccountRow {
  readonly id: string;
  readonly label: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly field: string | null;
  readonly field_other: string | null;
  readonly workplace: string | null;
  readonly country: string | null;
  readonly signup_method: string;
  readonly joined: string;
  readonly last_active: string;
  readonly characters: number;
  readonly units: number;
  readonly pages: number;
  /** Tokens sent to the worker, and tokens it answered with. */
  readonly tokens: number;
  readonly out_tokens: number;
  readonly requests: number;
  readonly allowance: number;
  readonly cost: number;
  readonly active_days: number;
}

interface Column {
  readonly id: string;
  readonly label: string;
  /** What the column sorts by, in the query below. */
  readonly order: string;
  /** The direction a first press sorts in: text upward, figures and dates downward. */
  readonly first: "asc" | "desc";
  readonly numeric?: boolean;
  readonly title?: string;
}

const COLUMNS: ReadonlyArray<Column> = [
  { id: "account", label: "Account", order: "label COLLATE NOCASE", first: "asc" },
  { id: "field", label: "Field", order: "users.field IS NULL, users.field", first: "asc" },
  { id: "workplace", label: "Workplace", order: "users.workplace IS NULL, users.workplace", first: "asc" },
  { id: "country", label: "Country", order: "users.country IS NULL, users.country", first: "asc" },
  { id: "joined", label: "Joined", order: "joined", first: "desc" },
  { id: "active", label: "Last active", order: "last_active", first: "desc" },
  { id: "characters", label: "Characters", order: "characters", first: "desc", numeric: true },
  { id: "pages", label: "Pages", order: "pages", first: "desc", numeric: true },
  { id: "tokens", label: "Worker tokens", order: "tokens", first: "desc", numeric: true, title: "Tokens sent to the worker, as its answers counted them" },
  { id: "requests", label: "Requests", order: "requests", first: "desc", numeric: true },
  { id: "allowance", label: "Allowance", order: "allowance", first: "desc", numeric: true, title: "Share of the monthly allowance used, by characters, pages or worker tokens, whichever is highest" },
  { id: "cost", label: "Est. cost", order: "cost", first: "desc", numeric: true, title: "What the engine and the worker cost for this account's use, estimated from the prices in the settings" },
  { id: "days", label: "Days active", order: "active_days", first: "desc", numeric: true, title: "Days with a request, of the last 30" },
];
const DEFAULT_SORT = "characters";

/** The columns shown: without prices in the settings there is no cost column (cost.ts). */
const columnsFor = (costs: UnitCosts | null): ReadonlyArray<Column> =>
  costs === null ? COLUMNS.filter((column) => column.id !== "cost") : COLUMNS;

interface TableState {
  readonly search: string;
  readonly sort: Column;
  readonly direction: "asc" | "desc";
  readonly page: number;
}

/** What the table is showing, from the address (sort and page) and the form body (those and the search). */
const tableState = (parameters: URLSearchParams, columns: ReadonlyArray<Column>): TableState => {
  const current = columns.find((column) => column.id === parameters.get("s"));
  const currentDirection = parameters.get("d") === "asc" ? "asc" : "desc";
  // A pressed column heading: the same column turns round, another starts in its own direction.
  const pressed = columns.find((column) => column.id === parameters.get("sort"));
  const sort = pressed ?? current ?? columns.find((column) => column.id === DEFAULT_SORT)!;
  const direction =
    pressed === undefined
      ? current === undefined
        ? sort.first
        : currentDirection
      : pressed === current
        ? currentDirection === "asc"
          ? "desc"
          : "asc"
        : pressed.first;
  const page = pressed === undefined ? Math.max(1, Math.floor(Number(parameters.get("page")) || 1)) : 1;
  return { search: (parameters.get("q") ?? "").trim().slice(0, MAX_SEARCH), sort, direction, page };
};

const likePattern = (term: string): string => `%${term.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;

/** A phone number is stored as +9665…; a search for 055… or 55… should still find it. */
const phonePattern = (term: string): string => {
  if (!/^[\d\s+()-]{3,}$/.test(term)) return likePattern(term);
  return `%${term.replace(/\D/g, "").replace(/^(00966|966|0)/, "")}%`;
};

/** The search, with its three bindings at `first`, `first + 1` and `first + 2`: email pattern, phone pattern, exact id. */
const matches = (first: number): string =>
  `(?${first} = '' OR users.email LIKE ?${first} ESCAPE '\\' OR users.phone LIKE ?${first + 1} ESCAPE '\\' OR users.id = ?${first + 2})`;

/** The columns of both usage tables that the tables of accounts add up, month by month. */
const MONTH_COLUMNS =
  "user_id, detect_characters, detect_records, ocr_pages, detect_requests, ocr_files, worker_requests, worker_input_tokens, worker_output_tokens";

const accountRows = async (
  env: Env,
  month: string,
  costs: UnitCosts | null,
  state: TableState,
  limit: number,
  offset: number,
): Promise<ReadonlyArray<AccountRow>> =>
  rows<AccountRow>(
    env.DB.prepare(
      `WITH month AS (
         SELECT user_id, SUM(detect_characters) AS characters, SUM(detect_records) AS units,
                SUM(ocr_pages) AS pages, SUM(worker_input_tokens) AS tokens, SUM(worker_output_tokens) AS out_tokens,
                SUM(detect_requests + ocr_files + worker_requests) AS requests
         FROM (${monthRows(MONTH_COLUMNS)})
         GROUP BY user_id
       ), days AS (
         SELECT user_id, MAX(day) AS last_day, COUNT(DISTINCT CASE WHEN day >= ?2 THEN day END) AS active_days
         FROM usage_daily GROUP BY user_id
       ), seen AS (
         SELECT user_id, MAX(last_used_at) AS last_used FROM sessions GROUP BY user_id
       )
       SELECT users.id, COALESCE(users.email, users.phone, users.id) AS label, users.email, users.phone,
              users.field, users.field_other, users.workplace, users.country, users.signup_method,
              users.created_at AS joined,
              MAX(COALESCE(seen.last_used, ''), COALESCE(days.last_day, ''), users.created_at) AS last_active,
              COALESCE(month.characters, 0) AS characters, COALESCE(month.units, 0) AS units,
              COALESCE(month.pages, 0) AS pages, COALESCE(month.tokens, 0) AS tokens, COALESCE(month.out_tokens, 0) AS out_tokens,
              COALESCE(month.requests, 0) AS requests,
              MAX(COALESCE(month.characters, 0) * 1.0 / ${MONTHLY_DETECT_CHARACTERS}, COALESCE(month.pages, 0) * 1.0 / ${MONTHLY_OCR_PAGES}, COALESCE(month.tokens, 0) * 1.0 / ${MONTHLY_WORKER_INPUT_TOKENS}) AS allowance,
              COALESCE(month.units, 0) * ?3 + COALESCE(month.pages, 0) * ?4 + COALESCE(month.tokens, 0) * ?5 + COALESCE(month.out_tokens, 0) * ?6 AS cost,
              COALESCE(days.active_days, 0) AS active_days
       FROM users
       LEFT JOIN month ON month.user_id = users.id
       LEFT JOIN days ON days.user_id = users.id
       LEFT JOIN seen ON seen.user_id = users.id
       WHERE ${matches(7)}
       ORDER BY ${state.sort.order} ${state.direction === "asc" ? "ASC" : "DESC"}, users.id
       LIMIT ?10 OFFSET ?11`,
    ).bind(
      month,
      dayOf(29),
      costs?.perUnit ?? 0,
      costs?.perPage ?? 0,
      costs?.perInputToken ?? 0,
      costs?.perOutputToken ?? 0,
      state.search === "" ? "" : likePattern(state.search),
      phonePattern(state.search),
      state.search,
      limit,
      offset,
    ),
  );

const accountsCsv = async (env: Env, state: TableState): Promise<Response> => {
  const month = utcMonth();
  const costs = unitCosts(env);
  const list = await accountRows(env, month, costs, state, 100_000, 0);
  return csvResponse(`doedesk-accounts-${month}.csv`, [
    [
      "account_id",
      "email",
      "phone",
      "field",
      "field_other",
      "workplace",
      "country",
      "sign_in",
      "joined_utc",
      "last_active_day_utc",
      "month_utc",
      "characters",
      "engine_units",
      "pages",
      "worker_input_tokens",
      "worker_output_tokens",
      "requests",
      "allowance_share",
      ...(costs === null ? [] : ["estimated_cost_usd"]),
      "active_days_last_30",
    ],
    ...list.map((row) => [
      row.id,
      row.email,
      row.phone,
      row.field,
      row.field_other,
      row.workplace,
      row.country,
      row.signup_method,
      row.joined,
      row.last_active.slice(0, 10),
      month,
      row.characters,
      row.units,
      row.pages,
      row.tokens,
      row.out_tokens,
      row.requests,
      Number(row.allowance.toFixed(4)),
      ...(costs === null ? [] : [Number(row.cost.toFixed(4))]),
      row.active_days,
    ]),
  ]);
};

const accountsPage = async (env: Env, state: TableState): Promise<string> => {
  const month = utcMonth();
  const like = state.search === "" ? "" : likePattern(state.search);
  const costs = unitCosts(env);
  const columns = columnsFor(costs);
  const [total, everyone] = await Promise.all([
    one(
      env.DB.prepare(`SELECT COUNT(*) AS value FROM users WHERE ${matches(1)}`).bind(
        like,
        phonePattern(state.search),
        state.search,
      ),
    ),
    one(env.DB.prepare("SELECT COUNT(*) AS value FROM users")),
  ]);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(state.page, pages);
  const list = await accountRows(env, month, costs, state, PAGE_SIZE, (page - 1) * PAGE_SIZE);

  const sortButton = (column: Column): string => {
    const current = column === state.sort;
    return `<button name="sort" value="${column.id}"${column.title === undefined ? "" : ` title="${escapeHtml(column.title)}"`}>${column.label}${current ? icon(state.direction === "asc" ? "up" : "down") : ""}</button>`;
  };
  const heading = (column: Column): string =>
    `<th scope="col"${column.numeric === true ? ' class="num"' : ""}${column === state.sort ? ` aria-sort="${state.direction === "asc" ? "ascending" : "descending"}"` : ""}>${sortButton(column)}</th>`;
  const figure = (value: number, text: string): string => `<td class="num${value === 0 ? " zero" : ""}">${text}</td>`;

  const body = list
    .map((row) => {
      const share = row.allowance;
      return `<tr>
<td class="who"><a href="/admin/accounts/${row.id}"><bdi>${escapeHtml(row.label)}</bdi></a></td>
<td>${escapeHtml(fieldLabel(row.field, row.field_other))}</td>
<td>${escapeHtml(row.workplace === null ? "" : (WORKPLACE_LABELS[row.workplace] ?? row.workplace))}</td>
<td>${escapeHtml(row.country ?? "")}</td>
<td>${dateLabel(row.joined)}</td>
<td>${dateLabel(row.last_active)}</td>
${figure(row.characters, number(row.characters))}
${figure(row.pages, number(row.pages))}
${figure(row.tokens, number(row.tokens))}
${figure(row.requests, number(row.requests))}
<td class="num allow${share === 0 ? " zero" : ""}" title="${number(row.characters)} of ${number(MONTHLY_DETECT_CHARACTERS)} characters, ${number(row.pages)} of ${number(MONTHLY_OCR_PAGES)} pages, ${number(row.tokens)} of ${number(MONTHLY_WORKER_INPUT_TOKENS)} worker tokens">${meterBar(share)}${percent(share)}</td>
${costs === null ? "" : figure(row.cost, usd(row.cost))}
${figure(row.active_days, number(row.active_days))}
<td class="line">${number(row.characters)} characters · ${number(row.pages)} pages · ${row.tokens === 0 ? "" : `${number(row.tokens)} worker tokens · `}${costs === null ? "" : `${usd(row.cost)} · `}${dateLabel(row.last_active)}</td>
</tr>`;
    })
    .join("");

  const first = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const last = Math.min(total, page * PAGE_SIZE);
  const step = (target: number, name: "previous" | "next", label: string): string =>
    `<button class="icon-button" name="page" value="${target}" title="${label}" aria-label="${label}"${target < 1 || target > pages ? " disabled" : ""}>${icon(name)}</button>`;

  return shell(
    "accounts",
    "",
    `<main><form method="post" action="/admin/accounts">
<input type="hidden" name="s" value="${state.sort.id}"><input type="hidden" name="d" value="${state.direction}">
<div class="bar"><h1>Accounts<span class="count">${state.search === "" ? number(everyone) : `${number(total)} of ${number(everyone)}`}</span></h1>
<label class="search">${icon("search")}<input type="search" name="q" value="${escapeHtml(state.search)}" placeholder="Email or phone" aria-label="Search accounts by email or phone" autocomplete="off" spellcheck="false"></label>
<button class="icon-button" formaction="/admin/accounts.csv" title="Download as CSV" aria-label="Download as CSV">${icon("download")}<span>CSV</span></button></div>
<div class="sorts" role="group" aria-label="Sort"><span>${shortMonth(month)}</span>${["characters", "pages", "tokens", "cost", "allowance", "active", "joined", "account"]
      .flatMap((id) => columns.filter((item) => item.id === id))
      .map((column) => {
        return `<button name="sort" value="${column.id}"${column === state.sort ? ' aria-pressed="true"' : ""}>${column.label}${column === state.sort ? icon(state.direction === "asc" ? "up" : "down") : ""}</button>`;
      })
      .join("")}</div>
${
  list.length === 0
    ? `<div class="sheet"><p class="empty none">No account matches</p></div>`
    : `<div class="sheet"><table class="accounts">
<thead><tr class="groups"><td colspan="6"></td><th colspan="${costs === null ? 5 : 6}" scope="colgroup">${monthLabel(month)}</th><th scope="colgroup" class="num">30 days</th></tr>
<tr>${columns.map(heading).join("")}</tr></thead>
<tbody>${body}</tbody></table></div>`
}
<div class="pager"><span>${number(first)}–${number(last)} of ${number(total)}</span>${step(page - 1, "previous", "Previous page")}${step(page + 1, "next", "Next page")}</div>
</form></main>`,
  );
};

// ---------------------------------------------------------------------------------------------
// One account

interface UserRecord {
  readonly id: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly field: string | null;
  readonly field_other: string | null;
  readonly workplace: string | null;
  readonly country: string | null;
  readonly signup_method: string;
  readonly created_at: string;
}

type Totals = Record<Counter, number>;

const findUser = (env: Env, id: string): Promise<UserRecord | null> =>
  env.DB.prepare(
    "SELECT id, email, phone, field, field_other, workplace, country, signup_method, created_at FROM users WHERE id = ?",
  )
    .bind(id)
    .first<UserRecord>();

const accountCsv = async (env: Env, id: string): Promise<Response | null> => {
  if ((await findUser(env, id)) === null) return null;
  const list = await rows<{ day: string; client: string } & Totals>(
    env.DB.prepare(`SELECT day, client, ${COUNTERS.join(", ")} FROM usage_daily WHERE user_id = ? ORDER BY day, client`).bind(id),
  );
  return csvResponse(`doedesk-account-${id.slice(0, 8)}-daily.csv`, [
    ["account_id", "day_utc", "client", ...COUNTERS],
    ...list.map((row) => [id, row.day, row.client, ...COUNTERS.map((counter) => row[counter])]),
  ]);
};

const accountPage = async (env: Env, id: string): Promise<string | null> => {
  const user = await findUser(env, id);
  if (user === null) return null;
  const db = env.DB;
  const month = utcMonth();
  const since = dayOf(89);
  const days = Array.from({ length: 90 }, (_, index) => dayOf(89 - index));
  const sums = COUNTERS.map((counter) => `SUM(${counter}) AS ${counter}`).join(", ");
  const costs = unitCosts(env);
  const [privacyCard, daily, months, clients, sessions, lastUsed] = await Promise.all([
    accountPrivacyCard(env, id),
    rows<{ day: string; characters: number; pages: number; requests: number }>(
      db
        .prepare(
          "SELECT day, SUM(detect_characters) AS characters, SUM(ocr_pages) AS pages, SUM(detect_requests + ocr_files + worker_requests) AS requests " +
            "FROM usage_daily WHERE user_id = ? AND day >= ? GROUP BY day",
        )
        .bind(id, since),
    ),
    rows<{ month: string } & Totals>(
      db
        .prepare(
          `SELECT month, ${sums} FROM (SELECT month, ${COUNTERS.join(", ")} FROM usage WHERE user_id = ?1 ` +
            `UNION ALL SELECT substr(day, 1, 7) AS month, ${COUNTERS.join(", ")} FROM usage_daily WHERE user_id = ?1) ` +
            "GROUP BY month ORDER BY month DESC",
        )
        .bind(id),
    ),
    rows<{ client: string } & Totals>(
      db.prepare(`SELECT client, ${sums} FROM usage_daily WHERE user_id = ? AND day >= ? GROUP BY client`).bind(id, since),
    ),
    rows<{ client: string; device: string | null; last_used_at: string }>(
      db.prepare("SELECT client, device, last_used_at FROM sessions WHERE user_id = ? ORDER BY last_used_at DESC LIMIT 20").bind(id),
    ),
    db.prepare("SELECT MAX(day) AS day FROM usage_daily WHERE user_id = ?").bind(id).first<{ day: string | null }>(),
  ]);

  const costOf = (row: Totals, prices: UnitCosts): number =>
    estimatedCostUsd({ units: row.detect_records, pages: row.ocr_pages, inputTokens: row.worker_input_tokens, outputTokens: row.worker_output_tokens }, prices);
  const requestsOf = (row: Totals): number => row.detect_requests + row.ocr_files + row.worker_requests;
  const zero = Object.fromEntries(COUNTERS.map((counter) => [counter, 0])) as Totals;
  const now = months.find((row) => row.month === month) ?? { month, ...zero };
  const recent = clients.reduce<Totals>(
    (total, row) => Object.fromEntries(COUNTERS.map((counter) => [counter, total[counter] + row[counter]])) as Totals,
    zero,
  );
  const lastActive = [sessions[0]?.last_used_at ?? "", lastUsed?.day ?? "", user.created_at].sort().at(-1) ?? user.created_at;
  const series = (key: "characters" | "pages" | "requests") => new Map(daily.map((row) => [row.day, row[key]]));

  const tile = (title: string, figure: string, delta: string, share?: number): string =>
    `<section class="card tile"><h2>${title}</h2><div class="figure">${figure}</div><div class="delta">${share === undefined ? "" : meterBar(share)}${delta}</div></section>`;
  const fact = (name: string, value: string): string => (value === "" ? "" : `<div><dt>${name}</dt><dd>${value}</dd></div>`);
  const monthRow = (row: { month: string } & Totals): string =>
    `<tr><td class="nowrap">${shortMonth(row.month)}</td><td class="num">${number(row.detect_characters)}</td><td class="num wide-only">${number(row.detect_records)}</td><td class="num">${number(row.ocr_pages)}</td><td class="num wide-only">${number(row.ocr_files)}</td><td class="num">${number(row.worker_input_tokens)}</td><td class="num wide-only">${number(row.worker_output_tokens)}</td><td class="num">${number(requestsOf(row))}</td><td class="num wide-only">${number(row.detect_refused + row.ocr_refused + row.worker_refused + row.detect_too_large + row.ocr_too_large + row.worker_too_large)}</td><td class="num wide-only">${number(row.detect_failed + row.ocr_failed + row.worker_failed)}</td>${costs === null ? "" : `<td class="num">${usd(costOf(row, costs))}</td>`}</tr>`;
  const clientCounts: ReadonlyArray<Count> = clients
    .map((row) => ({ label: row.client, count: requestsOf(row) }))
    .toSorted((left, right) => right.count - left.count);

  return shell(
    "accounts",
    "",
    `<main>
<a class="back" href="/admin/accounts">${icon("previous")}Accounts</a>
<div class="bar"><h1><bdi>${escapeHtml(user.email ?? user.phone ?? user.id)}</bdi></h1>
<a class="icon-button" href="/admin/accounts/${user.id}.csv" title="Download daily rows as CSV" aria-label="Download daily rows as CSV">${icon("download")}<span>CSV</span></a></div>
<dl class="meta">${fact("Field", escapeHtml(fieldLabel(user.field, user.field_other)))}${fact("Workplace", escapeHtml(user.workplace === null ? "" : (WORKPLACE_LABELS[user.workplace] ?? user.workplace)))}${fact("Country", escapeHtml(user.country ?? ""))}${fact("Sign-in", user.signup_method === "phone" ? "Phone" : "Email")}${fact("Joined", dateLabel(user.created_at))}${fact("Last active", dateLabel(lastActive))}</dl>
<div class="grid compact">
<h3 class="scope">${monthLabel(month)}</h3>
${tile("Characters", number(now.detect_characters), `${percent(now.detect_characters / MONTHLY_DETECT_CHARACTERS)} of ${number(MONTHLY_DETECT_CHARACTERS)}`, now.detect_characters / MONTHLY_DETECT_CHARACTERS)}
${tile("Pages", number(now.ocr_pages), `${percent(now.ocr_pages / MONTHLY_OCR_PAGES)} of ${number(MONTHLY_OCR_PAGES)}`, now.ocr_pages / MONTHLY_OCR_PAGES)}
${tile("Worker tokens", number(now.worker_input_tokens), `${percent(now.worker_input_tokens / MONTHLY_WORKER_INPUT_TOKENS)} of ${number(MONTHLY_WORKER_INPUT_TOKENS)} · ${number(now.worker_output_tokens)} answered`, now.worker_input_tokens / MONTHLY_WORKER_INPUT_TOKENS)}
${tile("Requests", number(requestsOf(now)), `${number(now.detect_requests)} text · ${number(now.ocr_files)} files · ${number(now.worker_requests)} worker`)}
${costs === null ? "" : tile("Est. cost", usd(costOf(now, costs)), `${number(now.detect_records)} engine units · ${number(now.ocr_pages)} pages · ${number(now.worker_input_tokens + now.worker_output_tokens)} worker tokens`)}
<h3 class="scope">Last 90 days</h3>
${dailyChart("Characters", days, series("characters")).replace('class="card chart"', 'class="card chart third"')}
${dailyChart("Pages", days, series("pages")).replace('class="card chart"', 'class="card chart third"')}
${dailyChart("Requests", days, series("requests")).replace('class="card chart"', 'class="card chart third"')}
${breakdown("Clients", clientCounts, CLIENT_LABELS)
  .replace('class="card"', 'class="card wide"')
  .replace(
    "</section>",
    sessions.length === 0
      ? "</section>"
      : `<details><summary>Sign-ins</summary><table><thead><tr><th>Client</th><th>Device</th><th class="num">Last used</th></tr></thead><tbody>${sessions
          .map(
            (session) =>
              `<tr><td>${escapeHtml(CLIENT_LABELS[session.client] ?? session.client)}</td><td>${escapeHtml(session.device ?? "")}</td><td class="num">${dateLabel(session.last_used_at)}</td></tr>`,
          )
          .join("")}</tbody></table></details></section>`,
  )}
<section class="card wide"><h2>Refused and failed</h2><table><thead><tr><td></td><th class="num">Allowance used up</th><th class="num">Too large</th><th class="num">Failed</th><th class="num" title="Answers the worker gave from a region other than the expected one">Off region</th></tr></thead><tbody>
<tr><th scope="row">Text</th><td class="num">${number(recent.detect_refused)}</td><td class="num">${number(recent.detect_too_large)}</td><td class="num">${number(recent.detect_failed)}</td><td></td></tr>
<tr><th scope="row">Files</th><td class="num">${number(recent.ocr_refused)}</td><td class="num">${number(recent.ocr_too_large)}</td><td class="num">${number(recent.ocr_failed)}</td><td></td></tr>
<tr><th scope="row">Worker</th><td class="num">${number(recent.worker_refused)}</td><td class="num">${number(recent.worker_too_large)}</td><td class="num">${number(recent.worker_failed)}</td><td class="num">${number(recent.worker_off_region)}</td></tr>
</tbody></table></section>
<h3 class="scope">Terms and rights</h3>
${privacyCard}
<h3 class="scope">By month</h3>
<section class="card full">${
      months.length === 0
        ? `<p class="empty">None yet</p>`
        : `<div class="scroll tall"><table><thead><tr><th>Month</th><th class="num">Characters</th><th class="num wide-only">Engine units</th><th class="num">Pages</th><th class="num wide-only">Files</th><th class="num">Worker tokens</th><th class="num wide-only">Answered</th><th class="num">Requests</th><th class="num wide-only">Refused</th><th class="num wide-only">Failed</th>${costs === null ? "" : '<th class="num">Est. cost</th>'}</tr></thead><tbody>${months.map(monthRow).join("")}</tbody></table></div>`
    }</section>
</div></main>`,
  );
};

// ---------------------------------------------------------------------------------------------
// How usage spreads across accounts

/** The value below which `share` of the sorted values fall, by nearest rank. */
const percentile = (sorted: ReadonlyArray<number>, share: number): number =>
  sorted.length === 0 ? 0 : (sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(share * sorted.length) - 1))] ?? 0);

const CHARACTER_BANDS: ReadonlyArray<readonly [string, number]> = [
  ["None", 1],
  ["Under 10,000", 10_000],
  ["10,000 to 100,000", 100_000],
  ["100,000 to 500,000", 500_000],
  ["500,000 to 1.5 million", 1_500_000],
  ["1.5 million or more", Number.POSITIVE_INFINITY],
];
const PAGE_BANDS: ReadonlyArray<readonly [string, number]> = [
  ["None", 1],
  ["1 to 10", 11],
  ["11 to 50", 51],
  ["51 to 100", 101],
  ["101 to 199", MONTHLY_OCR_PAGES],
  [`${MONTHLY_OCR_PAGES} or more`, Number.POSITIVE_INFINITY],
];

const distributionPage = async (env: Env, url: URL): Promise<string> => {
  const thisMonth = utcMonth();
  const lastMonth = previousMonth(thisMonth);
  const requested = url.searchParams.get("month") ?? "";
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(requested) ? requested : thisMonth;
  const costs = unitCosts(env);
  const [accounts] = await Promise.all([
    rows<{ field: string | null; characters: number; units: number; pages: number; tokens: number; outputTokens: number; requests: number }>(
      env.DB.prepare(
        `SELECT users.field AS field, COALESCE(m.characters, 0) AS characters, COALESCE(m.units, 0) AS units,
                COALESCE(m.pages, 0) AS pages, COALESCE(m.tokens, 0) AS tokens, COALESCE(m.out_tokens, 0) AS outputTokens,
                COALESCE(m.requests, 0) AS requests
         FROM users LEFT JOIN (
           SELECT user_id, SUM(detect_characters) AS characters, SUM(detect_records) AS units,
                  SUM(ocr_pages) AS pages, SUM(worker_input_tokens) AS tokens, SUM(worker_output_tokens) AS out_tokens,
                  SUM(detect_requests + ocr_files + worker_requests) AS requests
           FROM (${monthRows(MONTH_COLUMNS)})
           GROUP BY user_id
         ) m ON m.user_id = users.id`,
      ).bind(month),
    ),
  ]);
  const everyone = accounts.map((account) => ({
    ...account,
    cost: costs === null ? 0 : estimatedCostUsd({ units: account.units, pages: account.pages, inputTokens: account.tokens, outputTokens: account.outputTokens }, costs),
  }));
  const active = everyone.filter((account) => account.characters > 0 || account.pages > 0 || account.requests > 0);
  type Measure = "characters" | "pages" | "requests" | "tokens" | "cost";
  const sorted = (list: typeof everyone, measure: Measure): Array<number> =>
    list.map((account) => account[measure]).sort((left, right) => left - right);
  const sum = (list: typeof everyone, measure: Measure | "units" | "outputTokens"): number =>
    list.reduce((total, account) => total + account[measure], 0);
  const show = (measure: Measure, value: number): string =>
    measure === "cost" ? usd(value) : `<span title="${number(value)}">${compact(value)}</span>`;

  const MEASURES: ReadonlyArray<Measure> = costs === null ? ["characters", "pages", "requests", "tokens"] : ["characters", "pages", "requests", "tokens", "cost"];
  const values = Object.fromEntries(MEASURES.map((measure) => [measure, sorted(active, measure)])) as Record<Measure, Array<number>>;
  const spread = (label: string, share: number): string =>
    `<tr><th scope="row">${label}</th>${MEASURES.map((measure) => `<td class="num">${show(measure, percentile(values[measure], share))}</td>`).join("")}</tr>`;
  const tenth = Math.max(1, Math.ceil(active.length / 10));
  const topShare = (measure: Measure, count: number): string => {
    const total = sum(active, measure);
    const top = sorted(active, measure)
      .reverse()
      .slice(0, count)
      .reduce((part, value) => part + value, 0);
    return `<td class="num">${total === 0 ? "0%" : percent(top / total)}</td>`;
  };
  const top = (label: string, count: number): string =>
    `<tr><th scope="row">${label}</th>${topShare("characters", count)}${topShare("pages", count)}${costs === null ? "" : topShare("cost", count)}</tr>`;
  const bands = (measure: "characters" | "pages", limits: ReadonlyArray<readonly [string, number]>): ReadonlyArray<Count> =>
    limits.map(([label, below], index) => ({
      label,
      count: everyone.filter((account) => account[measure] < below && account[measure] >= (index === 0 ? 0 : (limits[index - 1]?.[1] ?? 0))).length,
    }));
  const fields = [...new Set(everyone.map((account) => account.field))]
    .map((field) => {
      const all = everyone.filter((account) => account.field === field);
      const used = all.filter((account) => active.includes(account));
      return { field, all, used };
    })
    .toSorted((left, right) => right.used.length - left.used.length || right.all.length - left.all.length);
  const atAllowance = active.filter((account) => allowanceShare(account.characters, account.pages, account.tokens) >= 1).length;
  const pastHalf = active.filter((account) => allowanceShare(account.characters, account.pages, account.tokens) >= 0.5).length;
  const totalCost = sum(active, "cost");
  const costValues = values.cost ?? [];

  const tile = (title: string, figure: string, delta: string): string =>
    `<section class="card tile"><h2>${title}</h2><div class="figure">${figure}</div><div class="delta">${delta}</div></section>`;

  return shell(
    "distribution",
    `<nav class="periods" aria-label="Month">${[thisMonth, lastMonth].map((value) => `<a href="/admin/distribution?month=${value}"${value === month ? ' aria-current="true"' : ""}>${shortMonth(value)}</a>`).join("")}</nav>`,
    `<main class="grid compact">
${tile("Active accounts", number(active.length), `of ${number(everyone.length)}`)}
${
  costs === null
    ? ""
    : `${tile("Est. cost", usd(totalCost), `${number(sum(active, "units"))} engine units · ${number(sum(active, "pages"))} pages · ${number(sum(active, "tokens") + sum(active, "outputTokens"))} worker tokens`)}
${tile("Cost per active account", usd(active.length === 0 ? 0 : totalCost / active.length), `median ${usd(percentile(costValues, 0.5))} · highest ${usd(percentile(costValues, 1))}`)}`
}
${tile("At the allowance", number(atAllowance), `${number(pastHalf)} past half of it`)}
<section class="card wide"><h2>Per active account</h2><table><thead><tr><td></td><th class="num">Characters</th><th class="num">Pages</th><th class="num">Requests</th><th class="num">Worker tokens</th>${costs === null ? "" : '<th class="num">Est. cost</th>'}</tr></thead><tbody>
${spread("Median", 0.5)}${spread("75th percentile", 0.75)}${spread("90th", 0.9)}${spread("99th", 0.99)}${spread("Highest", 1)}
</tbody></table></section>
<section class="card wide"><h2>Share from the heaviest accounts</h2><table><thead><tr><td></td><th class="num">Characters</th><th class="num">Pages</th>${costs === null ? "" : '<th class="num">Est. cost</th>'}</tr></thead><tbody>
${top("Top 1", 1)}${top("Top 5", 5)}${top("Top 10", 10)}${top(`Top tenth (${number(tenth)})`, tenth)}
</tbody></table></section>
${breakdown("Accounts by characters", bands("characters", CHARACTER_BANDS)).replace('class="card"', 'class="card wide"')}
${breakdown("Accounts by pages", bands("pages", PAGE_BANDS)).replace('class="card"', 'class="card wide"')}
<section class="card full"><h2>By field</h2><div class="fit"><table><thead><tr><th>Field</th><th class="num wide-only">Accounts</th><th class="num">Active</th><th class="num" title="Median across the field's active accounts">Median characters</th><th class="num wide-only">90th</th><th class="num" title="Median across the field's active accounts">Median pages</th><th class="num wide-only">90th</th>${costs === null ? "" : '<th class="num" title="Average estimated cost per active account">Average cost</th>'}</tr></thead><tbody>${fields
      .map(({ field, all, used }) => {
        const characters = sorted(used, "characters");
        const pages = sorted(used, "pages");
        return `<tr><td>${escapeHtml(field === null ? "Not answered" : (FIELD_LABELS[field] ?? field))}</td><td class="num wide-only">${number(all.length)}</td><td class="num">${number(used.length)}</td><td class="num">${show("characters", percentile(characters, 0.5))}</td><td class="num wide-only">${show("characters", percentile(characters, 0.9))}</td><td class="num">${show("pages", percentile(pages, 0.5))}</td><td class="num wide-only">${show("pages", percentile(pages, 0.9))}</td>${costs === null ? "" : `<td class="num">${usd(used.length === 0 ? 0 : sum(used, "cost") / used.length)}</td>`}</tr>`;
      })
      .join("")}</tbody></table></div></section>
</main>`,
  );
};

// ---------------------------------------------------------------------------------------------
// Routes. The caller has already checked the admin key.

const ACCOUNT_PATH = /^\/admin\/accounts\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\.csv)?$/;

const notFound = (): Response =>
  html(shell("accounts", "", `<main><a class="back" href="/admin/accounts">${icon("previous")}Accounts</a><p class="empty">No such account</p></main>`), 404);

/** Answers the usage views, or null when the address is not one of them. */
export const usageViews = async (request: Request, env: Env, url: URL): Promise<Response | null> => {
  const path = url.pathname.replace(/(.)\/$/, "$1");
  if (path === "/admin/accounts" || path === "/admin/accounts.csv") {
    const parameters = new URLSearchParams(url.searchParams);
    // The search term is read from the form body only: an address is logged, a body is not.
    parameters.delete("q");
    if (request.method === "POST") {
      for (const [key, value] of await request.formData()) if (typeof value === "string") parameters.set(key, value);
    }
    const state = tableState(parameters, columnsFor(unitCosts(env)));
    return path.endsWith(".csv") ? accountsCsv(env, state) : html(await accountsPage(env, state));
  }
  if (request.method !== "GET") return null;
  if (path === "/admin/distribution") return html(await distributionPage(env, url));
  if (path.startsWith("/admin/accounts/")) {
    const match = ACCOUNT_PATH.exec(path);
    const id = match?.[1];
    if (id === undefined) return notFound();
    if (match?.[2] !== undefined) return (await accountCsv(env, id)) ?? notFound();
    const page = await accountPage(env, id);
    return page === null ? notFound() : html(page);
  }
  return null;
};
