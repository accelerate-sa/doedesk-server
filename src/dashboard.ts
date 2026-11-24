// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Accelerate Technology Establishment
import { extension } from "./extension.ts";
import { MARK_SVG } from "./brand.ts";
import { type Env, escapeHtml } from "./http.ts";
import { MONTHLY_DETECT_CHARACTERS, monthRows, utcMonth } from "./usage.ts";

const PERIODS = [7, 30, 90] as const;

export const FIELD_LABELS: Record<string, string> = {
  legal: "Legal",
  finance: "Finance",
  government: "Government services",
  healthcare: "Healthcare",
  hr: "Human resources",
  real_estate: "Real estate",
  consulting: "Consulting",
  engineering: "Engineering and IT",
  research: "Research and education",
  other: "Other",
};
export const WORKPLACE_LABELS: Record<string, string> = {
  self: "On their own",
  small_company: "Company under 50",
  large_company: "Company of 50 or more",
  government: "Government entity",
};

export interface Count {
  readonly label: string | null;
  readonly count: number;
}

export const number = (value: number): string => new Intl.NumberFormat("en-US").format(value);
export const dayOf = (offset: number): string => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
export const dayLabel = (day: string): string =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

export const rows = async <T>(statement: D1PreparedStatement): Promise<ReadonlyArray<T>> => (await statement.all<T>()).results;
export const one = async (statement: D1PreparedStatement): Promise<number> =>
  (await statement.first<{ value: number }>())?.value ?? 0;

/** A list of counts in the order given, drawn as rows with a thin bar: the form for a handful of categories. */
export const breakdown = (title: string, counts: ReadonlyArray<Count>, labels: Record<string, string> = {}): string => {
  const total = Math.max(1, counts.reduce((sum, item) => sum + item.count, 0));
  const max = Math.max(1, ...counts.map((item) => item.count));
  const body =
    counts.length === 0
      ? `<p class="empty">None yet</p>`
      : `<ul class="ranks" style="--num:${Math.max(3, number(max).length)}ch">${counts
          .map((item) => {
            const label = item.label === null ? "Not answered" : (labels[item.label] ?? item.label);
            return `<li><span class="name">${escapeHtml(label)}</span><span class="track"><i style="inline-size:${(item.count / max) * 100}%"></i></span><span class="num">${number(item.count)}</span><span class="share">${Math.round((item.count / total) * 100)}%</span></li>`;
          })
          .join("")}</ul>`;
  return `<section class="card"><h2>${title}</h2>${body}</section>`;
};

/** One series over days: bars on a zero baseline, a value on hover, the table behind a disclosure. */
export const dailyChart = (
  title: string,
  days: ReadonlyArray<string>,
  values: ReadonlyMap<string, number>,
  /** The figure beside the title. Daily counts of distinct things do not add up, so those pass their own. */
  headline?: number,
): string => {
  const series = days.map((day) => values.get(day) ?? 0);
  const max = Math.max(1, ...series);
  const width = 600;
  const height = 120;
  const step = width / days.length;
  const barWidth = Math.max(2, step - 2);
  const bars = series
    .map((value, index) => {
      const barHeight = value === 0 ? 0 : Math.max(3, (value / max) * (height - 8));
      const x = index * step + (step - barWidth) / 2;
      const radius = Math.min(4, barWidth / 2, barHeight);
      const top = height - barHeight;
      const shape =
        barHeight === 0
          ? ""
          : `<path d="M${x} ${height}V${top + radius}a${radius} ${radius} 0 0 1 ${radius}-${radius}h${barWidth - 2 * radius}a${radius} ${radius} 0 0 1 ${radius} ${radius}V${height}z"/>`;
      return `<g class="bar" data-tip="${dayLabel(days[index] ?? "")}: ${number(value)}">${shape}<rect class="hit" x="${index * step}" y="0" width="${step}" height="${height}"/></g>`;
    })
    .join("");
  const total = series.reduce((sum, value) => sum + value, 0);
  const figure = headline ?? total;
  return `<section class="card chart"><h2>${title}<span class="total">${number(figure)}</span></h2>
<div class="plot"><svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="${title}: ${number(figure)}">${bars}<line x1="0" x2="${width}" y1="${height}" y2="${height}"/></svg><div class="tip" hidden></div></div>
<div class="axis"><span>${dayLabel(days[0] ?? "")}</span><span>peak ${number(max === 1 && total === 0 ? 0 : max)}</span><span>${dayLabel(days.at(-1) ?? "")}</span></div>
<details><summary>Table</summary><div class="scroll"><table><tbody>${days
    .map((day, index) => `<tr><td>${dayLabel(day)}</td><td class="num">${number(series[index] ?? 0)}</td></tr>`)
    .toReversed()
    .join("")}</tbody></table></div></details></section>`;
};

