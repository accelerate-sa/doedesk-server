-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 Accelerate Technology Establishment
-- A sign-in made only to confirm "Delete my account".
--
-- When accepting the Terms is required to sign in, a person who has not accepted must still be
-- able to delete their account. The app marks that sign-in (`purpose: "delete_account"`), and the
-- service lets it through without an acceptance. In exchange the sign-in can do nothing else: it
-- never creates an account, and its session may only read the account, export it and delete it.
--
-- Both columns are NULL for every ordinary sign-in and session, so code from before this
-- migration runs unchanged on the new schema.
ALTER TABLE login_requests ADD COLUMN purpose TEXT;
ALTER TABLE sessions ADD COLUMN purpose TEXT;
