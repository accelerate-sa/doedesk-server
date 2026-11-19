import type { Runtime } from "./types.ts";

export type { RunningServer, Runtime, ServeOptions } from "./types.ts";

/** The runtime this process is running on. Each one's module is loaded only there. */
export const loadRuntime = async (): Promise<Runtime> =>
  (await (typeof (globalThis as { Bun?: unknown }).Bun === "undefined" ? import("./node.ts") : import("./bun.ts"))).runtime;
