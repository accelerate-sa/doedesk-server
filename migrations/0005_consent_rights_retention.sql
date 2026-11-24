-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 Accelerate Technology Establishment
-- What the Terms of Use and the Privacy Policy promise and the service did not yet do:
-- a record of who accepted which version, a way to delete and export an account, contact mail
-- that is tracked until it is closed, and what the nightly job needs to enforce the keeping times.
--
-- Safe to apply before the new Worker is deployed: every change adds a table or a nullable column,
-- and the old Worker reads and writes none of them. The one statement that moves rows (contact mail,
-- at the end) is safe to run again; see the note there.
--
-- Written to carry over to Postgres: text timestamps in ISO 8601 (UTC), no SQLite-only table
-- options, no JSON functions. The one SQLite-only expression is marked.

-- ---------------------------------------------------------------------------------------------
-- Acceptance of the Terms, and optional consents

-- The acceptance sent with a sign-in attempt, as JSON, held until the code or link is verified.
-- It goes when the attempt goes (one day after it expires): no account, no record.
ALTER TABLE login_requests ADD COLUMN acceptance TEXT;

-- Set when the attempt came from a place where no new account may be created (see src/regions.ts):
-- 'country' or 'representative'. Decided when the attempt starts, where the request's country and
-- region are known, and read when it is verified: an existing account signs in, a new one is refused.
ALTER TABLE login_requests ADD COLUMN signup_block TEXT;

-- One row per acceptance of the Terms, and per choice about an optional purpose. Append-only: a
-- later choice is a new row, and nothing here is updated except the stamp written when the account
-- is closed (below). Read the newest row per account and document for the current state.
CREATE TABLE acceptances (
  id TEXT PRIMARY KEY,
  -- The account. Not a foreign key: these rows outlive the account by design (see account_closed_at).
  user_id TEXT NOT NULL,
  -- terms: agreement to the Terms of Use, having read the Privacy Policy.
  -- usage_data: the optional choice about product analytics.
  document TEXT NOT NULL,
  -- accepted (terms); agreed or declined (optional purposes). A withdrawal is a new 'declined' row.
  decision TEXT NOT NULL,
  -- Which texts. Null on rows for optional purposes, which have only a wording.
  terms_version TEXT,
  privacy_version TEXT,
  -- sha256 of the published text in the language shown, when the service knows it.
  terms_sha256 TEXT,
  privacy_sha256 TEXT,
  -- Which wording of the checkbox, notice or choice the app showed.
  wording_id TEXT,
  -- ar or en: the language the person saw.
  locale TEXT,
  -- The act: checkbox+button at sign-up, and so on.
  method TEXT NOT NULL,
  -- How the person was verified when they agreed: phone, email, or session (already signed in).
  identifier_kind TEXT,
  -- desktop, web, mobile ... and the app's version, which together name the screen design.
  client TEXT,
  app_version TEXT,
  -- Server time, UTC.
  accepted_at TEXT NOT NULL,
  -- The verified sign-in attempt the acceptance came with, when it came with one.
  login_request_id TEXT,
  -- Two letters, from the network provider. Never the IP address.
  country TEXT,
  -- Set when the account is deleted. From then the row is kept as proof for a fixed time and
  -- then deleted by the nightly job; login_request_id and country are cleared at the same moment.
  account_closed_at TEXT
);
CREATE INDEX acceptances_user ON acceptances(user_id, document, accepted_at);
CREATE INDEX acceptances_closed ON acceptances(account_closed_at);

-- ---------------------------------------------------------------------------------------------
-- Deleting an account safely, and deleting unused ones

-- When a session came from a verified code or link, the time of that verification. Null for a
-- session made from another session (POST /v1/auth/sessions) and for sessions older than this
-- migration. Deleting an account needs a session that was verified minutes ago.
ALTER TABLE sessions ADD COLUMN signed_in_at TEXT;

-- The last use of the account that its sessions no longer show: set when a session is ended or
-- expires. An account is unused when this, its creation, its sessions and its usage are all old.
ALTER TABLE users ADD COLUMN last_active_at TEXT;