const STYLE = `
:root{color-scheme:light dark;--paper:#f5f3ee;--card:#fff;--ink:#171815;--muted:#5c5e56;--border:#ddd9cf;--accent:#96531f;--track:#efece5;--bad:#a11c12}
@media (prefers-color-scheme:dark){:root{--paper:#121311;--card:#1a1c19;--ink:#eceae3;--muted:#a2a599;--border:#2b2e29;--accent:#e2a674;--track:#242722;--bad:#ff8b80}}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
.page{max-width:110rem;margin:0 auto;padding:1.5rem}
header{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem 1.5rem;margin-bottom:1.5rem;min-height:2.25rem}
.brand{display:flex;align-items:center;gap:.5rem;font-weight:600;color:inherit;text-decoration:none}
.tabs{display:flex;gap:1.25rem;margin-inline-end:auto;font-size:.9375rem}
.tabs a{color:var(--muted);text-decoration:none;padding:.3rem 0;border-bottom:2px solid transparent}
.tabs a:hover{color:var(--ink)}
.tabs a[aria-current]{color:var(--ink);border-bottom-color:var(--accent)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.brand svg{width:1.25rem;height:1.25rem}
.periods{display:flex;gap:.125rem;background:var(--track);border-radius:.6rem;padding:.125rem}
.periods a{padding:.3rem .75rem;border-radius:.5rem;color:var(--muted);text-decoration:none;font-size:.875rem;font-variant-numeric:tabular-nums}
.periods a[aria-current]{background:var(--card);color:var(--ink);box-shadow:0 0 0 1px var(--border)}
.grid{display:grid;gap:.75rem;grid-template-columns:repeat(12,minmax(0,1fr))}
.card{background:var(--card);border:1px solid var(--border);border-radius:.8rem;padding:1.25rem;grid-column:span 4;min-width:0}
.tile{grid-column:span 3}
.chart{grid-column:span 6}
.wide{grid-column:span 6}
@media (max-width:70rem){.card,.chart,.wide{grid-column:span 6}.tile{grid-column:span 6}}
@media (max-width:40rem){.page{padding:1rem}.card,.chart,.wide,.tile{grid-column:span 12}}
h2{margin:0 0 .75rem;font-size:.875rem;font-weight:500;color:var(--muted);display:flex;justify-content:space-between;align-items:baseline;gap:1rem}
h2 .total{color:var(--ink);font-weight:600;font-variant-numeric:tabular-nums}
.tile .figure{font-size:2.25rem;line-height:1.15;font-weight:700;letter-spacing:-.02em}
.tile .delta{margin-top:.25rem;font-size:.8125rem;color:var(--muted);font-variant-numeric:tabular-nums}
.empty{margin:0;color:var(--muted);font-size:.875rem}
.ranks{list-style:none;margin:0;padding:0;display:grid;gap:.5rem}
.ranks li{display:grid;grid-template-columns:minmax(0,11rem) minmax(2rem,1fr) var(--num,3ch) 4ch;align-items:center;gap:.75rem;font-size:.875rem}
.ranks .name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ranks .track{height:.375rem;background:var(--track);border-radius:.25rem;overflow:hidden}
.ranks .track i{display:block;height:100%;background:var(--accent);border-radius:.25rem}
.num,.share{text-align:end;font-variant-numeric:tabular-nums}
.share{color:var(--muted)}
.plot{position:relative}
.plot svg{display:block;width:100%;height:7.5rem;overflow:visible}
.plot path{fill:var(--accent)}
.plot line{stroke:var(--border);stroke-width:1;vector-effect:non-scaling-stroke}
.plot .hit{fill:transparent}
.plot .bar:hover path{opacity:.75}
.tip{position:absolute;top:-.25rem;transform:translate(-50%,-100%);background:var(--ink);color:var(--paper);padding:.2rem .5rem;border-radius:.4rem;font-size:.8125rem;white-space:nowrap;pointer-events:none;font-variant-numeric:tabular-nums}
.axis{display:flex;justify-content:space-between;margin-top:.375rem;font-size:.8125rem;color:var(--muted);font-variant-numeric:tabular-nums}
details{margin-top:.75rem;font-size:.875rem}
summary{cursor:pointer;color:var(--muted);width:fit-content}
table{width:100%;border-collapse:collapse;font-size:.875rem;margin-top:.5rem}
td,th{padding:.4rem 0;border-top:1px solid var(--border);text-align:start;font-weight:400;vertical-align:top}
th{color:var(--muted);border-top:0;font-size:.8125rem}
td+td,th+th{padding-inline-start:1rem}
.crash{color:var(--bad)}
details .scroll{max-height:16rem;overflow:auto}
.scroll.tall{max-height:24rem;overflow:auto}
.scroll thead th{position:sticky;top:0;background:var(--card)}
thead td{border-top:0}
tbody th{border-top:1px solid var(--border);color:var(--ink);font-size:inherit;white-space:nowrap}
.nowrap{white-space:nowrap}
.fit{overflow-x:auto}
a{color:inherit}
.full{grid-column:span 12}
.third{grid-column:span 4}
.scope{grid-column:1/-1;margin:.75rem 0 -.25rem;font-size:.8125rem;font-weight:500;color:var(--muted)}
.scope:first-child{margin-top:0}
.meter{display:inline-block;inline-size:3rem;block-size:.375rem;background:var(--track);border-radius:.25rem;overflow:hidden;vertical-align:middle;margin-inline-end:.5rem}
.meter i{display:block;block-size:100%;background:var(--accent);border-radius:.25rem}
.bar{display:flex;align-items:center;gap:.5rem;margin-bottom:.75rem}
h1{margin:0 auto 0 0;font-size:1.25rem;line-height:1.3;font-weight:600;letter-spacing:-.01em;display:flex;align-items:baseline;gap:.5rem;min-width:0;overflow-wrap:anywhere}
h1 .count{font-size:.875rem;font-weight:400;color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}
.search{position:relative;flex:0 1 18rem;min-width:0}
.search svg{position:absolute;inset-inline-start:.6rem;top:50%;translate:0 -50%;width:1rem;height:1rem;color:var(--muted);pointer-events:none}
.search input{width:100%;font:inherit;font-size:.875rem;padding:.45rem .6rem .45rem 2rem;border:1px solid var(--border);border-radius:.6rem;background:var(--card);color:inherit;appearance:none}
.search input::placeholder{color:var(--muted)}
.icon-button{display:inline-flex;align-items:center;gap:.35rem;font:inherit;font-size:.8125rem;line-height:1.25rem;padding:.45rem .65rem;border:1px solid var(--border);border-radius:.6rem;background:var(--card);color:inherit;cursor:pointer;text-decoration:none;white-space:nowrap}
.icon-button svg{width:1rem;height:1rem;flex:none}
.icon-button:hover{border-color:var(--muted)}
.icon-button[disabled]{opacity:.4;cursor:default;border-color:var(--border)}
.back{display:inline-flex;align-items:center;gap:.15rem;margin:0 0 .5rem -.2rem;color:var(--muted);text-decoration:none;font-size:.875rem}
.back svg{width:1rem;height:1rem}
.back:hover{color:var(--ink)}
.meta{display:flex;flex-wrap:wrap;gap:.25rem 1.5rem;margin:0 0 1.25rem;font-size:.875rem}
.meta div{display:flex;gap:.4rem}
.meta dt{color:var(--muted)}
.meta dd{margin:0}
.sheet{background:var(--card);border:1px solid var(--border);border-radius:.8rem;overflow-x:auto}
.none{padding:1.25rem}
.accounts{margin:0;font-size:.875rem}
.accounts th,.accounts td{padding:.55rem .6rem;white-space:nowrap;vertical-align:middle}
.accounts td+td,.accounts th+th,.accounts td+th{padding-inline-start:.6rem}
.accounts tr>:first-child{padding-inline-start:.9rem}
.accounts tr>:last-child{padding-inline-end:.9rem}
.accounts .meter{inline-size:2.5rem}
.accounts thead tr:first-child>*{border-top:0;padding-bottom:0}
.accounts .groups th{font-size:.75rem;color:var(--muted);box-shadow:inset 0 -1px var(--border);padding-bottom:.3rem}
.accounts .groups th+th{box-shadow:none}
.accounts thead tr+tr th{border-top:0}
.accounts th button{all:unset;cursor:pointer;display:inline-flex;align-items:center;gap:.2rem;color:var(--muted);font-size:.8125rem}
.accounts th button:hover,.accounts th[aria-sort] button{color:var(--ink)}
.accounts th button:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:.2rem}
.accounts th svg,.sorts svg{width:.8rem;height:.8rem}
.accounts .who{max-width:17rem;overflow:hidden;text-overflow:ellipsis;font-weight:500}
.accounts .who a{text-decoration:none}
.accounts .who a:hover{text-decoration:underline;text-decoration-color:var(--accent);text-underline-offset:.2em}
.accounts tbody tr:hover{background:color-mix(in srgb,var(--track) 55%,transparent)}
.accounts .line,.sorts{display:none}
.zero{color:var(--muted)}
.pager{display:flex;justify-content:flex-end;align-items:center;gap:.5rem;margin-top:.75rem;font-size:.875rem;color:var(--muted);font-variant-numeric:tabular-nums}
.pager .icon-button{padding:.4rem}
.pager span{margin-inline-end:.25rem}
.out{margin:0}
.badge{display:inline-block;margin-inline-start:.35rem;padding:0 .4rem;border-radius:1rem;background:var(--accent);color:var(--card);font-size:.75rem;font-weight:600;line-height:1.25rem;font-variant-numeric:tabular-nums}
.warn{color:var(--bad)}
.note{margin:.6rem 0 0;color:var(--muted);font-size:.8125rem}
.state{margin:0 0 .5rem;font-size:.9375rem}
.row{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem}
.actions{margin-top:.9rem}
.field{font:inherit;font-size:.875rem;padding:.45rem .6rem;border:1px solid var(--border);border-radius:.6rem;background:var(--card);color:inherit;min-width:0}
.field.grow{flex:1 1 14rem}
.icon-button.danger{color:var(--bad)}
.icon-button.danger:hover{border-color:var(--bad)}
.narrow{max-width:38rem}
.narrow h1{margin-bottom:.75rem}
.plain{margin:0;padding-inline-start:1.1rem;display:grid;gap:.3rem;font-size:.9375rem}
code{font:.8125rem ui-monospace,SFMono-Regular,Menlo,monospace}
pre.mail{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:.8125rem/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}
.mail .who{font-weight:400}
.mail .unread td{font-weight:600}
.tabs a{white-space:nowrap}
@media (max-width:70rem){.third{grid-column:span 12}.full{grid-column:span 12}}
@media (max-width:40rem){
.tabs{gap:.9rem;flex-wrap:wrap}
.brand span{display:none}
.wide-only{display:none}
td+td,th+th,td+th,th+td{padding-inline-start:.6rem}
.bar{flex-wrap:wrap}
.bar .search{order:3;flex:1 0 100%}
.fit .num{width:1%}
.grid.compact .tile{grid-column:span 6;padding:1rem}
.grid.compact .tile .figure{font-size:1.5rem}
.grid.compact .tile .meter{display:block;inline-size:auto;margin:.45rem 0 .35rem}
.search input{font-size:1rem}
.sorts{display:flex;align-items:center;gap:.4rem;overflow-x:auto;margin:0 -1rem .75rem;padding:0 1rem;font-size:.8125rem;color:var(--muted);scrollbar-width:none}
.sorts span{white-space:nowrap;margin-inline-end:.25rem}
.sorts button{all:unset;cursor:pointer;display:inline-flex;align-items:center;gap:.2rem;white-space:nowrap;padding:.3rem .65rem;border:1px solid var(--border);border-radius:1rem;background:var(--card);color:var(--muted)}
.sorts button[aria-pressed]{color:var(--ink);border-color:var(--muted)}
.accounts,.accounts tbody{display:block}
.accounts thead{display:none}
.accounts tr{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:.15rem .75rem;padding:.7rem .9rem;border-top:1px solid var(--border);position:relative}
.accounts tr:first-child{border-top:0}
.accounts tr>td,.accounts tr>td:first-child,.accounts tr>td:last-child{display:none;padding:0;border:0}
.accounts tr>td.who{display:block;max-width:none}
.accounts td.who a::after{content:"";position:absolute;inset:0}
.accounts tr>td.allow{display:block}
.accounts tr>td.line{display:block;grid-column:1/-1;color:var(--muted);font-size:.8125rem;white-space:normal}
}
`;

