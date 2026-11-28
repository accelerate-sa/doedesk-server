// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Accelerate Technology Establishment
import { extension } from "./extension.ts";
import { MARK_SVG } from "./brand.ts";
import { type Env, escapeHtml } from "./http.ts";
import { monthRows, utcMonth } from "./usage.ts";

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
  self: "Solo",
  small_company: "Under 50",
  large_company: "50 or more",
  government: "Government",
};

export interface Count {
  readonly label: string | null;
  readonly count: number;
}

export const number = (value: number): string => new Intl.NumberFormat("en-US").format(value);
export const dayOf = (offset: number): string => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
export const dayLabel = (day: string): string =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const monthName = (month: string): string =>
  new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" });

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

export const ICON = {
  download: '<path d="M12 4v11m0 0-4-4m4 4 4-4M5 19.5h14"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>',
  previous: '<path d="m14.5 6-6 6 6 6"/>',
  next: '<path d="m9.5 6 6 6-6 6"/>',
  down: '<path d="M12 5v14m0 0-5-5m5 5 5-5"/>',
  up: '<path d="M12 19V5m0 0-5 5m5-5 5 5"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  checks: '<path d="m2.5 12.5 4 4L15 8M11.5 15.5l1 1L21.5 8"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  out: '<path d="M10 4.5H6.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2H10M15 8l4 4-4 4M19 12H9.5"/>',
  trash: '<path d="M4.5 7h15M9.5 7V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2M6.5 7l.8 11.2a2 2 0 0 0 2 1.8h5.4a2 2 0 0 0 2-1.8L17.5 7M10 11v5M14 11v5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>',
  alert: '<path d="M12 4 3 19.5h18L12 4zM12 10v4.5M12 17h.01"/>',
  play: '<path d="M7.5 5.5v13l11-6.5-11-6.5z"/>',
  undo: '<path d="M4 12a8 8 0 1 0 2.6-5.9M4 5v4h4"/>',
} as const;

/** One icon of the dashboard's set: a 24-unit grid, one stroke weight, the text colour. */
export const icon = (name: keyof typeof ICON): string =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;

/** Copies `value` when pressed and shows a tick. Hidden until the page's script finds a clipboard. */
export const copyButton = (value: string, label = "Copy"): string =>
  `<button type="button" class="icon-button square ghost copy" data-copy="${escapeHtml(value)}" title="${label}" aria-label="${label}" hidden>${icon("copy")}${icon("check")}</button>`;

/** A detail behind an icon: shown on hover and on focus, so it is there for a keyboard and a finger too. */
export const hint = (text: string): string =>
  `<span class="hint" tabindex="0" role="note" aria-label="${escapeHtml(text)}" data-tip="${escapeHtml(text)}">${icon("info")}</span>`;

/** A coloured dot before a word, for a state. */
export const dot = (tone: "good" | "bad" | "accent" | "muted"): string => `<i class="dot ${tone}"></i>`;

/**
 * A box that filters the rows of the table it shares a `data-filter` container with, as the owner
 * types. It filters what is on the page and asks the server nothing, so it is shown by the script.
 */
export const filterBox = (label: string): string =>
  `<label class="search" data-js hidden>${icon("search")}<input type="search" placeholder="Filter" aria-label="${label}" aria-keyshortcuts="/" autocomplete="off" spellcheck="false"><kbd>/</kbd></label>`;

export const back = (href: string, label: string): string => `<a class="back" href="${href}">${icon("previous")}${label}</a>`;

