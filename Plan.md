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

- **KOL persona voice fix (2026-06-17):** The system prompt previously overrode the persona pack's
  first-person instructions with "Do not use first person on behalf of the KOL" and "do not claim to be
  the KOL" — making the model speak ABOUT the KOL as a third-party analyst instead of AS the KOL.
  This was the #1 quality gap vs TMB. Fix: system prompt now enables authentic KOL voice simulation
  ("speaks AS", "authentic voice", first-person permitted). Final-answer prompt simplified to let the
  model drive quality naturally instead of imposing rigid structure mandates. The persona pack's own
  voice/tone/format instructions now take precedence. Principle: let the model do the work, not rules.
- **A-share valuation auto-inject (2026-06-17):** TMB shows rich financial data (PE-TTM, forward PE,
  revenue/profit growth, margins, ROE) inline; Robindex showed only price. Fix: added `getAshareValuation`
  (Eastmoney push2 + datacenter `RPT_LICO_FN_CPD`) that fetches PE-TTM, PE-static, PB, market cap, ROE,
  gross/net margin, revenue/profit YoY, EPS for A-share stocks. Auto-fetched in `gatherMarketData` for the
  primary instrument (parallel with news — no added latency) and injected as `extraContext` in LIVE MARKET
  DATA. Also exposed as `get_ashare_valuation` tool (10th tool) for comparison stocks in the tool phase.
- **Speed overhaul (2026-06-17):** Latency was ~88s first-token / ~104s total. Root causes:
  (a) retrieval+rerank and market-data ran serially (~36s wasted), (b) tool phase ran unconditionally
  for all questions (~35s wasted on corpus-answerable queries), (c) rerank pool was too large (50→30),
  (d) get_quote resolved symbols sequentially.
  Fix: smart route classification (LLM planner decides quick vs deep), parallel preprocessing
  (market-data + retrieval via Promise.all), conditional tool phase (skip on quick route), smaller
  rerank pool (30/160char→18 keep), parallel get_quote. Target: <30s quick, <50s deep.
- **Answer-quality pass (quoted context):** Quoted-tweet content now participates in lexical scoring,
  LLM rerank, and the final SOURCE TWEETS prompt. The answer model sees both the KOL's own tweet and
  the quoted context it reacted to, with an explicit guard not to attribute quoted-account words to
  the KOL. This closes a major gap vs TMB for Qinbafrank-style quote-heavy research threads.
- **Answer posture pass (TMB parity):** Final assistant now applies the KOL's documented framework and
  cadence without claiming to be the KOL. The answer contract explicitly asks whether the KOL directly
  mentioned the topic, what is inferred from framework, whether old source views may be stale, and which
  signals would falsify the view.
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

---

## 4. Speed overhaul plan (2026-06-17) — in progress

> Goal: first-token from ~88s → <30s quick / <50s deep.

### Diagnosis

Live measurement (robindex.ai, "怎么看待 AI 泡沫" question):
- Query-plan (flash): ~4s
- Market data + retrieval + **rerank**: ~36s (serial bottleneck)
- **Tool phase (2 rounds)**: ~35s (unconditional, even for opinion questions)
- Answer streaming: ~16s
- **Total: ~88s first-token, ~104s done**

Answer quality is strong (15+ cited tweets, structured, on-voice). The fight is **speed**.

Post-deploy measurement from the temporary deterministic quick-route experiment (robindex.ai,
"怎么看 AI 泡沫？请用 Qinbafrank 的框架回答。"):
- `meta`: 2.9s, 18 citations, no chart
- first token: 16.1s
- done: 40.1s
- phases: plan → market/retrieval → thinking; **no tool phase**
- NOTE: the regex-based quick-route guard was removed after review. Route classification must remain
  LLM-owned; do not maintain prompt-classification word lists.

Three-question production benchmark before deep-route compaction:
- SPCX 走势: meta 14.7s, first token 108.0s, done 154.7s, 18 citations, chart=false
- 中际旭创该不该买: meta 20.7s, first token 76.7s, done 101.8s, 18 citations, chart=false
- AI 泡沫: meta 2.9s, first token 3.2s, done 3.2s, 18 citations
Follow-up fix kept: compact tool outputs before final-answer prompt, and cap deep tool phase to 1
round when LLM prefetch already resolved a primary quote. Regex instrument/route hints were removed.
Current LLM-only planner optimization: compacted the planner system prompt and reduced planner output
budget (500→360 max tokens). This keeps routing/term expansion owned by the LLM while reducing planner
latency and prompt-cache pressure.
Follow-up LLM-owned speed optimization: quick-route retrieval still uses the LLM reranker, but with a
smaller candidate pool and citation cap (18→14) plus shorter candidate snippets. Deep-route questions keep
the wider 30/18 evidence budget.