const SCRIPT = `
for (const plot of document.querySelectorAll(".plot")) {
  const tip = plot.querySelector(".tip");
  plot.addEventListener("pointermove", (event) => {
    const bar = event.target.closest(".bar");
    if (!bar) { tip.hidden = true; return; }
    const box = plot.getBoundingClientRect();
    const hit = bar.querySelector(".hit").getBoundingClientRect();
    tip.textContent = bar.dataset.tip;
    tip.style.insetInlineStart = "auto";
    tip.style.left = Math.min(box.width - 40, Math.max(40, hit.left + hit.width / 2 - box.left)) + "px";
    tip.hidden = false;
  });
  plot.addEventListener("pointerleave", () => { tip.hidden = true; });
}`;

/** The dashboard's own views; a layer beside the service names its own (src/extension.ts). */
export type Section = "overview" | "accounts" | "distribution" | "privacy" | "mail" | (string & {});

/** Where the count of unread mail goes in the page. admin.ts fills it in for every view. */
export const MAIL_BADGE = "<!--unread-mail-->";

const SECTIONS: ReadonlyArray<{ readonly id: Section; readonly href: string; readonly label: string }> = [
  { id: "overview", href: "/admin", label: "Overview" },
  { id: "accounts", href: "/admin/accounts", label: "Accounts" },
  { id: "distribution", href: "/admin/distribution", label: "Spread" },
  { id: "privacy", href: "/admin/privacy", label: "Privacy" },
  { id: "mail", href: "/admin/mail", label: `Mail${MAIL_BADGE}` },
];