const STYLE = `
:root{color-scheme:light dark;--paper:#f5f3ee;--card:#fff;--ink:#171815;--muted:#5c5e56;--border:#ddd9cf;--accent:#96531f;--on-accent:#fff;--track:#efece5;--bad:#a11c12;--good:#2c7a4b;--control:2.25rem}
@media (prefers-color-scheme:dark){:root{--paper:#121311;--card:#1a1c19;--ink:#eceae3;--muted:#a2a599;--border:#2b2e29;--accent:#e2a674;--on-accent:#1d1309;--track:#242722;--bad:#ff8b80;--good:#7fcf9b}}
@media (pointer:coarse){:root{--control:2.5rem}}
*{box-sizing:border-box}
[hidden]{display:none!important}
body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
.page{max-width:110rem;margin:0 auto;padding:1.5rem}
header{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem 1.5rem;margin-bottom:1.5rem;min-height:var(--control)}
.brand{display:flex;align-items:center;gap:.5rem;font-weight:600;color:inherit;text-decoration:none;border-radius:.4rem}
.tabs{display:flex;gap:1.25rem;flex:1 1 0;min-width:0;overflow-x:auto;scrollbar-width:none;font-size:.9375rem;padding:2px}
.tabs::-webkit-scrollbar{display:none}
.tabs a{color:var(--muted);text-decoration:none;padding:.3rem 0;border-bottom:2px solid transparent;white-space:nowrap}
.tabs a:hover{color:var(--ink)}
.tabs a[aria-current]{color:var(--ink);border-bottom-color:var(--accent)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.brand svg{width:1.25rem;height:1.25rem}
.periods{display:inline-flex;gap:.125rem;background:var(--track);border-radius:.6rem;padding:.125rem;block-size:var(--control);flex:none}
.periods a,.periods button{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;padding:0 .75rem;border-radius:.5rem;color:var(--muted);font-size:.8125rem;font-weight:500;white-space:nowrap;cursor:pointer}
.periods a:hover,.periods button:hover{color:var(--ink)}
.periods a:focus-visible,.periods button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.periods a[aria-current],.periods button[aria-pressed=true]{background:var(--card);color:var(--ink);box-shadow:0 0 0 1px var(--border)}
.grid{display:grid;gap:.75rem;grid-template-columns:repeat(12,minmax(0,1fr))}
.card{background:var(--card);border:1px solid var(--border);border-radius:.8rem;padding:1.25rem;grid-column:span 4;min-width:0}
.tile{grid-column:span 3}
.kpis{grid-column:1/-1;display:grid;gap:.75rem;grid-template-columns:repeat(auto-fit,minmax(9.5rem,1fr))}
.kpis .tile,.grid.compact .kpis .tile{grid-column:auto}
.chart{grid-column:span 6}
.wide{grid-column:span 6}
@media (max-width:70rem){.card,.chart,.wide{grid-column:span 6}.tile{grid-column:span 6}}
@media (max-width:40rem){.page{padding:1rem}.card,.chart,.wide,.tile{grid-column:span 12}}
h2{margin:0 0 .75rem;font-size:.875rem;font-weight:500;color:var(--muted);display:flex;justify-content:space-between;align-items:baseline;gap:1rem}
h2 .total{color:var(--ink);font-weight:600}
.head{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;margin-bottom:.75rem;min-height:var(--control)}
.head h2{margin:0;flex:1 1 auto}
.head .search{flex:0 1 12rem}
.tile .figure{font-size:2rem;line-height:1.15;font-weight:700;letter-spacing:-.02em}
.tile .delta{margin-top:.25rem;font-size:.8125rem;color:var(--muted)}
.empty{margin:0;color:var(--muted);font-size:.875rem}
.ranks{list-style:none;margin:0;padding:0;display:grid;gap:.5rem}
.ranks li{display:grid;grid-template-columns:minmax(0,11rem) minmax(2rem,1fr) var(--num,3ch) 4ch;align-items:center;gap:.75rem;font-size:.875rem}
.ranks .name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ranks .track{height:.375rem;background:var(--track);border-radius:.25rem;overflow:hidden}
.ranks .track i{display:block;height:100%;background:var(--accent);border-radius:.25rem}
.num,.share{text-align:end}
.share{color:var(--muted)}
.plot{position:relative}
.plot svg{display:block;width:100%;height:7.5rem;overflow:visible}
.plot path{fill:var(--accent)}
.plot line{stroke:var(--border);stroke-width:1;vector-effect:non-scaling-stroke}
.plot .hit{fill:transparent}
.plot .bar:hover path{opacity:.75}
.tip{position:absolute;top:-.25rem;transform:translate(-50%,-100%);background:var(--ink);color:var(--paper);padding:.2rem .5rem;border-radius:.4rem;font-size:.8125rem;white-space:nowrap;pointer-events:none}
.axis{display:flex;justify-content:space-between;margin-top:.375rem;font-size:.8125rem;color:var(--muted)}
details{margin-top:.75rem;font-size:.875rem}
summary{cursor:pointer;color:var(--muted);width:fit-content;border-radius:.3rem}
summary:hover{color:var(--ink)}
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
.nowrap,.keep{white-space:nowrap}
td bdi{overflow-wrap:anywhere}
.fit{overflow-x:auto}
a{color:inherit}
.full{grid-column:span 12}
.third{grid-column:span 4}
.scope{grid-column:1/-1;margin:.75rem 0 -.25rem;font-size:.8125rem;font-weight:500;color:var(--muted)}
.scope:first-child{margin-top:0}
.meter{display:inline-block;inline-size:3rem;block-size:.375rem;background:var(--track);border-radius:.25rem;overflow:hidden;vertical-align:middle;margin-inline-end:.5rem}
.meter i{display:block;block-size:100%;background:var(--accent);border-radius:.25rem}
.meter.over i{background:var(--bad)}
.bar{display:flex;align-items:center;gap:.5rem;margin-bottom:.75rem;min-height:var(--control)}
h1{margin:0 auto 0 0;font-size:1.25rem;line-height:1.3;font-weight:600;letter-spacing:-.01em;display:flex;align-items:baseline;gap:.5rem;min-width:0;overflow-wrap:anywhere}
h1 .count{font-size:.875rem;font-weight:400;color:var(--muted);white-space:nowrap}
.search{position:relative;display:block;flex:0 1 18rem;min-width:0}
.search svg{position:absolute;inset-inline-start:.6rem;top:50%;translate:0 -50%;width:1rem;height:1rem;color:var(--muted);pointer-events:none}
.search input{width:100%;block-size:var(--control);font:inherit;font-size:.875rem;padding:0 .6rem 0 2rem;border:1px solid var(--border);border-radius:.6rem;background:var(--card);color:inherit;appearance:none}
.search input::placeholder{color:var(--muted)}
.search kbd{position:absolute;inset-inline-end:.5rem;top:50%;translate:0 -50%;font:inherit;font-size:.75rem;line-height:1.1rem;padding:0 .35rem;border:1px solid var(--border);border-radius:.3rem;color:var(--muted);pointer-events:none}
.search input:focus~kbd,.search input:not(:placeholder-shown)~kbd{display:none}
@media (pointer:coarse){.search kbd{display:none}}
.icon-button{display:inline-flex;align-items:center;justify-content:center;gap:.4rem;flex:none;block-size:var(--control);min-inline-size:var(--control);padding:0 .75rem;font:inherit;font-size:.8125rem;font-weight:500;line-height:1;border:1px solid var(--border);border-radius:.6rem;background:var(--card);color:inherit;cursor:pointer;text-decoration:none;white-space:nowrap}
.icon-button svg{width:1rem;height:1rem;flex:none}
.icon-button:hover{border-color:var(--muted)}
.icon-button[disabled]{opacity:.4;cursor:default;border-color:var(--border)}
.icon-button.square{inline-size:var(--control);padding:0}
.icon-button.ghost{border-color:transparent;background:transparent;color:var(--muted)}
.icon-button.ghost:hover{background:var(--track);color:var(--ink)}
.icon-button.primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
.icon-button.danger{color:var(--bad)}
.icon-button.danger:hover{border-color:var(--bad)}
.icon-button.danger.solid{background:var(--bad);border-color:var(--bad);color:var(--card)}
.copy{--control:1.75rem;vertical-align:middle;align-self:center}
.copy svg+svg,.copy.done svg{display:none}
.copy.done svg+svg{display:block;color:var(--good)}
.back{display:inline-flex;align-items:center;gap:.15rem;margin:0 0 .5rem -.2rem;color:var(--muted);text-decoration:none;font-size:.875rem;border-radius:.3rem}
.back svg{width:1rem;height:1rem}
.back:hover{color:var(--ink)}
.meta{display:flex;flex-wrap:wrap;align-items:center;gap:.25rem 1.5rem;margin:0 0 1.25rem;font-size:.875rem}
.meta div{display:flex;align-items:center;gap:.4rem}
.meta dt{color:var(--muted)}
.meta dd{margin:0;display:flex;align-items:center;gap:.25rem}
.sheet{background:var(--card);border:1px solid var(--border);border-radius:.8rem;overflow:hidden}
.toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;padding:.6rem .75rem;border-bottom:1px solid var(--border)}
.toolbar.foot{border-bottom:0;border-top:1px solid var(--border);justify-content:flex-end;font-size:.875rem;color:var(--muted)}
.toolbar form{display:contents}
.spacer{flex:1 1 0}
.none{padding:2rem 1.25rem;display:grid;justify-items:center;gap:.75rem}
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
.accounts .who{max-width:15rem;overflow:hidden;text-overflow:ellipsis;font-weight:500}
.accounts .who a{text-decoration:none}
.accounts .who a:hover{text-decoration:underline;text-decoration-color:var(--accent);text-underline-offset:.2em}
.accounts tbody tr:hover{background:color-mix(in srgb,var(--track) 55%,transparent)}
.accounts .line,.sorts{display:none}
.zero{color:var(--muted)}
.pager{display:flex;justify-content:flex-end;align-items:center;gap:.5rem;font-size:.875rem;color:var(--muted)}
.pager span{margin-inline-end:.25rem}
.out{margin:0}
.badge{display:inline-block;margin-inline-start:.35rem;padding:0 .4rem;border-radius:1rem;background:var(--accent);color:var(--on-accent);font-size:.75rem;font-weight:600;line-height:1.25rem}
.warn{color:var(--bad)}
.note{margin:.6rem 0 0;color:var(--muted);font-size:.8125rem}
.state{margin:0 0 .5rem;font-size:.9375rem}
.row{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem}
.row.end{justify-content:flex-end}
.actions{margin-top:.9rem}
.field{font:inherit;font-size:.875rem;block-size:var(--control);padding:0 .6rem;border:1px solid var(--border);border-radius:.6rem;background:var(--card);color:inherit;min-width:0}
.field::placeholder{color:var(--muted)}
.field.grow{flex:1 1 14rem}
.field[aria-invalid=true]{border-color:var(--bad)}
.narrow{max-width:38rem}
.narrow h1{margin-bottom:.75rem}
.plain{margin:0;padding-inline-start:1.1rem;display:grid;gap:.3rem;font-size:.9375rem}
code{font:.8125rem ui-monospace,SFMono-Regular,Menlo,monospace}
pre.mail{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:.8125rem/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}
.feedback-grid{display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(16rem,1fr))}
.feedback-block h3{margin:0 0 .35rem;font-size:.8125rem;font-weight:500;color:var(--muted)}
.feedback-block p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:.9375rem}
.panel-disclosure{margin-top:0}
.panel-disclosure>summary{display:inline-flex;align-items:center;gap:.4rem;font-weight:500;color:var(--ink)}
.panel-disclosure>summary svg{width:1rem;height:1rem;color:var(--muted)}
.panel-disclosure[open]>summary{margin-bottom:.75rem}
.mail .who{font-weight:400}
.mail .unread .who{font-weight:600}
.mail .closed{color:var(--muted)}
.dot{display:inline-block;flex:none;inline-size:.5rem;block-size:.5rem;border-radius:50%;background:var(--muted);margin-inline-end:.45rem;vertical-align:.06em}
.dot.good{background:var(--good)}
.dot.bad{background:var(--bad)}
.dot.accent{background:var(--accent)}
.pill{display:inline-flex;align-items:center;gap:.35rem;flex:none;block-size:1.5rem;padding:0 .6rem;border-radius:1rem;background:var(--track);font-size:.8125rem;white-space:nowrap}
.pill svg{width:.875rem;height:.875rem}
.hint{position:relative;display:inline-flex;flex:none;color:var(--muted);cursor:help;border-radius:50%;align-self:center}
.hint svg{width:1rem;height:1rem}
.hint::after{content:attr(data-tip);position:absolute;z-index:5;inset-block-start:calc(100% + .4rem);inset-inline-end:-.5rem;inline-size:max-content;max-inline-size:min(17rem,70vw);padding:.4rem .6rem;border-radius:.5rem;background:var(--ink);color:var(--paper);font-size:.8125rem;font-weight:400;line-height:1.4;white-space:normal;letter-spacing:0;visibility:hidden;pointer-events:none}
.hint:hover::after,.hint:focus::after{visibility:visible}
.hint.start::after{inset-inline:-.5rem auto}
.sr{position:absolute;inline-size:1px;block-size:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
dialog,.dialog{inline-size:min(24rem,calc(100vw - 2rem));padding:1.25rem;border:1px solid var(--border);border-radius:.9rem;background:var(--card);color:var(--ink)}
dialog{box-shadow:0 1rem 3rem rgb(0 0 0/.3)}
dialog::backdrop{background:rgb(0 0 0/.45)}
.modal{display:grid;justify-items:center;align-content:start;gap:.5rem;padding-top:8vh}
.modal .back{justify-self:start;margin:0 auto .5rem;inline-size:min(24rem,100%);padding:0}
dialog h2,.dialog h1{margin:0 0 .5rem;font-size:1.0625rem;line-height:1.3;font-weight:600;letter-spacing:-.01em;color:var(--ink);justify-content:flex-start;align-items:center;gap:.5rem}
dialog h2 svg,.dialog h1 svg{width:1.125rem;height:1.125rem;flex:none}
dialog h2 .bad,.dialog h1 .bad{color:var(--bad)}
.dialog h1 .good{color:var(--good)}
.detail{margin:0;color:var(--muted);font-size:.875rem;overflow-wrap:anywhere}
.detail+.detail{margin-top:.15rem}
dialog .field,.dialog .field{display:block;inline-size:100%;margin:.9rem 0 0}
dialog .row,.dialog .row{margin-top:.9rem}
@media (max-width:70rem){.third{grid-column:span 12}.full{grid-column:span 12}}
@media (max-width:40rem){
header{gap:.5rem .75rem}
.brand{margin-inline-end:auto}
.tabs{order:3;flex:1 0 100%;gap:1.1rem}
.wide-only{display:none}
.nowrap{white-space:normal}
td+td,th+th,td+th,th+td{padding-inline-start:.6rem}
.bar{flex-wrap:wrap}
.toolbar .search,.head .search{flex:1 1 9rem}
.fit .num{width:1%}
.grid.compact .tile{grid-column:span 6;padding:1rem}
.grid.compact .tile .figure{font-size:1.5rem}
.grid.compact .tile .meter{display:block;inline-size:auto;margin:.45rem 0 .35rem}
.search input,.field{font-size:1rem}
.sorts{display:flex;align-items:center;gap:.4rem;overflow-x:auto;margin:0 -1rem .75rem;padding:2px 1rem;font-size:.8125rem;color:var(--muted);scrollbar-width:none}
.sorts span{white-space:nowrap;margin-inline-end:.25rem}
.sorts button{all:unset;cursor:pointer;display:inline-flex;align-items:center;gap:.2rem;white-space:nowrap;padding:.3rem .65rem;border:1px solid var(--border);border-radius:1rem;background:var(--card);color:var(--muted)}
.sorts button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
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
for (const item of document.querySelectorAll("[data-js]")) item.hidden = false;
const live = document.getElementById("live");

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
}

if (navigator.clipboard) {
  for (const button of document.querySelectorAll("[data-copy]")) {
    button.hidden = false;
    button.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(button.dataset.copy); } catch { return; }
      button.classList.add("done");
      live.textContent = "Copied";
      setTimeout(() => { button.classList.remove("done"); live.textContent = ""; }, 1400);
    });
  }
}

for (const scope of document.querySelectorAll("[data-filter]")) {
  const rows = [...scope.querySelectorAll("tbody tr")];
  const input = scope.querySelector("input[type=search]:not([name])");
  const choices = [...scope.querySelectorAll("[data-show]")];
  const none = scope.querySelector("[data-none]");
  let show = "";
  const apply = () => {
    const term = input ? input.value.trim().toLowerCase() : "";
    let shown = 0;
    for (const row of rows) {
      const hit = (term === "" || row.textContent.toLowerCase().includes(term)) && (show === "" || (row.dataset.state || "").split(" ").includes(show));
      row.hidden = !hit;
      if (hit) shown += 1;
    }
    if (none) none.hidden = shown > 0;
  };
  if (input) input.addEventListener("input", apply);
  for (const choice of choices) {
    choice.addEventListener("click", () => {
      show = choice.dataset.show;
      for (const other of choices) other.setAttribute("aria-pressed", String(other === choice));
      apply();
    });
  }
}

for (const input of document.querySelectorAll("input[type=search][name]")) {
  input.addEventListener("search", () => { if (input.value === "" && input.defaultValue !== "") input.form.requestSubmit(); });
}

document.addEventListener("keydown", (event) => {
  const field = event.target.closest("input, select, textarea");
  if (event.key === "Escape" && field && field.type === "search" && !field.name && !document.querySelector("dialog[open]")) {
    field.value = "";
    field.dispatchEvent(new Event("input"));
    field.blur();
    return;
  }
  if (event.key !== "/" || field || event.metaKey || event.ctrlKey || event.altKey || document.querySelector("dialog[open]")) return;
  const search = [...document.querySelectorAll("input[type=search]")].find((item) => item.offsetParent !== null);
  if (!search) return;
  event.preventDefault();
  search.focus();
  search.select();
});

for (const input of document.querySelectorAll("form input[data-word]")) {
  const submit = input.form.querySelector("button:not([type=button])");
  const check = () => { submit.disabled = input.value.trim() !== input.dataset.word; };
  input.addEventListener("input", check);
  check();
}

const dialog = document.getElementById("confirm");
if (dialog && dialog.showModal) {
  const title = dialog.querySelector("h2 span");
  const detail = dialog.querySelector(".detail");
  const word = dialog.querySelector("input");
  const yes = dialog.querySelector("[value=yes]");
  let pending = null;
  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-confirm]");
    if (!button || !button.form) return;
    event.preventDefault();
    pending = button;
    title.textContent = button.dataset.confirm;
    detail.textContent = button.dataset.detail || "";
    detail.hidden = !button.dataset.detail;
    yes.textContent = button.dataset.yes || "Confirm";
    word.hidden = !button.dataset.word;
    word.value = "";
    word.placeholder = "Type " + (button.dataset.word || "");
    word.setAttribute("aria-label", word.placeholder + " to confirm");
    yes.disabled = Boolean(button.dataset.word);
    dialog.returnValue = "";
    dialog.showModal();
    if (word.hidden) yes.focus(); else word.focus();
  });
  word.addEventListener("input", () => { yes.disabled = word.value.trim() !== pending.dataset.word; });
  dialog.querySelector("[data-cancel]").addEventListener("click", () => dialog.close(""));
  dialog.addEventListener("close", () => {
    if (dialog.returnValue !== "yes" || !pending) return;
    if (pending.dataset.word) {
      const typed = document.createElement("input");
      typed.type = "hidden";
      typed.name = "confirm";
      typed.value = pending.dataset.word;
      pending.form.append(typed);
    }
    pending.form.requestSubmit(pending);
  });
}`;

