-- 2026-09-28 production hardening. Safe to re-run.
CREATE UNIQUE INDEX IF NOT EXISTS idx_stocktake_one_open_per_user
ON stocktake_sessions(created_by)
WHERE status='open' AND created_by IS NOT NULL;

CREATE TABLE IF NOT EXISTS auth_rate_limits (
  rate_key TEXT PRIMARY KEY,
  window_start TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_rate_limits_updated ON auth_rate_limits(updated_at);
