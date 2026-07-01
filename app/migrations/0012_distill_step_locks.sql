-- Prevent the distill self-chain and minute cron from advancing the same KOL concurrently.

CREATE TABLE IF NOT EXISTS distill_step_locks (
  kol_id       TEXT PRIMARY KEY,
  owner        TEXT NOT NULL,
  lease_until  INTEGER NOT NULL,
  updated_at   TEXT DEFAULT (datetime('now'))
);

