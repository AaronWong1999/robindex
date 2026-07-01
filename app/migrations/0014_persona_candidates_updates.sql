-- Candidate-first persona publication and durable weekly/monthly update jobs.

CREATE TABLE IF NOT EXISTS persona_candidates (
  kol_id          TEXT PRIMARY KEY,
  version         TEXT NOT NULL,
  persona_pack    TEXT NOT NULL,
  persona_json    TEXT,
  coverage_json   TEXT,
  status          TEXT NOT NULL DEFAULT 'staged',
  last_error      TEXT,
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS persona_update_jobs (
  kol_id               TEXT PRIMARY KEY,
  kind                 TEXT NOT NULL,
  phase                TEXT NOT NULL DEFAULT 'distilling',
  distill_phase        TEXT NOT NULL DEFAULT 'map',
  distill_group_index  INTEGER NOT NULL DEFAULT 0,
  distill_steps        INTEGER NOT NULL DEFAULT 0,
  retries              INTEGER NOT NULL DEFAULT 0,
  last_error           TEXT,
  started_at           TEXT DEFAULT (datetime('now')),
  updated_at           TEXT DEFAULT (datetime('now')),
  completed_at         TEXT
);

CREATE INDEX IF NOT EXISTS idx_persona_update_runnable
ON persona_update_jobs(phase, updated_at);

ALTER TABLE eval_results ADD COLUMN score_relevance REAL;
ALTER TABLE eval_results ADD COLUMN score_entailment REAL;
