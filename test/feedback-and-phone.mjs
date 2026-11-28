// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Accelerate Technology Establishment
// Verifies:
//   1. Anonymous `agent.feedback` ingest (`POST /ingest/batch/`), retention, and `/admin/feedback` UI.
//   2. Turnstile-gated phone reveal (`GET /contact/phone`, `POST /contact/phone`) and zero raw phone
//      digits in built public legal HTML.
//
//   node test/feedback-and-phone.mjs
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { client, startLocalService, startWorkerService } from "./local-service.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
let failures = 0;
const expect = (label, condition, detail = null) => {
  if (!condition) failures += 1;
  console.log(`${condition ? "ok  " : "FAIL"} ${label}${condition ? "" : ` -> ${JSON.stringify(detail)?.slice(0, 600)}`}`);
};
const same = (label, actual, expected) => expect(label, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });

// --- 1. Agent feedback ingest + Admin UI --------------------------------------------------------
{
  const service = await startLocalService();
  try {
    const call = client(service.base);
    const admin = { authorization: `Bearer ${service.adminKey}` };
    const formHeaders = { ...admin, "content-type": "application/x-www-form-urlencoded" };
    const reportId1 = crypto.randomUUID();
    const reportId2 = crypto.randomUUID();

    // Send an anonymous user-approved agent.feedback report from a consent region (DE) with no installId or consent.
    const approved = await call("POST", "/ingest/batch/", {
      headers: { "x-test-country": "DE" },
      body: {
        api_key: "doedesk-client",
        batch: [
          {
            uuid: reportId1,
            event: "agent.feedback",
            distinct_id: reportId1,
            timestamp: new Date().toISOString(),
            properties: {
              kind: "tool_bug",
              subject: "t3_thread_read",
              expected: "Returns all recent messages.",
              actual: "Truncated after item 10 without cursor.",
              workaround: "Passed explicit limit=50.",
              trace: { turns: 2, entries: [{ role: "tool", name: "t3_thread_read" }] },
              userRequested: true,
              source: "mcp",
              provider: "anthropic",
              model: "claude-sonnet-4-6",
              email: "should-be-stripped@example.com",
              $process_person_profile: false,
              t3CodeVersion: "2026.11.3",
              telemetryChannel: "stable",
            },
          },
        ],
      },
    });
    same("agent.feedback: approved anonymous report is accepted even from DE without installId/consent", [approved.status, approved.json], [200, { status: 1, stored: 1, dropped: 0 }]);

    // Resending the same uuid is deduplicated, and an unprompted report strips prose fields.
    const second = await call("POST", "/ingest/batch/", {
      headers: { "x-test-country": "SA" },
      body: {
        api_key: "doedesk-client",
        batch: [
          {
            uuid: reportId1,
            event: "agent.feedback",
            distinct_id: reportId1,
            properties: { kind: "tool_bug", subject: "t3_thread_read", userRequested: true },
          },
          {
            uuid: reportId2,
            event: "agent.feedback",
            distinct_id: reportId2,
            properties: {
              kind: "friction",
              subject: "t3 status",
              expected: "Should NOT be stored for unprompted",
              actual: "Should NOT be stored for unprompted",
              userRequested: false,
              source: "cli",
              t3CodeVersion: "2026.11.3",
            },
          },
        ],
      },
    });
    same("agent.feedback: deduplicates by uuid and stores unprompted report", [second.status, service.query("SELECT COUNT(*) AS n FROM agent_feedback")[0].n], [200, 2]);

    const rows = service.query("SELECT id, kind, subject, user_requested, expected, actual, workaround, provider, model, properties, trace FROM agent_feedback ORDER BY received_at");
    const row1 = rows.find((row) => row.id === reportId1);
    const row2 = rows.find((row) => row.id === reportId2);
    same("agent.feedback: approved report preserves fields and strips PII properties", [row1.kind, row1.subject, row1.user_requested, row1.expected, row1.actual, row1.workaround, row1.provider, row1.model, row1.properties.includes("should-be-stripped"), row1.trace.includes("t3_thread_read")], ["tool_bug", "t3_thread_read", 1, "Returns all recent messages.", "Truncated after item 10 without cursor.", "Passed explicit limit=50.", "anthropic", "claude-sonnet-4-6", false, true]);
    same("agent.feedback: unprompted report stores categories only without prose", [row2.kind, row2.subject, row2.user_requested, row2.expected, row2.actual], ["friction", "t3 status", 0, null, null]);
    same("agent.feedback: does not pollute the usage events table", service.query("SELECT COUNT(*) AS n FROM events")[0].n, 0);

    // Admin auth & unread badge
    same("admin/feedback requires admin key", [(await call("GET", "/admin/feedback")).status, (await call("GET", "/admin/feedback.json")).status], [401, 401]);
    const overview = await call("GET", "/admin", { headers: admin });
    expect("admin nav shows Feedback unread badge (2)", overview.status === 200 && overview.text.includes('href="/admin/feedback">Feedback<span class="badge">2</span></a>'), overview.text.slice(0, 600));

    const list = await call("GET", "/admin/feedback", { headers: admin });
    expect("admin/feedback lists both reports", list.status === 200 && list.text.includes("t3_thread_read") && list.text.includes("t3 status"), list.text.slice(0, 500));

    const detail = await call("GET", `/admin/feedback/${reportId1}`, { headers: admin });
    expect("admin/feedback/<id> shows expected/actual/workaround/trace and marks read", detail.status === 200 && detail.text.includes("Returns all recent messages.") && detail.text.includes("Truncated after item 10") && detail.text.includes("Passed explicit limit=50.") && detail.text.includes("t3_thread_read") && service.query("SELECT read_at FROM agent_feedback WHERE id = ?", reportId1)[0].read_at !== null);

    const closed = await call("POST", "/admin/feedback", { raw: new URLSearchParams({ action: "close", id: reportId1 }).toString(), headers: formHeaders });
    same("admin/feedback close marks closed_at", [closed.status, service.query("SELECT closed_at FROM agent_feedback WHERE id = ?", reportId1)[0].closed_at !== null], [303, true]);

    const readAll = await call("POST", "/admin/feedback", { raw: new URLSearchParams({ action: "read-all" }).toString(), headers: formHeaders });
    same("admin/feedback read-all clears unread count and badge", [readAll.status, service.query("SELECT COUNT(*) AS n FROM agent_feedback WHERE read_at IS NULL")[0].n, (await call("GET", "/admin", { headers: admin })).text.includes(">Feedback</a>")], [303, 0, true]);

    const apiJson = await call("GET", "/admin/feedback.json", { headers: admin });
    same("admin/feedback.json returns counts and items", [apiJson.status, apiJson.json?.counts?.total, apiJson.json?.counts?.open, apiJson.json?.items?.length], [200, 2, 1, 2]);

    const retention = await call("GET", "/admin/retention.json", { headers: admin });
    expect("retention includes agent_feedback rule", retention.status === 200 && retention.json.rules.some((rule) => rule.id === "agent_feedback"));
  } finally {
    await service.stop();
  }
}

