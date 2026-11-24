-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 Accelerate Technology Establishment
-- Accounts move from email + password to phone codes and email links. Nothing but a test
-- account existed before this, so the tables are rebuilt rather than migrated.
DROP TABLE IF EXISTS signup_attempts;
DROP TABLE IF EXISTS usage;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS users;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE,
  phone TEXT UNIQUE,
  created_at TEXT NOT NULL,
  -- Where and how the account was created.
  country TEXT,
  signup_method TEXT NOT NULL,
  -- Answers to the two onboarding questions. Null until answered or skipped.
  field TEXT,
  field_other TEXT,
  workplace TEXT,
  profile_at TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  -- desktop, web, mobile, server, site
  client TEXT NOT NULL,
  device TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

-- One attempt to sign in: a code sent by SMS, or a link sent by email.
CREATE TABLE login_requests (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  identifier TEXT NOT NULL,
  -- sha256 of the SMS code or of the token in the emailed link.
  secret_hash TEXT NOT NULL,
  -- sha256 of the secret the waiting app polls with (email only).
  poll_hash TEXT,
  client TEXT NOT NULL,
  device TEXT,
  country TEXT,
  city TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  -- pending, approved, used
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX login_requests_identifier ON login_requests(identifier, created_at);

CREATE TABLE rate_limits (
  key TEXT NOT NULL,
  bucket TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, bucket)
);

-- Characters checked and pages read per account per month. No content is stored.
CREATE TABLE usage (
  user_id TEXT NOT NULL REFERENCES users(id),
  month TEXT NOT NULL,
  detect_characters INTEGER NOT NULL DEFAULT 0,
  ocr_pages INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, month)
);

-- Product usage events from the app, in the shape the app already sends (PostHog batches).
CREATE TABLE events (
  uuid TEXT PRIMARY KEY,
  event TEXT NOT NULL,
  distinct_id TEXT NOT NULL,
  install_id TEXT,
  at TEXT NOT NULL,
  day TEXT NOT NULL,
  received_at TEXT NOT NULL,
  country TEXT,
  app_version TEXT,
  platform TEXT,
  surface TEXT,
  properties TEXT NOT NULL
);
CREATE INDEX events_day_event ON events(day, event);
CREATE INDEX events_install ON events(install_id, day);

-- Crash and error reports from the apps.
CREATE TABLE crash_reports (
  id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL,
  day TEXT NOT NULL,
  source TEXT NOT NULL,
  app_version TEXT,
  platform TEXT,
  install_id TEXT,
  message TEXT NOT NULL,
  detail TEXT NOT NULL
);
CREATE INDEX crash_reports_day ON crash_reports(day);
