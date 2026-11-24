// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Accelerate Technology Establishment
// Proves the worker route end to end on this machine (POST /v1/worker/chat/completions,
// src/worker-chat.ts): the model that reads sealed documents for the app.
//   - it needs a sign-in, and an account that may use the service;
//   - streaming and tools in any form are refused, and nothing of a refused request is sent on;
//   - each request goes to the upstream of the account's region and to no other: a region whose
//     upstream has no key, fails or cannot be reached is not answered for by another region;
//   - the person changes the region, and the next request goes to the new one;
//   - the upstream is sent its region's model, the messages and the few settings taken, and
//     nothing else: no other field, and nothing that names the account;
//   - its answer comes back byte for byte, with the region that answered;
//   - requests wait their turn: never more in flight than the region allows, accounts in turn, a
//     bounded wait that ends as "busy" with how many are waiting, and never another region;
//   - a region whose upstream does not list its model as hosted where it must be is not served;
//   - tokens, failures, oversized requests and answers served from an unexpected host are counted,
//     and the monthly allowance refuses at the right point;
//   - a worker that fails, is busy or cannot be reached is answered for in our own words;
//   - nothing sent and nothing answered is in the database or in the log: only counts.
//
//   node test/worker-chat.mjs
//
// It starts its own copies of the service on throwaway databases, with a stand-in for each
// region's upstream (see local-service.mjs). No real worker is called, and no real key is used.
import { randomBytes } from "node:crypto";

import { client, sha256Hex, startLocalService, startWorkerStubs as startAllWorkerStubs, WORKER_ANSWER_TOKENS, WORKER_ANOTHER_MODEL, WORKER_EU_TEST_MODEL, WORKER_EU_TEST_ROUTE, WORKER_KEY, WORKER_REGIONS, WORKER_STUB_PROVIDER, workerKeyFor, workerTokens } from "./local-service.mjs";
import { COUNTERS, dayOf, monthOf, sampleSql } from "./usage-sample.mjs";

const PATH = "/v1/worker/chat/completions";
const TOKEN_ALLOWANCE = 10_000_000;
const MAX_BYTES = 2_000_000;
/** Each region's model unless set, and what OpenRouter is asked: hosts that neither train on nor keep what they are sent. */
const MODELS = { sa: "qwen/qwen3.8-27b", eu: WORKER_EU_TEST_MODEL, global: "thinkingmachines/inkling-2-mini" };
const NO_RETENTION = { data_collection: "deny", zdr: true };
/** The EU region has no worker of its own; here its settings hold it to one host (local-service.mjs). */
const EU_ROUTE = WORKER_EU_TEST_ROUTE;
/** Waits for something the service does after it has answered. */
const until = async (condition, ms = 5000) => {
  for (let waited = 0; waited < ms && !condition(); waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
  return condition();
};
const OUTPUT_FLOOR = 4000;
const REGION_HEADER = "x-doedesk-worker-region";

let failures = 0;
const expect = (label, condition, detail = null) => {
  if (!condition) failures += 1;
  console.log(`${condition ? "ok  " : "FAIL"} ${label}${condition ? "" : ` -> ${JSON.stringify(detail)?.slice(0, 700)}`}`);
};
const same = (label, actual, expected) => expect(label, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });

// Text that occurs nowhere else: in what is sent, in what the worker answers, and in its errors.
const marker = (label) => `${label}${randomBytes(9).toString("hex")}`;
const MARKS = {
  sealed: marker("SealedDocumentSentToTheWorker"),
  arabic: `${marker("وثيقة")}سرية`,
  refused: marker("ContentOfARequestThatWasRefused"),
  failure: marker("ErrorMessageOfTheWorker"),
  // The stand-in's usual answer, which no test sends.
  answer: "The contract is dated 3 March",
};

// --- What goes into the database before the service starts ------------------------------------

const today = dayOf(0);
const thisMonth = monthOf(today);
const lastMonthDay = `${monthOf(new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 15)).toISOString())}-15`;
const zero = Object.fromEntries(COUNTERS.map((counter) => [counter, 0]));
const user = (name, region = "sa") => ({
  region,
  id: `00000000-0000-4000-a000-${sha256Hex(name).slice(0, 12)}`,
  email: `${name}@worker.example`,
  phone: null,
  created_at: new Date(Date.now() - 40 * 86_400_000).toISOString(),
  country: "SA",
  signup_method: "email",
  field: "legal",
  field_other: null,
  workplace: "self",
  profile_at: null,
});
const token = (name, kind) => `dd_test_worker_${name}_${kind}`;
const session = (person, name, kind, purpose = null) => ({
  token_hash: sha256Hex(token(name, kind)),
  user_id: person.id,
  client: kind,
  device: "test",
  created_at: person.created_at,
  last_used_at: new Date().toISOString(),
  purpose,
});

const reader = user("reader");
const european = user("european", "eu");
const worldwide = user("worldwide", "global");
const near = user("near-allowance");
const fresh = user("fresh-month");
const leaving = user("leaving");
const data = {
  users: [reader, european, worldwide, near, fresh, leaving],
  sessions: [
    session(reader, "reader", "desktop"),
    session(reader, "reader", "mobile"),
    session(european, "european", "desktop"),
    session(worldwide, "worldwide", "desktop"),
    session(near, "near-allowance", "server"),
    session(fresh, "fresh-month", "desktop"),
    // A sign-in made only to delete the account (migrations/0006).
    session(leaving, "leaving", "desktop", "delete_account"),
  ],
  daily: [
    // 999,990 tokens today, on top of the monthly total below: ten short of the allowance.
    { user_id: near.id, day: today, client: "server", ...zero, worker_requests: 40, worker_input_tokens: 999_990, worker_output_tokens: 9_000 },
    // The whole allowance, last month.
    { user_id: fresh.id, day: lastMonthDay, client: "desktop", ...zero, worker_requests: 300, worker_input_tokens: TOKEN_ALLOWANCE, worker_output_tokens: 80_000 },
  ],
  monthly: [{ user_id: near.id, month: thisMonth, ...zero, worker_requests: 500, worker_input_tokens: 9_000_000, worker_output_tokens: 120_000 }],
};
const seedSql = sampleSql(data);
// Every account of these copies has the worker (WORKER_OPEN), except in the last copy. Who has it
// one by one is not the service's to say: a layer beside it does (src/extension.ts).
const startWorkerStubs = async (options) => {
  const workers = await startAllWorkerStubs(options);
  return { ...workers, vars: { ...workers.vars, WORKER_OPEN: "1" } };
};

const messagesOf = (...contents) => contents.map((content, index) => ({ role: index === 0 && contents.length > 1 ? "system" : "user", content }));
const ask = (call, as, body) => call("POST", PATH, { body, token: as });

/** Every row of every table, as text: what a marker must not be found in. */
const everyRow = (service) =>
  service
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'")
    .map((table) => `${table.name}: ${JSON.stringify(service.query(`SELECT * FROM "${table.name}"`))}`)
    .join("\n");
const foundIn = (text, marks = MARKS) => Object.entries(marks).flatMap(([name, mark]) => (text.includes(mark) ? [name] : []));

