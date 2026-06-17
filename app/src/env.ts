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
}
