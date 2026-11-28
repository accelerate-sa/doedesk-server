// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Accelerate Technology Establishment
/**
 * Admin views for anonymous product feedback reports submitted by DoeDesk agents (`agent.feedback`).
 *
 *   GET  /admin/feedback          list of reports with unread/open/closed filters
 *   GET  /admin/feedback.json     recent reports as JSON
 *   GET  /admin/feedback/<id>     one report, its expected/actual/workaround fields and sanitized trace
 *   POST /admin/feedback          action=read-all | close | reopen
 */
import { back, copyButton, dayLabel, dot, filterBox, hint, icon, number, rows, shell } from "./dashboard.ts";
import { type Env, escapeHtml, html, json, nowIso } from "./http.ts";

export interface FeedbackSummaryRow {
  readonly id: string;
  readonly received_at: string;
  readonly at: string;
  readonly country: string | null;
  readonly app_version: string | null;
  readonly kind: string;
  readonly subject: string;
  readonly user_requested: number;
  readonly source: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly expected: string | null;
  readonly actual: string | null;
  readonly has_trace: number;
  readonly read_at: string | null;
  readonly closed_at: string | null;
}

interface FeedbackDetailRow extends Omit<FeedbackSummaryRow, "has_trace"> {
  readonly workaround: string | null;
  readonly trace: string | null;
  readonly properties: string;
}

const when = (iso: string): string => `${dayLabel(iso.slice(0, 10))} ${iso.slice(0, 4)}, ${iso.slice(11, 16)}`;
const day = (iso: string): string => `${dayLabel(iso.slice(0, 10))} ${iso.slice(0, 4)}`;
const words = (value: string): string => value.replace(/[_-]+/g, " ");
const seeOther = (location: string): Response => new Response(null, { status: 303, headers: { location } });
const page = (main: string, status = 200): Response => html(shell("feedback", "", main), status);

const KIND_TONE: Record<string, "bad" | "accent" | "muted"> = {
  bug: "bad",
  tool_bug: "bad",
  error: "bad",
  broken: "bad",
  confusing: "accent",
  confusing_behavior: "accent",
  friction: "accent",
  missing: "accent",
  missing_feature: "accent",
};

const formatJson = (raw: string): string => {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
};

export const feedbackCounts = async (env: Env): Promise<{ readonly unread: number; readonly open: number; readonly total: number }> => {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS total, " +
      "COALESCE(SUM(CASE WHEN read_at IS NULL THEN 1 ELSE 0 END), 0) AS unread, " +
      "COALESCE(SUM(CASE WHEN closed_at IS NULL THEN 1 ELSE 0 END), 0) AS open FROM agent_feedback",
  ).first<{ total: number; unread: number; open: number }>();
  return { total: row?.total ?? 0, unread: row?.unread ?? 0, open: row?.open ?? 0 };
};

