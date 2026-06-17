-- 0007: Durable persona fact store for full-corpus map-reduce distillation.
--
-- The old single-call distillation could only see ~3.8% of a prolific KOL's tweets (an 80K-char
-- recency-truncated window). Map-reduce distillation reads 100% of the corpus by chunking it, mapping
-- each chunk to a partial persona (flash), then hierarchically reducing the partials (pro).
--
-- This table persists both the per-chunk partials (so a backfill is resumable / auditable) and the
-- final merged facts (so the WEEKLY refresh is incremental: map only the new tweets and reduce them
-- into the stored merged facts, instead of re-reading the whole history or doing a fragile text append).
CREATE TABLE IF NOT EXISTS persona_facts (
  id             TEXT PRIMARY KEY,         -- '<kol>:merged' | '<kol>:chunk:<idx>:<corpusHash>'
  kol_id         TEXT NOT NULL,
  kind           TEXT NOT NULL,            -- 'chunk' | 'merged'
  chunk_idx      INTEGER,                  -- map-stage chunk index (NULL for merged)
  corpus_hash    TEXT,                     -- identifies the corpus slice a chunk came from (resume/invalidate)
  json           TEXT NOT NULL,            -- the (partial or merged) persona JSON
  tweets_covered INTEGER,                  -- how many tweets this row was distilled from
  date_min       TEXT,                     -- earliest tweet date covered
  date_max       TEXT,                     -- latest tweet date covered
  updated_at     TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_persona_facts_kol ON persona_facts(kol_id, kind);
