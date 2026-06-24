-- 0010: BYOK (Bring Your Own Key) — user-provided LLM API configs.
-- Users can bring their own OpenRouter, DeepSeek, or custom OpenAI-compatible API keys.
-- When a BYOK model is selected, calls bypass the system AI Gateway entirely
-- and go directly to the user's provider. System models are mutually exclusive
-- and require credit/quota checks.

CREATE TABLE IF NOT EXISTS byok_models (
  id           TEXT PRIMARY KEY,              -- e.g. "cm_a1b2c3d4"
  user_id      TEXT NOT NULL,                 -- Privy DID
  provider     TEXT NOT NULL,                 -- 'openrouter' | 'deepseek' | 'custom'
  model_name   TEXT NOT NULL,                 -- e.g. 'openai/gpt-4o' | 'deepseek-chat' | 'Auto'
  display_name TEXT NOT NULL,                 -- user-visible label
  base_url     TEXT NOT NULL,                 -- API endpoint URL (OpenAI-compatible chat completions)
  api_key      TEXT NOT NULL,                 -- user's API key (plaintext; D1 is CF-internal)
  color        TEXT DEFAULT '#6B7280',
  badge        TEXT DEFAULT 'API',
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_byok_user ON byok_models(user_id);
