-- Robindex D1 schema. Idempotent (safe to re-run).

CREATE TABLE IF NOT EXISTS kols (
  id            TEXT PRIMARY KEY,          -- e.g. 'aleabitoreddit'
  display_name  TEXT NOT NULL,
  handle        TEXT NOT NULL,             -- x.com handle, no '@'
  twitter_uid   TEXT,                      -- numeric user id (for incremental sync)
  avatar_url    TEXT,
  tagline       TEXT,
  persona_pack  TEXT,                      -- assembled persona markdown (injected every turn)
  persona_version TEXT,
  retrieval_mode TEXT DEFAULT 'query_side',-- 'query_side' (default) | 'tagged'
  corpus_id     TEXT,                       -- search another KOL's corpus; NULL = own id
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tweets (
  id            TEXT PRIMARY KEY,          -- tweet id (string)
  kol_id        TEXT NOT NULL,
  text          TEXT NOT NULL,
  created_at_iso TEXT,                     -- ISO8601
  created_at_ts INTEGER,                   -- epoch seconds, for sorting/range
  is_retweet    INTEGER DEFAULT 0,
  lang          TEXT,
  likes         INTEGER DEFAULT 0,
  retweets      INTEGER DEFAULT 0,
  replies       INTEGER DEFAULT 0,
  quotes        INTEGER DEFAULT 0,
  views         INTEGER DEFAULT 0,
  urls          TEXT,                      -- JSON array
  media         TEXT,                      -- JSON array
  quoted        TEXT,                      -- JSON {id,text,handle,name,url} of the quoted tweet, if any
  FOREIGN KEY (kol_id) REFERENCES kols(id)
);
CREATE INDEX IF NOT EXISTS idx_tweets_kol ON tweets(kol_id, created_at_ts DESC);

-- Distilled long-form knowledge (methodology / theses / track-record / monthly analysis), chunked.
CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id            TEXT PRIMARY KEY,          -- '<kol>:<source>:<n>'
  kol_id        TEXT NOT NULL,
  source        TEXT NOT NULL,             -- 'methodology' | 'theses' | 'analysis:2026-02' | ...
  title         TEXT,
  text          TEXT NOT NULL,
  FOREIGN KEY (kol_id) REFERENCES kols(id)
);
CREATE INDEX IF NOT EXISTS idx_knowledge_kol ON knowledge_chunks(kol_id);

CREATE TABLE IF NOT EXISTS conversations (
  id            TEXT PRIMARY KEY,
  kol_id        TEXT NOT NULL,             -- a thread is bound to exactly one KOL
  model         TEXT,
  title         TEXT,
  summary       TEXT,                      -- rolling summary for bounded long-term memory
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id            TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role          TEXT NOT NULL,             -- 'user' | 'assistant'
  content       TEXT NOT NULL,
  citations     TEXT,                      -- JSON: [{ref:'T1', tweet_id, url, date, snippet}]
  tool_calls    TEXT,                      -- JSON: [{tool, args, result_summary}]
  created_at    TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS sync_state (
  kol_id        TEXT PRIMARY KEY,
  last_tweet_id TEXT,
  last_run_at   TEXT,
  note          TEXT
);

-- Machine-generated search fields per tweet (LLM query-planning + FTS5 + LLM rerank).
-- Original tweet text stays in `tweets`; these are only for retrieval. See migrations/0003.
CREATE TABLE IF NOT EXISTS tweet_tags (
  tweet_id     TEXT PRIMARY KEY,
  kol_id       TEXT NOT NULL,
  entities     TEXT,
  aliases      TEXT,
  topics       TEXT,
  stances      TEXT,
  style        TEXT,
  generated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (tweet_id) REFERENCES tweets(id)
);
CREATE INDEX IF NOT EXISTS idx_tweet_tags_kol ON tweet_tags(kol_id);

-- FTS5 index over original text + machine columns. Column order is fixed (BM25 weights
-- in rag.ts depend on it). 'trigram' tokenizer = substring match for English AND CJK.
CREATE VIRTUAL TABLE IF NOT EXISTS tweet_search USING fts5(
  text,
  entities,
  aliases,
  topics,
  stances,
  style,
  tweet_id UNINDEXED,
  kol_id UNINDEXED,
  tokenize = 'trigram'
);

-- Persona generation experiments: one row per persona-gen LLM call. Lets us see WHY a
-- generation failed (finish_reason=length? body-read timeout? JSON parse?) instead of
-- guessing, and survives beyond the 1-hour TTL of KV persona_debug:* keys. See migration 0006.
CREATE TABLE IF NOT EXISTS persona_experiments (
  id            TEXT PRIMARY KEY,
  kol_id        TEXT NOT NULL,
  started_at    TEXT DEFAULT (datetime('now')),
  max_tokens    INTEGER,
  finish_reason TEXT,                      -- 'stop'|'length'|'content_filter'|'body_read_timeout'|'error'
  content_len   INTEGER,
  duration_ms   INTEGER,
  parse_ok      INTEGER DEFAULT 0,
  error_type    TEXT,                      -- 'truncation'|'timeout'|'http_error'|'parse_error'|NULL
  note          TEXT,
  trigger       TEXT                       -- 'diagnose'|'generate'|'evolve'|'onboard'
);
CREATE INDEX IF NOT EXISTS idx_persona_exp_kol ON persona_experiments(kol_id, started_at DESC);

-- Golden eval set per KOL (mined from Q&A tweets + synthesized follower questions).
CREATE TABLE IF NOT EXISTS eval_cases (
  id            TEXT PRIMARY KEY,
  kol_id        TEXT NOT NULL,
  question      TEXT NOT NULL,
  ground_truth_type TEXT,                  -- 'real_qa' | 'synth_follower'
  expected_stance   TEXT,
  expected_citation_tweet_ids TEXT,        -- JSON array
  source_tweet_id   TEXT,
  created_at    TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_eval_cases_kol ON eval_cases(kol_id);

-- One row per (case x persona_version x model_version) eval run. Drives regression
-- detection and auto-rollback.
CREATE TABLE IF NOT EXISTS eval_results (
  id            TEXT PRIMARY KEY,
  kol_id        TEXT NOT NULL,
  case_id       TEXT NOT NULL,
  persona_version TEXT,
  model_version    TEXT,
  score_citation  REAL,
  score_voice     REAL,
  score_stance    REAL,
  passed          INTEGER DEFAULT 0,
  regressed       INTEGER DEFAULT 0,
  created_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_eval_results_kol ON eval_results(kol_id, created_at DESC);

-- Durable persona fact store for full-corpus map-reduce distillation (see migration 0007).
-- Persists per-chunk partials (resumable backfill) + the final merged facts (incremental weekly reduce).
CREATE TABLE IF NOT EXISTS persona_facts (
  id             TEXT PRIMARY KEY,         -- '<kol>:merged' | '<kol>:chunk:<idx>:<corpusHash>'
  kol_id         TEXT NOT NULL,
  kind           TEXT NOT NULL,            -- 'chunk' | 'merged'
  chunk_idx      INTEGER,
  corpus_hash    TEXT,
  json           TEXT NOT NULL,
  tweets_covered INTEGER,
  date_min       TEXT,
  date_max       TEXT,
  updated_at     TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_persona_facts_kol ON persona_facts(kol_id, kind);
