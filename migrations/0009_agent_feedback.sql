-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 Accelerate Technology Establishment
-- Anonymous product feedback reports submitted by DoeDesk agents (`agent.feedback`).
-- No installation identifier, account identifier, or IP address is stored.
-- Safe to apply before deploying the new code: additive table only.

CREATE TABLE agent_feedback (
  id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL,
  day TEXT NOT NULL,
  at TEXT NOT NULL,
  country TEXT,
  app_version TEXT,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_requested INTEGER NOT NULL DEFAULT 0,
  source TEXT,
  provider TEXT,
  model TEXT,
  expected TEXT,
  actual TEXT,
  workaround TEXT,
  trace TEXT,
  properties TEXT NOT NULL,
  read_at TEXT,
  closed_at TEXT
);

CREATE INDEX agent_feedback_received ON agent_feedback(received_at DESC);
CREATE INDEX agent_feedback_day ON agent_feedback(day);
CREATE INDEX agent_feedback_state ON agent_feedback(closed_at, read_at);
