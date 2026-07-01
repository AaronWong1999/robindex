export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  CACHE: KVNamespace;
  AI: Ai;
  RAW?: R2Bucket;              // R2 bucket robindex-raw — durable raw-tweet archive
  GATEWAY_URL: string;
  MODEL_FLASH: string;
  MODEL_PRO: string;
  CFGATEWAYKEY: string;        // Worker secret — AI Gateway auth (cf-aig-authorization)
  OPENROUTER_KEY?: string;     // Worker secret — OpenRouter provider key (Authorization)
  GETXAPI_KEY?: string;        // Worker secret (preferred X/Twitter ingest source)
  APIFY_TOKEN?: string;        // Worker secret (for cron ingest)
  ADMIN_KEY?: string;          // Worker secret (for bulk import)
  KOL_ONBOARD_INVITE_SECRET?: string; // 256-bit bearer secret for the hidden self-serve onboarding page
  PRIVY_APP_ID?: string;       // Worker secret / env variable for Privy
  STRIPE_SECRET_KEY?: string;       // Worker secret — Stripe API key (sk_test_… / sk_live_…)
  STRIPE_WEBHOOK_SECRET?: string;   // Worker secret — Stripe webhook signing secret (whsec_…)
  AIRWALLEX_API_KEY?: string;       // Worker secret — Airwallex scoped API key
  AIRWALLEX_CLIENT_ID?: string;     // Worker secret — Airwallex client id
  AIRWALLEX_WEBHOOK_SECRET?: string;// Worker secret — Airwallex webhook signing secret
  AIRWALLEX_ENV?: string;           // "prod" (default) | "demo"
  SELF?: Fetcher;              // service binding to this same Worker (reliable self-invocation; a Worker
                              // cannot fetch its own custom domain — CF blocks it — so distill-auto chains via this)
}

export interface KolRow {
  id: string;
  display_name: string;
  handle: string;
  twitter_uid: string | null;
  avatar_url: string | null;
  tagline: string | null;
  persona_pack: string | null;
  persona_version: string | null;
  retrieval_mode?: string | null;   // 'query_side' (default) | 'tagged'
  corpus_id?: string | null;        // search another KOL's corpus; null = own id
  profile_json?: string | null;
  onboarding_status?: string | null;
  is_public?: number | null;
  followers_count?: number | null;
  statuses_count?: number | null;
  x_created_at?: string | null;
  subscription_enabled?: number | null;
  subscription_price_cents?: number | null;
  subscription_promo_cents?: number | null;
  subscription_gift?: number | null;
  airwallex_product_id?: string | null;
  airwallex_price_id?: string | null;
}
