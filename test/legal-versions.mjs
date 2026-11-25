// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Accelerate Technology Establishment
// Checks the code against the documents in `legal/`, without starting the service:
//   - the versions in src/legal.ts are the versions the four documents carry, the effective date is
//     set in both places or in neither, and any hash in the code is the hash of the file;
//   - the countries where usage data waits for agreement (src/regions.ts) are the ones listed in
//     `legal/consent-spec.md` section 11.2;
//   - each keeping time in src/periods.ts is the figure the English Privacy Policy states.
//
//   node test/legal-versions.mjs            check
//   node test/legal-versions.mjs --print    also print each document's version and sha256, to paste
//                                           into src/legal.ts when a version is published
//
// The documents are read from `legal/` beside `src/`, or from the folder in DOEDESK_LEGAL_DIR.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { LEGAL } from "../src/legal.ts";
import * as periods from "../src/periods.ts";
import { CONSENT_REGION_CODES } from "../src/regions.ts";
import { DAILY_RETENTION_DAYS } from "../src/usage.ts";

const folder = process.env.DOEDESK_LEGAL_DIR ?? join(dirname(dirname(fileURLToPath(import.meta.url))), "legal");
const read = (name) => readFileSync(join(folder, name), "utf8");

let failures = 0;
const expect = (label, condition, detail = null) => {
  if (!condition) failures += 1;
  console.log(`${condition ? "ok  " : "FAIL"} ${label}${condition ? "" : ` -> ${JSON.stringify(detail)?.slice(0, 600)}`}`);
};

// --- Versions, effective dates, hashes ----------------------------------------------------------
for (const document of ["terms", "privacy"]) {
  for (const locale of ["en", "ar"]) {
    const name = `${document}.${locale}.md`;
    const text = read(name);
    // The line under the title: "**Version 1.1 · Effective …**" / "**الإصدار 1.1 · تاريخ السريان: …**".
    const line = /^\*\*(?:Version|الإصدار) (\d+(?:\.\d+)*) · (.*)\*\*$/m.exec(text);
    const version = line?.[1];
    const dated = line !== null && !/\[[^\]]+\]/.test(line[2]);
    const sha256 = createHash("sha256").update(text).digest("hex");
    if (process.argv.includes("--print")) console.log(`     ${name}: version ${version}, sha256 ${sha256}`);
    expect(`${name}: carries the version the service announces (${LEGAL[document].version})`, version === LEGAL[document].version, { inFile: version, inCode: LEGAL[document].version });
    expect(`${name}: an effective date is set in the file and in the code, or in neither`, dated === (LEGAL[document].effective !== null), { fileHasDate: dated, inCode: LEGAL[document].effective });
    const recorded = LEGAL[document].sha256[locale];
    expect(`${name}: the hash in the code, if any, is the hash of this file`, recorded === null || recorded === sha256, { inCode: recorded, ofFile: sha256 });
    expect(`${name}: once dated, the code holds its hash`, !dated || recorded !== null, { dated, recorded });
  }
  expect(`${document}: the required version was published and is not newer than the current one`, LEGAL[document].published.includes(LEGAL[document].required) && LEGAL[document].published.at(-1) === LEGAL[document].version, LEGAL[document]);
}

// --- Usage data: the consent regions ------------------------------------------------------------
const spec = read("consent-spec.md");
const section = spec.slice(spec.indexOf("### 11.2"), spec.indexOf("**Not in the list"));
const listed = new Set();
for (const line of section.split("\n")) {
  // Group A: bullets with the codes in one code span. Group B: table rows that start with a code.
  const bullet = /^- [^`]*`([A-Z ]+)`\s*$/.exec(line);
  if (bullet !== null) for (const code of bullet[1].trim().split(/\s+/)) listed.add(code);
  const row = /^\| `([A-Z]{2})`(?: \+ region `([A-Z0-9]+)`)? \|/.exec(line);
  if (row !== null) listed.add(row[2] === undefined ? row[1] : `${row[1]}-${row[2]}`);
}
const inCode = new Set(CONSENT_REGION_CODES);
const missing = [...listed].filter((code) => !inCode.has(code));
const extra = [...inCode].filter((code) => !listed.has(code));
expect(`consent regions: the ${inCode.size} in the code are the ${listed.size} in consent-spec.md 11.2`, listed.size > 40 && missing.length === 0 && extra.length === 0, { missing, extra });

// --- Keeping times ------------------------------------------------------------------------------
const policy = read("privacy.en.md");
const states = (label, sentence) => expect(`periods: the policy says "${sentence}"`, policy.includes(sentence), label);
states("ACCOUNT_UNUSED_MONTHS", `after ${periods.ACCOUNT_UNUSED_MONTHS} months of inactivity`);
states("SIGN_IN_ATTEMPT_DAYS_AFTER_EXPIRY", `| Sign-in attempts | ${periods.SIGN_IN_ATTEMPT_DAYS_AFTER_EXPIRY} day${periods.SIGN_IN_ATTEMPT_DAYS_AFTER_EXPIRY === 1 ? "" : "s"} after expiry |`);
states("USAGE_DATA_DAYS", `| App usage data | ${periods.USAGE_DATA_DAYS} days |`);
states("ERROR_REPORT_DAYS", `| Error reports | ${periods.ERROR_REPORT_DAYS} days |`);
states("CONTACT_MAIL_MONTHS_AFTER_CLOSED", `| Support & rights emails | ${periods.CONTACT_MAIL_MONTHS_AFTER_CLOSED} months after closure`);
states("DAILY_RETENTION_DAYS", `Daily counts: ${DAILY_RETENTION_DAYS} days`);

console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
