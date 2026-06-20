-- 0008: User-scoped chat history for Desk frontend sync.
-- Adds user_id to conversations + a parallel table for full frontend message payloads.

ALTER TABLE conversations ADD COLUMN user_id TEXT;
CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS chat_history (
  id              TEXT PRIMARY KEY,         -- same as conversations.id when linked
  user_id         TEXT NOT NULL,
  kol_id          TEXT NOT NULL,
  title           TEXT,
  messages_json   TEXT NOT NULL DEFAULT '[]', -- full frontend messages array as JSON
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_history_user ON chat_history(user_id, updated_at DESC);
