CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

-- Characters checked and pages read per account per month. No content is stored.
CREATE TABLE usage (
  user_id TEXT NOT NULL REFERENCES users(id),
  month TEXT NOT NULL,
  detect_characters INTEGER NOT NULL DEFAULT 0,
  ocr_pages INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, month)
);

CREATE TABLE signup_attempts (
  ip TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip, day)
);
