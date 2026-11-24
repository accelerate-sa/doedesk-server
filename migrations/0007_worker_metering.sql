-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 Accelerate Technology Establishment
-- Metering for the worker: the small model that reads sealed documents for the app
-- (POST /v1/worker/chat/completions, src/worker-chat.ts).
-- Counts only, like detection and reading: nothing sent to the worker and nothing it answers is
-- stored, here or anywhere.
--
-- The same seven counters go on both usage tables, after the ones migration 0004 made, so rolling a
-- day up into its month loses only the day and the client (see 0004 for how the two tables fit
-- together).
--
-- Safe to apply before the new code is deployed: every change adds a column with a default, and the
-- code from before this migration names the columns it writes.

-- Requests that were answered.
ALTER TABLE usage_daily ADD COLUMN worker_requests INTEGER NOT NULL DEFAULT 0;
-- Tokens, as the worker's own answer reports them (`usage.prompt_tokens`, `usage.completion_tokens`).
-- Input tokens are the measure the monthly allowance is set in.
ALTER TABLE usage_daily ADD COLUMN worker_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_daily ADD COLUMN worker_output_tokens INTEGER NOT NULL DEFAULT 0;
-- Requests turned away: allowance used up, over the size limit, the worker failed or was busy.
ALTER TABLE usage_daily ADD COLUMN worker_refused INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_daily ADD COLUMN worker_too_large INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_daily ADD COLUMN worker_failed INTEGER NOT NULL DEFAULT 0;
-- Answers that said they came from a region other than the expected one. A count; not which.
ALTER TABLE usage_daily ADD COLUMN worker_off_region INTEGER NOT NULL DEFAULT 0;

ALTER TABLE usage ADD COLUMN worker_requests INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage ADD COLUMN worker_input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage ADD COLUMN worker_output_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage ADD COLUMN worker_refused INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage ADD COLUMN worker_too_large INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage ADD COLUMN worker_failed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage ADD COLUMN worker_off_region INTEGER NOT NULL DEFAULT 0;
