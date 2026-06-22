-- 0009: Server-authoritative billing.
-- Until now billing lived entirely in the browser (localStorage, see public/app/billing.js).
-- Money cannot be trusted to the client, so these tables become the source of truth:
--   * credit grants happen ONLY from verified payment webhooks (never from the client),
--   * the balance/subscription state is read back from here,
--   * provider-agnostic columns (stripe | airwallex) so a second PSP can be added later.
-- user_id is the Privy DID (did:privy:...), verified server-side from the access token.

CREATE TABLE IF NOT EXISTS billing_accounts (
  user_id        TEXT PRIMARY KEY,            -- Privy DID
  email          TEXT,
  credits        REAL NOT NULL DEFAULT 0,     -- points balance, same unit as client RXB
  free_used      INTEGER NOT NULL DEFAULT 0,
  free_reset_at  INTEGER NOT NULL DEFAULT 0,  -- epoch ms
  stripe_customer_id    TEXT,
  airwallex_customer_id TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS billing_subscriptions (
  id              TEXT PRIMARY KEY,           -- internal uuid
  user_id         TEXT NOT NULL,
  kol_id          TEXT NOT NULL,
  status          TEXT NOT NULL,              -- active | canceled | past_due | incomplete
  plan            TEXT NOT NULL,              -- promo | default
  price_cents     INTEGER NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'usd',
  auto_renew      INTEGER NOT NULL DEFAULT 1,
  current_period_end INTEGER,                 -- epoch ms
  provider        TEXT NOT NULL,              -- stripe | airwallex
  provider_sub_id TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE(user_id, kol_id)
);
CREATE INDEX IF NOT EXISTS idx_bsub_user ON billing_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_bsub_provider ON billing_subscriptions(provider_sub_id);

-- Credit grants (signup gift, top-up packs, subscription gifts). Spend lives in billing_consumption.
CREATE TABLE IF NOT EXISTS billing_ledger (
  id        TEXT PRIMARY KEY,
  user_id   TEXT NOT NULL,
  type      TEXT NOT NULL,                    -- signup | topup | subscription
  credits   REAL NOT NULL,
  usd_cents INTEGER,
  kol_id    TEXT,
  ref       TEXT,                             -- pack id / provider session id
  ts        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bledger_user ON billing_ledger(user_id, ts DESC);

CREATE TABLE IF NOT EXISTS billing_consumption (
  id      TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kol_id  TEXT,
  model   TEXT,
  tok_in  INTEGER,
  tok_out INTEGER,
  points  REAL NOT NULL DEFAULT 0,
  free    INTEGER NOT NULL DEFAULT 0,
  byok    INTEGER NOT NULL DEFAULT 0,
  q       TEXT,
  ts      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bcons_user ON billing_consumption(user_id, ts DESC);

-- One row per checkout we created; webhook flips status and is idempotent on the PK.
CREATE TABLE IF NOT EXISTS billing_payments (
  id           TEXT PRIMARY KEY,             -- provider session/intent id
  user_id      TEXT,
  provider     TEXT NOT NULL,
  kind         TEXT NOT NULL,                -- pack | sub
  ref          TEXT,                         -- pack id / kol id
  amount_cents INTEGER,
  currency     TEXT,
  status       TEXT NOT NULL,               -- created | paid | failed
  created_at   INTEGER NOT NULL
);

-- Webhook idempotency: every provider event id is recorded once before we act on it.
CREATE TABLE IF NOT EXISTS billing_events (
  event_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  ts       INTEGER NOT NULL
);
