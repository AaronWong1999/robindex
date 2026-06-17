-- 0003: LLM query-planning + SQLite FTS5 + LLM rerank retrieval.
--
-- Architecture: each tweet keeps its ORIGINAL text untouched in `tweets`. Offline,
-- deepseek-flash generates machine search fields (entities / aliases / topics /
-- stances / style). Those fields are stored in `tweet_tags` (for inspection /
-- rebuild) and written into the `tweet_search` FTS5 table on DIFFERENT columns.
-- Retrieval matches against the machine columns + the original text, but the answer
-- model is only ever shown the real original text (read back from `tweets`).
--
-- Tokenizer: 'trigram' is the only D1/SQLite-built tokenizer that does substring
-- matching for BOTH English and CJK (the corpus is bilingual). Trigram only matches
-- terms of >=3 characters, so short terms (e.g. "美债", "AI") fall back to instr() at
-- query time — see app/src/rag.ts.

CREATE TABLE IF NOT EXISTS tweet_tags (
  tweet_id     TEXT PRIMARY KEY,
  kol_id       TEXT NOT NULL,
  entities     TEXT,                      -- proper nouns / tickers / companies (space-separated)
  aliases      TEXT,                      -- alternate names / codenames / abbreviations
  topics       TEXT,                      -- concepts / themes, CN+EN (space-separated)
  stances      TEXT,                      -- the opinion / attitude the tweet expresses
  style        TEXT,                      -- rhetorical / tone markers (voice exemplars)
  generated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (tweet_id) REFERENCES tweets(id)
);
CREATE INDEX IF NOT EXISTS idx_tweet_tags_kol ON tweet_tags(kol_id);

-- Standalone FTS5 index. Column order is fixed: BM25 weights in rag.ts depend on it.
-- (text, entities, aliases, topics, stances, style) are indexed; the last two are not.
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