// --- 2. Turnstile-gated contact phone + built legal HTML check ----------------------------------
{
  // Start local Turnstile siteverify stub
  const verifyStub = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const params = new URLSearchParams(body);
      const token = params.get("response");
      const secret = params.get("secret");
      const ok = secret === "test-turnstile-secret" && token === "valid-human-token";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(ok ? { success: true, hostname: "doedesk.com" } : { success: false, "error-codes": ["invalid-input-response"] }));
    });
  });
  await new Promise((resolve) => verifyStub.listen(0, "127.0.0.1", resolve));
  const stubPort = verifyStub.address().port;
  const verifyUrl = `http://127.0.0.1:${stubPort}/siteverify`;

  const unconfigured = await startWorkerService({ host: "doedesk.com" });
  const configured = await startWorkerService({
    host: "doedesk.com",
    vars: {
      TURNSTILE_SITE_KEY: "0x4AAAAAAA_test_site_key",
      TURNSTILE_SECRET_KEY: "test-turnstile-secret",
      TURNSTILE_VERIFY_URL: verifyUrl,
      CONTACT_PHONE: "+966 53 948 5811",
    },
  });

  try {
    const callUnconf = client(unconfigured.base);
    same("contact/phone unconfigured: GET reports configured=false and POST returns 503", [(await callUnconf("GET", "/contact/phone")).json, (await callUnconf("POST", "/contact/phone", { body: { token: "any" } })).status], [{ configured: false, siteKey: null }, 503]);

    const callConf = client(configured.base);
    same("contact/phone configured: GET returns siteKey without leaking secret or phone", (await callConf("GET", "/contact/phone")).json, { configured: true, siteKey: "0x4AAAAAAA_test_site_key" });
    same("contact/phone POST missing token -> 400", (await callConf("POST", "/contact/phone", { body: {} })).status, 400);
    same("contact/phone POST invalid token -> 403", (await callConf("POST", "/contact/phone", { body: { token: "bot-token" } })).status, 403);
    const okRes = await callConf("POST", "/contact/phone", { body: { token: "valid-human-token" } });
    same("contact/phone POST valid token -> 200 with protected phone", [okRes.status, okRes.json], [200, { phone: "+966 53 948 5811" }]);

    // Verify built legal HTML files contain ZERO raw phone digits and DO contain the redacted phone gate (private repo with web/ only).
    if (existsSync(join(ROOT, "web"))) {
      for (const file of ["privacy.html", "terms.html", "ar/privacy.html", "ar/terms.html"]) {
        const full = join(ROOT, "web", "dist", file);
        if (!existsSync(full)) {
          expect(`${file} exists in web/dist`, false, "run build:site first");
          continue;
        }
        const markup = readFileSync(full, "utf8");
        expect(`${file}: no raw phone digits in public HTML`, !markup.includes("5811") && !markup.includes("948 5811"), file);
        expect(`${file}: renders Turnstile redacted phone gate`, markup.includes("data-phone-gate") && markup.includes("/contact/phone"), file);
      }
    }
  } finally {
    await configured.stop();
    await unconfigured.stop();
    await new Promise((resolve) => verifyStub.close(resolve));
  }
}

console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
