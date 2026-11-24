// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Accelerate Technology Establishment
import { chmodSync } from "node:fs";

/**
 * A database file is readable and writable by its owner alone, whatever the process's umask was
 * when the file was made. SQLite gives the write-ahead log and its index the same mode as the file.
 * A file owned by someone else (a copy being inspected) is left as it is.
 */
export const ownerOnly = (path: string): void => {
  if (path === ":memory:" || path === "") return;
  try {
    chmodSync(path, 0o600);
  } catch {
    // Not ours to change.
  }
};
