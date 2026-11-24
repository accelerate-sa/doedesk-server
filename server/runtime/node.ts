// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Accelerate Technology Establishment
// Node: `node:sqlite` and `node:http`. The fallback if Bun proves unsuitable; the tests run on both.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import { applyPragmas, type OpenOptions, type SqliteDriver } from "../d1.ts";
import { ownerOnly } from "./files.ts";
import type { RunningServer, Runtime, ServeOptions } from "./types.ts";

const STATEMENTS_KEPT = 500;

const openDatabase = (path: string, options: OpenOptions = {}): SqliteDriver => {
  const database = new DatabaseSync(path, { readOnly: options.readOnly === true });
  if (options.readOnly !== true) ownerOnly(path);
  const prepared = new Map<string, StatementSync>();
  const statement = (sql: string): StatementSync => {
    let found = prepared.get(sql);
    if (found === undefined) {
      found = database.prepare(sql);
      if (prepared.size >= STATEMENTS_KEPT) prepared.clear();
      prepared.set(sql, found);
    }
    return found;
  };
  const driver: SqliteDriver = {
    // Node hands every JavaScript number to SQLite as a float, whole or not. D1 does the same
    // (server/test/d1-parity.mjs), so nothing is converted here.
    query: (sql, values) => statement(sql).all(...values) as Array<Record<string, unknown>>,
    exec: (sql) => {
      database.exec(sql);
    },
    close: () => {
      prepared.clear();
      database.close();
    },
  };
  applyPragmas(driver, options);
  return driver;
};

class BodyTooLarge extends Error {}

/** Aborts when the connection closes before the answer was written: the caller went away. */
const goneSignal = (outgoing: ServerResponse): AbortSignal => {
  const gone = new AbortController();
  outgoing.once("close", () => {
    if (!outgoing.writableFinished) gone.abort();
  });
  return gone.signal;
};

const toRequest = (incoming: IncomingMessage, maxBodyBytes: number, signal: AbortSignal): Request => {
  const headers = new Headers();
  for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
    headers.append(incoming.rawHeaders[index] ?? "", incoming.rawHeaders[index + 1] ?? "");
  }
  const method = incoming.method ?? "GET";
  const url = `http://${incoming.headers.host ?? "localhost"}${incoming.url ?? "/"}`;
  if (method === "GET" || method === "HEAD") return new Request(url, { method, headers, signal });
  let taken = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      incoming.on("data", (chunk: Buffer) => {
        taken += chunk.length;
        if (taken > maxBodyBytes) {
          controller.error(new BodyTooLarge());
          incoming.destroy();
          return;
        }
        controller.enqueue(new Uint8Array(chunk));
      });
      incoming.on("end", () => controller.close());
      incoming.on("error", (cause) => controller.error(cause));
    },
    cancel() {
      incoming.destroy();
    },
  });
  return new Request(url, { method, headers, body, signal, duplex: "half" } as RequestInit);
};

const send = async (response: Response, outgoing: ServerResponse): Promise<void> => {
  const headers: Record<string, string | Array<string>> = {};
  response.headers.forEach((value, name) => {
    if (name === "set-cookie") return;
    headers[name] = value;
  });
  // The Workers types that `src/` is checked against name this method differently.
  const cookies = (response.headers as unknown as { getSetCookie(): Array<string> }).getSetCookie();
  if (cookies.length > 0) headers["set-cookie"] = cookies;
  outgoing.writeHead(response.status, headers);
  if (response.body !== null) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      outgoing.write(value);
    }
  }
  outgoing.end();
};

const serve = async (options: ServeOptions): Promise<RunningServer> => {
  const server = createServer((incoming, outgoing) => {
    const declared = Number(incoming.headers["content-length"] ?? 0);
    if (declared > options.maxBodyBytes) {
      outgoing.writeHead(413, { "content-type": "application/json; charset=utf-8", connection: "close" });
      outgoing.end(JSON.stringify({ error: { code: "too_large", message: "The request is too large." } }));
      return;
    }
    options
      .fetch(toRequest(incoming, options.maxBodyBytes, goneSignal(outgoing)), incoming.socket.remoteAddress ?? "")
      .then((response) => send(response, outgoing))
      .catch(() => {
        if (!outgoing.headersSent) outgoing.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        outgoing.end(JSON.stringify({ error: { code: "internal", message: "Something went wrong on our side." } }));
      });
  });
  // Reading a document can take two minutes; Node's defaults would cut the request before that.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 60_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.hostname, () => resolve());
  });
  const address = server.address();
  return {
    port: typeof address === "object" && address !== null ? address.port : options.port,
    stop: () =>
      new Promise<void>((resolve) => {
        // `close` stops new connections and resolves when the open ones end; idle ones are ended now.
        server.close(() => resolve());
        server.closeIdleConnections();
      }),
  };
};

export const runtime: Runtime = { name: "node", version: process.version, openDatabase, serve };
