// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Accelerate Technology Establishment
// Proves the service's central promise on a running server: what is sent to be checked for
// personal data (POST /v1/detect) or read (POST /v1/ocr), and what the engine answers about it,
// is written nowhere. Only counts are. The same for the worker that reads sealed documents
// (POST /v1/worker/chat/completions), through each of the three regions' upstreams: what it is
// sent, what it answers, and its error messages. This server receives the sealed text on its way
// to the upstream and on its way back; the proof is that it keeps none of it.
//
//   node server/test/nothing-kept.mjs           the server on Bun (DOEDESK_TEST_TARGET=node for Node)
//
// Each request carries markers that occur nowhere else: in the texts, in the file, in the engine's
// answers, in an engine's error message, and in what goes to the worker and comes back. Afterwards every byte of every file in the service's
// data folder (the database, its write-ahead log, the jobs file), read while the service runs and
// again after it has stopped, and everything the service printed, is searched for each marker, in
// UTF-8 and in UTF-16. The usage counters are checked too, so that the requests are known to have
// been handled.
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { client, sha256Hex, startServerService, startWorkerStubs, TARGET, WORKER_KEY, WORKER_REGIONS } from "../../test/local-service.mjs";

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
  sealed: marker("SealedDocumentSentToTheWorker"),
  sealedArabic: `${marker("وثيقة")}سرية`,
  workerFailure: marker("ErrorMessageOfTheWorker"),
  // The start of each key the service holds for a region's upstream: none belongs in a file or a line of output.
  workerKey: WORKER_KEY,
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
// One upstream per region. Each answers with what it was sent ("[[echo]]"), so that the server
// holds the sealed text on the way back too, and its failures repeat it beside a marker of their own.
const workers = await startWorkerStubs({ failWith: MARKS.workerFailure });

const TOKEN = "dd_test_nothing_kept";
const person = "00000000-0000-4000-a000-0000000000c1";
const now = new Date().toISOString();
// One account per region, so that each upstream is sent the sealed text. `person` is Saudi Arabia's.
const accountIn = { sa: person, eu: "00000000-0000-4000-a000-0000000000c2", global: "00000000-0000-4000-a000-0000000000c3" };
const tokenIn = { sa: TOKEN, eu: `${TOKEN}_eu`, global: `${TOKEN}_global` };
const seedSql = WORKER_REGIONS.flatMap((region) => [
  `INSERT INTO users (id, email, phone, created_at, country, signup_method, region) VALUES ('${accountIn[region]}', 'kept-${region}@test.example', NULL, '${now}', 'SA', 'email', '${region}');`,
  `INSERT INTO sessions (token_hash, user_id, client, device, created_at, last_used_at) VALUES ('${sha256Hex(tokenIn[region])}', '${accountIn[region]}', 'desktop', 'Test Mac', '${now}', '${now}');`,
]).join("\n");

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

for (const [label, vars] of [["engine", { ENGINE_URL: `http://127.0.0.1:${engine.address().port}`, ...workers.vars, WORKER_OPEN: "1", ...Object.fromEntries(WORKER_REGIONS.map((region) => [`WORKER_${region.toUpperCase()}_PARALLEL`, "1"])), ...Object.fromEntries(WORKER_REGIONS.map((region) => [`WORKER_${region.toUpperCase()}_MAX_WAIT_SECONDS`, "2"])) }]]) {
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

    const sealed = (prefix, region) => ({ body: { messages: [{ role: "system", content: "Answer from the document only." }, { role: "user", content: `${prefix} Document: ${MARKS.sealed} ${MARKS.sealedArabic}` }] }, token: tokenIn[region] });
    for (const region of WORKER_REGIONS) {
      const worker = workers[region];
      const answered = await call("POST", "/v1/worker/chat/completions", sealed("[[echo]]", region));
      const workerDown = await call("POST", "/v1/worker/chat/completions", sealed("[[worker-down]]", region));
      expect(
        `worker (${region}): the requests went through this region's upstream: one answered with the sealed text, one the worker failed`,
        answered.status === 200 && answered.headers.get("x-doedesk-worker-region") === region && answered.text.includes(MARKS.sealed) && answered.text.includes(MARKS.sealedArabic) && workerDown.status === 502 && worker.seen.requests.length === 2 && worker.seen.answers.filter((text) => text.includes(MARKS.workerFailure)).length === 1,
        [answered.status, workerDown.status, workerDown.json, worker.seen.requests.length],
      );
    }
    // A change of region is a record about the account. It holds two region names and nothing sent.
    const moved = await call("POST", "/v1/me/region", { body: { region: "eu" }, token: TOKEN });
    const afterMove = await call("POST", "/v1/worker/chat/completions", sealed("[[echo]]", "sa"));
    expect("worker: after the person changes region the sealed text goes through the new region's upstream, and the record of the change holds only the two regions", moved.status === 200 && afterMove.headers.get("x-doedesk-worker-region") === "eu" && workers.eu.seen.requests.length === 3 && JSON.stringify(service.query("SELECT from_region, to_region FROM region_changes").map((row) => ({ ...row }))) === JSON.stringify([{ from_region: "sa", to_region: "eu" }]), [moved.status, moved.json, afterMove.status]);
    await call("POST", "/v1/me/region", { body: { region: "sa" }, token: TOKEN });
    // Last, because an upstream that says it is busy is sent nothing more for a while: a request
    // that waits in the queue with the sealed text in it, and one the upstream was too busy for.
    for (const region of WORKER_REGIONS) {
      const holding = call("POST", "/v1/worker/chat/completions", sealed("[[slow=700]] [[echo]]", region));
      await new Promise((resolve) => setTimeout(resolve, 100));
      const queued = await call("POST", "/v1/worker/chat/completions", sealed("[[echo]]", region));
      const workerBusy = await call("POST", "/v1/worker/chat/completions", sealed("[[worker-busy]]", region));
      expect(
        `worker (${region}): a request waited its turn with the sealed text in it, and one the upstream was too busy for was answered as busy`,
        (await holding).status === 200 && queued.status === 200 && Number(queued.headers.get("x-doedesk-worker-queued-ms")) >= 300 && workerBusy.status === 429 && workerBusy.json?.error?.code === "worker_busy" && workers[region].seen.answers.filter((text) => text.includes(MARKS.workerFailure)).length === 2,
        [queued.status, queued.headers.get("x-doedesk-worker-queued-ms"), workerBusy.status, workerBusy.json],
      );
      const workerCounted = service.query("SELECT SUM(worker_requests) AS worker_requests, SUM(worker_input_tokens) AS worker_input_tokens, SUM(worker_output_tokens) AS worker_output_tokens, SUM(worker_failed) AS worker_failed FROM usage_daily WHERE user_id = ?", accountIn[region])[0];
      expect(`worker (${region}): what is kept is counts: requests, tokens sent and answered, failures`, workerCounted?.worker_requests >= 3 && workerCounted?.worker_input_tokens > 0 && workerCounted?.worker_output_tokens > 0 && workerCounted?.worker_failed === 2, workerCounted);
    }

    const whileRunning = findMarks(service.folder, service.log());
    expect(`${label}: while it runs, no text, file, engine answer or engine error, nothing sent to any region's worker or answered by it, and no key of ours is in any file of the data folder or in the log`, whileRunning.length === 0, whileRunning);
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
await workers.stop();
console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
