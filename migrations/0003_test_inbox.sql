-- Mail sent to e2e-…@doedesk.com, kept for a day so a test can read the message it caused.
CREATE TABLE test_inbox (
  address TEXT NOT NULL,
  received_at TEXT NOT NULL,
  raw TEXT NOT NULL
);
CREATE INDEX test_inbox_address ON test_inbox(address, received_at);