// ================================================================================================
// First copy: a worker in each region, with each one's model left as it is unless set.
// ================================================================================================
{
  const workers = await startWorkerStubs({ failWith: MARKS.failure });
  // The seeded accounts' own region: Saudi Arabia. `worker` is its upstream throughout.
  const worker = workers.sa;
  const service = await startLocalService({ seedSql, vars: { ...workers.vars, WORKER_SA_EXPECTED_PROVIDER: WORKER_STUB_PROVIDER } });
  const call = client(service.base);
  const desktop = token("reader", "desktop");
  const mobile = token("reader", "mobile");
  const dailyRow = (userId, clientName) => service.query("SELECT * FROM usage_daily WHERE user_id = ? AND day = ? AND client = ?", userId, today, clientName)[0];
  const counters = (row) => Object.fromEntries(COUNTERS.map((counter) => [counter, row?.[counter] ?? 0]));
  const counted = (extra) => ({ ...zero, ...extra });
  let workerStopped = false;

  try {
    // --- Who may ask -------------------------------------------------------------------------------
    const anonymous = await call("POST", PATH, { body: { messages: messagesOf(`Summarise. ${MARKS.refused}`) } });
    const wrongToken = await ask(call, "dd_test_worker_nobody", { messages: messagesOf(`Summarise. ${MARKS.refused}`) });
    same("the worker needs a sign-in", [anonymous.status, anonymous.json?.error?.code, wrongToken.status], [401, "unauthenticated", 401]);
    const deletionOnly = await ask(call, token("leaving", "desktop"), { messages: messagesOf(`Summarise. ${MARKS.refused}`) });
    same("a sign-in made only to delete the account cannot use it", [deletionOnly.status, deletionOnly.json?.error?.code], [403, "deletion_only_sign_in"]);

    // --- What is refused ---------------------------------------------------------------------------
    const text = `What is the notice period? ${MARKS.refused}`;
    const refusals = {
      "stream: true": { messages: messagesOf(text), stream: true },
      tools: { messages: messagesOf(text), tools: [{ type: "function", function: { name: "send_email", parameters: {} } }] },
      "an empty list of tools": { messages: messagesOf(text), tools: [] },
      tool_choice: { messages: messagesOf(text), tool_choice: "auto" },
      functions: { messages: messagesOf(text), functions: [{ name: "send_email" }] },
      function_call: { messages: messagesOf(text), function_call: { name: "send_email" } },
      "a message from a tool": { messages: [...messagesOf(text), { role: "tool", content: "sent", tool_call_id: "call_1" }] },
      "no messages": { model: "any", temperature: 0 },
      "an empty list of messages": { messages: [] },
      "messages that are not a list": { messages: text },
      "a message without a role": { messages: [{ content: text }] },
      "a message whose content is not text": { messages: [{ role: "user", content: [{ type: "text", text }] }] },
      "a message that is not an object": { messages: [text] },
      "a list instead of an object": [{ messages: messagesOf(text) }],
    };
    const refused = {};
    for (const [name, body] of Object.entries(refusals)) refused[name] = await ask(call, desktop, body);
    refused["a body that is not JSON"] = await call("POST", PATH, { raw: `{"messages": [{"role": "user", "content": "${MARKS.refused}`, token: desktop, headers: { "content-type": "application/json" } });
    refused["an empty body"] = await call("POST", PATH, { raw: "", token: desktop, headers: { "content-type": "application/json" } });
    same(
      "streaming, tools in every form, and malformed requests are refused as invalid",
      Object.fromEntries(Object.entries(refused).map(([name, answer]) => [name, `${answer.status} ${answer.json?.error?.code}`])),
      Object.fromEntries(Object.keys(refused).map((name) => [name, "400 invalid_request"])),
    );
    expect(
      "each refusal is a plain sentence, and none repeats what was sent",
      Object.values(refused).every((answer) => typeof answer.json?.error?.message === "string" && /^[A-Z][^\n]+\.$/.test(answer.json.error.message) && !answer.text.includes(MARKS.refused) && !answer.text.includes("send_email")),
      Object.fromEntries(Object.entries(refused).map(([name, answer]) => [name, answer.json?.error?.message])),
    );
    expect("the refusals for streaming and for tools say which it was", /stream/.test(refused["stream: true"].json?.error?.message) && /no tools/.test(refused.tools.json?.error?.message) && /no tools/.test(refused["a message from a tool"].json?.error?.message));
    same("nothing of a refused request reached a worker, and none was counted", [WORKER_REGIONS.map((region) => workers[region].seen.requests.length), service.query("SELECT COUNT(*) AS n FROM usage_daily WHERE user_id = ?", reader.id)[0].n], [[0, 0, 0], 0]);

    // --- What the worker is sent -------------------------------------------------------------------
    const sealed = [
      { role: "system", content: "Answer from the document only." },
      { role: "user", content: `[[echo]] Document: ${MARKS.sealed} ${MARKS.arabic}. Who signed it?`, name: "reader", tool_calls: [{ id: "call_1" }], cache_control: { type: "ephemeral" } },
    ];
    const first = await ask(call, desktop, {
      model: "gpt-someone-elses",
      messages: sealed,
      temperature: 0.2,
      max_completion_tokens: 512,
      max_tokens: 256,
      response_format: { type: "json_object" },
      reasoning_effort: "low",
      // Fields the worker route does not take: none may be sent on.
      stream: false,
      tools: null,
      user: reader.email,
      metadata: { account: reader.id },
      top_p: 0.5,
      n: 4,
      stop: ["END"],
      seed: 7,
      service_tier: "flex",
      search_settings: { include_domains: ["example.com"] },
    });
    const sentOn = worker.seen.requests.at(-1);
    same("an answered request reaches the worker once, at its chat completions address", [first.status, worker.seen.requests.length, sentOn?.method, sentOn?.path], [200, 1, "POST", "/openai/v1/chat/completions"]);
    same("the worker is sent its region's model, the messages as role and content, the settings taken with the output limits raised to the region's floor and the reasoning setting the region was measured with, and no other field", sentOn?.body, {
      model: MODELS.sa,
      messages: sealed.map(({ role, content }) => ({ role, content })),
      temperature: 0.2,
      max_completion_tokens: OUTPUT_FLOOR,
      max_tokens: OUTPUT_FLOOR,
      response_format: { type: "json_object" },
      reasoning_effort: "none",
    });
    same("the worker is given the service's key for that region, not the person's sign-in", sentOn?.authorization, `Bearer ${workerKeyFor("sa")}`);
    const sentHeaders = JSON.stringify(sentOn?.headers ?? {});
    expect(
      "nothing that names the account goes to the worker: not its id, its address or its sign-in, in a header or in the body",
      ![reader.id, reader.email, desktop, sha256Hex(desktop)].some((value) => sentHeaders.includes(value) || JSON.stringify(sentOn?.body).includes(value)) && sentOn?.headers?.cookie === undefined,
      sentOn?.headers,
    );

    // --- What comes back ---------------------------------------------------------------------------
    expect("the worker's answer comes back unchanged, byte for byte", first.text === worker.seen.answers.at(-1) && first.json?.choices?.[0]?.message?.content?.includes(MARKS.sealed) && first.json?.model === MODELS.sa, first.text.slice(0, 300));
    same(
      "…as JSON, never cached, with the region that answered, which a page on another origin may read",
      [first.headers.get("content-type"), first.headers.get("cache-control"), first.headers.get(REGION_HEADER), first.headers.get("access-control-expose-headers"), first.headers.get("access-control-allow-origin")],
      ["application/json; charset=utf-8", "no-store", "sa", `${REGION_HEADER}, x-doedesk-worker-queued-ms, x-doedesk-worker-waiting`, "*"],
    );

    // --- One region, one upstream ------------------------------------------------------------------
    same("so far only Saudi Arabia's upstream has been sent anything", WORKER_REGIONS.map((region) => workers[region].seen.requests.length), [1, 0, 0]);
    const fromEurope = await ask(call, token("european", "desktop"), { model: MODELS.sa, messages: messagesOf(`tokens=11 [[echo]] ${MARKS.sealed}`), max_completion_tokens: 9000 });
    const fromAnywhere = await ask(call, token("worldwide", "desktop"), { messages: messagesOf(`tokens=12 [[echo]] ${MARKS.sealed}`) });
    same(
      "an account in the EU region is answered by the EU upstream and one in the global region by the global upstream, each named in the answer",
      [fromEurope.status, fromEurope.headers.get(REGION_HEADER), fromAnywhere.status, fromAnywhere.headers.get(REGION_HEADER), WORKER_REGIONS.map((region) => workers[region].seen.requests.length)],
      [200, "eu", 200, "global", [1, 1, 1]],
    );
    same(
      "…each sent its own region's model and key, whatever model the caller named, with the reasoning setting it was measured with: the EU's to the one host its settings name and nowhere else, the global one to any host that keeps nothing",
      ["eu", "global"].map((region) => ((sentTo) => [sentTo?.body?.model, sentTo?.authorization, sentTo?.body?.provider, sentTo?.body?.reasoning_effort])(workers[region].seen.requests.at(-1))),
      [[MODELS.eu, `Bearer ${workerKeyFor("eu")}`, EU_ROUTE, "none"], [MODELS.global, `Bearer ${workerKeyFor("global")}`, NO_RETENTION, "none"]],
    );
    // The EU upstream keeps a record of each call that names its data region. The first answer's is read.
    await until(() => workers.eu.seen.recordsRead.length > 0);
    same(
      "…and the EU upstream's own record of the call is read, with the region's key, and says Europe: nothing is counted; no other region's upstream is asked for one",
      [workers.eu.seen.recordsRead, workers.sa.seen.recordsRead.length, workers.global.seen.recordsRead.length, dailyRow(european.id, "desktop")?.worker_off_region],
      [[{ id: "gen-stub-1", authorization: `Bearer ${workerKeyFor("eu")}` }], 0, 0, 0],
    );
    const tellsApp = {};
    for (const [region, name] of [["sa", "reader"], ["eu", "european"], ["global", "worldwide"]]) {
      const { model, structured } = (await call("GET", "/v1/me", { token: token(name, "desktop") })).json?.worker ?? {};
      tellsApp[region] = [model, structured];
    }
    same("…and the app is told how to ask each region's model for JSON: an object in Saudi Arabia and in the EU, the strict schema elsewhere", tellsApp, { sa: [MODELS.sa, "jsonObject"], eu: [MODELS.eu, "jsonObject"], global: [MODELS.global, "jsonSchema"] });
    same("…an output limit above the floor is left as it is, and a request with none is given the floor", [workers.eu.seen.requests.at(-1)?.body?.max_completion_tokens, workers.global.seen.requests.at(-1)?.body?.max_completion_tokens], [9000, OUTPUT_FLOOR]);
    same("…and deep.sa, which is not a router, is sent no routing request", Object.hasOwn(worker.seen.requests.at(-1)?.body ?? {}, "provider"), false);
    same("…counted for the account that asked", [european, worldwide].map((person) => dailyRow(person.id, "desktop")?.worker_input_tokens), [11, 12]);

    // --- The person changes the region -------------------------------------------------------------
    const beforeChange = await call("GET", "/v1/me", { token: token("european", "desktop") });
    same("the account's own view names its region and the worker there, and never the upstream's address or key", [beforeChange.json?.region, beforeChange.json?.regionUpdatedAt, beforeChange.json?.worker, beforeChange.text.includes(workers.eu.origin) || beforeChange.text.includes(WORKER_KEY)], [
      "eu",
      null,
      { region: "eu", entitled: true, available: true, model: MODELS.eu, structured: "jsonObject", hostLabel: null, locationLabel: null, parallel: 16, maxWaitSeconds: 20, queue: { active: 0, waiting: 0 } },
      false,
    ]);
    const invalid = await call("POST", "/v1/me/region", { body: { region: "us" }, token: token("european", "desktop") });
    const unsigned = await call("POST", "/v1/me/region", { body: { region: "sa" } });
    const deleting = await call("POST", "/v1/me/region", { body: { region: "sa" }, token: token("leaving", "desktop") });
    same("a region is one of the three, and changing it needs an ordinary sign-in", [invalid.status, invalid.json?.error?.code, unsigned.status, deleting.status, deleting.json?.error?.code], [400, "invalid_request", 401, 403, "deletion_only_sign_in"]);
    const same1 = await call("POST", "/v1/me/region", { body: { region: "eu" }, token: token("european", "desktop") });
    same("choosing the region the account already has changes nothing and adds nothing to its history", [same1.status, same1.json?.regionUpdatedAt, service.query("SELECT COUNT(*) AS n FROM region_changes")[0].n], [200, null, 0]);
    const changed = await call("POST", "/v1/me/region", { body: { region: "sa" }, token: token("european", "desktop") });
    same("a change is answered with the new region and its worker", [changed.status, changed.json?.region, typeof changed.json?.regionUpdatedAt, changed.json?.worker?.region, changed.json?.worker?.hostLabel], [200, "sa", "string", "sa", "deep.sa"]);
    same("…Saudi Arabia's is described on deep.sa's word, with the one request at a time its account takes", [changed.json?.worker?.locationLabel, changed.json?.worker?.parallel], ["Saudi Arabia, according to deep.sa", 1]);
    const afterChange = await ask(call, token("european", "desktop"), { messages: messagesOf("tokens=13 After the change.") });
    same("the next request goes to the new region's upstream, and to no other", [afterChange.status, afterChange.headers.get(REGION_HEADER), WORKER_REGIONS.map((region) => workers[region].seen.requests.length)], [200, "sa", [2, 1, 1]]);
    await call("POST", "/v1/me/region", { body: { region: "global" }, token: token("european", "desktop") });
    const history = service.query("SELECT from_region, to_region, client, changed_at FROM region_changes WHERE user_id = ? ORDER BY changed_at", european.id);
    same("each change is added to the account's history, with the app it was made from", history.map((row) => [row.from_region, row.to_region, row.client]), [["eu", "sa", "desktop"], ["sa", "global", "desktop"]]);
    const europeanCopy = await call("GET", "/v1/me/export", { token: token("european", "desktop") });
    same(
      "the account's copy of its data holds the region, when it changed and the history",
      [europeanCopy.json?.account?.region, europeanCopy.json?.account?.regionUpdatedAt === history.at(-1)?.changed_at, europeanCopy.json?.regionHistory?.map((row) => `${row.from_region}>${row.to_region}`)],
      ["global", true, ["eu>sa", "sa>global"]],
    );
    // Back to where the seeded account started, so the counts below are Saudi Arabia's alone.
    await call("POST", "/v1/me/region", { body: { region: "eu" }, token: token("european", "desktop") });
    const sentSoFar = worker.seen.requests.length;

    // --- Metering ----------------------------------------------------------------------------------
    let expected = counted({ worker_requests: 1, worker_input_tokens: workerTokens(sealed), worker_output_tokens: WORKER_ANSWER_TOKENS });
    same("the request and the tokens the worker reports, sent and answered, are counted; nothing else", counters(dailyRow(reader.id, "desktop")), expected);
    expect("tokens are what the worker reports", first.json?.usage?.prompt_tokens === workerTokens(sealed) && workerTokens(sealed) > 100);

    const fromPhone = await ask(call, mobile, { messages: messagesOf("tokens=1200 A short question.") });
    same("a second client of the same account gets its own row", [fromPhone.status, counters(dailyRow(reader.id, "mobile"))], [200, counted({ worker_requests: 1, worker_input_tokens: 1200, worker_output_tokens: WORKER_ANSWER_TOKENS })]);
    same("…and the first client's row is untouched", counters(dailyRow(reader.id, "desktop")), expected);

    const elsewhere = await ask(call, desktop, { messages: messagesOf("tokens=300 [[off-region]] Where are you?") });
    expected = { ...expected, worker_requests: 2, worker_input_tokens: expected.worker_input_tokens + 300, worker_output_tokens: expected.worker_output_tokens + WORKER_ANSWER_TOKENS, worker_off_region: 1 };
    same("an answer the upstream says another host served is passed on as it is, under the account's region", [elsewhere.status, elsewhere.headers.get(REGION_HEADER), elsewhere.json?.provider, elsewhere.text === worker.seen.answers.at(-1)], [200, "sa", "Elsewhere", true]);
    same("…and counted as off region, for the owner to see", counters(dailyRow(reader.id, "desktop")), expected);

    const unnamed = await ask(call, desktop, { messages: messagesOf("tokens=50 [[no-region]] Where are you?") });
    expected = { ...expected, worker_requests: 3, worker_input_tokens: expected.worker_input_tokens + 50, worker_output_tokens: expected.worker_output_tokens + WORKER_ANSWER_TOKENS };
    same("an answer that names no host is passed on, and is not counted as off region", [unnamed.status, unnamed.json?.provider, counters(dailyRow(reader.id, "desktop"))], [200, undefined, expected]);

    const uncounted = await ask(call, desktop, { messages: messagesOf("[[no-usage]] A question.") });
    expected = { ...expected, worker_requests: 4 };
    same("an answer without a usage object is passed on and counted as a request with no tokens", [uncounted.status, uncounted.json?.usage, counters(dailyRow(reader.id, "desktop"))], [200, undefined, expected]);

    // --- Size --------------------------------------------------------------------------------------
    const padded = (bytes) => {
      const empty = JSON.stringify({ messages: [{ role: "user", content: "tokens=5 " }] });
      return JSON.stringify({ messages: [{ role: "user", content: `tokens=5 ${"a".repeat(bytes - Buffer.byteLength(empty))}` }] });
    };
    const json = { "content-type": "application/json" };
    const fits = await call("POST", PATH, { raw: padded(MAX_BYTES), token: desktop, headers: json });
    const tooBig = await call("POST", PATH, { raw: padded(MAX_BYTES + 1), token: desktop, headers: json });
    expected = { ...expected, worker_requests: 5, worker_input_tokens: expected.worker_input_tokens + 5, worker_output_tokens: expected.worker_output_tokens + WORKER_ANSWER_TOKENS, worker_too_large: 1 };
    same("a request of exactly 2,000,000 bytes is answered; one byte more is refused as too large", [Buffer.byteLength(padded(MAX_BYTES)), fits.status, tooBig.status, tooBig.json?.error?.code], [MAX_BYTES, 200, 413, "too_large"]);
    same("…and counted as too large, without reaching the worker", [counters(dailyRow(reader.id, "desktop")), worker.seen.requests.length - sentSoFar], [expected, 5]);

    // --- A worker that fails -----------------------------------------------------------------------
    const down = await ask(call, desktop, { messages: messagesOf(`[[worker-down]] Document: ${MARKS.sealed}`) });
    const notJson = await ask(call, desktop, { messages: messagesOf(`[[not-json]] Document: ${MARKS.sealed}`) });
    expected = { ...expected, worker_failed: 2 };
    same("a worker that fails, or answers something that is not a completion, is a 502 of ours", [down.status, down.json?.error?.code, down.json?.error?.message, notJson.status, notJson.json?.error?.code], [502, "worker_failed", "The worker answered 500.", 502, "worker_failed"]);
    expect(
      "…that repeats neither the request nor the worker's own words",
      [down, notJson].every((answer) => foundIn(answer.text).length === 0 && !/stub|html|completion/i.test(answer.text) && answer.headers.get(REGION_HEADER) === null),
      [down.text, notJson.text],
    );
    same("…counted as failed, with no request and no tokens added", counters(dailyRow(reader.id, "desktop")), expected);
    same("a region whose upstream fails is not answered for by another region: the other two were sent nothing", [workers.eu.seen.requests.length, workers.global.seen.requests.length], [1, 1]);

    const rejected = await ask(call, desktop, { messages: messagesOf(`[[worker-refuses]] Document: ${MARKS.sealed}`) });
    expected = { ...expected, worker_failed: 3 };
    same("a request the worker refuses is refused with the same status, in our words", [rejected.status, rejected.json?.error?.code, foundIn(rejected.text), /context|stub/i.test(rejected.text)], [400, "worker_rejected", [], false]);
    same("…counted as failed", counters(dailyRow(reader.id, "desktop")), expected);

    const jsonFailed = await ask(call, desktop, { messages: messagesOf(`[[worker-json-fails]] Document: ${MARKS.sealed}`) });
    expected = { ...expected, worker_failed: 4 };
    same("a worker that could not fit its own answer to the format is named by its code, and nothing else of its refusal is passed on", [jsonFailed.status, jsonFailed.json?.error?.code, foundIn(jsonFailed.text), /generate|stub/i.test(jsonFailed.text)], [400, "json_validate_failed", [], false]);
    same("…counted as failed", counters(dailyRow(reader.id, "desktop")), expected);

    // --- What the app is told ----------------------------------------------------------------------
    const me = await call("GET", "/v1/me", { token: desktop });
    same("the account's own view: this month's worker tokens and requests, across its clients", [me.json?.usage?.workerInputTokens, me.json?.usage?.workerRequests], [expected.worker_input_tokens + 1200, expected.worker_requests + 1]);
    same("…and the allowance for the worker, beside the other two", [me.json?.allowance?.workerInputTokens, me.json?.allowance?.detectCharacters, me.json?.allowance?.ocrPages], [TOKEN_ALLOWANCE, 3_000_000, 200]);
    const copy = await call("GET", "/v1/me/export", { token: desktop });
    const exported = copy.json?.usage?.daily?.find((row) => row.client === "desktop");
    same("the account's copy of its data holds the worker's counts, and nothing sent or answered", [counters(exported), foundIn(copy.text)], [expected, []]);
    const page = await call("GET", `/admin/accounts/${reader.id}`, { headers: { authorization: `Bearer ${service.adminKey}` } });
    expect(
      "the owner's page for the account shows the worker's refusals, failures and answers from another region",
      page.text.includes(`<tr><th scope="row">Worker</th><td class="num">0</td><td class="num">1</td><td class="num">4</td><td class="num">1</td></tr>`),
      page.text.split("Refused and failed")[1]?.slice(0, 900),
    );

    // --- The allowance -----------------------------------------------------------------------------
    const nearToken = token("near-allowance", "server");
    const sentBefore = worker.seen.requests.length;
    // 9,000,000 in the monthly total + 999,990 today = 9,999,990 used.
    const last = await ask(call, nearToken, { messages: messagesOf("tokens=20 The last question that fits.") });
    const over = await ask(call, nearToken, { messages: messagesOf(`tokens=1 One more. ${MARKS.refused}`) });
    same("allowance: ten tokens short, one more request is answered (its tokens cannot be known first)", [last.status, worker.seen.requests.length - sentBefore], [200, 1]);
    same("allowance: at 10,000,010 the next is refused like detection is, and does not reach the worker", [over.status, over.json?.error?.code, worker.seen.requests.length - sentBefore, over.text.includes(MARKS.refused)], [429, "quota_exceeded", 1, false]);
    same(
      "allowance: the day's row holds what was served and the refusal",
      counters(dailyRow(near.id, "server")),
      counted({ worker_requests: 41, worker_input_tokens: 999_990 + 20, worker_output_tokens: 9_000 + WORKER_ANSWER_TOKENS, worker_refused: 1 }),
    );
    const nearMe = await call("GET", "/v1/me", { token: nearToken });
    same("allowance: the month's total is the monthly total plus the daily rows", nearMe.json?.usage?.workerInputTokens, TOKEN_ALLOWANCE + 10);
    const stillText = await call("POST", "/v1/detect", { body: { texts: ["Jane Doe"] }, token: nearToken });
    same("allowance: an account out of worker tokens can still have text checked", stillText.status, 200);
    const newMonth = await ask(call, token("fresh-month", "desktop"), { messages: messagesOf("tokens=10 A new month.") });
    same("allowance: last month's use does not count against this month", newMonth.status, 200);

    // --- A worker that cannot be reached -------------------------------------------------------------
    const elsewhereBefore = [workers.eu.seen.requests.length, workers.global.seen.requests.length];
    await worker.stop();
    workerStopped = true;
    const unreachable = await ask(call, desktop, { messages: messagesOf(`Document: ${MARKS.sealed}`) });
    expected = { ...expected, worker_failed: 5 };
    same("a worker that cannot be reached is a 502 of ours, counted as failed", [unreachable.status, unreachable.json?.error?.code, foundIn(unreachable.text), counters(dailyRow(reader.id, "desktop"))], [502, "worker_failed", [], expected]);
    same("…and the sealed text was not sent to another region's upstream in its place", [workers.eu.seen.requests.length, workers.global.seen.requests.length], elsewhereBefore);
    const stillEurope = await ask(call, token("european", "desktop"), { messages: messagesOf("tokens=5 While Saudi Arabia's worker is down.") });
    same("…while an account in another region is answered as usual", [stillEurope.status, stillEurope.headers.get(REGION_HEADER)], [200, "eu"]);

    // --- Nothing is kept ---------------------------------------------------------------------------
    same("each region's upstream was sent the sealed text, and answered with it", WORKER_REGIONS.map((region) => workers[region].seen.requests.some((request) => JSON.stringify(request.body).includes(MARKS.sealed)) && workers[region].seen.answers.some((answer) => answer.includes(MARKS.sealed))), [true, true, true]);
    same("the worker was sent the sealed text, and answered with it", [worker.seen.requests.filter((request) => JSON.stringify(request.body).includes(MARKS.sealed)).length >= 2, worker.seen.answers.some((answer) => answer.includes(MARKS.sealed)), worker.seen.answers.some((answer) => answer.includes(MARKS.failure))], [true, true, true]);
    same("nothing sent to the worker, nothing it answered and none of its error messages is in any table of the database", foundIn(everyRow(service)), []);
    same("…or in what the service printed", foundIn(service.log()), []);
    // The account's opaque id is not looked for: wrangler prints each request's address, and the owner's page for an account is addressed by it.
    expect("the service logged neither the worker's key nor an account's address or sign-in", !service.log().includes(WORKER_KEY) && !/@worker\.example/.test(service.log()) && !service.log().includes(desktop), service.log().match(/.*(stub-worker|@worker\.example|dd_test_worker).*/g)?.slice(0, 3));
    same("every request to an upstream carried the service's key for that region, and no other region's", WORKER_REGIONS.map((region) => [...new Set(workers[region].seen.requests.map((request) => request.authorization))]), WORKER_REGIONS.map((region) => [`Bearer ${workerKeyFor(region)}`]));
  } catch (cause) {
    failures += 1;
    console.log("FAIL the run stopped:", cause);
    console.log(service.log().split("\n").slice(-30).join("\n"));
  } finally {
    await service.stop();
    if (!workerStopped) await worker.stop();
    await workers.eu.stop();
    await workers.global.stop();
  }
}

