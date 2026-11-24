// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Accelerate Technology Establishment
// The site's own routes on the Worker: the download page, the stable link to each installer, and
// the articles.
// Needs the built site (`pnpm run build:site`, which writes web/dist).
//
//   node test/site-routes.mjs
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { client, startWorkerService } from "./local-service.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
let failures = 0;
const expect = (label, condition, detail = null) => {
  if (!condition) failures += 1;
  console.log(`${condition ? "ok  " : "FAIL"} ${label}${condition ? "" : ` -> ${JSON.stringify(detail)?.slice(0, 600)}`}`);
};
const same = (label, actual, expected) => expect(label, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });

if (!existsSync(join(ROOT, "web", "dist", "download.html"))) {
  console.log("FAIL web/dist has no download page: run `pnpm run build:site` first");
  process.exit(1);
}

const RELEASE = "https://github.com/accelerate-sa/doedesk/releases/latest/download/";
const service = await startWorkerService({ host: "doedesk.com" });
try {
  const call = client(service.base);

  for (const [path, lang] of [["/download", "en"], ["/ar/download", "ar"]]) {
    const page = await call("GET", path);
    expect(`${path}: the download page itself, not a redirect`, page.status === 200 && (page.headers.get("content-type") ?? "").startsWith("text/html") && page.text.includes(`<html lang="${lang}"`), { status: page.status, location: page.headers.get("location") });
    expect(`${path}: every build's button is in the page without JavaScript, through the site's own link`, page.text.includes('href="/download/mac"') && page.text.includes('class="dl-list"'), page.text.slice(0, 200));
  }

  const builds = {
    mac: "DoeDesk-arm64.dmg",
    windows: "DoeDesk-x64.exe",
    linux: "DoeDesk-x86_64.AppImage",
    "linux-deb": "DoeDesk-amd64.deb",
    "linux-arm64": "DoeDesk-arm64.AppImage",
  };
  for (const [slug, file] of Object.entries(builds)) {
    const answer = await call("GET", `/download/${slug}`);
    same(`/download/${slug}: a 302 to ${file} in the latest release`, [answer.status, answer.headers.get("location")], [302, `${RELEASE}${file}`]);
  }

  const unknown = await call("GET", "/download/constructor");
  const nested = await call("GET", "/download/mac/x");
  same("a name that is no build is not redirected (the site's 404 page)", [unknown.status, nested.status], [404, 404]);

  const robots = await call("GET", "/robots.txt");
  expect("robots.txt: the page may be indexed, the links under it not", robots.status === 200 && /^Disallow: \/download\/$/m.test(robots.text) && !/^Disallow: \/download$/m.test(robots.text), robots.text);
  const sitemap = await call("GET", "/sitemap.xml");
  expect("sitemap lists the download page in both languages", sitemap.text.includes("<loc>https://doedesk.com/download</loc>") && sitemap.text.includes("<loc>https://doedesk.com/ar/download</loc>"), sitemap.text.slice(0, 300));

  // Articles are behind a switch (`articlesPublished` in web/src/config.ts), and a language has an
  // index only when it has an article: what the build wrote says what must be served.
  for (const [path, lang, folder] of [["/blog", "en", "blog"], ["/ar/blog", "ar", "ar/blog"]]) {
    const index = await call("GET", path);
    const listed = sitemap.text.includes(`<loc>https://doedesk.com${path}</loc>`);
    if (!existsSync(join(ROOT, "web", "dist", `${folder}.html`))) {
      same(`${path}: no index and nothing in the sitemap while this language has no published article`, [index.status, listed], [404, false]);
      continue;
    }
    expect(`${path}: the articles index, at the address without a slash`, index.status === 200 && index.text.includes(`<html lang="${lang}"`) && listed, { status: index.status, location: index.headers.get("location"), listed });
    for (const file of readdirSync(join(ROOT, "web", "dist", folder)).filter((name) => name.endsWith(".html"))) {
      const address = `${path}/${file.slice(0, -".html".length)}`;
      const article = await call("GET", address);
      expect(`${address}: the article, linked from the index and listed in the sitemap`, article.status === 200 && article.text.includes(`<html lang="${lang}"`) && index.text.includes(`href="${address}"`) && sitemap.text.includes(`<loc>https://doedesk.com${address}</loc>`), { status: article.status, location: article.headers.get("location") });
    }
    const missing = await call("GET", `${path}/no-such-article`);
    same(`${path}/no-such-article: the site's 404 page`, missing.status, 404);
  }
} catch (cause) {
  failures += 1;
  console.log(`FAIL the run stopped: ${cause?.stack ?? cause}`);
} finally {
  await service.stop();
}
console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
