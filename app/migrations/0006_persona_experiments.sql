-- 0006: Persona generation experiments + eval harness tables.
-- Supports Phase 1 (persona stability diagnosis + lifecycle observability) and
-- Phase 2 (automated eval / regression / auto-rollback).

-- One row per diagnostic / production persona-gen LLM call. Lets us see WHY a
-- generation failed (finish_reason=length? body-read timeout? JSON parse?) instead
-- of guessing. Replaces reliance on 1-hour-TTL KV persona_debug:* keys.
CREATE TABLE IF NOT EXISTS persona_experiments (
  id            TEXT PRIMARY KEY,          -- '<kol>:<ts>:<rand>'
  kol_id        TEXT NOT NULL,
  started_at    TEXT DEFAULT (datetime('now')),
  max_tokens    INTEGER,                   -- the max_tokens sent in the request
  finish_reason TEXT,                      -- 'stop' | 'length' | 'content_filter' | 'body_read_timeout' | 'error'
  content_len   INTEGER,                   -- chars of returned content (0 if empty)
  duration_ms   INTEGER,                   -- wall-clock for the whole call
  parse_ok      INTEGER DEFAULT 0,         -- 1 if downstream JSON.parse succeeded
  error_type    TEXT,                      -- 'truncation' | 'timeout' | 'http_error' | 'parse_error' | NULL
  note          TEXT,                      -- human-readable detail (HTTP body, error msg, etc.)
  trigger       TEXT                       -- 'diagnose' | 'generate' | 'evolve' | 'onboard'
);
CREATE INDEX IF NOT EXISTS idx_persona_exp_kol ON persona_experiments(kol_id, started_at DESC);

-- Golden eval set per KOL. Cases are mined from the KOL's own Q&A tweets plus
-- synthesized follower questions. No manual labeling required.
CREATE TABLE IF NOT EXISTS eval_cases (
  id            TEXT PRIMARY KEY,          -- '<kol>:<n>'
  kol_id        TEXT NOT NULL,
  question      TEXT NOT NULL,             -- the prompt shown to the persona
  ground_truth_type TEXT,                  -- 'real_qa' | 'synth_follower'
  expected_stance   TEXT,                  -- free-text stance direction (for stance-consistency metric)
  expected_citation_tweet_ids TEXT,        -- JSON array of tweet ids that SHOULD be cited, if known
  source_tweet_id   TEXT,                  -- the KOL's own tweet the case was derived from, if 'real_qa'
  created_at    TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_eval_cases_kol ON eval_cases(kol_id);

-- One row per (case x persona_version x model_version) eval run. Drives regression
-- detection and auto-rollback decisions.
CREATE TABLE IF NOT EXISTS eval_results (
  id            TEXT PRIMARY KEY,
  kol_id        TEXT NOT NULL,
  case_id       TEXT NOT NULL,
  persona_version TEXT,                    -- persona pack version under test
  model_version    TEXT,                   -- MODEL_PRO value at test time (regression across model upgrades)
  score_citation  REAL,                    -- 0-1: do generated [T#] resolve to real, relevant tweets?
  score_voice     REAL,                    -- 0-1: LLM-judge agreement with Expression DNA (relative only)
  score_stance    REAL,                    -- 0-1: alignment with expected_stance / track_record direction
  passed          INTEGER DEFAULT 0,       -- 1 if overall above threshold
  regressed       INTEGER DEFAULT 0,       -- 1 if this run regressed vs baseline (drives auto-rollback)
  created_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_eval_results_kol ON eval_results(kol_id, created_at DESC);
