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