const feedbackList = async (env: Env): Promise<string> => {
  const [list, counts] = await Promise.all([
    rows<FeedbackSummaryRow>(
      env.DB.prepare(
        "SELECT id, received_at, at, country, app_version, kind, subject, user_requested, source, provider, model, expected, actual, " +
          "CASE WHEN trace IS NOT NULL AND trace <> '' THEN 1 ELSE 0 END AS has_trace, read_at, closed_at " +
          "FROM agent_feedback ORDER BY (closed_at IS NOT NULL), received_at DESC LIMIT 300",
      ),
    ),
    feedbackCounts(env),
  ]);

  const show = (value: string, label: string, pressed = false): string =>
    `<button type="button" data-show="${value}" aria-pressed="${pressed}">${label}</button>`;

  return `<main>
<div class="bar"><h1>Feedback<span class="count">${number(counts.unread)} unread · ${number(counts.open)} open</span></h1>
${hint("Anonymous product reports from agents (Settings > Labs). No install ID or account ID is stored.")}</div>
<div class="sheet" data-filter>
<div class="toolbar"><div class="periods" role="group" aria-label="Show" data-js hidden>${show("", "All", true)}${show("unread", "Unread")}${show("open", "Open")}${show("approved", "User approved")}${show("closed", "Closed")}</div>
${filterBox("Filter feedback")}<span class="spacer"></span>
<form method="post" action="/admin/feedback"><button class="icon-button square" name="action" value="read-all" title="Mark all read" aria-label="Mark all read"${counts.unread === 0 ? " disabled" : ""}>${icon("checks")}</button></form></div>
${
  list.length === 0
    ? `<div class="none"><p class="empty">No agent feedback reports yet</p></div>`
    : `<div class="fit"><table class="accounts mail"><thead><tr><th>Subject</th><th>Kind</th><th>Approval</th><th>App</th><th>Received</th><th></th></tr></thead><tbody>${list
        .map((row) => {
          const states = [
            row.closed_at !== null ? "closed" : "open",
            ...(row.read_at === null && row.closed_at === null ? ["unread"] : []),
            ...(row.user_requested === 1 ? ["approved"] : []),
          ].join(" ");
          const appInfo = [row.app_version, row.provider].filter(Boolean).join(" · ");
          const details = [
            row.has_trace === 1 ? "Trace" : "",
            row.closed_at === null ? "" : `Closed ${day(row.closed_at)}`,
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            `<tr class="${states}" data-state="${states}">` +
            `<td class="who">${row.read_at === null ? dot("accent").replace("<i", '<i title="Unread"') : ""}<a href="/admin/feedback/${encodeURIComponent(row.id)}"><bdi>${escapeHtml(row.subject)}</bdi></a></td>` +
            `<td class="keep">${dot(KIND_TONE[row.kind] ?? "muted")}${escapeHtml(words(row.kind))}</td>` +
            `<td class="keep">${row.user_requested === 1 ? "Approved" : "Automatic"}</td>` +
            `<td>${escapeHtml(appInfo || row.source || "—")}</td>` +
            `<td class="nowrap">${when(row.received_at)}</td>` +
            `<td class="zero">${escapeHtml(details)}</td>` +
            `<td class="line">${escapeHtml(words(row.kind))} · ${row.user_requested === 1 ? "approved" : "automatic"}${appInfo ? ` · ${escapeHtml(appInfo)}` : ""} · ${day(row.received_at)}${row.closed_at === null ? "" : " · closed"}</td>` +
            `</tr>`
          );
        })
        .join("")}</tbody></table></div><div class="none" data-none hidden><p class="empty">No match</p></div>`
}
</div></main>`;
};

