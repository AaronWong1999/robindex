-- Hidden invite-based, resumable self-serve KOL onboarding.

CREATE TABLE IF NOT EXISTS kol_onboarding_requests (
  id TEXT PRIMARY KEY,
  session_hash TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  source_input TEXT NOT NULL,
  handle TEXT NOT NULL,
  kol_id TEXT,
  state TEXT NOT NULL DEFAULT 'queued',
  last_error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT,
  FOREIGN KEY (kol_id) REFERENCES kols(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_onboarding_request_session_handle
ON kol_onboarding_requests(session_hash, handle);
CREATE INDEX IF NOT EXISTS idx_onboarding_request_session
ON kol_onboarding_requests(session_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_onboarding_request_ip
ON kol_onboarding_requests(ip_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_onboarding_request_state
ON kol_onboarding_requests(state, updated_at);

ALTER TABLE kols ADD COLUMN x_created_at TEXT;

ALTER TABLE kol_onboarding_jobs ADD COLUMN lease_owner TEXT;
ALTER TABLE kol_onboarding_jobs ADD COLUMN lease_until INTEGER;
ALTER TABLE kol_onboarding_jobs ADD COLUMN next_retry_at TEXT;
ALTER TABLE kol_onboarding_jobs ADD COLUMN phase_retries INTEGER NOT NULL DEFAULT 0;
ALTER TABLE kol_onboarding_jobs ADD COLUMN no_progress_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE kol_onboarding_jobs ADD COLUMN r2_batches INTEGER NOT NULL DEFAULT 0;
ALTER TABLE kol_onboarding_jobs ADD COLUMN r2_rows INTEGER NOT NULL DEFAULT 0;
ALTER TABLE kol_onboarding_jobs ADD COLUMN originals_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE kol_onboarding_jobs ADD COLUMN indexed_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE kol_onboarding_jobs ADD COLUMN reduce_level INTEGER NOT NULL DEFAULT 0;
ALTER TABLE kol_onboarding_jobs ADD COLUMN candidate_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE kol_onboarding_jobs ADD COLUMN coverage_attempts INTEGER NOT NULL DEFAULT 0;

ALTER TABLE persona_update_jobs ADD COLUMN reduce_level INTEGER NOT NULL DEFAULT 0;
ALTER TABLE persona_update_jobs ADD COLUMN candidate_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE persona_update_jobs ADD COLUMN coverage_attempts INTEGER NOT NULL DEFAULT 0;

ALTER TABLE persona_candidates ADD COLUMN profile_json TEXT;
