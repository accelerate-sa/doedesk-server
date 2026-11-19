// Proves the service's central promise on a running server: what is sent to be checked for
// personal data (POST /v1/detect) or read (POST /v1/ocr), and what the engine answers about it,
// is written nowhere. Only counts are.
//
//   node server/test/nothing-kept.mjs           the server on Bun (DOEDESK_TEST_TARGET=node for Node)
//
// Each request carries markers that occur nowhere else: in the texts, in the file, in the engine's
// answers, and in an engine's error message. Afterwards every byte of every file in the service's
// data folder (the database, its write-ahead log, the jobs file), read while the service runs and
// again after it has stopped, and everything the service printed, is searched for each marker, in
// UTF-8 and in UTF-16. The usage counters are checked too, so that the requests are known to have
// been handled.
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { client, sha256Hex, startServerService, TARGET } from "../../test/local-service.mjs";

let failures = 0;
const expect = (label, condition, detail = null) => {
  if (!condition) failures += 1;
  console.log(`${condition ? "ok  " : "FAIL"} ${label}${condition ? "" : ` -> ${JSON.stringify(detail)?.slice(0, 600)}`}`);
};
if (TARGET === "worker") {
  console.log("skipped: this suite reads the server's own files");
  process.exit(0);
}

const marker = (label) => `${label}${randomBytes(9).toString("hex")}`;
const MARKS = {
  text: marker("TextSentForDetection"),
  arabic: `${marker("نص")}محمد`,
  file: marker("BytesOfTheFileSentForReading"),
  detected: marker("EntityTheEngineReported"),
  read: marker("TextTheReaderFound"),
  failure: marker("ErrorMessageOfTheEngine"),
};

// An engine in the shape the server uses on the machine (src/engine.ts). It echoes what it got
// back as entities and text, so that the server holds the content in memory on the way back.
const engine = createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const body = Buffer.concat(chunks);
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/detect") {
      const { texts } = JSON.parse(body.toString());
      response.end(JSON.stringify({ results: texts.map((text) => ({ entities: [{ start: 0, end: Math.min(4, text.length), kind: "PERSON", note: MARKS.detected }] })) }));
    } else if (body.includes(Buffer.from("unreadable"))) {
      response.statusCode = 422;
      response.end(JSON.stringify({ error: { message: `could not read: ${MARKS.failure}` } }));
    } else {
      response.end(JSON.stringify({ text: `${MARKS.read} ${body.toString("latin1").slice(0, 40)}`, pages: 2 }));
    }
  });
});
await new Promise((resolve) => engine.listen(0, "127.0.0.1", resolve));

const TOKEN = "dd_test_nothing_kept";
const person = "00000000-0000-4000-a000-0000000000c1";
const now = new Date().toISOString();
const seedSql = [
  `INSERT INTO users (id, email, phone, created_at, country, signup_method) VALUES ('${person}', 'kept@test.example', NULL, '${now}', 'SA', 'email');`,
  `INSERT INTO sessions (token_hash, user_id, client, device, created_at, last_used_at) VALUES ('${sha256Hex(TOKEN)}', '${person}', 'desktop', 'Test Mac', '${now}', '${now}');`,
].join("\n");

const filesOf = (folder) =>
  readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    return statSync(path).isDirectory() ? filesOf(path) : [path];
  });
const findMarks = (folder, log) => {
  const found = [];
  for (const path of filesOf(folder)) {
    const bytes = readFileSync(path);
    for (const [name, mark] of Object.entries(MARKS)) {
      if (bytes.includes(Buffer.from(mark, "utf8")) || bytes.includes(Buffer.from(mark, "utf16le"))) found.push(`${name} in ${path.slice(folder.length + 1)}`);
    }
  }
  for (const [name, mark] of Object.entries(MARKS)) if (log.includes(mark)) found.push(`${name} in the service's output`);
  return found;
};

for (const [label, vars] of [["engine", { ENGINE_URL: `http://127.0.0.1:${engine.address().port}` }]]) {
  const service = await startServerService({ seedSql, vars });
  let stopped = false;
  try {
    const call = client(service.base);
    const detected = await call("POST", "/v1/detect", { body: { texts: [`Jane Doe ${MARKS.text}`, MARKS.arabic, ""] }, token: TOKEN });
    const pdf = Buffer.from(`%PDF-1.7 pages=2 ${MARKS.file}`);
    const read = await call("POST", "/v1/ocr?layout=1", { raw: pdf, token: TOKEN, headers: { "content-type": "application/pdf" } });
    const refused = await call("POST", "/v1/ocr", { raw: Buffer.from(`%PDF-1.7 unreadable [[unreadable]] ${MARKS.file}`), token: TOKEN, headers: { "content-type": "application/pdf" } });
    expect(`${label}: the requests were answered (detection, reading, and a file the reader refused)`, detected.status === 200 && read.status === 200 && refused.status === 422, [detected.status, read.status, refused.status, refused.json]);

    const counted = service.query("SELECT detect_requests, detect_texts, detect_characters, ocr_files, ocr_failed FROM usage_daily WHERE user_id = ?", person)[0];
    expect(`${label}: what is kept is counts: requests, texts, characters, files, failures`, counted?.detect_requests === 1 && counted?.detect_texts === 3 && counted?.ocr_files === 1 && counted?.ocr_failed === 1, counted);

    const whileRunning = findMarks(service.folder, service.log());
    expect(`${label}: while it runs, no text, file, engine answer or engine error is in any file of the data folder or in the log`, whileRunning.length === 0, whileRunning);
    await service.end();
    stopped = true;
    const afterStop = findMarks(service.folder, service.log());
    expect(`${label}: after it stops (the write-ahead log folded in), still none`, afterStop.length === 0, afterStop);
  } finally {
    if (!stopped) await service.end();
    await service.stop();
  }
}
engine.close();
console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