/**
 * The page every dashboard view sits in. `control` goes at the end of the header; `main` is the
 * `<main>` element. The title never names an account, so nothing identifying reaches the tab or history.
 */
export const shell = (section: Section, control: string, main: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>DoeDesk dashboard</title><link rel="icon" href="https://doedesk.com/favicon.svg"><style>${STYLE}</style></head>
<body><div class="page">
<header><a class="brand" href="/admin">${MARK_SVG}<span>DoeDesk</span></a>
<nav class="tabs" aria-label="Views">${[...SECTIONS, ...(extension().adminSections ?? [])].map((item) => `<a href="${item.href}"${item.id === section ? ' aria-current="page"' : ""}>${item.label}</a>`).join("")}</nav>${control}<form method="post" action="/admin/sign-out" class="out"><button class="icon-button">Sign out</button></form></header>
${main}</div><script>${SCRIPT}</script></body></html>`;

export const dashboardPage = async (env: Env, url: URL): Promise<string> => {
  const requested = Number(url.searchParams.get("days"));
  const period = PERIODS.includes(requested as (typeof PERIODS)[number]) ? requested : 30;
  const since = dayOf(period - 1);
  const sinceIso = `${since}T00:00:00.000Z`;
  const days = Array.from({ length: period }, (_, index) => dayOf(period - 1 - index));
  const db = env.DB;
  const month = utcMonth();
  const smsBucket = String(Math.floor(Date.now() / 1000 / 86_400));

  const [
    accounts,
    newAccounts,
    activeInstalls,
    turns,
    crashes,
    smsToday,
    signupsByDay,
    activeByDay,
    fields,
    workplaces,
    countries,
    methods,
    providers,
    events,
    usage,
    recentCrashes,
  ] = await Promise.all([
    one(db.prepare("SELECT COUNT(*) AS value FROM users")),
    one(db.prepare("SELECT COUNT(*) AS value FROM users WHERE created_at >= ?").bind(sinceIso)),
    one(db.prepare("SELECT COUNT(DISTINCT install_id) AS value FROM events WHERE day >= ?").bind(since)),
    one(db.prepare("SELECT COUNT(*) AS value FROM events WHERE day >= ? AND event = 'client.turn.requested'").bind(since)),
    one(db.prepare("SELECT COUNT(*) AS value FROM crash_reports WHERE day >= ?").bind(since)),
    one(db.prepare("SELECT count AS value FROM rate_limits WHERE key = 'sms:all:86400' AND bucket = ?").bind(smsBucket)),
    rows<{ day: string; count: number }>(
      db.prepare("SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS count FROM users WHERE created_at >= ? GROUP BY day").bind(sinceIso),
    ),
    rows<{ day: string; count: number }>(
      db.prepare("SELECT day, COUNT(DISTINCT install_id) AS count FROM events WHERE day >= ? GROUP BY day").bind(since),
    ),
    rows<Count>(db.prepare("SELECT field AS label, COUNT(*) AS count FROM users GROUP BY field ORDER BY count DESC")),
    rows<Count>(db.prepare("SELECT workplace AS label, COUNT(*) AS count FROM users GROUP BY workplace ORDER BY count DESC")),
    rows<Count>(db.prepare("SELECT COALESCE(country, 'Unknown') AS label, COUNT(*) AS count FROM users GROUP BY label ORDER BY count DESC LIMIT 8")),
    rows<Count>(db.prepare("SELECT signup_method AS label, COUNT(*) AS count FROM users GROUP BY signup_method ORDER BY count DESC")),
    rows<Count>(
      db
        .prepare(
          "SELECT COALESCE(json_extract(properties, '$.provider'), 'unknown') AS label, COUNT(*) AS count FROM events " +
            "WHERE day >= ? AND event = 'provider.request.completed' GROUP BY label ORDER BY count DESC LIMIT 8",
        )
        .bind(since),
    ),
    rows<Count>(db.prepare("SELECT event AS label, COUNT(*) AS count FROM events WHERE day >= ? GROUP BY event ORDER BY count DESC LIMIT 8").bind(since)),
    db
      .prepare(
        `SELECT COALESCE(SUM(detect_characters), 0) AS characters, COALESCE(SUM(ocr_pages), 0) AS pages, COALESCE(SUM(worker_input_tokens), 0) AS tokens FROM (${monthRows("detect_characters, ocr_pages, worker_input_tokens")})`,
      )
      .bind(month)
      .first<{ characters: number; pages: number; tokens: number }>(),
    rows<{ received_at: string; source: string; app_version: string | null; message: string }>(
      db.prepare("SELECT received_at, source, app_version, message FROM crash_reports ORDER BY received_at DESC LIMIT 20"),
    ),
  ]);

  const tile = (title: string, figure: string, delta: string): string =>
    `<section class="card tile"><h2>${title}</h2><div class="figure">${figure}</div><div class="delta">${delta}</div></section>`;
  const periodName = `${period} days`;

  return shell(
    "overview",
    `<nav class="periods" aria-label="Period">${PERIODS.map((value) => `<a href="/admin?days=${value}"${value === period ? ' aria-current="true"' : ""}>${value}d</a>`).join("")}</nav>`,
    `<main class="grid">
${tile("Accounts", number(accounts), `+${number(newAccounts)} in ${periodName}`)}
${tile("Active installs", number(activeInstalls), `${number(turns)} messages sent`)}
${tile("Text checked this month", number(usage?.characters ?? 0), `${number(usage?.pages ?? 0)} pages read · ${number(usage?.tokens ?? 0)} worker tokens · ${number(MONTHLY_DETECT_CHARACTERS)} per account`)}
${tile("Crash reports", number(crashes), `${number(smsToday)} SMS codes today`)}
${dailyChart("New accounts", days, new Map(signupsByDay.map((row) => [row.day, row.count])))}
${dailyChart("Active installs by day", days, new Map(activeByDay.map((row) => [row.day, row.count])), activeInstalls)}
${breakdown("Field", fields, FIELD_LABELS)}
${breakdown("Workplace", workplaces, WORKPLACE_LABELS)}
${breakdown("Country", countries)}
${breakdown("Sign-in", methods, { phone: "Phone", email: "Email" })}
${breakdown("AI provider", providers)}
${breakdown("Events", events)}
${
  recentCrashes.length === 0
    ? ""
    : `<section class="card wide"><h2>Latest crash reports</h2><details><summary>${recentCrashes.length} reports</summary><div class="scroll"><table><thead><tr><th>When</th><th>App</th><th>Message</th></tr></thead><tbody>${recentCrashes
        .map(
          (crash) =>
            `<tr><td>${escapeHtml(crash.received_at.slice(0, 16).replace("T", " "))}</td><td>${escapeHtml(`${crash.source} ${crash.app_version ?? ""}`)}</td><td class="crash">${escapeHtml(crash.message.slice(0, 300))}</td></tr>`,
        )
        .join("")}</tbody></table></div></details></section>`
}
</main>`,
  );
};