// ================================================================================================
// Second copy: a region's settings changed, and acceptance of the Terms required.
// ================================================================================================
{
  const workers = await startWorkerStubs();
  const worker = workers.eu;
  const service = await startLocalService({
    seedSql,
    vars: {
      ...workers.vars,
      WORKER_EU_URL: `${worker.url}/`,
      WORKER_EU_MODEL: WORKER_ANOTHER_MODEL,
      WORKER_EU_STRUCTURED: "jsonObject",
      WORKER_EU_REASONING_EFFORT: "low",
      WORKER_EU_MIN_OUTPUT_TOKENS: "700",
      WORKER_EU_PROVIDER: JSON.stringify({ only: ["host-two"], zdr: true }),
      WORKER_EU_EXPECTED_PROVIDER: "elsewhere",
      WORKER_GLOBAL_PROVIDER: "none",
      WORKER_GLOBAL_REASONING_EFFORT: "caller",
      REQUIRE_ACCEPTANCE: "all",
    },
  });
  const call = client(service.base);
  try {
    // The seeded accounts have accepted nothing: with acceptance required for use, they are paused.
    const paused = await ask(call, token("reader", "desktop"), { model: "x", messages: messagesOf(`Document: ${MARKS.sealed}`) });
    same("required: an account that has not accepted the Terms is refused, as for detection, and nothing is sent or counted", [paused.status, paused.json?.error?.code, WORKER_REGIONS.map((region) => workers[region].seen.requests.length), service.query("SELECT COUNT(*) AS n FROM usage_daily WHERE user_id = ?", reader.id)[0].n], [403, "terms_update_required", [0, 0, 0], 0]);

    // A new account from Germany: its region is the EU's, guessed once when it is made.
    const signIn = async (email, country) => {
      const start = await call("POST", "/v1/auth/email/start", { body: { email, client: "desktop", acceptance: await acceptanceFor(call) }, headers: country === null ? {} : { "x-test-country": country } });
      const link = new URL(start.json.testLink);
      await fetch(`${service.base}/auth/confirm`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ r: link.searchParams.get("r"), t: link.searchParams.get("t") }) });
      return call("POST", "/v1/auth/email/poll", { body: { requestId: start.json.requestId, pollSecret: start.json.pollSecret } });
    };
    const signedIn = await signIn("accepted@worker.example", "DE");
    same("a new account is told its region and the worker there when it signs in", [signedIn.json?.account?.region, signedIn.json?.worker], ["eu", { region: "eu", entitled: true, available: true, model: WORKER_ANOTHER_MODEL, structured: "jsonObject", hostLabel: null, locationLabel: null, parallel: 16, maxWaitSeconds: 20, queue: { active: 0, waiting: 0 } }]);
    // The seeded reader's account was made in Saudi Arabia. It signs in again, from Germany.
    const again = await signIn(reader.email, "DE");
    same("signing in later from another country does not change an account's region", [again.json?.created, again.json?.account?.region, service.query("SELECT region, region_updated_at FROM users WHERE id = ?", reader.id).map((row) => ({ ...row }))], [false, "sa", [{ region: "sa", region_updated_at: null }]]);
    const elsewhere = await signIn("elsewhere@worker.example", "US");
    const unknown = await signIn("unknown@worker.example", null);
    same("an account made from the United States, or from a country that is not known, starts in the global region", [elsewhere.json?.account?.region, unknown.json?.account?.region], ["global", "global"]);

    const fromThere = await ask(call, signedIn.json?.token, { model: MODELS.eu, messages: messagesOf("tokens=30 [[off-region]] A question."), reasoning_effort: "high", max_completion_tokens: 512 });
    const fromHere = await ask(call, signedIn.json?.token, { messages: messagesOf("tokens=30 A question.") });
    same("a model set in the settings is the one sent, whatever the caller names", [fromThere.status, fromHere.status, worker.seen.requests.map((request) => request.body.model)], [200, 200, [WORKER_ANOTHER_MODEL, WORKER_ANOTHER_MODEL]]);
    same("the address may be set with a trailing slash", worker.seen.requests.map((request) => request.path), ["/openai/v1/chat/completions", "/openai/v1/chat/completions"]);
    same(
      "the region's reasoning effort replaces the caller's, its output floor may be set, and its routing request is sent as set",
      worker.seen.requests.map((request) => [request.body.reasoning_effort, request.body.max_completion_tokens, request.body.provider]),
      [["low", 700, { only: ["host-two"], zdr: true }], ["low", 700, { only: ["host-two"], zdr: true }]],
    );
    same(
      "the host expected to serve a region may be set, in any case: an answer from it is not off region, one from another is",
      service.query("SELECT worker_requests, worker_input_tokens, worker_off_region FROM usage_daily WHERE user_id = ?", signedIn.json?.account?.id).map((row) => ({ ...row })),
      [{ worker_requests: 2, worker_input_tokens: 60, worker_off_region: 1 }],
    );
    const unrouted = await ask(call, elsewhere.json?.token, { messages: messagesOf("tokens=30 A question."), reasoning_effort: "medium" });
    same("a region set to send no routing request sends none, and one set to pass the caller's reasoning setting on does", [unrouted.status, Object.hasOwn(workers.global.seen.requests.at(-1)?.body ?? {}, "provider"), workers.global.seen.requests.at(-1)?.body?.reasoning_effort], [200, false, "medium"]);
  } catch (cause) {
    failures += 1;
    console.log("FAIL the second run stopped:", cause);
    console.log(service.log().split("\n").slice(-30).join("\n"));
  } finally {
    await service.stop();
    await workers.stop();
  }
}