-- Lets a repeated DELETE /v1/me, sent with the session that already deleted the account, get the
-- same confirmation instead of "not signed in". Holds no account data; rows go after a day.
CREATE TABLE deletion_receipts (
  -- sha256 of the session token that asked for the deletion.
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  -- Until when the acceptance record is kept, as told to the person.
  kept_until TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Rights requests that were handled: date, kind, how it arrived, outcome. No content of the request.
CREATE TABLE rights_requests (
  id TEXT PRIMARY KEY,
  handled_at TEXT NOT NULL,
  -- access, deletion, correction, withdrawal, objection, restriction, other
  type TEXT NOT NULL,
  -- app (the person, signed in), email (the owner, for a request that came by mail)
  channel TEXT NOT NULL,
  -- done, refused, not_found
  outcome TEXT NOT NULL,
  -- The account's internal identifier. After a deletion it names nothing but this row and the
  -- acceptance record kept as proof.
  account_id TEXT
);
CREATE INDEX rights_requests_handled ON rights_requests(handled_at);

-- ---------------------------------------------------------------------------------------------
-- Contact mail

-- Mail to hello@, privacy@, security@ and legal@doedesk.com. Each message is forwarded to the
-- owner's mailbox; this copy is what the dashboard tracks until the matter is closed.
CREATE TABLE contact_mail (
  id TEXT PRIMARY KEY,
  -- The address it was sent to.
  address TEXT NOT NULL,
  -- The envelope sender and the subject line, for the dashboard's list.
  sender TEXT,
  subject TEXT,
  received_at TEXT NOT NULL,
  -- The message as received, cut at 200,000 characters.
  raw TEXT NOT NULL,
  -- When it was handed to the owner's mailbox, or why it could not be.
  forwarded_at TEXT,
  forward_error TEXT,
  -- When the owner opened it on the dashboard, and when the matter was closed.
  read_at TEXT,
  closed_at TEXT
);
CREATE INDEX contact_mail_received ON contact_mail(received_at);
CREATE INDEX contact_mail_closed ON contact_mail(closed_at);

-- Contact mail received so far sits in test_inbox, next to the test mailboxes. Move it.
-- randomblob() is SQLite-only; it is used here once, to give the moved rows an identifier.
-- If the old Worker receives mail between this migration and the deploy, run these two statements
-- again afterwards: they move whatever is there and leave the test mailboxes alone.
INSERT INTO contact_mail (id, address, received_at, raw)
  SELECT lower(hex(randomblob(16))), address, received_at, raw FROM test_inbox WHERE address NOT LIKE 'e2e-%';
DELETE FROM test_inbox WHERE address NOT LIKE 'e2e-%';

-- ---------------------------------------------------------------------------------------------
-- Usage data: the choice an installation made

-- Usage data from the app is never tied to an account, so the proof of the choice is kept the same
-- way the data is: by installation identifier. One row per change of state. Kept as long as usage
-- events are (400 days); each event from a consent region also carries its own consent stamp.
CREATE TABLE usage_data_choices (
  -- The random identifier the app made for this installation. Not derived from anything.
  install_id TEXT NOT NULL,
  -- on_consented (the person agreed), on_by_default_notice_shown (on by default, the notice was
  -- shown), off (switched off; the app then discards the identifier).
  state TEXT NOT NULL,
  -- When the person chose, by the device's clock, as the app sent it.
  chosen_at TEXT NOT NULL,
  -- ask or notice: which rule the app applied. And the signal that decided it: network, locale, timezone.
  basis TEXT,
  signal TEXT,
  -- Which wording of the choice or notice was on the screen.
  wording_id TEXT,
  locale TEXT,
  received_at TEXT NOT NULL,
  -- Two letters, from the network provider. Never the IP address.
  country TEXT,
  app_version TEXT,
  PRIMARY KEY (install_id, chosen_at, state)
);
CREATE INDEX usage_data_choices_received ON usage_data_choices(received_at);