/**
 * The one confirmation the dashboard asks with. A button that carries `data-confirm` opens it
 * with that question, `data-detail` under it, `data-yes` on its button, and `data-word` as the
 * word to type, which is then sent as `confirm`. Without the script the button posts as it is,
 * and the server asks on a page of its own.
 */
const CONFIRM_DIALOG = `<dialog id="confirm" aria-labelledby="confirm-title"><form method="dialog"><h2 id="confirm-title">${icon("alert").replace("<svg", '<svg class="bad"')}<span></span></h2><p class="detail"></p><input class="field" autocomplete="off" spellcheck="false" autocapitalize="characters"><div class="row end"><button type="button" class="icon-button" data-cancel>Cancel</button><button class="icon-button danger solid" value="yes"></button></div></form></dialog>`;

/** The dashboard's own views; a layer beside the service names its own (src/extension.ts). */
export type Section = "overview" | "accounts" | "distribution" | "privacy" | "mail" | "feedback" | (string & {});

/** Where the unread counts go in the page. admin.ts fills them in for every view. */
export const MAIL_BADGE = "<!--unread-mail-->";
export const FEEDBACK_BADGE = "<!--unread-feedback-->";

const SECTIONS: ReadonlyArray<{ readonly id: Section; readonly href: string; readonly label: string }> = [
  { id: "overview", href: "/admin", label: "Overview" },
  { id: "accounts", href: "/admin/accounts", label: "Accounts" },
  { id: "distribution", href: "/admin/distribution", label: "Spread" },
  { id: "privacy", href: "/admin/privacy", label: "Privacy" },
  { id: "mail", href: "/admin/mail", label: `Mail${MAIL_BADGE}` },
  { id: "feedback", href: "/admin/feedback", label: `Feedback${FEEDBACK_BADGE}` },
];

