// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Accelerate Technology Establishment
/**
 * Makes the nightly job run once a night, however often it is started.
 *
 * systemd starts `server/nightly.ts` from a timer. A second start on the same UTC day (a restart
 * of the timer, a person running it by hand, a machine that came back and caught up) finds the
 * day already taken and does nothing. A run that failed may be tried again; a run that died
 * without saying so may be taken over once it is two hours old.
 *
 * The record is a small SQLite file beside the database (`jobs.sqlite`). It holds no account data:
 * a job's name, a day, two times and an outcome.
 */
import { createDatabase, type SqliteDriver } from "./d1.ts";

const TAKE_OVER_AFTER_MS = 2 * 3_600_000;

export interface JobRun {
  readonly job: string;
  readonly day: string;
  readonly started_at: string;
  readonly finished_at: string | null;
  /** running, done, failed */
  readonly outcome: string;
  readonly detail: string | null;
}

export type Claim = { readonly run: true } | { readonly run: false; readonly reason: "done" | "running" };

export const openJobs = (driver: SqliteDriver) => {
  driver.exec(
    "CREATE TABLE IF NOT EXISTS job_runs (job TEXT NOT NULL, day TEXT NOT NULL, started_at TEXT NOT NULL, " +
      "finished_at TEXT, outcome TEXT NOT NULL, detail TEXT, PRIMARY KEY (job, day))",
  );
  const database = createDatabase(driver);

  /** Takes the day for this process, if nobody has it. Exactly one of several callers gets `run: true`. */
  const claim = async (job: string, day: string, now = new Date()): Promise<Claim> => {
    const started = now.toISOString();
    const fresh = await database
      .prepare("INSERT INTO job_runs (job, day, started_at, outcome) VALUES (?, ?, ?, 'running') ON CONFLICT (job, day) DO NOTHING")
      .bind(job, day, started)
      .run();
    if (fresh.meta.changes === 1) return { run: true };
    // A failed run, or one that has said nothing for two hours, may be taken again. The UPDATE
    // names the state it saw, so of two processes trying this only one succeeds.
    const retaken = await database
      .prepare(
        "UPDATE job_runs SET started_at = ?, finished_at = NULL, outcome = 'running', detail = NULL " +
          "WHERE job = ? AND day = ? AND (outcome = 'failed' OR (outcome = 'running' AND started_at < ?))",
      )
      .bind(started, job, day, new Date(now.getTime() - TAKE_OVER_AFTER_MS).toISOString())
      .run();
    if (retaken.meta.changes === 1) return { run: true };
    const row = await database.prepare("SELECT outcome FROM job_runs WHERE job = ? AND day = ?").bind(job, day).first<{ outcome: string }>();
    return { run: false, reason: row?.outcome === "done" ? "done" : "running" };
  };

  const finish = async (job: string, day: string, outcome: "done" | "failed", detail: string | null): Promise<void> => {
    await database
      .prepare("UPDATE job_runs SET finished_at = ?, outcome = ?, detail = ? WHERE job = ? AND day = ?")
      .bind(new Date().toISOString(), outcome, detail === null ? null : detail.slice(0, 1000), job, day)
      .run();
  };

  const last = (job: string): Promise<JobRun | null> =>
    database.prepare("SELECT * FROM job_runs WHERE job = ? ORDER BY day DESC LIMIT 1").bind(job).first<JobRun>();

  const lastDone = (job: string): Promise<JobRun | null> =>
    database.prepare("SELECT * FROM job_runs WHERE job = ? AND outcome = 'done' ORDER BY day DESC LIMIT 1").bind(job).first<JobRun>();

  return { claim, finish, last, lastDone };
};

/**
 * Runs `work` once for `day`. Returns what happened: ran, or skipped and why. A failure is recorded
 * and thrown again, so the process exits with an error and systemd shows the unit as failed.
 */
export const runOnce = async (
  driver: SqliteDriver,
  job: string,
  day: string,
  work: () => Promise<string | void>,
): Promise<"ran" | "skipped:done" | "skipped:running"> => {
  const jobs = openJobs(driver);
  const claim = await jobs.claim(job, day);
  if (!claim.run) return `skipped:${claim.reason}`;
  try {
    const detail = await work();
    await jobs.finish(job, day, "done", typeof detail === "string" ? detail : null);
    return "ran";
  } catch (cause) {
    await jobs.finish(job, day, "failed", cause instanceof Error ? cause.message : String(cause));
    throw cause;
  }
};
