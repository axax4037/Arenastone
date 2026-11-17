CREATE TABLE IF NOT EXISTS request_identities (
  request_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
