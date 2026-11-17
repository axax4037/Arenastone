PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE inventory (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  lot TEXT NOT NULL DEFAULT '',
  expiry TEXT NOT NULL DEFAULT '',
  qty INTEGER NOT NULL DEFAULT 0 CHECK (qty >= 0),
  min_qty INTEGER NOT NULL DEFAULT 0 CHECK (min_qty >= 0),
  price REAL NOT NULL DEFAULT 0 CHECK (price >= 0),
  last_stocktake TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, is_hidden INTEGER NOT NULL DEFAULT 0 CHECK (is_hidden IN (0, 1)),
  UNIQUE(item_id, lot, expiry)
);
CREATE TABLE transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  type TEXT NOT NULL,
  item_id TEXT NOT NULL,
  name TEXT NOT NULL,
  lot TEXT NOT NULL DEFAULT '',
  expiry TEXT NOT NULL DEFAULT '',
  qty INTEGER NOT NULL DEFAULT 0,
  price REAL NOT NULL DEFAULT 0,
  user_name TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT ''
, batch_id INTEGER, balance_before INTEGER, balance_after INTEGER, location_id INTEGER, location_name TEXT NOT NULL DEFAULT '', source_location_id INTEGER, target_location_id INTEGER, user_id INTEGER, reason TEXT NOT NULL DEFAULT '', reference_type TEXT NOT NULL DEFAULT '', reference_id TEXT NOT NULL DEFAULT '', document_no TEXT NOT NULL DEFAULT '');
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, access_role TEXT NOT NULL DEFAULT 'operator'
  CHECK (access_role IN ('viewer','operator','inventory_manager','system_admin')));
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE request_results (
  request_id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '',
  response_json TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  completed_at TEXT NOT NULL DEFAULT ''
);
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE TABLE report_runs (
  period_key TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT ''
);
ANALYZE sqlite_schema;
CREATE TABLE IF NOT EXISTS "d1_migrations"(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE items (
  item_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  min_qty INTEGER NOT NULL DEFAULT 0 CHECK (min_qty >= 0),
  target_qty INTEGER NOT NULL DEFAULT 0 CHECK (target_qty >= 0),
  warning_days INTEGER NOT NULL DEFAULT 30 CHECK (warning_days BETWEEN 0 AND 3650),
  lead_time_days INTEGER NOT NULL DEFAULT 7 CHECK (lead_time_days BETWEEN 0 AND 3650),
  default_price REAL NOT NULL DEFAULT 0 CHECK (default_price >= 0),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE locations (
  location_id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE inventory_batches (
  batch_id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  lot TEXT NOT NULL DEFAULT '',
  expiry TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(item_id, lot, expiry),
  FOREIGN KEY (item_id) REFERENCES items(item_id) ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE TABLE stock_balances (
  batch_id INTEGER NOT NULL,
  location_id INTEGER NOT NULL,
  qty INTEGER NOT NULL DEFAULT 0 CHECK (qty >= 0),
  last_stocktake TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (batch_id, location_id),
  FOREIGN KEY (batch_id) REFERENCES inventory_batches(batch_id) ON DELETE RESTRICT,
  FOREIGN KEY (location_id) REFERENCES locations(location_id) ON DELETE RESTRICT
);
CREATE TABLE stocktake_sessions (
  session_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed','cancelled')),
  blind_mode INTEGER NOT NULL DEFAULT 0 CHECK (blind_mode IN (0,1)),
  location_id INTEGER NOT NULL,
  location_name TEXT NOT NULL DEFAULT '',
  created_by INTEGER,
  created_by_name TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  total_lines INTEGER NOT NULL DEFAULT 0,
  counted_lines INTEGER NOT NULL DEFAULT 0,
  variance_lines INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (location_id) REFERENCES locations(location_id) ON DELETE RESTRICT
);
CREATE TABLE stocktake_lines (
  session_id TEXT NOT NULL,
  batch_id INTEGER NOT NULL,
  location_id INTEGER NOT NULL,
  item_id TEXT NOT NULL,
  lot TEXT NOT NULL DEFAULT '',
  expiry TEXT NOT NULL DEFAULT '',
  system_qty INTEGER NOT NULL DEFAULT 0 CHECK (system_qty >= 0),
  counted_qty INTEGER,
  difference INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','counted')),
  counted_at TEXT NOT NULL DEFAULT '',
  counted_by INTEGER,
  counted_by_name TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (session_id, batch_id, location_id),
  FOREIGN KEY (session_id) REFERENCES stocktake_sessions(session_id) ON DELETE CASCADE,
  FOREIGN KEY (batch_id) REFERENCES inventory_batches(batch_id) ON DELETE RESTRICT,
  FOREIGN KEY (location_id) REFERENCES locations(location_id) ON DELETE RESTRICT,
  FOREIGN KEY (item_id) REFERENCES items(item_id) ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE TABLE stock_adjustments (
  adjustment_id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL DEFAULT '',
  batch_id INTEGER NOT NULL,
  location_id INTEGER NOT NULL,
  item_id TEXT NOT NULL,
  system_qty INTEGER NOT NULL,
  counted_qty INTEGER NOT NULL,
  difference INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  user_id INTEGER,
  user_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  resolved_at TEXT NOT NULL DEFAULT '',
  resolved_by INTEGER,
  resolution_note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE audit_logs (
  audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL DEFAULT '',
  entity_id TEXT NOT NULL DEFAULT '',
  user_id INTEGER,
  user_name TEXT NOT NULL DEFAULT '',
  user_role TEXT NOT NULL DEFAULT '',
  before_json TEXT NOT NULL DEFAULT '',
  after_json TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  request_id TEXT NOT NULL DEFAULT '',
  ip_hint TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT ''
);
CREATE TABLE system_logs (
  log_id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','error','critical')),
  event_type TEXT NOT NULL,
  message TEXT NOT NULL,
  request_id TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT '',
  user_id INTEGER,
  user_name TEXT NOT NULL DEFAULT '',
  context_json TEXT NOT NULL DEFAULT ''
);
CREATE TABLE backup_checkpoints (
  checkpoint_date TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  item_count INTEGER NOT NULL DEFAULT 0,
  batch_count INTEGER NOT NULL DEFAULT 0,
  balance_count INTEGER NOT NULL DEFAULT 0,
  transaction_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ok',
  note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE login_challenges (
  challenge_id TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  challenge TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE auth_rate_limits (
  rate_key TEXT PRIMARY KEY,
  window_start TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
DELETE FROM sqlite_sequence;
CREATE INDEX idx_inventory_item_id ON inventory(item_id);
CREATE INDEX idx_inventory_name ON inventory(name);
CREATE INDEX idx_inventory_expiry ON inventory(expiry);
CREATE INDEX idx_inventory_item_batch ON inventory(item_id, lot, expiry);
CREATE INDEX idx_transactions_created_at ON transactions(created_at);
CREATE INDEX idx_transactions_item_id ON transactions(item_id);
CREATE INDEX idx_transactions_request_id ON transactions(request_id);
CREATE INDEX idx_transactions_type ON transactions(type);
CREATE INDEX idx_users_account ON users(account);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);
CREATE INDEX idx_request_results_created_at ON request_results(created_at);
CREATE INDEX idx_items_name ON items(name COLLATE NOCASE);
CREATE INDEX idx_items_category ON items(category);
CREATE INDEX idx_items_active ON items(is_active);
CREATE INDEX idx_locations_active ON locations(is_active);
CREATE INDEX idx_batches_item_id ON inventory_batches(item_id);
CREATE INDEX idx_batches_expiry ON inventory_batches(expiry);
CREATE INDEX idx_batches_identity ON inventory_batches(item_id, lot, expiry);
CREATE INDEX idx_balances_location ON stock_balances(location_id);
CREATE INDEX idx_balances_qty ON stock_balances(qty);
CREATE INDEX idx_balances_stocktake ON stock_balances(last_stocktake);
CREATE INDEX idx_transactions_location ON transactions(location_id, created_at);
CREATE INDEX idx_transactions_reference ON transactions(reference_type, reference_id);
CREATE INDEX idx_users_access_role ON users(access_role);
CREATE INDEX idx_stocktake_sessions_status ON stocktake_sessions(status);
CREATE INDEX idx_stocktake_sessions_started ON stocktake_sessions(started_at);
CREATE INDEX idx_stocktake_sessions_location ON stocktake_sessions(location_id, status);
CREATE UNIQUE INDEX idx_stocktake_one_open_per_user ON stocktake_sessions(created_by) WHERE status='open' AND created_by IS NOT NULL;
CREATE INDEX idx_stocktake_lines_session_status ON stocktake_lines(session_id, status);
CREATE INDEX idx_stocktake_lines_item ON stocktake_lines(item_id);
CREATE INDEX idx_adjustments_session ON stock_adjustments(session_id);
CREATE INDEX idx_adjustments_item ON stock_adjustments(item_id);
CREATE INDEX idx_adjustments_created ON stock_adjustments(created_at);
CREATE INDEX idx_adjustments_unresolved ON stock_adjustments(resolved_at);
CREATE INDEX idx_audit_logs_created ON audit_logs(created_at);
CREATE INDEX idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX idx_audit_logs_user ON audit_logs(user_id, created_at);
CREATE INDEX idx_system_logs_created ON system_logs(created_at);
CREATE INDEX idx_system_logs_severity ON system_logs(severity, created_at);
CREATE INDEX idx_system_logs_event ON system_logs(event_type, created_at);
CREATE INDEX idx_login_challenges_expires
  ON login_challenges(expires_at);
CREATE INDEX idx_auth_rate_limits_updated ON auth_rate_limits(updated_at);

INSERT INTO settings(key,value,updated_at) VALUES('schema_version','4.0.0',datetime('now'))
ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;
