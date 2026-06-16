DROP INDEX IF EXISTS idx_tweets_embed;
DROP INDEX IF EXISTS idx_knowledge_kol;

ALTER TABLE tweets DROP COLUMN embedding;
ALTER TABLE tweets DROP COLUMN embedded;

ALTER TABLE knowledge_chunks DROP COLUMN embedding;
ALTER TABLE knowledge_chunks DROP COLUMN embedded;

CREATE INDEX IF NOT EXISTS idx_knowledge_kol ON knowledge_chunks(kol_id);
