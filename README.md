# Robindex

Robindex is a Cloudflare-native "AI Trader Desk". You chat with an AI that faithfully impersonates a
chosen finance KOL — its knowledge, logic, tone — grounded in that KOL's real historical tweets and
live market data, with clickable citations back to the source tweets.

Production: https://robindex.ai · Research room: `https://robindex.ai/research?agent=kol&persona=<kol_id>`

Distillation is **API + retrieval only — no fine-tuning** (so we ride model upgrades for free).

---

## Architecture (Cloudflare-only)

Single Hono Worker (`app/src/index.ts`) serving a vanilla static frontend (Workers Static Assets) + a
JSON/SSE API. No build step. All LLM calls go through the **Cloudflare AI Gateway**.

| Concern | Implementation |
| --- | --- |
| Frontend | Workers Static Assets (`app/public`), vanilla HTML/CSS/JS, mobile-first |
| API / SSE chat | Hono Worker (`app/src/index.ts`) |
| Store | D1 `robindex-db` |
| Raw tweet archive | R2 `robindex-raw` |
| Cache (quotes/kline/news + resolved symbols) | KV `CACHE` |
| LLM | AI Gateway → `deepseek/deepseek-v4-flash` (cheap path) / `deepseek/deepseek-v4-pro` (answer/persona) |
| Live market data | public Tencent endpoints (quote/kline/minute) + Yahoo (US fundamentals) |
| Charts | benji.org/liveline (frontend renders from chart meta) |
| Scheduled jobs | daily incremental ingest (`0 9 * * *`), weekly persona refresh (`30 9 * * 1`), per-minute distill-job driver (`* * * * *`, advances any in-progress `distill-auto` backfill) |

**No vectors / no embeddings anywhere.** Retrieval is sparse (FTS5). This is a deliberate decision —
short, jargon-dense, bilingual finance text retrieves better with full-text + LLM expansion than with
embeddings.

### Retrieval — the core (`app/src/query-plan.ts` + `app/src/rag.ts`)

Default mode is **query-side-only**: the LLM does the work, no hardcoded dictionaries (so it improves as
models improve).

1. **Plan** — `planQuery()` (flash): turns the question into a structured plan — tradable `instruments`
   `{name,ticker,market}`, plus **bilingual (CN/EN) keyword expansion** (the only cross-language bridge).
2. **Search** — `retrieve()` runs multi-route FTS5 over `tweet_search` (trigram tokenizer) scoped to the
   `{text}` column, matching the planner's bilingual terms against the **original tweet text**. An
   `instr()` route covers <3-char terms trigram can't match. Recency is a weak tie-breaker only.
3. **Rerank** — `llmRerank()` (flash) is the relevance **authority**: it selects the final ≤20 citations
   by topic-specificity, the KOL's own view, set coverage (facets + ecosystem), and concrete substance —
   explicitly *not* by recency.
4. The answer model is shown **only the real original tweet text**; citations are normalized to `[T#]`.

Cross-lingual recall works because the planner expands a Chinese question into the English words a
relevant tweet would contain (and vice-versa), matched against the raw text.

**Per-KOL retrieval mode** (`kols.retrieval_mode`, `kols.corpus_id`):
- `query_side` (default) — matches the `{text}` column only.
- `tagged` (opt-in A/B control) — also weights machine tag columns (`entities/aliases/topics/stances/style`
  generated offline by flash, stored in `tweet_tags` + `tweet_search`). `corpus_id` lets a control KOL
  reuse another KOL's corpus without duplicating the tweets table.
  Tagging is **optional** — query-side-only is the default and needs zero per-tweet LLM cost.

### Live data + tools (`app/src/chat.ts`, `app/src/tools.ts`)

- The planner's instruments (and `exact_entities` as fallback) are resolved against the live quote feed;
  only those that return a real price are used → quote + 30-day K-line + per-stock news.
- Macro/"should I buy"/大盘 questions with no named instrument inject a benchmark **index basket**
  (纳指/标普/道指/恒生/上证) as text context (not charted).
- A bounded **tool phase** (≤2 rounds) lets the model fetch anything missing via **9 tools**: `get_quote`
  (one or many, also resolves names), `get_kline`, `get_news`, `get_financials`, `get_key_indicators`,
  `get_analyst_data`, `get_sec_filings`, `get_market_ranking`, `get_ashare_detail` (sectors/fund_flow/
  dragon_tiger).

