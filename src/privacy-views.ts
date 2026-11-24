// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Accelerate Technology Establishment
/**
 * The owner's views for what the Privacy Policy and the Terms promise: who has accepted the Terms,
 * rights requests (export and deletion for requests that come by mail, and the log), contact mail,
 * and what the nightly job will delete. All of it sits behind the admin key (see admin.ts).
 *
 * An account's identifier, a number, an address or an installation identifier never travels in a
 * web address here: every action that names one is a form posted in the body, so request logs do
 * not record it.
 */
import { acceptanceStatus } from "./acceptance.ts";
import { dayLabel, number, one, rows, shell } from "./dashboard.ts";
import { type Env, escapeHtml, html, json, monthsBefore, nowIso } from "./http.ts";
import { acceptanceRule, compareVersions, LEGAL } from "./legal.ts";
import { forwardAddresses, mailCounts } from "./mail.ts";
import { CONTACT_MAIL_AUTO_CLOSE_DAYS, CONTACT_MAIL_MONTHS_AFTER_CLOSED } from "./periods.ts";
import { blockedPlaces } from "./regions.ts";
import { applyRetention, cleanUsageEvents, type RetentionReport, retentionReport, type UsageEventScope } from "./retention.ts";
import {
  countUsageData,
  deleteAccountForOwner,
  deleteUsageData,
  exportAccount,
  exportUsageData,
  isInstallationIdentifier,
  logRightsRequest,
  RIGHTS_OUTCOMES,
  RIGHTS_TYPES,
  type RightsOutcome,
  type RightsType,
} from "./rights.ts";

const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const when = (iso: string): string => `${dayLabel(iso.slice(0, 10))} ${iso.slice(0, 4)}, ${iso.slice(11, 16)}`;
const day = (iso: string): string => `${dayLabel(iso.slice(0, 10))} ${iso.slice(0, 4)}`;
const words = (value: string): string => value.replace(/_/g, " ");
const tile = (title: string, figure: string, delta: string): string =>
  `<section class="card tile"><h2>${title}</h2><div class="figure">${figure}</div><div class="delta">${delta}</div></section>`;
