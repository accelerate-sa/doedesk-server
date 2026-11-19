import type { OpenOptions, SqliteDriver } from "../d1.ts";

export interface ServeOptions {
  readonly hostname: string;
  readonly port: number;
  /** Largest request body taken, in bytes. A larger one is refused before it is read whole. */
  readonly maxBodyBytes: number;
  /** `peer` is the address of the machine on the other end of the connection. */
  readonly fetch: (request: Request, peer: string) => Promise<Response>;
}

export interface RunningServer {
  readonly port: number;
  /** Stops taking connections. Resolves once every request already taken has been answered. */
  stop(): Promise<void>;
}

/** What differs between Bun and Node. Everything else in `server/` is the same code on both. */
export interface Runtime {
  readonly name: "bun" | "node";
  readonly version: string;
  openDatabase(path: string, options?: OpenOptions): SqliteDriver;
  serve(options: ServeOptions): Promise<RunningServer>;
}