// ================================================================================================
// Third copy: one region has no key. Its accounts have no worker; no other region answers for them.
// ================================================================================================
{
  const workers = await startWorkerStubs({ without: ["eu"] });
  const service = await startLocalService({ seedSql, vars: workers.vars });
  const call = client(service.base);
  try {
    const off = await ask(call, token("european", "desktop"), { messages: messagesOf(`Document: ${MARKS.sealed}`) });
    same(
      "an account whose region has no worker is told so, and the sealed text is sent to no region's upstream and nothing is counted",
      [off.status, off.json?.error?.code, off.json?.error?.region, /not available in your region yet/.test(off.json?.error?.message ?? "") && /not sent to another region/.test(off.json?.error?.message ?? "") && off.json?.error?.offered === false, WORKER_REGIONS.map((region) => workers[region].seen.requests.length), service.query("SELECT COUNT(*) AS n FROM usage_daily WHERE user_id = ?", european.id)[0].n],
      [503, "worker_unavailable", "eu", true, [0, 0, 0], 0],
    );
    same("…and still nobody is told so without a sign-in", (await call("POST", PATH, { body: { messages: messagesOf("A question.") } })).status, 401);
    const me = await call("GET", "/v1/me", { token: token("european", "desktop") });
    same("…its own view says the region has no worker now", [me.status, me.json?.region, me.json?.worker?.available, me.json?.worker?.model], [200, "eu", false, null]);
    const others = [await ask(call, token("reader", "desktop"), { messages: messagesOf("tokens=4 A question.") }), await ask(call, token("worldwide", "desktop"), { messages: messagesOf("tokens=4 A question.") })];
    same("…while accounts in the other regions are answered by their own upstreams", [others.map((answer) => [answer.status, answer.headers.get(REGION_HEADER)]), WORKER_REGIONS.map((region) => workers[region].seen.requests.length)], [[[200, "sa"], [200, "global"]], [1, 0, 1]]);
    same("…and the rest of the service answers as usual", [me.json?.usage?.workerInputTokens, (await call("POST", "/v1/detect", { body: { texts: ["Jane Doe"] }, token: token("european", "desktop") })).status], [0, 200]);
  } catch (cause) {
    failures += 1;
    console.log("FAIL the third run stopped:", cause);
    console.log(service.log().split("\n").slice(-30).join("\n"));
  } finally {
    await service.stop();
    await workers.stop();
  }
}