### Quoted tweets (themarketbrew-style nested citations)

Each citation can carry the nested **quoted tweet**. `tweets.quoted` stores it (JSON); ingest captures
GetXAPI's `quoted_tweet` natively. For older tweets without it, `attachQuoted()` falls back to parsing
the self-quote `x.com/<handle>/status/<id>` link and resolving the original from our own corpus. The
right-side 原文支持 panel renders it.

### Persona — full-corpus map-reduce (`app/src/persona-distill.ts`)

Per-KOL `persona_pack` (mental models with a code-enforced triple-verification gate, decision heuristics,
expression DNA, track record, counter-views, sector focus, signature quotes, verbatim analytical
exemplars). Re-injected every turn (not remembered by the model). History capped at last 6 turns; older
turns compressed to a rolling summary.

It is distilled from **100% of the corpus** via map-reduce, because a prolific KOL has ~1.2M tokens of
tweets — far beyond any single context window (the old single-call distiller in `persona-gen.ts` only saw
an ~80K-char recency window ≈ 3.8% of a 13.7k-tweet corpus):

1. **Map** — chunk the corpus chronologically (~32 chunks); **flash** distills each into a partial persona.
   Every evidence quote is verified as a verbatim substring of its chunk — unverifiable quotes are dropped
   (hard anti-hallucination gate, in code).
2. **Reduce** — **pro** hierarchically merges the partials into one persona, preferring frameworks that
   recur across chunks (enduring) over one-off takes (recent noise).
3. `analytical_exemplars` are **verbatim tweets selected in code** (zero fabrication risk).

Partials + the merged result are persisted to `persona_facts`, so the **weekly refresh is incremental**:
map only the new week's tweets and reduce them into the stored facts — no re-reading history, ~$cents.

**Eval + auto-rollback** (`app/src/eval.ts`): a golden Q&A set is mined from the KOL's own tweets; each new
persona version is scored on citation accuracy (hard/verifiable), voice fidelity and stance consistency
(LLM-judge, **relative regression only**). If a version regresses vs the prior one, it auto-rolls-back to
the last good pack. This is the self-healing "one generation better than the last" ratchet.

> **Cloudflare ~100s limit:** a single `pro` call near max output flirts with the worker execution limit,
> so map/reduce are **staged + resumable**. The whole pipeline is automated by
> `POST /api/admin/distill-auto?kol_id=X&reset=1` — it runs server-side via a self-fetch chain for the fast
> steps plus a per-minute cron (`driveDistillJobs`) for the slow eval sequence. Distill LLM calls send
> `reasoning:{enabled:false}` (the reasoning models otherwise burn the whole token budget on CoT and return
> empty), the final merge is hard-capped so it finishes/parses, and it's split into `reduceFinalDraft`
> (pro-only) + `finalizeMerged` (LLM-free). See `Plan.md` for the orchestrator design, the four CF/model
> gotchas, the manual-mode fallback runbook, and costs (~$1 / ~20 min one-time backfill per KOL).

### Anti-contamination (hard rules)
Every retrieval/data query is scoped `WHERE kol_id=?` — the model never chooses which library to search.
A conversation is bound to one `kol_id`. Persona is re-injected each turn.

---

## Data model (D1, `app/schema.sql`)

- `kols` — id, display, handle, twitter_uid, avatar, tagline, `persona_pack`, `retrieval_mode`, `corpus_id`
- `tweets` — id, kol_id, text, timestamps, engagement, urls, media, **`quoted`** (JSON)
- `tweet_tags` — per-tweet machine search fields (only used by `tagged` mode)
- `tweet_search` — FTS5 (trigram): `text` + tag columns + `tweet_id`/`kol_id`
- `knowledge_chunks` — distilled methodology/theses/weekly-stance + persona backups/snapshots
- `conversations` / `messages` — bound to one kol_id; messages store used citations
- `sync_state` — per-KOL `last_tweet_id` for incremental ingest
- `persona_facts` — map-reduce chunk partials + merged facts (resumable backfill + weekly incremental)
- `persona_experiments` — one row per persona-gen/eval/rollback event (D1 observability, survives KV TTL)
- `eval_cases` / `eval_results` — golden eval set + per-version scores (drives auto-rollback)

