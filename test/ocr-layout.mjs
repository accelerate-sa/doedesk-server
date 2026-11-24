// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Accelerate Technology Establishment
// Proves what `/v1/ocr` answers a caller that asks where the words are (`?layout=1`), the answer
// the app needs to send an image with a box over each personal detail:
//   - nothing changes for a caller that does not ask, and the engine is then not asked either;
//   - asked, the answer carries the engine's layout as the engine gave it, in the shape the app
//     reads: here the app's own recorded reading of a test letter, checked by the app's rules;
//   - an engine that cannot say where the words are, or says something that is not a layout,
//     gives an answer without `layout`, which tells the app not to send the image.
//
//   node test/ocr-layout.mjs                                     the Worker (wrangler dev)
//   DOEDESK_TEST_TARGET=bun node test/ocr-layout.mjs             the server, on Bun (or node)
//   DOEDESK_APP_GATEWAY=<app>/packages/privacy-gateway node test/ocr-layout.mjs
//                                                                also runs the app's own parser
import { pathToFileURL } from "node:url";
import { join } from "node:path";

import { client, LETTER_READ, sha256Hex, startLocalService } from "./local-service.mjs";

let failures = 0;
const expect = (label, condition, detail = null) => {
  if (!condition) failures += 1;
  console.log(`${condition ? "ok  " : "FAIL"} ${label}${condition ? "" : ` -> ${JSON.stringify(detail)?.slice(0, 600)}`}`);
};
const same = (label, actual, expected) => expect(label, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });

/**
 * The rules the app checks a layout by before it draws a box (packages/privacy-gateway/src/
 * redaction/layout.ts and words.ts in the app repository). Returns the first rule broken, or null.
 */
const breaksAppRules = (text, layout) => {
  if (typeof layout !== "object" || layout === null || !Array.isArray(layout.pages)) return "no pages";
  if (layout.pages.length !== 1) return "an image is read as exactly one page";
  const covered = new Uint8Array(text.length);
  for (const page of layout.pages) {
    if ((page.unit ?? "pixel") !== "pixel") return "not measured in pixels";
    if (!Number.isFinite(page.width) || !Number.isFinite(page.height)) return "no page size";
    if (!Array.isArray(page.words)) return "no words";
    for (const word of page.words) {
      if (!Array.isArray(word.polygon) || word.polygon.length !== 8 || !word.polygon.every(Number.isFinite)) return `four corners: ${JSON.stringify(word)}`;
      if (!Number.isInteger(word.offset) || !Number.isInteger(word.length) || word.offset < 0 || word.length <= 0 || word.offset + word.length > text.length) return `a place in the text: ${JSON.stringify(word)}`;
      if (text.substr(word.offset, word.length) !== word.text) return `the text at its place: ${JSON.stringify(word)}`;
      if (!Number.isFinite(word.confidence) || word.confidence < 0 || word.confidence > 1) return `a confidence: ${JSON.stringify(word)}`;
      covered.fill(1, word.offset, word.offset + word.length);
    }
  }
  for (let index = 0; index < text.length; index += 1) {
    if (covered[index] === 0 && !/\s/u.test(text[index])) return `character ${index} has no place`;
  }
  return null;
};

const TOKEN = "dd_test_ocr_layout";
const person = "00000000-0000-4000-a000-0000000000b7";
const now = new Date().toISOString();
const seedSql = [
  `INSERT INTO users (id, email, created_at, country, signup_method) VALUES ('${person}', 'layout@seeded.example', '${now}', 'SA', 'email');`,
  `INSERT INTO sessions (token_hash, user_id, client, device, created_at, last_used_at, signed_in_at) VALUES ('${sha256Hex(TOKEN)}', '${person}', 'desktop', 'Test Mac', '${now}', '${now}', '${now}');`,
].join("\n");