// ================================================================================================
// Fourth copy: frozen for a move, when nothing may be written (src/maintenance.ts).
// ================================================================================================
{
  const workers = await startWorkerStubs();
  const worker = workers.sa;
  const service = await startLocalService({ seedSql, vars: { ...workers.vars, MAINTENANCE: "freeze" } });
  const call = client(service.base);
  try {
    const frozen = await ask(call, token("reader", "desktop"), { messages: messagesOf("tokens=40 A question during the move.") });
    // Under wrangler a line the service prints reaches its output a moment after the answer.
    for (let waited = 0; waited < 5000 && !service.log().includes("freeze_unmetered"); waited += 100) await new Promise((resolve) => setTimeout(resolve, 100));
    same(
      "freeze: the worker is answered as usual and not counted, like detection and reading; the log counts it, with no identifier",
      [frozen.status, frozen.text === worker.seen.answers.at(-1), service.query("SELECT COUNT(*) AS n FROM usage_daily WHERE user_id = ?", reader.id)[0].n, (service.log().match(/freeze_unmetered/g) ?? []).length, /@worker\.example/.test(service.log())],
      [200, true, 0, 1, false],
    );
  } catch (cause) {
    failures += 1;
    console.log("FAIL the fourth run stopped:", cause);
    console.log(service.log().split("\n").slice(-30).join("\n"));
  } finally {
    await service.stop();
    await workers.stop();
  }
}

