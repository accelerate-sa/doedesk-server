// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Accelerate Technology Establishment
/**
 * Emails the owner that a unit has failed.
 *
 *   bun server/alert.ts <unit name>
 *
 * Uses the mail server the service already uses (SMTP_*), and sends to ALERT_EMAIL from
 * ALERT_FROM (an approved sender; signin@doedesk.com unless set). The message holds the unit's
 * name, the machine's name and the time: nothing from the database or the journal. Without
 * ALERT_EMAIL it prints the line and exits 0, so a machine with no address set does not loop.
 */
import { hostname } from "node:os";

import { sendMail } from "./smtp.ts";

const unit = (process.argv[2] ?? "a unit").replace(/[^A-Za-z0-9@._-]/g, "");
const to = (process.env.ALERT_EMAIL ?? "").trim();
const line = `${unit} failed on ${hostname()} at ${new Date().toISOString()}`;
if (to === "" || (process.env.SMTP_HOST ?? "") === "") {
  console.log(`alert not sent (ALERT_EMAIL or SMTP_HOST is not set): ${line}`);
  process.exit(0);
}
try {
  await sendMail(
    {
      host: process.env.SMTP_HOST ?? "",
      port: Number(process.env.SMTP_PORT ?? 587),
      username: process.env.SMTP_USERNAME ?? "",
      password: process.env.SMTP_PASSWORD ?? "",
      security: process.env.SMTP_SECURITY === "implicit" ? "implicit" : "starttls",
    },
    {
      to,
      from: { email: (process.env.ALERT_FROM ?? "").trim() || "signin@doedesk.com", name: "DoeDesk Cloud" },
      subject: `DoeDesk Cloud: ${unit} failed`,
      text: `${line}\n\nOn the machine:\n  systemctl status ${unit}\n  journalctl --namespace doedesk -u ${unit} -n 50\n\nThe runbook says what to do next.\n`,
    },
  );
  console.log(`alert sent: ${line}`);
} catch (cause) {
  console.error(`alert not sent (${(cause as { code?: string }).code ?? "error"}): ${line}`);
  process.exit(1);
}