Migrations in `app/migrations/` (apply with `wrangler d1 execute robindex-db --remote --file=...`):
`0002_remove_embeddings` · `0003_fts5_search` · `0004_retrieval_mode` · `0005_quoted_tweet` ·
`0006_persona_experiments` · `0007_persona_facts`.

## KOLs

| id | Display | Handle | Mode |
| --- | --- | --- | --- |
| `qinbafrank` | Qinbafrank | @qinbafrank | query_side (main, 13.7k tweets) |
| `qinbafrank-tag` | Qinbafrank（打标签对照）| @qinbafrank | tagged (A/B control, reuses qinbafrank corpus) |
| `aleabitoreddit` | Serenity | @aleabitoreddit | query_side (5.9k tweets + 201 knowledge chunks) |

---

## Operations

Cloudflare auth uses the **Global API Key** (KEY + EMAIL), not a bearer token. Requires Node ≥ 22.
Secrets live in `account.guard.json` (gitignored) — `CLOUDFLARE_API_KEY`, `expectedEmail`, `ADMIN_KEY`,
`CFGATEWAYKEY`. Worker secrets (set via `wrangler secret`): `CFGATEWAYKEY`, `GETXAPI_KEY`, `ADMIN_KEY`,
optional `OPENROUTER_KEY`.

```bash
cd app
export CLOUDFLARE_API_KEY=$(node -p "require('../account.guard.json').CLOUDFLARE_API_KEY")
export CLOUDFLARE_EMAIL=$(node -p "require('../account.guard.json').expectedEmail")
export NODE_OPTIONS='--require ./scripts/cloudflare-dns-patch.cjs'
unset CLOUDFLARE_API_TOKEN
npx tsc --noEmit && npm run test:dsl   # local checks
npx wrangler deploy                    # deploy
```

Admin APIs (header `x-admin-key: $ADMIN_KEY`):
- `GET /api/admin/stats` · `GET /api/admin/search-stats` — corpus / index coverage
- `POST /api/admin/reindex?kol_id=&mode=raw|tag&shards=&shard=&batch=` — build FTS index. `mode=raw`
  writes original text (no LLM, instant searchable); `mode=tag` adds machine tags. Drive with
  `scripts/build_search_index.mjs` (`MODE=raw|tag SHARDS=4 SHARD=k`).
- `POST /api/admin/refetch-quotes?kol_id=&pages=&cursor=` — backfill `quoted` from GetXAPI
  (budget-controlled, UPDATE-only; note: GetXAPI's timeline only exposes a recent window).
- `GET /api/admin/estimate?count=N` (or `?uid=`) — self-serve onboarding cost quote.
- `POST /api/admin/onboard {handle}` — clone a new KOL: create row → ingest → raw-index → persona.
- `POST /api/admin/distill-auto?kol_id=&reset=1` — automated full-corpus persona backfill (map→reduce→
  finalize→eval, server-side; poll `persona-experiments?kol_id=` trigger=`distill_auto` for the `DONE` row).

Smoke:
```bash
curl https://robindex.ai/api/kols
curl "https://robindex.ai/api/tweets?kol_id=qinbafrank&limit=1"
```

## Important files
- `app/src/index.ts` — routes, chat SSE, admin APIs, cron entrypoint
- `app/src/query-plan.ts` — flash query planner (bilingual expansion + instruments)
- `app/src/rag.ts` — FTS5 retrieval, LLM rerank, quoted-tweet attach, legacy fallback
- `app/src/chat.ts` — prompt assembly (cache-friendly), market data, tool phase, streaming, summary
- `app/src/tagger.ts` — offline/inline flash tagging (raw + tag indexing)
- `app/src/ingest.ts` — daily GetXAPI incremental ingest (+ quoted capture) + weekly refresh/incremental distill
- `app/src/persona-gen.ts` — single-call persona distill (legacy/small KOLs) + shared markdown/validation helpers
- `app/src/persona-distill.ts` — full-corpus map-reduce distillation (map/reduce/incremental/voice-refine)
- `app/src/eval.ts` — golden eval set, scoring, auto-rollback
- `app/src/finance.ts` / `eastmoney-*.ts` / `marketdata.ts` — live market data
- `app/schema.sql` + `app/migrations/` — D1 schema

See `Plan.md` for the persona-pipeline runbook, changelog, and roadmap (incl. the self-serve KOL marketplace).
