// Screenshots of the usage views of the owner's dashboard, with sample data, in light and dark at a
// phone and a desktop width.
//
//   node test/usage-shots.mjs [output folder]
//
// Starts its own local service (see local-service.mjs). To reuse one that is already running:
//   DOEDESK_BASE=http://127.0.0.1:PORT DOEDESK_ADMIN_KEY=… node test/usage-shots.mjs
// Playwright is borrowed from the app checkout; set DOEDESK_APP_WEB if that lives elsewhere.
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startLocalService } from "./local-service.mjs";
import { monthOf, sampleData, sampleSql } from "./usage-sample.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = resolve(process.argv[2] ?? join(root, "brand/ideation/usage-dashboard"));
const appWeb = process.env.DOEDESK_APP_WEB ?? resolve(root, "../doedesk/apps/web");
const { chromium } = createRequire(join(appWeb, "package.json"))("playwright");

const data = sampleData();
const service =
  process.env.DOEDESK_BASE === undefined
    ? await startLocalService({ seedSql: sampleSql(data), vars: { ENGINE_PRICE_PER_1000_UNITS: "1", ENGINE_PRICE_PER_1000_PAGES: "1.5" } })
    : { base: process.env.DOEDESK_BASE, adminKey: process.env.DOEDESK_ADMIN_KEY, stop: async () => {} };

// An account with a good spread of history: the one with the most days of use among those who
// answered the onboarding questions.
const answered = new Set(data.users.filter((user) => user.field !== null).map((user) => user.id));
const days = new Map();
for (const row of data.daily) if (answered.has(row.user_id)) days.set(row.user_id, (days.get(row.user_id) ?? 0) + 1);
const busiest = [...days].sort((left, right) => right[1] - left[1])[0][0];
const lastMonth = monthOf(new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 1)).toISOString());

const views = [
  ["accounts", "/admin/accounts"],
  ["account", `/admin/accounts/${busiest}`],
  ["spread", "/admin/distribution"],
  ["spread-last-month", `/admin/distribution?month=${lastMonth}`],
];
const sizes = [
  ["phone", { width: 390, height: 844 }],
  ["desktop", { width: 1440, height: 900 }],
];

mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ channel: "chrome" });
try {
  for (const scheme of ["light", "dark"]) {
    for (const [size, viewport] of sizes) {
      const context = await browser.newContext({
        viewport,
        colorScheme: scheme,
        deviceScaleFactor: 2,
        extraHTTPHeaders: { authorization: `Bearer ${service.adminKey}` },
      });
      const page = await context.newPage();
      for (const [name, path] of views) {
        await page.goto(service.base + path, { waitUntil: "networkidle" });
        const file = join(output, `${name}-${size}-${scheme}.png`);
        await page.screenshot({ path: file, fullPage: true });
        console.log(file);
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
  await service.stop();
}