### A. Latency — backend

#### A1. Smart route classification (query-plan.ts) ✅ DONE
- Added `route: "quick" | "deep"` and `needs_tools: boolean` to `QueryPlan`.
- Flash planner (a call we make anyway) classifies in step 1:
  - **quick**: viewpoint/opinion/verify/"他怎么看" questions → skip tool phase entirely
  - **deep**: live-price buy/sell timing, fresh news, fundamentals, intraday → run tool phase
- Default to deep (safe).
- Route classification stays LLM-only. A regex quick-route guard was tested and removed as
  unsustainable; do not reintroduce prompt-classification keyword lists.
- Planner prompt was compacted; no local keyword classifier was added.
- Retrieval rerank budgets can depend on the LLM planner's `route`, but not on local keyword/regex lists.

#### A2. Parallel preprocessing (index.ts /api/chat) ✅ DONE
- `gatherMarketData` and `retrieve` run concurrently via `Promise.all` after plan returns.
- Previously serial (~15-20s wasted).

#### A3. Smaller/faster rerank (rag.ts) ✅ DONE
- Rerank candidate pool: 50→30, keep: 22→18, text slice: 240→160 chars.
- Cuts rerank LLM tokens ~40%.

#### A4. Parallel get_quote (tools.ts) ✅ DONE
- Replace sequential `for (await resolveQuote...)` with `Promise.all`.
- Removes N× latency multiplier for multi-symbol quote calls.

#### A5. Conditional tool phase (index.ts) ✅ DONE
- Tool phase only runs when `plan.needs_tools === true` (deep route).
- Quick route skips ~35s of tool rounds entirely.
- Rounds cap: 1 for quick-with-tools, 2 for deep.

### B. Streaming UX — frontend

#### B1. Earlier meta event (index.ts) ✅ DONE
- Send `meta` (citations + chart) right after retrieval, **before** tool phase.
- Right-side 原文支持 panel populates while answer streams.

#### B2. Phase stepper UI (research.js) ✅ DONE
- Replace static "正在准备…" with a phase stepper: `理解问题 → 检索原文 → 取行情 → 生成中`
- Each step lights up as its SSE `progress` event arrives.

### C. UI polish (styles.css) ✅ DONE

#### C1. Complete markdown renderer (.md) ✅ DONE
- Add `a`, `code`, `pre`, `blockquote`, `table`/`th`/`td` styles.
- Add `:focus-visible` ring (a11y).

#### C2. Fix duplicate .tab bug ✅ DONE
- Lines 466 vs 521 — conflicting pill vs underline rules. Resolve to one.

#### C3. Fix light theme ✅ DONE
- Replace hardcoded dark hex/rgba in `.srcpanel`, `.composer`, `.src`, etc. with tokens.
- Fix ~24 raw `rgba(245,244,239,…)` literals.

#### C4. Fix Google Fonts + reduced-motion ✅ DONE
- Add weight 600 to the `@import` (CSS uses 600 extensively but only 400;700 requested).
- Add `prefers-reduced-motion` guards on pulse/blink animations.

### D. Verify & deploy — TODO
1. `npx tsc --noEmit` + `npm run test:dsl` + `npm run test:prompt` ✅ DONE
2. Local smoke via curl timing SSE phases — BLOCKED locally by Wrangler remote proxy auth timeout
3. Commit on branch, deploy via `wrangler deploy` ✅ DONE (version `1967b71d-af05-458b-b2f3-17742d14620b`)
4. Re-measure live latency ✅ DONE for AI bubble quick-route smoke

### Files touched
- `app/src/query-plan.ts` — A1: route/needs_tools
- `app/src/index.ts` — A2 parallel, A5 conditional tools, B1 early meta
- `app/src/rag.ts` — A3: smaller rerank pool
- `app/src/tools.ts` — A4: parallel get_quote
- `app/src/source-format.ts` — quoted context prompt formatting
- `app/scripts/test_prompt_format.mjs` — prompt-format regression test
- `app/public/research.js` — B2: phase stepper
- `app/public/styles.css` — C1-C4: markdown, .tab, light theme, fonts, reduced-motion

### Risk guardrails
- Retrieval stays `WHERE kol_id=?` scoped; no anti-contamination change.
- Rerank remains the relevance authority (just smaller pool).
- Quick route still retrieves + cites; only the tool phase is conditionally skipped.
- If `route` classification fails, default to `deep` (safe).
- The answer model should not impersonate the KOL or invent alternate spellings of the KOL name; it should
  apply the documented framework, cite source tweets, and separate direct support from inference.
- No schema/DB migration needed. No model change.
