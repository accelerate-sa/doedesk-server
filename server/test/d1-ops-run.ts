// Runs the shared operations against the server's wrapper on whichever runtime started this file,
// and prints the answers as JSON. Used by d1-parity.mjs.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createDatabase } from "../d1.ts";
import { migrate } from "../migrate.ts";
import { loadRuntime } from "../runtime/index.ts";
// @ts-expect-error a plain JavaScript module shared with the Node-side test
import { runOps } from "./d1-ops.mjs";

const folder = mkdtempSync(join(tmpdir(), "doedesk-d1-ops-"));
try {
  const driver = (await loadRuntime()).openDatabase(join(folder, "ops.sqlite"));
  migrate(driver, join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), "migrations"));
  const answers = await runOps(createDatabase(driver));
  driver.close();
  console.log(JSON.stringify(answers));
} finally {
  rmSync(folder, { recursive: true, force: true });
}
