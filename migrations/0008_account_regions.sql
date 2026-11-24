-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Copyright (C) 2026 Accelerate Technology Establishment
-- The region of an account: where the worker that reads its sealed documents runs.
--   sa       deep.sa, in Saudi Arabia according to deep.sa
--   eu       OpenRouter's EU endpoint
--   global   OpenRouter's global endpoint, with no region restriction
-- The region decides only the worker's upstream (src/worker-regions.ts). Accounts, detection and
-- reading are on the one DoeDesk Cloud server whichever it is.
--
-- Safe to apply before the new code is deployed: the column has a default, and the code from
-- before this migration names the columns it writes.

ALTER TABLE users ADD COLUMN region TEXT NOT NULL DEFAULT 'global';
-- When the person last changed it. NULL: it is still what the account started with.
ALTER TABLE users ADD COLUMN region_updated_at TEXT;

-- Accounts from before regions get the region a new account would get from the same two facts
-- (`defaultAccountRegion` in src/regions.ts; server/test/unit.ts holds this list to that one):
-- a Saudi mobile number or a sign-up from Saudi Arabia is "sa"; the EU, the EEA, the United
-- Kingdom and Switzerland are "eu"; anywhere else, and a country that was not known, is "global".
UPDATE users SET region = CASE
  WHEN signup_method = 'phone' OR country = 'SA' THEN 'sa'
  WHEN country IN (
    'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU',
    'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
    'IS', 'LI', 'NO',
    'AX', 'GF', 'GP', 'MQ', 'YT', 'RE', 'MF',
    'GB', 'GI', 'JE', 'GG', 'IM',
    'CH'
  ) THEN 'eu'
  ELSE 'global'
END;

-- Every change of region the person made, oldest first. Rows are added and never changed; they
-- are in the account's copy of its data (GET /v1/me/export) and are deleted with the account.
CREATE TABLE region_changes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  from_region TEXT NOT NULL,
  to_region TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  -- The kind of app the change was made from: desktop, web, mobile, server, site.
  client TEXT NOT NULL
);
CREATE INDEX region_changes_user ON region_changes (user_id, changed_at);
