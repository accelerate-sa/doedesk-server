// The parts of Bun this folder uses, declared by hand: Bun's own type package redeclares the
// web platform's globals and cannot be loaded beside the Workers types that `src/` is written to.
declare module "bun:sqlite" {
  export class Database {
    constructor(path: string, options?: { readonly?: boolean; create?: boolean; readwrite?: boolean });
    query(sql: string): { all(...values: ReadonlyArray<unknown>): Array<unknown> };
    exec(sql: string): void;
    close(): void;
  }
}

declare const Bun: {
  readonly version: string;
  serve(options: {
    hostname: string;
    port: number;
    maxRequestBodySize?: number;
    idleTimeout?: number;
    fetch(request: Request, server: { requestIP(request: Request): { address: string } | null }): Response | Promise<Response>;
    error?(error: Error): Response | Promise<Response>;
  }): { readonly port: number | undefined; stop(closeActiveConnections?: boolean): Promise<void> };
};
