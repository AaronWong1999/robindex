-- 0004: per-KOL retrieval mode + shared-corpus pointer.
--
-- Default retrieval is now QUERY-SIDE-ONLY: the planner emits bilingual (CN/EN) keywords and we match
-- them against the ORIGINAL tweet text only (no reliance on per-tweet LLM tags). This is the main,
-- cheap, instant scheme.
--
-- `corpus_id` lets a KOL entry search ANOTHER KOL's corpus (tweets/tweet_search) instead of its own,
-- without duplicating the tweets table (whose PK is the tweet id alone).

ALTER TABLE kols ADD COLUMN retrieval_mode TEXT DEFAULT 'query_side';  -- 'query_side' | 'tagged'
ALTER TABLE kols ADD COLUMN corpus_id TEXT;                            -- NULL = use own id