/**
 * The page every dashboard view sits in. `control` goes at the end of the header; `main` is the
 * `<main>` element. The title never names an account, so nothing identifying reaches the tab or history.
 */
export const shell = (section: Section, control: string, main: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>DoeDesk dashboard</title><link rel="icon" href="https://doedesk.com/favicon.svg"><style>${STYLE}</style></head>
<body><div class="page">
<header><a class="brand" href="/admin" aria-label="DoeDesk">${MARK_SVG}<span>DoeDesk</span></a>
<nav class="tabs" aria-label="Views">${[...SECTIONS, ...(extension().adminSections ?? [])].map((item) => `<a href="${item.href}"${item.id === section ? ' aria-current="page"' : ""}>${item.label}</a>`).join("")}</nav>${control}<form method="post" action="/admin/sign-out" class="out"><button class="icon-button square ghost" title="Sign out" aria-label="Sign out">${icon("out")}</button></form></header>
${main}</div>${CONFIRM_DIALOG}<div id="live" class="sr" role="status"></div><script>${SCRIPT}</script></body></html>`;

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

  return shell(
    "overview",
    `<nav class="periods" aria-label="Period">${PERIODS.map((value) => `<a href="/admin?days=${value}"${value === period ? ' aria-current="true"' : ""}>${value}d</a>`).join("")}</nav>`,
    `<main class="grid">
${tile("Accounts", number(accounts), `+${number(newAccounts)} new`)}
${tile("Active installs", number(activeInstalls), `${number(turns)} messages`)}
${tile(`Characters, ${monthName(month)}`, number(usage?.characters ?? 0), `${number(usage?.pages ?? 0)} pages · ${number(usage?.tokens ?? 0)} worker tokens`)}
${tile("Crashes", number(crashes), `${number(smsToday)} SMS today`)}
${dailyChart("New accounts", days, new Map(signupsByDay.map((row) => [row.day, row.count])))}
${dailyChart("Active installs", days, new Map(activeByDay.map((row) => [row.day, row.count])), activeInstalls)}
${breakdown("Field", fields, FIELD_LABELS)}
${breakdown("Workplace", workplaces, WORKPLACE_LABELS)}
${breakdown("Country", countries)}
${breakdown("Sign-in", methods, { phone: "Phone", email: "Email" })}
${breakdown("AI provider", providers)}
${breakdown("Events", events)}
${
  recentCrashes.length === 0
    ? ""
    : `<section class="card full" data-filter><div class="head"><h2>Latest crashes</h2>${filterBox("Filter crashes")}</div><div class="scroll tall"><table><thead><tr><th>When</th><th>App</th><th>Message</th></tr></thead><tbody>${recentCrashes
        .map(
          (crash) =>
            `<tr><td class="nowrap">${escapeHtml(crash.received_at.slice(0, 16).replace("T", " "))}</td><td class="nowrap">${escapeHtml(`${crash.source} ${crash.app_version ?? ""}`)}</td><td class="crash">${escapeHtml(crash.message.slice(0, 300))}</td></tr>`,
        )
        .join("")}</tbody></table></div><p class="empty" data-none hidden>No match</p></section>`
}
</main>`,
  );
};