// ================================================================================================
// Fifth copy: the queue. Saudi Arabia takes one request at a time, the EU two; a wait is two seconds.
// ================================================================================================
{
  const workers = await startWorkerStubs({ failWith: MARKS.failure });
  const service = await startLocalService({
    seedSql,
    vars: { ...workers.vars, WORKER_SA_PARALLEL: "1", WORKER_SA_PER_MINUTE: "0", WORKER_SA_MAX_WAIT_SECONDS: "2", WORKER_EU_PARALLEL: "2" },
  });
  const call = client(service.base);
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const asReader = token("reader", "desktop");
  const asFresh = token("fresh-month", "desktop");
  const asEuropean = token("european", "desktop");
  const sentTo = (region, text) => workers[region].seen.requests.findIndex((request) => JSON.stringify(request.body).includes(text));
  try {
    // --- Never more at once than the region takes, and accounts in turn ------------------------
    const folder = [1, 2, 3, 4].map((number) => ask(call, asReader, { messages: messagesOf(`tokens=5 [[slow=150]] folder-${number}`) }));
    await pause(60);
    // A second person asks one question while the first person's folder is waiting.
    const single = ask(call, asFresh, { messages: messagesOf("tokens=5 [[slow=150]] single-question") });
    const answers = await Promise.all([...folder, single]);
    same("every request that waited its turn is answered", answers.map((answer) => answer.status), [200, 200, 200, 200, 200]);
    same("Saudi Arabia's upstream never had more than its one request in flight", workers.sa.seen.mostAtOnce, 1);
    expect(
      "accounts take turns: the second person's one question is sent before the rest of the first person's folder",
      sentTo("sa", "single-question") >= 0 && sentTo("sa", "single-question") < sentTo("sa", "folder-3") && sentTo("sa", "single-question") < sentTo("sa", "folder-4"),
      workers.sa.seen.requests.map((request) => request.body.messages.at(-1).content),
    );
    expect(
      "an answer says how long its request waited for its turn",
      Number(answers[0].headers.get("x-doedesk-worker-queued-ms")) < 100 && Number(answers[3].headers.get("x-doedesk-worker-queued-ms")) >= 250 && answers[3].headers.get("x-doedesk-worker-waiting") !== null,
      answers.map((answer) => answer.headers.get("x-doedesk-worker-queued-ms")),
    );
    const five = await Promise.all([1, 2, 3, 4, 5].map((number) => ask(call, asEuropean, { messages: messagesOf(`tokens=5 [[slow=120]] eu-${number}`) })));
    same("the EU's upstream, which takes two at once, never had more than two", [five.map((answer) => answer.status), workers.eu.seen.mostAtOnce], [[200, 200, 200, 200, 200], 2]);
    const described = await call("GET", "/v1/me", { token: asReader });
    same("the app is told how many requests its region takes at once, how long a request may wait, and how busy the region is", [described.json?.worker?.parallel, described.json?.worker?.maxWaitSeconds, described.json?.worker?.queue], [1, 2, { active: 0, waiting: 0 }]);

    // --- A caller that goes away gives up its place --------------------------------------------
    const holding = ask(call, asReader, { messages: messagesOf("tokens=5 [[slow=600]] holding") });
    await pause(80);
    const leaving = new AbortController();
    const left = fetch(`${service.base}${PATH}`, { method: "POST", signal: leaving.signal, headers: { "content-type": "application/json", authorization: `Bearer ${asFresh}` }, body: JSON.stringify({ messages: messagesOf("tokens=5 left-the-queue") }) }).then(() => "answered", () => "gone");
    await pause(80);
    leaving.abort();
    const after = await ask(call, asFresh, { messages: messagesOf("tokens=5 after-the-one-who-left") });
    same("a request whose caller went away while it waited is never sent, and the next one is", [await left, (await holding).status, after.status, sentTo("sa", "left-the-queue"), sentTo("sa", "after-the-one-who-left") >= 0], ["gone", 200, 200, -1, true]);

    // --- The upstream says to wait -------------------------------------------------------------
    const before = workers.sa.seen.requests.length;
    const refusedOnce = await ask(call, asReader, { messages: messagesOf("tokens=5 [[refuse-once]] patience") });
    const [first, second] = workers.sa.seen.times.slice(before);
    same("a request the upstream refuses in its turn is sent again, once the time the upstream named has passed", [refusedOnce.status, workers.sa.seen.requests.length - before, second - first >= 950], [200, 2, true]);

    // --- The wait is bounded, and ends as busy --------------------------------------------------
    const others = [workers.eu.seen.requests.length, workers.global.seen.requests.length];
    const sentBefore = workers.sa.seen.requests.length;
    const long = ask(call, asReader, { messages: messagesOf("tokens=5 [[slow=3200]] a-long-document") });
    await pause(100);
    const waited = await Promise.all([ask(call, asFresh, { messages: messagesOf(`tokens=5 ${MARKS.sealed} waiting-one`) }), ask(call, asReader, { messages: messagesOf(`tokens=5 ${MARKS.sealed} waiting-two`) })]);
    same(
      "a request not sent within the region's wait is answered as busy, with the region and how long to wait",
      waited.map((answer) => [answer.status, answer.json?.error?.code, answer.json?.error?.region, Number(answer.headers.get("retry-after")) >= 1]),
      [[429, "worker_busy", "sa", true], [429, "worker_busy", "sa", true]],
    );
    same("…and with how many were waiting, itself included", waited.map((answer) => answer.json?.error?.waiting).toSorted(), [1, 2]);
    expect("…in our words, which say it was not sent to another region and repeat nothing that was sent", waited.every((answer) => /another region/.test(answer.json?.error?.message ?? "") && foundIn(answer.text).length === 0), waited[0].text);
    same(
      "…and it was sent nowhere: not to Saudi Arabia's upstream, and not to another region's",
      [(await long).status, workers.sa.seen.requests.length - sentBefore, sentTo("sa", "waiting-one"), sentTo("sa", "waiting-two"), workers.eu.seen.requests.length, workers.global.seen.requests.length],
      [200, 1, -1, -1, ...others],
    );
    same("…counted as failed for the account, with no request and no tokens", service.query("SELECT worker_failed FROM usage_daily WHERE user_id = ? AND day = ?", fresh.id, today).map((row) => row.worker_failed), [1]);

    // --- An upstream that is busy beyond the wait ------------------------------------------------
    const busy = await ask(call, asReader, { messages: messagesOf("[[worker-busy]] A question.") });
    same("an upstream that says to wait longer than the region's wait is answered for as busy, with the time it named", [busy.status, busy.json?.error?.code, busy.headers.get("retry-after")], [429, "worker_busy", "7"]);
    expect("…in our words, not the upstream's", !busy.text.includes(MARKS.failure) && !/rate limit/i.test(busy.text), busy.text);
    const held = await ask(call, asFresh, { messages: messagesOf("tokens=5 while-told-to-wait") });
    same("…and nothing more is sent to it until then: the next request waits, and is answered as busy", [held.status, held.json?.error?.code, sentTo("sa", "while-told-to-wait"), Number(held.headers.get("retry-after")) >= 1], [429, "worker_busy", -1, true]);
  } catch (cause) {
    failures += 1;
    console.log("FAIL the fifth run stopped:", cause);
    console.log(service.log().split("\n").slice(-30).join("\n"));
  } finally {
    await service.stop();
    await workers.stop();
  }
}

