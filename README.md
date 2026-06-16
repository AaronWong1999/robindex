# Robindex

Robindex is a Cloudflare-native KOL research assistant. Users ask questions as if they were consulting a specific finance KOL, and the app answers with that KOL's persona, reasoning style, historical source tweets, and live market data.

Production: https://robindex.ai

## Current Architecture

Robindex now uses **D1 original text + sparse retrieval + KOL playbooks**. It does **not** use Vectorize or embedding in the chat path.

| Layer | Current implementation |
| --- | --- |
| Frontend | Cloudflare Workers Static Assets, vanilla HTML/CSS/JS |
| API / SSE chat | Hono Worker in `app/src/index.ts` |
| Store | Cloudflare D1 `robindex-db` |
| Raw archive | R2 `robindex-raw` for paid tweet data |
| Cache | KV `CACHE` for quotes/kline/news-style runtime data |
| LLM | Cloudflare AI Gateway → `deepseek/deepseek-v4-flash` / `deepseek/deepseek-v4-pro` |
| Retrieval | D1 sparse retrieval in `app/src/rag.ts`: terms, tickers, priority topics, recency, engagement, local rerank |
| KOL memory | `persona_pack`, `knowledge_chunks`, weekly stance refresh, bounded conversation summaries |
| Scheduled jobs | Daily tweet ingest and weekly persona refresh via Cloudflare Cron |

Explicitly removed:
- No Vectorize binding in `app/wrangler.jsonc`.
- No `embedding` / `embedded` columns in D1.
- No `bge-m3`, `embedBatch`, `embedPending`, or vector backfill scripts.
- Migration: `app/migrations/0002_remove_embeddings.sql`.

## KOLs

| id | Display | Handle | Current corpus |
| --- | --- | --- | --- |
| `qinbafrank` | Qinbafrank | `@qinbafrank` | 13,756 original tweets in D1, 2021-10-03 to 2026-06-16 |
| `aleabitoreddit` | Serenity | `@aleabitoreddit` | 5,935 original tweets in D1, 2025-07-02 to 2026-06-16; 201 distilled knowledge chunks |

Each conversation is bound to one `kol_id`. All tweet, knowledge, message, and sync rows carry a KOL boundary, so personas do not contaminate each other.

## Chat Flow

1. The user sends `{ kol_id, model, conversation_id, message }` to `/api/chat`.
2. The Worker loads the KOL row and stable `persona_pack`.
3. It detects tickers/entities and fetches live market data/tools where relevant.
4. It expands search terms with a small LLM call.
5. `retrieve()` searches D1 original tweets and knowledge chunks using sparse retrieval only.
6. The prompt is assembled as stable persona/methodology first, then source tweets, live data, news/tools, bounded history, and user question.
7. The model streams the final answer via SSE, with citations normalized to `[T#]`.
8. The frontend renders the answer, chart metadata, and right-side source tweet panel.

## Data Ingest

Tweet data is paid, so the ingest path is conservative:

- Daily cron uses GetXAPI by `twitter_uid` and `sync_state.last_tweet_id`.
- It strictly validates the returned author before inserting.
- New tweets are inserted into D1 and archived to R2.
- No embedding job is triggered; new tweets are searchable immediately through D1 sparse retrieval.
- Weekly cron distills recent posts into dated stance knowledge and optionally evolves persona packs.

## Important Files

- `app/src/index.ts` — Worker routes, chat SSE, admin APIs, deploy entrypoint
- `app/src/rag.ts` — D1 sparse retrieval and citation construction
- `app/src/chat.ts` — prompt assembly, market data gathering, tool phase
- `app/src/ingest.ts` — daily tweet ingest and weekly persona refresh
- `app/src/persona-gen.ts` — persona generation/evolution helpers
- `app/schema.sql` — current no-embedding D1 schema
- `app/migrations/0002_remove_embeddings.sql` — production migration that removed embedding fields
- `app/wrangler.jsonc` — Cloudflare Worker config; no Vectorize binding

## Local Checks

```bash
cd app
npx tsc --noEmit
npm run test:dsl
rg -n "embedding|embedded|VECTORIZE|vectorize|embedBatch|embedPending|indexVectors|bge-m3" src scripts schema.sql wrangler.jsonc package.json public
```

The final `rg` command should return no runtime-code matches.

## Deploy

Cloudflare auth in this workspace uses the Global API Key from `account.guard.json`, not a bearer API token.

```bash
cd app
CLOUDFLARE_API_KEY=$(node -p "require('../account.guard.json').CLOUDFLARE_API_KEY") \
CLOUDFLARE_EMAIL=$(node -p "require('../account.guard.json').expectedEmail") \
NODE_OPTIONS='--require ./scripts/cloudflare-dns-patch.cjs' \
npx wrangler deploy
```

Latest known deployed Worker version after the no-vector migration:

```text
ee3941de-5c1c-4f56-9d71-7037f78af800
```

## Production Smoke

```bash
curl https://robindex.ai/api/kols
curl "https://robindex.ai/api/tweets?kol_id=qinbafrank&limit=1"
curl "https://robindex.ai/api/tweets?kol_id=aleabitoreddit&limit=1"
```

Admin-only smoke:

```bash
curl https://robindex.ai/api/admin/stats -H "x-admin-key: $ADMIN_KEY"
```

Expected shape: tweet totals, non-retweet counts, date ranges, knowledge counts, and `sync_state`; no `emb` field.