const download = (name: string, body: unknown): Response =>
  new Response(JSON.stringify(body, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${name}"`,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
const seeOther = (location: string): Response => new Response(null, { status: 303, headers: { location } });
const page = (section: "privacy" | "mail", main: string, status = 200): Response => html(shell(section, "", main), status);
const back = (href: string, label: string): string => `<a class="back" href="${href}">‹ ${label}</a>`;

// ---------------------------------------------------------------------------------------------
// The card on an account's page

/** Where one account stands on the Terms, with the two actions for a request that came by mail. */
export const accountPrivacyCard = async (env: Env, accountId: string): Promise<string> => {
  const [status, history] = await Promise.all([
    acceptanceStatus(env, accountId),
    rows<{ terms_version: string | null; privacy_version: string | null; locale: string | null; method: string; client: string | null; app_version: string | null; accepted_at: string }>(
      env.DB.prepare(
        "SELECT terms_version, privacy_version, locale, method, client, app_version, accepted_at FROM acceptances WHERE user_id = ? AND document = 'terms' ORDER BY accepted_at DESC",
      ).bind(accountId),
    ),
  ]);
  const state = status.outstanding
    ? `<span class="warn">Not accepted</span>${status.termsVersion === null ? "" : ` · last accepted ${escapeHtml(status.termsVersion)}`}`
    : `Accepted ${escapeHtml(status.termsVersion ?? "")} on ${day(status.acceptedAt ?? "")}`;
  return `<section class="card wide"><h2>Terms of Use<span class="total">${LEGAL.terms.required} required</span></h2>
<p class="state">${state}</p>
${
  history.length === 0
    ? ""
    : `<details><summary>Record</summary><table><thead><tr><th>When</th><th>Terms</th><th>Privacy</th><th>Language</th><th>How</th><th>App</th></tr></thead><tbody>${history
        .map(
          (row) =>
            `<tr><td class="nowrap">${when(row.accepted_at)}</td><td>${escapeHtml(row.terms_version ?? "")}</td><td>${escapeHtml(row.privacy_version ?? "")}</td><td>${escapeHtml(row.locale ?? "")}</td><td>${escapeHtml(row.method)}</td><td>${escapeHtml([row.client, row.app_version].filter(Boolean).join(" "))}</td></tr>`,
        )
        .join("")}</tbody></table></details>`
}
<form method="post" action="/admin/rights" class="row actions"><input type="hidden" name="account" value="${accountId}">
<button class="icon-button" name="action" value="export" title="Download everything held about this account, and log the request">Export</button>
<button class="icon-button danger" name="action" value="delete">Delete account…</button></form>
<p class="note">For a request that came by mail. Both are written to the log of requests.</p></section>`;
};

// ---------------------------------------------------------------------------------------------
// Privacy: acceptance, requests, usage data by identifier, retention

const retentionTable = (report: RetentionReport): string =>
  `<table><thead><tr><th>What</th><th>Kept</th><th class="num">${report.applied ? "Removed" : "Would remove now"}</th></tr></thead><tbody>${report.rules
    .map(
      (line) =>
        `<tr><td>${escapeHtml(line.what)}</td><td>${escapeHtml(line.kept)}</td><td class="num${line.rows === 0 ? " zero" : ""}">${line.error === undefined ? number(line.rows) : `<span class="warn">Failed: ${escapeHtml(line.error)}</span>`}</td></tr>`,
    )
    .join("")}</tbody></table>`;

const privacyPage = async (env: Env): Promise<string> => {
  const db = env.DB;
  const since = monthsBefore(1).toISOString();
  const [accounts, accepted, recentRequests, outstanding, requests, choices, report, mail] = await Promise.all([
    one(db.prepare("SELECT COUNT(*) AS value FROM users")),
    rows<{ version: string | null }>(
      db.prepare(
        "SELECT (SELECT terms_version FROM acceptances WHERE acceptances.user_id = users.id AND document = 'terms' ORDER BY accepted_at DESC LIMIT 1) AS version FROM users",
      ),
    ),
    one(db.prepare("SELECT COUNT(*) AS value FROM rights_requests WHERE handled_at >= ?").bind(since)),
    rows<{ id: string; label: string; created_at: string; version: string | null }>(
      db.prepare(
        "SELECT users.id, COALESCE(users.email, users.phone, users.id) AS label, users.created_at, " +
          "(SELECT terms_version FROM acceptances WHERE acceptances.user_id = users.id AND document = 'terms' ORDER BY accepted_at DESC LIMIT 1) AS version " +
          "FROM users ORDER BY users.created_at DESC LIMIT 2000",
      ),
    ),
    rows<{ handled_at: string; type: string; channel: string; outcome: string; account_id: string | null }>(
      db.prepare("SELECT handled_at, type, channel, outcome, account_id FROM rights_requests ORDER BY handled_at DESC LIMIT 100"),
    ),
    rows<{ state: string; count: number }>(db.prepare("SELECT state, COUNT(*) AS count FROM usage_data_choices GROUP BY state")),
    retentionReport(env),
    mailCounts(env),
  ]);
  const isOutstanding = (version: string | null): boolean => version === null || compareVersions(version, LEGAL.terms.required) < 0;
  const acceptedCount = accepted.filter((row) => !isOutstanding(row.version)).length;
  const waiting = outstanding.filter((row) => isOutstanding(row.version));
  const choice = (state: string): number => choices.find((row) => row.state === state)?.count ?? 0;
  const rule = acceptanceRule(env);
  const forwarding = forwardAddresses(env).length;
  const blocked = blockedPlaces(env);
  const setting = (name: string, value: string): string => `<tr><th scope="row">${name}</th><td>${value}</td></tr>`;

  return `<main class="grid compact">
${tile("Terms accepted", number(acceptedCount), `of ${number(accounts)} accounts · version ${LEGAL.terms.required}`)}
${tile("Not accepted", number(accounts - acceptedCount), rule === "all" ? "Detection is refused for them" : rule === "signup" ? "Required at sign-in" : "Recorded, not required")}
${tile("Requests, last month", number(recentRequests), "Access, deletion and others")}
${tile("Usage-data choices", number(choice("on_consented") + choice("on_by_default_notice_shown") + choice("off")), `${number(choice("on_consented"))} agreed · ${number(choice("on_by_default_notice_shown"))} notice · ${number(choice("off"))} off`)}
<section class="card wide"><h2>Accounts that have not accepted<span class="total">${number(waiting.length)}</span></h2>${
    waiting.length === 0
      ? `<p class="empty">None</p>`
      : `<div class="scroll tall"><table><thead><tr><th>Account</th><th>Joined</th><th class="wide-only">Last accepted</th></tr></thead><tbody>${waiting
          .slice(0, 200)
          .map(
            (row) =>
              `<tr><td><a href="/admin/accounts/${row.id}"><bdi>${escapeHtml(row.label)}</bdi></a></td><td class="nowrap">${day(row.created_at)}</td><td class="wide-only">${escapeHtml(row.version ?? "Never")}</td></tr>`,
          )
          .join("")}</tbody></table></div>`
  }</section>
<section class="card wide"><h2>In force</h2><table><tbody>
${setting("Terms and Privacy Policy", `${LEGAL.terms.version} and ${LEGAL.privacy.version}${LEGAL.terms.effective === null ? ` · <span class="warn">no effective date set</span>` : ` · from ${LEGAL.terms.effective}`}`)}
${setting("Acceptance", rule === "off" ? "Recorded when sent; not required" : rule === "signup" ? "Required to sign in" : "Required to sign in and to use the service")}
${setting("Mail forwarding", forwarding === 0 ? `<span class="warn">Not set: mail is stored here only</span>` : `${number(forwarding)} mailbox${forwarding === 1 ? "" : "es"}${mail.notForwarded > 0 ? ` · <span class="warn">${number(mail.notForwarded)} not forwarded</span>` : ""}`)}
${setting("New accounts refused from", `${blocked.length === 0 ? "Nowhere" : escapeHtml(blocked.join(", "))}${env.SIGNUP_BLOCK_EU_UK === "1" ? " · EU, EEA and UK" : ""}`)}
${setting("Usage-data identifiers", env.USAGE_DATA_RANDOM_IDENTIFIERS_ONLY === "1" ? "Random only" : "Random, and the form apps up to 0.1.x send")}
</tbody></table></section>
<section class="card wide"><h2>Requests handled</h2>${
    requests.length === 0
      ? `<p class="empty">None yet</p>`
      : `<div class="scroll tall"><table><thead><tr><th>When</th><th>Request</th><th>From</th><th>Outcome</th><th class="wide-only">Account</th></tr></thead><tbody>${requests
          .map(
            (row) =>
              `<tr><td class="nowrap">${when(row.handled_at)}</td><td>${escapeHtml(words(row.type))}</td><td>${row.channel === "app" ? "The app" : "Mail"}</td><td>${escapeHtml(words(row.outcome))}</td><td class="wide-only"><code>${escapeHtml(row.account_id?.slice(0, 8) ?? "")}</code></td></tr>`,
          )
          .join("")}</tbody></table></div>`
  }
<form method="post" action="/admin/rights" class="row actions"><input type="hidden" name="action" value="log">
<select class="field" name="type" aria-label="Request">${RIGHTS_TYPES.map((type) => `<option value="${type}">${words(type)}</option>`).join("")}</select>
<select class="field" name="outcome" aria-label="Outcome">${RIGHTS_OUTCOMES.map((outcome) => `<option value="${outcome}">${words(outcome)}</option>`).join("")}</select>
<button class="icon-button">Add to the log</button></form>
<p class="note">For a request answered by hand. Export and deletion from an account's page are logged by themselves.</p></section>
<section class="card wide"><h2>Usage data by installation identifier</h2>
<form method="post" action="/admin/rights" class="row actions">
<input class="field grow" name="installation" placeholder="Identifier from Settings" aria-label="Installation identifier" autocomplete="off" spellcheck="false" required>
<button class="icon-button" name="action" value="usage-export">Export</button>
<button class="icon-button danger" name="action" value="usage-delete">Delete…</button></form>
<p class="note">Usage data is not tied to an account. The person quotes the identifier shown in the app's Settings.</p></section>
<section class="card full"><h2>Kept and deleted<span class="total">Nightly, 03:17 UTC</span></h2>
<div class="fit">${retentionTable(report)}</div>
<form method="post" action="/admin/retention" class="row actions"><input class="field" name="confirm" placeholder="Type RUN" aria-label="Type RUN to confirm" autocomplete="off" required>
<button class="icon-button danger">Run now</button></form></section>
</main>`;
};

const confirmPage = (title: string, lines: ReadonlyArray<string>, hidden: Record<string, string>, backTo: string): Response =>
  page(
    "privacy",
    `<main>${back(backTo, "Back")}<section class="card narrow"><h1>${title}</h1>
<ul class="plain">${lines.map((line) => `<li>${line}</li>`).join("")}</ul>
<form method="post" action="/admin/rights" class="row actions">${Object.entries(hidden)
      .map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`)
      .join("")}
<input class="field" name="confirm" placeholder="Type DELETE" aria-label="Type DELETE to confirm" autocomplete="off" required autofocus>
<button class="icon-button danger">Delete for good</button></form>
<p class="note">This cannot be undone.</p></section></main>`,
  );

const resultPage = (title: string, lines: ReadonlyArray<string>, status = 200): Response =>
  page(
    "privacy",
    `<main>${back("/admin/privacy", "Privacy")}<section class="card narrow"><h1>${title}</h1><ul class="plain">${lines.map((line) => `<li>${line}</li>`).join("")}</ul></section></main>`,
    status,
  );

/** POST /admin/rights: export, deletion and the log, for requests that came by mail. */
const rightsAction = async (env: Env, form: FormData): Promise<Response> => {
  const field = (name: string): string => {
    const value = form.get(name);
    return typeof value === "string" ? value.trim() : "";
  };
  const action = field("action");
  const confirmed = field("confirm") === "DELETE";

  if (action === "log") {
    const type = RIGHTS_TYPES.find((candidate) => candidate === field("type")) as RightsType | undefined;
    const outcome = RIGHTS_OUTCOMES.find((candidate) => candidate === field("outcome")) as RightsOutcome | undefined;
    if (type === undefined || outcome === undefined) return resultPage("Nothing was logged", ["Choose a request and an outcome."], 400);
    await logRightsRequest(env, { type, channel: "email", outcome, accountId: null }).run();
    return seeOther("/admin/privacy");
  }

  if (action === "export" || action === "delete") {
    const accountId = field("account").toLowerCase();
    if (!ACCOUNT_ID.test(accountId)) return resultPage("No such account", [], 404);
    if (action === "export") {
      const copy = await exportAccount(env, accountId);
      await logRightsRequest(env, { type: "access", channel: "email", outcome: copy === null ? "not_found" : "done", accountId }).run();
      return copy === null ? resultPage("No such account", [], 404) : download(`doedesk-account-${accountId.slice(0, 8)}.json`, copy);
    }
    if (!confirmed) {
      const account = await env.DB.prepare(
        "SELECT COALESCE(email, phone, id) AS label, created_at, (SELECT COUNT(*) FROM sessions WHERE user_id = users.id) AS sessions, " +
          "(SELECT COUNT(*) FROM usage_daily WHERE user_id = users.id) + (SELECT COUNT(*) FROM usage WHERE user_id = users.id) AS usage_rows FROM users WHERE id = ?",
      )
        .bind(accountId)
        .first<{ label: string; created_at: string; sessions: number; usage_rows: number }>();
      if (account === null) return resultPage("No such account", [], 404);
      return confirmPage(
        "Delete this account?",
        [
          `<bdi>${escapeHtml(account.label)}</bdi>, joined ${day(account.created_at)}`,
          `${number(account.sessions)} sign-ins and ${number(account.usage_rows)} usage records go with it, and the onboarding answers`,
          "The record of acceptance of the Terms is kept for five years, under the account's identifier only",
        ],
        { action: "delete", account: accountId },
        `/admin/accounts/${accountId}`,
      );
    }
    const done = await deleteAccountForOwner(env, accountId);
    return done === null
      ? resultPage("No such account", ["It may have been deleted already. The request was logged as not found."], 404)
      : resultPage("Account deleted", [
          `Deleted ${when(done.deletedAt)} UTC`,
          `Reference for your reply: <code>${done.accountId}</code>`,
          `Acceptance record kept until ${day(done.kept[0]?.until ?? "")}`,
          "Usage data from the app and mail the person sent are not tied to the account; delete those separately if asked",
        ]);
  }

  if (action === "usage-export" || action === "usage-delete") {
    const installation = field("installation").toLowerCase();
    if (!isInstallationIdentifier(installation)) {
      return resultPage("That is not an installation identifier", ["It is a UUID, or 64 hexadecimal characters from apps up to 0.1.x."], 400);
    }
    if (action === "usage-export") {
      const copy = await exportUsageData(env, installation);
      const found = copy.events.length + copy.choices.length + copy.errorReports.length > 0;
      await logRightsRequest(env, { type: "access", channel: "email", outcome: found ? "done" : "not_found", accountId: null }).run();
      return download(`doedesk-usage-data-${installation.slice(0, 8)}.json`, copy);
    }
    if (!confirmed) {
      const counts = await countUsageData(env, installation);
      return confirmPage(
        "Delete this installation's usage data?",
        [`${number(counts.events)} events`, `${number(counts.choices)} records of the choice`, `${number(counts.errorReports)} error reports`],
        { action: "usage-delete", installation },
        "/admin/privacy",
      );
    }
    const counts = await deleteUsageData(env, installation);
    return resultPage("Usage data deleted", [
      `${number(counts.events)} events, ${number(counts.choices)} records of the choice, ${number(counts.errorReports)} error reports`,
    ]);
  }
  return resultPage("Unknown action", [], 400);
};

// ---------------------------------------------------------------------------------------------
// Mail

interface MailRow {
  readonly id: string;
  readonly address: string;
  readonly sender: string | null;
  readonly subject: string | null;
  readonly received_at: string;
  readonly forwarded_at: string | null;
  readonly forward_error: string | null;
  readonly read_at: string | null;
  readonly closed_at: string | null;
}

const decodeBytes = (bytes: Uint8Array, charset: string): string => {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
};

const decodeBody = (body: string, encoding: string, charset: string): string => {
  if (encoding === "base64") {
    try {
      return decodeBytes(Uint8Array.from(atob(body.replace(/\s+/g, "")), (character) => character.charCodeAt(0)), charset);
    } catch {
      return body;
    }
  }
  if (encoding === "quoted-printable") {
    const bytes: Array<number> = [];
    const joined = body.replace(/=\r?\n/g, "");
    for (let index = 0; index < joined.length; index += 1) {
      const hex = joined[index] === "=" ? joined.slice(index + 1, index + 3) : "";
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        index += 2;
      } else bytes.push(joined.charCodeAt(index) & 0xff);
    }
    return decodeBytes(Uint8Array.from(bytes), charset);
  }
  return body;
};

/**
 * The readable text of a stored message: its plain-text part when it has one, decoded. Good enough
 * to read a request on the dashboard when forwarding failed; the forwarded copy is the faithful one.
 */
export const readableMail = (raw: string): { readonly headers: ReadonlyMap<string, string>; readonly text: string } => {
  const split = (part: string): { headers: Map<string, string>; body: string } => {
    const at = part.search(/\r?\n\r?\n/);
    const head = at === -1 ? part : part.slice(0, at);
    const headers = new Map<string, string>();
    for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
      const colon = line.indexOf(":");
      if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
    }
    return { headers, body: at === -1 ? "" : part.slice(at).replace(/^\r?\n\r?\n/, "") };
  };
  const textOf = (part: string, depth: number): string | null => {
    const { headers, body } = split(part);
    const type = headers.get("content-type") ?? "text/plain";
    const boundary = /boundary="?([^";]+)"?/i.exec(type)?.[1];
    if (/^multipart\//i.test(type) && boundary !== undefined && depth < 4) {
      const parts = body.split(`--${boundary}`).slice(1).filter((piece) => !piece.startsWith("--"));
      for (const piece of parts) {
        const found = textOf(piece.replace(/^\r?\n/, ""), depth + 1);
        if (found !== null) return found;
      }
      return null;
    }
    if (!/^text\/plain/i.test(type)) return null;
    return decodeBody(body, (headers.get("content-transfer-encoding") ?? "").toLowerCase(), /charset="?([^";]+)"?/i.exec(type)?.[1] ?? "utf-8");
  };
  const top = split(raw);
  return { headers: top.headers, text: textOf(raw, 0) ?? top.body };
};

const autoCloseNote = `Closed by itself ${CONTACT_MAIL_AUTO_CLOSE_DAYS} days after arrival; deleted ${CONTACT_MAIL_MONTHS_AFTER_CLOSED} months after closing.`;

const mailList = async (env: Env): Promise<string> => {
  const [list, counts] = await Promise.all([
    rows<MailRow>(
      env.DB.prepare(
        "SELECT id, address, sender, subject, received_at, forwarded_at, forward_error, read_at, closed_at FROM contact_mail " +
          "ORDER BY (closed_at IS NOT NULL), received_at DESC LIMIT 300",
      ),
    ),
    mailCounts(env),
  ]);
  const forwarding = forwardAddresses(env).length > 0;
  return `<main>
<div class="bar"><h1>Mail<span class="count">${number(counts.unread)} unread · ${number(counts.open)} open</span></h1>
<form method="post" action="/admin/mail"><button class="icon-button" name="action" value="read-all"${counts.unread === 0 ? " disabled" : ""}>Mark all read</button></form></div>
${forwarding ? "" : `<p class="note warn">Forwarding is not set, so mail reaches this page only. Set MAIL_FORWARD_TO.</p>`}
${
  list.length === 0
    ? `<div class="sheet"><p class="empty none">No mail</p></div>`
    : `<div class="sheet"><table class="accounts mail"><thead><tr><th>Received</th><th>To</th><th>From</th><th>Subject</th><th>Forwarded</th><th>State</th></tr></thead><tbody>${list
        .map(
          (row) =>
            `<tr${row.read_at === null ? ' class="unread"' : ""}><td>${when(row.received_at)}</td><td>${escapeHtml(row.address.split("@")[0] ?? "")}</td><td><bdi>${escapeHtml(row.sender ?? "")}</bdi></td>` +
            `<td class="who"><a href="/admin/mail/${row.id}"><bdi>${escapeHtml(row.subject === null || row.subject === "" ? "(no subject)" : row.subject)}</bdi></a></td>` +
            `<td>${row.forwarded_at === null ? `<span class="warn" title="${escapeHtml(row.forward_error ?? "")}">No</span>` : "Yes"}</td><td>${row.closed_at === null ? (row.read_at === null ? "Unread" : "Open") : `Closed ${day(row.closed_at)}`}</td>` +
            // The one line a phone shows under the subject.
            `<td class="line"><bdi>${escapeHtml(row.sender ?? "")}</bdi> · ${escapeHtml(row.address.split("@")[0] ?? "")} · ${day(row.received_at)}${row.forwarded_at === null ? ` · <span class="warn">not forwarded</span>` : ""}${row.closed_at === null ? "" : " · closed"}</td></tr>`,
        )
        .join("")}</tbody></table></div>`
}
<p class="note">${autoCloseNote}</p></main>`;
};

const mailMessage = async (env: Env, id: string): Promise<string | null> => {
  const row = await env.DB.prepare(
    "SELECT id, address, sender, subject, received_at, forwarded_at, forward_error, read_at, closed_at, raw FROM contact_mail WHERE id = ?",
  )
    .bind(id)
    .first<MailRow & { raw: string }>();
  if (row === null) return null;
  if (row.read_at === null) await env.DB.prepare("UPDATE contact_mail SET read_at = ? WHERE id = ? AND read_at IS NULL").bind(nowIso(), id).run();
  const mail = readableMail(row.raw);
  const fact = (name: string, value: string): string => (value === "" ? "" : `<div><dt>${name}</dt><dd><bdi>${escapeHtml(value)}</bdi></dd></div>`);
  return `<main>${back("/admin/mail", "Mail")}
<div class="bar"><h1><bdi>${escapeHtml(row.subject === null || row.subject === "" ? (mail.headers.get("subject") ?? "(no subject)") : row.subject)}</bdi></h1>
<form method="post" action="/admin/mail"><input type="hidden" name="id" value="${row.id}"><button class="icon-button" name="action" value="${row.closed_at === null ? "close" : "reopen"}">${row.closed_at === null ? "Close" : "Reopen"}</button></form></div>
<dl class="meta">${fact("From", mail.headers.get("from") ?? row.sender ?? "")}${fact("To", row.address)}${fact("Received", `${when(row.received_at)} UTC`)}${fact("Forwarded", row.forwarded_at === null ? `No${row.forward_error === null ? "" : `: ${row.forward_error}`}` : `${when(row.forwarded_at)} UTC`)}${fact("Closed", row.closed_at === null ? "" : day(row.closed_at))}</dl>
<section class="card full"><pre class="mail">${escapeHtml(mail.text)}</pre>
<details><summary>As received</summary><pre class="mail">${escapeHtml(row.raw)}</pre></details></section></main>`;
};

const mailAction = async (env: Env, form: FormData): Promise<Response> => {
  const action = form.get("action");
  const id = String(form.get("id") ?? "");
  const now = nowIso();
  if (action === "read-all") {
    await env.DB.prepare("UPDATE contact_mail SET read_at = ? WHERE read_at IS NULL").bind(now).run();
    return seeOther("/admin/mail");
  }
  if (action === "close") {
    await env.DB.prepare("UPDATE contact_mail SET closed_at = ?, read_at = COALESCE(read_at, ?) WHERE id = ? AND closed_at IS NULL").bind(now, now, id).run();
    return seeOther("/admin/mail");
  }
  if (action === "reopen") {
    await env.DB.prepare("UPDATE contact_mail SET closed_at = NULL WHERE id = ?").bind(id).run();
    return seeOther(`/admin/mail/${encodeURIComponent(id)}`);
  }
  return seeOther("/admin/mail");
};

// ---------------------------------------------------------------------------------------------
// Routes. The caller has already checked the admin key.

/** Answers these views, or null when the address is not one of them. */
export const privacyViews = async (request: Request, env: Env, url: URL): Promise<Response | null> => {
  const path = url.pathname.replace(/(.)\/$/, "$1");
  const get = request.method === "GET";
  const post = request.method === "POST";

  if (path === "/admin/privacy" && get) return page("privacy", await privacyPage(env));
  if (path === "/admin/rights" && post) return rightsAction(env, await request.formData());

  // The dry run, as JSON, and the run itself.
  if (path === "/admin/retention.json" && get) return json(await retentionReport(env));
  if (path === "/admin/retention" && post) {
    const form = await request.formData();
    if (form.get("confirm") !== "RUN") return resultPage("Nothing was run", ["Type RUN to confirm."], 400);
    const report = await applyRetention(env);
    return (request.headers.get("accept") ?? "").includes("application/json")
      ? json(report)
      : page("privacy", `<main>${back("/admin/privacy", "Privacy")}<section class="card full"><h2>Removed just now</h2><div class="fit">${retentionTable(report)}</div></section></main>`);
  }

  // One-off: usage events collected under the old identifiers (see retention.ts).
  // GET is the dry run; POST with confirm=DELETE deletes.
  if (path === "/admin/maintenance/usage-events" && (get || post)) {
    const parameters = new URLSearchParams(url.searchParams);
    if (post) for (const [key, value] of await request.formData()) if (typeof value === "string") parameters.set(key, value);
    const scope = (["provider", "legacy", "before"] as const).find((candidate) => candidate === parameters.get("scope")) as UsageEventScope | undefined;
    const before = parameters.get("before");
    if (scope === undefined || (scope === "before" && (before === null || !/^\d{4}-\d{2}-\d{2}$/.test(before)))) {
      return json({ error: { code: "invalid_request", message: "Send scope=provider, scope=legacy, or scope=before with before=YYYY-MM-DD." } }, 400);
    }
    if (post && parameters.get("confirm") !== "DELETE") {
      return json({ error: { code: "confirmation_required", message: "Send confirm=DELETE to delete. A GET request is the dry run." } }, 400);
    }
    return json(await cleanUsageEvents(env, scope, before, post));
  }

  if (path === "/admin/mail" && get) return page("mail", await mailList(env));
  if (path === "/admin/mail" && post) return mailAction(env, await request.formData());
  if (path.startsWith("/admin/mail/") && get) {
    const message = await mailMessage(env, path.slice("/admin/mail/".length));
    return message === null ? page("mail", `<main>${back("/admin/mail", "Mail")}<p class="empty">No such message</p></main>`, 404) : page("mail", message);
  }
  return null;
};