// ================================================================================================
// Sixth copy: the Saudi upstream's own list does not say the model is hosted in Saudi Arabia.
// ================================================================================================
{
  const workers = await startWorkerStubs();
  // The same key reaches models hosted elsewhere. This is what the list would say of one.
  workers.sa.models.splice(0, workers.sa.models.length, { id: MODELS.sa, object: "model", hosted_in: "global" }, { id: WORKER_ANOTHER_MODEL, object: "model", hosted_in: "saudi" });
  const service = await startLocalService({ seedSql, vars: workers.vars });
  const call = client(service.base);
  try {
    const refused = await ask(call, token("reader", "desktop"), { messages: messagesOf(`Document: ${MARKS.sealed}`) });
    same(
      "a Saudi account is not served while the upstream's list says the model is hosted elsewhere, and its file is sent to no region",
      [refused.status, refused.json?.error?.code, refused.json?.error?.region, workers.sa.seen.modelLists >= 1, WORKER_REGIONS.map((region) => workers[region].seen.requests.length)],
      [503, "worker_unavailable", "sa", true, [0, 0, 0]],
    );
    const me = await call("GET", "/v1/me", { token: token("reader", "desktop") });
    same("…and its own view says the region has no worker now", [me.json?.region, me.json?.worker?.available], ["sa", false]);
    const europe = await ask(call, token("european", "desktop"), { messages: messagesOf("tokens=5 A question.") });
    same("…while a region that requires nothing of its upstream is served without reading its list", [europe.status, workers.eu.seen.modelLists], [200, 0]);
    // A second service, so this is the first EU answer it gave: the one whose record is read.
    const elsewhereInRecord = await ask(call, token("worldwide", "desktop"), { messages: messagesOf("tokens=5 A question.") });
    same("an answer in the global region has no record read: nothing is required of where it was served", [elsewhereInRecord.status, workers.global.seen.recordsRead.length], [200, 0]);
  } catch (cause) {
    failures += 1;
    console.log("FAIL the sixth run stopped:", cause);
    console.log(service.log().split("\n").slice(-30).join("\n"));
  } finally {
    await service.stop();
    await workers.stop();
  }
}

