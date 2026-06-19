# Robindex

Robindex is a Cloudflare-native AI trader desk. A user chats with a finance KOL as if the model **is**
that KOL: the answer is grounded in the KOL's real historical tweets, a distilled persona pack, and live
market data, with clickable source-tweet citations.

Production: https://robindex.ai

Research room: `https://robindex.ai/research?agent=kol&persona=<kol_id>`

There is no fine-tuning. The system is retrieval + persona distillation + tools, so model upgrades improve
the product without retraining.

## Current State

- Live KOLs:
  - `qinbafrank` — `v2-mapreduce-2026-06-18`, 13.7k tweets.
  - `aleabitoreddit` — `v2-mapreduce-2026-06-19`, 5.9k tweets.
- Both live KOLs have full-corpus `persona_facts:merged`, so weekly updates use incremental map-reduce.
- Tweet corpora and search indexes are live in Cloudflare D1; raw paid tweet pulls are archived in R2.
- Local raw JSON snapshots and old hand-written persona files were removed from the repo. D1/R2 are the
  source of truth.

## Architecture

Single Cloudflare Worker (`app/src/index.ts`) serves static assets and JSON/SSE APIs.

| Concern | Implementation |
| --- | --- |
| Frontend | Workers Static Assets in `app/public`, vanilla HTML/CSS/JS |
| API / SSE chat | Hono Worker in `app/src/index.ts` |
| Database | D1 `robindex-db` |
| Raw archive | R2 `robindex-raw` |
| Cache | KV `CACHE` |
| LLM | Cloudflare AI Gateway to `deepseek/deepseek-v4-flash` and `deepseek/deepseek-v4-pro` |
| Market data | Tencent quote/kline/minute endpoints, Yahoo fundamentals, Eastmoney A-share data |
| Cron | daily ingest, weekly persona refresh, per-minute distill/eval job driver |

The retrieval stack deliberately uses FTS5, not vectors. Finance tweets are short, bilingual, and
jargon-dense; sparse retrieval plus LLM query expansion has been more controllable than embeddings.

## How A Reply Is Built

1. The chat endpoint loads the selected KOL row and `persona_pack`.
2. `planQuery()` expands the user's question into instruments and bilingual search terms.
3. `retrieve()` searches only that KOL's corpus in `tweet_search`, then `llmRerank()` selects final source
   tweets.
4. `gatherMarketData()` injects current quotes, K-lines, news, fundamentals, and benchmark context.
5. `buildMessages()` creates the system prompt:
   - `You ARE ${display_name} (@${handle}), a finance KOL. Stay 100% in character.`
   - do not mention being AI;
   - use the KOL's own voice, logic, worldview;
   - cite source tweets as `[T#]`;
   - use live data for current numbers.
6. A bounded tool phase can fetch missing data, then the answer streams over SSE.

## Persona Pipeline

Full-corpus persona generation is automated by:

```bash
POST /api/admin/distill-auto?kol_id=<id>&reset=1
```

The pipeline:

1. `mapStage` chunks the full non-retweet corpus chronologically and uses `deepseek-v4-flash` to extract
   partial persona JSON.
2. `reduceGroup` merges chunk partials in groups with `deepseek-v4-pro`.
3. `reduceFinalDraft` performs the final pro merge into `merged_draft`.
4. `finalizeMerged` is LLM-free: verifies quotes against the corpus, attaches verbatim exemplars, writes
   `persona_facts:merged`, and publishes `kols.persona_pack`.
5. Eval builds or reuses a golden set, scores the new persona, and rolls back only if it regresses vs the
   prior version.

Cost controls currently live in production:

- dynamic chunk sizing: tiny KOLs stay in one chunk; large KOLs keep up to 32 chunks;
- eval case reservation: overlapping cron/self-chain jobs do not score the same case twice;
- batch voice/stance judges: several eval answers are judged in one flash call;
- weekly smoke eval: weekly incremental updates score 12 cases first, escalating to full eval only when
  suspicious;
- canonical-corpus ingest only: shared/diagnostic KOL rows do not spend GetXAPI quota.

## Scheduled Jobs

Configured in `app/wrangler.jsonc`:

- `0 9 * * *` — daily GetXAPI ingest for canonical KOL rows only.
- `30 9 * * 1` — weekly stance chunk + persona incremental update.
- `* * * * *` — drives in-progress `distill-auto` eval jobs from KV.

Weekly persona refresh behavior:

- If `persona_facts:merged` exists, run `distillPersonaIncremental()` on the new week's tweets.
- If there are too few new tweets, skip persona mutation and keep the weekly stance note.
- Run 12-case smoke eval after weekly persona changes. If suspicious, enqueue full eval via
  `distill_job:<kol>`.

## Data Model

See `app/schema.sql` and migrations in `app/migrations/`.

Important tables:

- `kols` — KOL metadata and live `persona_pack`.
- `tweets` — canonical tweet corpus.
- `tweet_search` — FTS5 index over original tweet text plus optional tag columns.
- `knowledge_chunks` — weekly stance notes and persona backups.
- `persona_facts` — durable map/reduce partials and merged persona JSON.
- `persona_experiments` — distill/eval/rollback audit log.
- `eval_cases`, `eval_results` — golden eval set and per-version scores.
- `sync_state` — per-KOL incremental ingest cursor.

## Operations

Cloudflare auth uses Global API Key + email, not a bearer token. Local secrets are in
`account.guard.json`, which must remain untracked.

```bash
cd app
export CLOUDFLARE_API_KEY=$(node -p "require('../account.guard.json').CLOUDFLARE_API_KEY")
export CLOUDFLARE_EMAIL=$(node -p "require('../account.guard.json').expectedEmail")
export NODE_OPTIONS='--require ./scripts/cloudflare-dns-patch.cjs'
unset CLOUDFLARE_API_TOKEN

npx tsc --noEmit
npm run test:dsl
npm run deploy
```

Useful admin endpoints require `x-admin-key: $ADMIN_KEY`:

- `GET /api/admin/stats`
- `GET /api/admin/search-stats`
- `POST /api/admin/ingest`
- `POST /api/admin/persona-refresh`
- `POST /api/admin/distill-auto?kol_id=<id>&reset=1`
- `GET /api/admin/persona-experiments?kol_id=<id>`
- `POST /api/admin/eval-build?kol_id=<id>`
- `POST /api/admin/eval-run?kol_id=<id>&limit=2`

Smoke checks:

```bash
curl https://robindex.ai/api/kols
curl "https://robindex.ai/api/tweets?kol_id=qinbafrank&limit=1"
```

## Repository Layout

- `app/src/index.ts` — routes, SSE chat, admin APIs, cron entrypoint.
- `app/src/chat.ts` — prompt assembly, market context, tools, streaming.
- `app/src/rag.ts` — FTS retrieval, rerank, quote attachment.
- `app/src/query-plan.ts` — flash query planner.
- `app/src/ingest.ts` — daily tweet ingest and weekly persona refresh.
- `app/src/persona-distill.ts` — full and incremental map-reduce persona generation.
- `app/src/eval.ts` — eval set generation, scoring, smoke/full eval, rollback.
- `app/src/tools.ts` and market data modules — live data tools.
- `app/public` — static frontend.
- `app/migrations` and `app/schema.sql` — D1 schema.

See `Plan.md` for the current roadmap and operational notes.