const feedbackDetail = async (env: Env, id: string): Promise<string | null> => {
  const row = await env.DB.prepare(
    "SELECT id, received_at, at, country, app_version, kind, subject, user_requested, source, provider, model, expected, actual, workaround, trace, properties, read_at, closed_at " +
      "FROM agent_feedback WHERE id = ?",
  )
    .bind(id)
    .first<FeedbackDetailRow>();
  if (row === null) return null;
  if (row.read_at === null) {
    await env.DB.prepare("UPDATE agent_feedback SET read_at = ? WHERE id = ? AND read_at IS NULL").bind(nowIso(), id).run();
  }

  const fact = (name: string, value: string | null, more = ""): string =>
    value === null || value === "" ? "" : `<div><dt>${name}</dt><dd><bdi>${escapeHtml(value)}</bdi>${more}</dd></div>`;

  const providerLine = [row.provider, row.model].filter(Boolean).join(" / ");
  const hasProse = Boolean(row.expected || row.actual || row.workaround);
  const prettyTrace = row.trace === null ? null : formatJson(row.trace);
  const prettyProps = formatJson(row.properties);

  return `<main>${back("/admin/feedback", "Feedback")}
<div class="bar"><h1><bdi>${escapeHtml(row.subject)}</bdi><span class="count">${escapeHtml(words(row.kind))}</span></h1>
<form method="post" action="/admin/feedback" class="out"><input type="hidden" name="id" value="${escapeHtml(row.id)}">
<button class="icon-button" name="action" value="${row.closed_at === null ? "close" : "reopen"}">${row.closed_at === null ? `${icon("check")}Close` : `${icon("undo")}Reopen`}</button></form></div>
<dl class="meta">
${fact("Approval", row.user_requested === 1 ? "User approved" : "Automatic (categories only)")}
${fact("Source", row.source === null ? null : row.source.toUpperCase())}
${fact("App", row.app_version)}
${fact("Provider", providerLine || null)}
${fact("Country", row.country)}
${fact("Received", `${when(row.received_at)} UTC`)}
${fact("Closed", row.closed_at === null ? null : day(row.closed_at))}
${fact("Report", row.id.slice(0, 8), copyButton(row.id, "Copy report ID"))}
</dl>
<div class="grid">
<section class="card full"><h2>Report</h2>
${
  hasProse
    ? `<div class="feedback-grid">${
        row.expected === null ? "" : `<div class="feedback-block"><h3>Expected</h3><p>${escapeHtml(row.expected)}</p></div>`
      }${
        row.actual === null ? "" : `<div class="feedback-block"><h3>Actual</h3><p>${escapeHtml(row.actual)}</p></div>`
      }${
        row.workaround === null ? "" : `<div class="feedback-block"><h3>Workaround</h3><p>${escapeHtml(row.workaround)}</p></div>`
      }</div>`
    : `<p class="empty">Unprompted report: only categories${prettyTrace === null ? "" : " and trace"} were sent; agent prose stayed on the user's computer.</p>`
}
</section>
${
  prettyTrace === null
    ? ""
    : `<section class="card full"><div class="head"><h2>Trace</h2>${copyButton(prettyTrace, "Copy trace JSON")}</div>
<details open><summary>Sanitized trace</summary><div class="scroll tall"><pre class="mail">${escapeHtml(prettyTrace)}</pre></div></details></section>`
}
<section class="card full"><div class="head"><h2>Properties</h2>${copyButton(prettyProps, "Copy properties JSON")}</div>
<details><summary>Raw JSON</summary><div class="scroll tall"><pre class="mail">${escapeHtml(prettyProps)}</pre></div></details></section>
</div></main>`;
};

const feedbackAction = async (env: Env, form: FormData): Promise<Response> => {
  const action = form.get("action");
  const id = String(form.get("id") ?? "");
  const now = nowIso();
  if (action === "read-all") {
    await env.DB.prepare("UPDATE agent_feedback SET read_at = ? WHERE read_at IS NULL").bind(now).run();
    return seeOther("/admin/feedback");
  }
  if (action === "close") {
    await env.DB.prepare("UPDATE agent_feedback SET closed_at = ?, read_at = COALESCE(read_at, ?) WHERE id = ? AND closed_at IS NULL")
      .bind(now, now, id)
      .run();
    return seeOther("/admin/feedback");
  }
  if (action === "reopen") {
    await env.DB.prepare("UPDATE agent_feedback SET closed_at = NULL WHERE id = ?").bind(id).run();
    return seeOther(`/admin/feedback/${encodeURIComponent(id)}`);
  }
  return seeOther("/admin/feedback");
};

export const feedbackViews = async (request: Request, env: Env, url: URL): Promise<Response | null> => {
  const path = url.pathname.replace(/(.)\/$/, "$1");
  if (path === "/admin/feedback.json" && request.method === "GET") {
    const [counts, items] = await Promise.all([
      feedbackCounts(env),
      rows<FeedbackSummaryRow>(
        env.DB.prepare(
          "SELECT id, received_at, at, country, app_version, kind, subject, user_requested, source, provider, model, expected, actual, " +
            "CASE WHEN trace IS NOT NULL AND trace <> '' THEN 1 ELSE 0 END AS has_trace, read_at, closed_at " +
            "FROM agent_feedback ORDER BY received_at DESC LIMIT 200",
        ),
      ),
    ]);
    return json({ counts, items });
  }
  if (path === "/admin/feedback" && request.method === "GET") return page(await feedbackList(env));
  if (path === "/admin/feedback" && request.method === "POST") return feedbackAction(env, await request.formData());
  if (path.startsWith("/admin/feedback/") && request.method === "GET") {
    const id = decodeURIComponent(path.slice("/admin/feedback/".length));
    const detail = await feedbackDetail(env, id);
    return detail === null
      ? page(`<main>${back("/admin/feedback", "Feedback")}<div class="sheet"><div class="none"><p class="empty">No such report</p></div></div></main>`, 404)
      : page(detail);
  }
  return null;
};