// The rules themselves, on the recorded reading and on readings that must fail them.
expect("the app's recorded reading of its test letter keeps the app's rules", breaksAppRules(LETTER_READ.text, LETTER_READ.layout) === null, breaksAppRules(LETTER_READ.text, LETTER_READ.layout));
{
  const shifted = structuredClone(LETTER_READ.layout);
  shifted.pages[0].words[3].offset += 1;
  const inches = structuredClone(LETTER_READ.layout);
  inches.pages[0].unit = "inch";
  expect("…and a word one place off, or a page in inches, breaks them", breaksAppRules(LETTER_READ.text, shifted) !== null && breaksAppRules(LETTER_READ.text, inches) !== null);
}

const service = await startLocalService({ seedSql });
try {
  const call = client(service.base);
  const read = (path, marker) => call("POST", path, { raw: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(marker)]), token: TOKEN, headers: { "content-type": "image/png" } });
  const askedOfEngine = () => service.engine.seen.ocr.at(-1)?.layout === true;

  const plain = await read("/v1/ocr", "[[letter]]");
  same("a caller that does not ask gets text and pages only, as before", [plain.status, plain.json], [200, { text: LETTER_READ.text, pages: 1 }]);
  expect("…and the engine is not asked where the words are", !askedOfEngine());
  const zero = await read("/v1/ocr?layout=0", "[[letter]]");
  expect("only layout=1 asks", zero.status === 200 && !("layout" in (zero.json ?? {})) && !askedOfEngine(), zero.json);

  const asked = await read("/v1/ocr?layout=1", "[[letter]]");
  expect("a caller that asks is answered, and the engine was asked", asked.status === 200 && askedOfEngine(), asked.status);
  same("…with the engine's layout exactly as the engine gave it: the app's own recorded reading", asked.json, LETTER_READ);
  expect("…which keeps every rule the app checks before drawing a box", breaksAppRules(asked.json?.text ?? "", asked.json?.layout) === null, breaksAppRules(asked.json?.text ?? "", asked.json?.layout));
  const words = asked.json?.layout?.pages?.[0]?.words ?? [];
  const at = (text) => words.filter((word) => word.text === text).map((word) => word.polygon);
  same("…and a name in the letter is where the app's fixture has it", at("Al-Otaibi,"), LETTER_READ.layout.pages[0].words.filter((word) => word.text === "Al-Otaibi,").map((word) => word.polygon));

  if (process.env.DOEDESK_APP_GATEWAY) {
    // The released app's own code on the answer, when a copy of it is at hand.
    const gateway = process.env.DOEDESK_APP_GATEWAY;
    const { parseLayout } = await import(pathToFileURL(join(gateway, "src", "redaction", "layout.ts")).href);
    const { pageWords } = await import(pathToFileURL(join(gateway, "src", "redaction", "words.ts")).href);
    const page = pageWords({ text: asked.json.text, pages: asked.json.pages, layout: parseLayout(asked.json.text, asked.json.layout) });
    same("the app's own parser takes the answer: the page's size, its words and lines", [page.width, page.height, page.words.length, page.lines.length > 0], [1000, 1300, words.length, true]);
  }

  const none = await read("/v1/ocr?layout=1", "[[no-layout]]");
  expect("an engine that cannot say where the words are: text and pages, no layout (the app then sends no image)", none.status === 200 && none.json?.text === "text" && !("layout" in (none.json ?? {})), none.json);
  const odd = await read("/v1/ocr?layout=1", "[[odd-layout]]");
  expect("an engine whose layout is not a layout at all: no layout", odd.status === 200 && !("layout" in (odd.json ?? {})), odd.json);

  const anonymous = await call("POST", "/v1/ocr?layout=1", { raw: Buffer.from("[[letter]]"), headers: { "content-type": "image/png" } });
  expect("asking where the words are needs a sign-in, like any reading", anonymous.status === 401, anonymous.status);
  const counted = service.query("SELECT SUM(ocr_files) AS files, SUM(ocr_pages) AS pages FROM usage_daily WHERE user_id = ?", person)[0];
  same("a reading with positions counts as one file and its pages, like any other", [Number(counted?.files), Number(counted?.pages)], [5, 5]);
} finally {
  await service.stop();
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
