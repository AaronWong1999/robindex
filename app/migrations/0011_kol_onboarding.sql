-- Durable, publish-gated KOL onboarding and database-driven presentation/billing metadata.

ALTER TABLE kols ADD COLUMN profile_json TEXT;
ALTER TABLE kols ADD COLUMN onboarding_status TEXT NOT NULL DEFAULT 'ready';
ALTER TABLE kols ADD COLUMN is_public INTEGER NOT NULL DEFAULT 1;
ALTER TABLE kols ADD COLUMN followers_count INTEGER DEFAULT 0;
ALTER TABLE kols ADD COLUMN statuses_count INTEGER DEFAULT 0;
ALTER TABLE kols ADD COLUMN subscription_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE kols ADD COLUMN subscription_price_cents INTEGER NOT NULL DEFAULT 3990;
ALTER TABLE kols ADD COLUMN subscription_promo_cents INTEGER NOT NULL DEFAULT 1990;
ALTER TABLE kols ADD COLUMN subscription_gift INTEGER NOT NULL DEFAULT 2000;
ALTER TABLE kols ADD COLUMN airwallex_product_id TEXT;
ALTER TABLE kols ADD COLUMN airwallex_price_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_kols_handle ON kols(handle);
CREATE INDEX IF NOT EXISTS idx_kols_public_status ON kols(is_public, onboarding_status);

UPDATE kols SET airwallex_price_id='pri_sgpdbtvwkhjpzeoldpt' WHERE id='qinbafrank' AND airwallex_price_id IS NULL;
UPDATE kols SET airwallex_price_id='pri_sgpdtsnpnhjpzf4j1gy' WHERE id='aleabitoreddit' AND airwallex_price_id IS NULL;

CREATE TABLE IF NOT EXISTS kol_onboarding_jobs (
  kol_id          TEXT PRIMARY KEY,
  handle          TEXT NOT NULL,
  phase           TEXT NOT NULL DEFAULT 'draft',
  cursor          TEXT,
  has_more        INTEGER NOT NULL DEFAULT 1,
  pages_fetched   INTEGER NOT NULL DEFAULT 0,
  tweets_fetched  INTEGER NOT NULL DEFAULT 0,
  tweets_inserted INTEGER NOT NULL DEFAULT 0,
  retries         INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  started_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now')),
  completed_at    TEXT,
  FOREIGN KEY (kol_id) REFERENCES kols(id)
);

CREATE INDEX IF NOT EXISTS idx_kol_onboarding_phase ON kol_onboarding_jobs(phase, updated_at);
