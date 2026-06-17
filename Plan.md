# Robindex — Decisions, Changelog & Roadmap

> Living doc for whoever picks this up. Read `README.md` first (what it is + how to run it). This file
> is the **why** (key decisions), the **changelog** (condensed), and the **roadmap**. Keep it lean —
> delete anything that's no longer true.

Last updated: 2026-06-17.

## 0. Current truth

- Production: `https://robindex.ai`. Cloudflare-only (Worker + D1 + R2 + KV + AI Gateway). No build step.
- Two KOLs live (`qinbafrank`, `aleabitoreddit`) + one A/B control (`qinbafrank-tag`).
- Retrieval = **LLM query-plan → SQLite FTS5 (trigram) → LLM rerank**, default **query-side-only**.
  **No vectors/embeddings** anywhere (deliberate; do not reintroduce).
- All LLM calls via **AI Gateway** (`deepseek-v4-flash` cheap path, `-pro` answer/persona). No fine-tuning.
- Architecture/data-model/runbook details live in `README.md`.

## 1. Key decisions (the "why")

- **No vector DB.** Short, jargon-dense, bilingual finance text retrieves better with full-text +
  LLM expansion. Pure-vector blurs specialized terms (RRP/SOFR/准备金). FTS5 trigram handles CN+EN.
- **Query-side-only by default, tagging optional.** Cross-lingual recall is done at query time (the
  planner expands CN↔EN), not by pre-tagging every tweet. This means a new KOL goes live in minutes
  (fetch → store → raw-index, zero LLM) and there's no per-tweet tagging bill or maintenance. Per-tweet
  machine tags exist only as an opt-in `tagged` A/B mode.
- **No hardcoded dictionaries.** Domain/term expansion is the LLM planner's job and the LLM reranker is
  the relevance authority — so quality improves automatically as models improve. (We tried a hardcoded
  liquidity-jargon booster; removed it per this principle.)
- **Original text is sacred.** Machine tags only widen *retrieval*; the answer model is shown only the
  real tweet text. Citations are clickable to source; quoted tweets render nested.
- **Anti-contamination.** Every query scoped `WHERE kol_id=?`; conversation bound to one KOL; persona
  re-injected each turn (not model memory); persona evolves weekly (append-only), never per single tweet.
- **Cost/caching.** Stable prompt prefix first (persona pack + tool SOP in the system message) for
  provider prefix-cache hits; variable content (retrieved tweets, live data, question) last.
- **Twitter data is paid.** Ingest is incremental (`sync_state.last_tweet_id`), author-validated, stored
  in full (D1 + R2). GetXAPI's user-timeline only exposes a recent window (~hundreds of tweets), so full
  back-history requires a deeper scrape.

## 2. Changelog (condensed, newest first)

- **Quoted/retweet display.** `tweets.quoted` (migration 0005) + native capture in ingest + `attachQuoted`
  (stored-or-self-quote-link fallback) + nested render in the 原文支持 panel + budget-safe
  `/api/admin/refetch-quotes`. ~97% of qinbafrank tweets are quote-tweets; recent window backfilled cheap.
- **Retrieval quality pass (LLM-driven).** Removed hardcoded domain expansion + the BM25 "force top-N"
  rule; reranker is the authority (topic-specificity > recency, coverage, concrete substance); planner
  prompt expanded for bilingual + ecosystem breadth; concept routes split to dodge the FTS phrase cap;
  tamed recency; chunked the hydrate query under D1's ~100-param limit. Tool phase 3→2 rounds.
- **Instrument detection = LLM only.** Deleted the static dictionary; the planner identifies
  instruments and we validate against the live quote feed (incl. `exact_entities` fallback, which fixed
  the just-IPO'd SpaceX→SPCX chart). Macro/no-ticker questions inject a benchmark index basket as text.
- **Index decoupling.** `mode=raw` makes a tweet searchable instantly (no LLM); `mode=tag` is the async
  enhancement. Daily ingest raw-indexes only.
- **Distiller upgrade.** Code-enforced triple-verification gate + added corpus dimensions (track record,
  counter-views, sector focus, signature quotes).
- **Per-KOL retrieval mode + A/B control** (migration 0004): `qinbafrank` query_side vs `qinbafrank-tag`
  tagged, sharing one corpus via `corpus_id`.
- **FTS5 retrieval rebuilt** (migration 0003): replaced the old `instr()`-only sparse retrieval.
- **No-vector migration** (migration 0002): removed Vectorize + all embedding columns/code.
- **Foundation**: Cloudflare scaffold, financial data service, persona injection, SSE chat with
  citations, mobile-first UI, two KOL corpora loaded, daily/weekly crons.

## 3. Roadmap / open items

**Self-serve KOL marketplace (revenue-share)** — any KOL submits a handle, sees an instant cost quote,
pays, and is cloned + live in minutes; end-user revenue split 50/50.
1. Quote — `GET /api/admin/estimate` (built). TODO: use GetXAPI's `tweet_count`/profile for the count.
2. Pay — Stripe/CF Payments; gate behind payment; `onboarding` row.
3. Fast ingest — full-history fetch, store all raw text (D1+R2). Only unavoidable paid step.
4. Go live in minutes — `reindex?mode=raw` (no LLM) + one `pro` persona call. Now answerable + billable.
5. Tag in background (optional) — `reindex?mode=tag`, sharded; or lazy/tiered.
- Revenue share: `usage_events` table (kol_id, conv_id, model, tokens, ts) + weekly billing rollup +
  KOL dashboard (corpus stats, coverage, earnings).

**Smaller TODOs**
- Tagging/quote backfill of *older* (pre-timeline-window) history needs a deeper scrape (paid) — skipped
  for now; free self-quote fallback covers most of it.
- `account.guard.json` holds live secrets (gitignored). Keys were exposed in the initial commit — rotate.
- Tune `RATES` in `/api/admin/estimate` to real GetXAPI + DeepSeek pricing before charging.
