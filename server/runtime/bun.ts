// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Accelerate Technology Establishment
// Bun: its built-in SQLite and HTTP server.
import { Database } from "bun:sqlite";

import { applyPragmas, type OpenOptions, type SqliteDriver } from "../d1.ts";
import { ownerOnly } from "./files.ts";
import type { RunningServer, Runtime, ServeOptions } from "./types.ts";

const openDatabase = (path: string, options: OpenOptions = {}): SqliteDriver => {
  const database = options.readOnly === true ? new Database(path, { readonly: true }) : new Database(path, { create: true, readwrite: true });
  if (options.readOnly !== true) ownerOnly(path);
  const driver: SqliteDriver = {
    // `query` keeps each prepared statement, so a statement is compiled once.
    // One difference from D1 that cannot be removed here: Bun hands a whole number to SQLite as an
    // integer, where D1 (and Node) hand every number over as a float. It shows only where SQL looks
    // at a bound number's type: `typeof(?)`, a number joined to text (`'k:' || ?` gives k:60, not
    // k:60.0), or dividing by one. No statement in `src/` does any of those today;
    // server/test/d1-parity.mjs pins the difference to exactly that.
    query: (sql, values) => database.query(sql).all(...values) as Array<Record<string, unknown>>,
    exec: (sql) => {
      database.exec(sql);
    },
    close: () => database.close(),
  };
  applyPragmas(driver, options);
  return driver;
};

const serve = async (options: ServeOptions): Promise<RunningServer> => {
  const server = Bun.serve({
    hostname: options.hostname,
    port: options.port,
    maxRequestBodySize: options.maxBodyBytes,
    // Reading a document can take two minutes with nothing sent meanwhile. 255 is Bun's ceiling.
    idleTimeout: 255,
    fetch: (request, bunServer) => options.fetch(request, bunServer.requestIP(request)?.address ?? ""),
    error: () => new Response(JSON.stringify({ error: { code: "internal", message: "Something went wrong on our side." } }), {
      status: 500,
      headers: { "content-type": "application/json; charset=utf-8" },
    }),
  });
  return {
    port: server.port ?? options.port,
    // Without `true`, Bun lets requests in flight finish and resolves when they have.
    stop: () => server.stop(),
  };
};

export const runtime: Runtime = { name: "bun", version: Bun.version, openDatabase, serve };
