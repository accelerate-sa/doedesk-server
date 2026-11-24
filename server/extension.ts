// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Accelerate Technology Establishment
/**
 * Finds a layer of code beside the service and attaches it (src/extension.ts).
 *
 * A layer is a folder next to `server/` and `src/` that holds an `index.ts` exporting `extension`,
 * and may hold a `migrations/` folder of its own, applied after this service's and recorded in a
 * ledger of its own (`extension_migrations`). With no such folder the service runs as it is.
 *
 *   DOEDESK_EXTENSION_DIR   the folder's name. Unset: `enterprise`.
 *   DOEDESK_EXTENSION=off   leave the layer out even though the folder is there.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { type ServiceExtension, useExtension } from "../src/extension.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** The ledger of a layer's migrations. This service's own is `d1_migrations`. */
export const EXTENSION_LEDGER = "extension_migrations";

type Settings = Readonly<Record<string, string | undefined>>;

/** The layer's folder, or null when there is none or it is switched off. */
export const extensionFolder = (settings: Settings = process.env): string | null => {
  if ((settings.DOEDESK_EXTENSION ?? "").trim() === "off") return null;
  const folder = join(ROOT, (settings.DOEDESK_EXTENSION_DIR ?? "").trim() || "enterprise");
  return existsSync(join(folder, "index.ts")) ? folder : null;
};

/** The layer's own migrations, or null when it has none. */
export const extensionMigrations = (settings: Settings = process.env): string | null => {
  const folder = extensionFolder(settings);
  return folder !== null && existsSync(join(folder, "migrations")) ? join(folder, "migrations") : null;
};

/** Attaches the layer, when there is one. Returns its name, or null. */
export const loadExtension = async (settings: Settings = process.env): Promise<string | null> => {
  const folder = extensionFolder(settings);
  if (folder === null) return null;
  const layer = ((await import(pathToFileURL(join(folder, "index.ts")).href)) as { extension?: ServiceExtension }).extension;
  if (layer === undefined) throw new Error(`${folder}/index.ts does not export \`extension\`.`);
  useExtension(layer);
  return layer.name;
};