// ================================================================================================
// Seventh copy: the Saudi model is one the list confirms, and an answer names another model.
// ================================================================================================
{
  const workers = await startWorkerStubs();
  const service = await startLocalService({ seedSql, vars: { ...workers.vars, WORKER_SA_MODEL: WORKER_ANOTHER_MODEL } });
  const call = client(service.base);
  try {
    const confirmed = await ask(call, token("reader", "desktop"), { messages: messagesOf("tokens=5 A question.") });
    const again = await ask(call, token("reader", "desktop"), { messages: messagesOf("tokens=5 Another question.") });
    same("a model the list confirms is served, and the list is read once, not with every request", [confirmed.status, again.status, workers.sa.seen.requests.map((request) => request.body.model), workers.sa.seen.modelLists], [200, 200, [WORKER_ANOTHER_MODEL, WORKER_ANOTHER_MODEL], 1]);
    const redirected = await ask(call, token("reader", "desktop"), { messages: messagesOf("tokens=5 [[other-model]] A question.") });
    const next = await ask(call, token("reader", "desktop"), { messages: messagesOf("tokens=5 The next question.") });
    // The EU upstream's record of this service's first EU answer names another data region.
    const moved = await ask(call, token("european", "desktop"), { messages: messagesOf("tokens=5 [[data-region=us]] A question.") });
    const offRegion = () => service.query("SELECT worker_off_region FROM usage_daily WHERE user_id = ? AND day = ?", european.id, today).map((row) => row.worker_off_region);
    await until(() => offRegion()[0] === 1);
    const within = await ask(call, token("european", "desktop"), { messages: messagesOf("tokens=5 [[data-region=us]] The next question.") });
    same(
      "an EU answer whose record names another data region is passed on and counted as off region, with the region in the log; the next answer within the minute is not looked up",
      [moved.status, moved.headers.get(REGION_HEADER), offRegion(), /worker_off_region eu/.test(service.log()), within.status, workers.eu.seen.recordsRead.length],
      [200, "eu", [1], true, 200, 1],
    );
    same(
      "an answer that names another model than the one asked for is counted as off region, and the list is read again before the next request",
      [redirected.status, next.status, workers.sa.seen.modelLists, service.query("SELECT worker_off_region FROM usage_daily WHERE user_id = ? AND day = ?", reader.id, today).map((row) => row.worker_off_region)],
      [200, 200, 2, [1]],
    );
  } catch (cause) {
    failures += 1;
    console.log("FAIL the seventh run stopped:", cause);
    console.log(service.log().split("\n").slice(-30).join("\n"));
  } finally {
    await service.stop();
    await workers.stop();
  }
}

// ================================================================================================
// Eighth copy: no region has a key. Every account has the worker here, and none can be answered.
// ================================================================================================
{
  const workers = await startWorkerStubs({ without: WORKER_REGIONS });
  const service = await startLocalService({ seedSql, vars: workers.vars });
  const call = client(service.base);
  try {
    const question = { messages: messagesOf(`Document: ${MARKS.sealed}`) };
    const inside = [await ask(call, token("reader", "desktop"), question), await ask(call, token("european", "desktop"), question), await ask(call, token("worldwide", "desktop"), question)];
    const insideMe = await call("GET", "/v1/me", { token: token("reader", "desktop") });
    same(
      "no keys: an account with the worker is told its region has none, in every region, and its own view names no model",
      [inside.map((answer) => [answer.status, answer.json?.error?.code]), insideMe.json?.worker?.entitled, insideMe.json?.worker?.available, insideMe.json?.worker?.model],
      [[[503, "worker_unavailable"], [503, "worker_unavailable"], [503, "worker_unavailable"]], true, false, null],
    );
    same("no keys: nothing was sent anywhere and nothing was counted", [WORKER_REGIONS.map((region) => workers[region].seen.requests.length + workers[region].seen.modelLists), service.query("SELECT COUNT(*) AS n FROM usage_daily WHERE user_id IN (?, ?, ?)", reader.id, european.id, worldwide.id)[0].n], [[0, 0, 0], 0]);
    same("no keys: detection answers as usual", (await call("POST", "/v1/detect", { body: { texts: ["Jane Doe"] }, token: token("reader", "desktop") })).status, 200);
  } catch (cause) {
    failures += 1;
    console.log("FAIL the eighth run stopped:", cause);
    console.log(service.log().split("\n").slice(-30).join("\n"));
  } finally {
    await service.stop();
    await workers.stop();
  }
}

// ================================================================================================
// Ninth copy: WORKER_OPEN is not set. This is how the service runs by itself where the worker is
// offered under an agreement: no account has it, and the service keeps no list of who does.
// ================================================================================================
{
  const workers = await startAllWorkerStubs();
  const service = await startLocalService({ seedSql, vars: { ...workers.vars, REQUIRE_ACCEPTANCE: "all" } });
  const call = client(service.base);
  try {
    const asker = token("european", "desktop");
    const refused = [await ask(call, asker, { messages: messagesOf(`tokens=4 Document: ${MARKS.sealed}`) }), await ask(call, asker, { messages: messagesOf("A question."), stream: true })];
    same(
      "not open: an account is told the worker is not included, first, before the Terms are asked of it, whatever its region or its request, with nothing sent and nothing counted",
      [refused.map((answer) => [answer.status, answer.json?.error?.code]), /own server/.test(refused[0].json?.error?.message ?? ""), WORKER_REGIONS.map((region) => workers[region].seen.requests.length), service.query("SELECT COUNT(*) AS n FROM usage_daily WHERE user_id = ?", european.id)[0].n],
      [[[403, "worker_not_included"], [403, "worker_not_included"]], true, [0, 0, 0], 0],
    );
    const me = await call("GET", "/v1/me", { token: asker });
    same("…its own view says the worker is not included, and nothing of the model, the host or the queue", [me.status, me.json?.worker], [200, { region: "eu", entitled: false, available: false }]);
    const noRegion = await call("POST", "/v1/me/region", { body: { region: "sa" }, token: asker });
    same("…and it cannot change a region that governs only the worker: nothing is recorded", [noRegion.status, noRegion.json?.error?.code, service.query("SELECT region FROM users WHERE id = ?", european.id)[0].region, service.query("SELECT COUNT(*) AS n FROM region_changes")[0].n], [403, "worker_not_included", "eu", 0]);
    const start = await call("POST", "/v1/auth/email/start", { body: { email: "someone@nowhere.example", client: "desktop", acceptance: await acceptanceFor(call) }, headers: { "x-test-country": "DE" } });
    const link = new URL(start.json.testLink);
    await fetch(`${service.base}/auth/confirm`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ r: link.searchParams.get("r"), t: link.searchParams.get("t") }) });
    const signedIn = await call("POST", "/v1/auth/email/poll", { body: { requestId: start.json.requestId, pollSecret: start.json.pollSecret } });
    same("…a new account is told so when it signs in, and nothing of the worker", signedIn.json?.worker, { region: "eu", entitled: false, available: false });
  } catch (cause) {
    failures += 1;
    console.log("FAIL the ninth run stopped:", cause);
    console.log(service.log().split("\n").slice(-30).join("\n"));
  } finally {
    await service.stop();
    await workers.stop();
  }
}

/** An acceptance of the Terms in force, in the shape the app sends with a sign-in. */
async function acceptanceFor(call) {
  const legal = (await call("GET", "/v1/legal")).json;
  return { termsVersion: legal.terms.version, privacyVersion: legal.privacy.version, locale: "en", wordingId: "signup-2026-11", method: "checkbox+button", appVersion: "0.2.0" };
}

console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
