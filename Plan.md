# Robindex — Decisions, Runbook & Roadmap

> Living doc for whoever picks this up. Read `README.md` first (what it is + architecture + how to run).
> This file is the **why** (decisions), the **persona pipeline runbook** (the one genuinely tricky part),
> and the **roadmap**. Keep it lean — delete anything no longer true.

Last updated: 2026-06-18.

## 0. Current truth

- Production: `https://robindex.ai`. Cloudflare-only (Worker + D1 + R2 + KV + AI Gateway). No build step.
- KOLs live: `qinbafrank` (main, 13.7k tweets, **persona = v2-mapreduce, full-corpus**), `aleabitoreddit`
  (Serenity), `qinbafrank-tag` (tagged A/B control sharing qinbafrank's corpus).
- Retrieval = **LLM query-plan → SQLite FTS5 (trigram) → LLM rerank**, default query-side-only.
  **No vectors/embeddings** anywhere (deliberate; do not reintroduce).
- All LLM calls via **AI Gateway** (`deepseek-v4-flash` cheap path, `-pro` answer/persona). **No fine-tuning.**
- Persona is distilled from **100% of the corpus** (map-reduce) with an **eval + auto-rollback** loop.
- Cloudflare auth = **Global API Key** (`CLOUDFLARE_API_KEY` + `CLOUDFLARE_EMAIL`), not a bearer token.

## 1. Key decisions (the "why")

- **No vector DB.** Short, jargon-dense, bilingual finance text retrieves better with full-text + LLM
  expansion. Pure-vector blurs specialized terms (RRP/SOFR/准备金). FTS5 trigram handles CN+EN.
- **Query-side-only by default, tagging optional.** Cross-lingual recall is done at query time (planner
  expands CN↔EN), not by pre-tagging tweets. A new KOL goes searchable in minutes (fetch → store →
  raw-index, zero LLM). Per-tweet machine tags are an opt-in `tagged` A/B mode only.
- **No hardcoded dictionaries.** Domain expansion is the planner's job; the reranker is the relevance
  authority — quality improves automatically as models improve.
- **No fine-tuning.** Persona is prompt + retrieval only, so we ride model upgrades for free.
- **Original text is sacred / anti-hallucination in code.** The answer model sees only real tweet text;
  persona evidence quotes are verified as verbatim substrings and dropped if they don't resolve; analytical
  exemplars are verbatim tweets selected in code. Citations are clickable; quoted tweets render nested.
- **Anti-contamination.** Every query scoped `WHERE kol_id=?`; conversation bound to one KOL; persona
  re-injected each turn (not model memory).
- **Cost/caching.** Stable prompt prefix first (persona pack + tool SOP in system message) for provider
  prefix-cache hits; variable content (retrieved tweets, live data, question) last.

---

## 2. Persona distillation pipeline (the tricky part — read this before touching it)

**Why map-reduce.** A prolific KOL is ~1.2M tokens of tweets — beyond any context window. The old
single-call distiller (`persona-gen.ts`) only fit an ~80K-char **recency** window ≈ 3.8% of the corpus, so
the persona was "the last two weeks", missing enduring frameworks. `persona-distill.ts` reads 100%:

- **Map** (`flash`, ~32 chunks): each chunk → a compact partial persona. Evidence quotes verified verbatim
  against the chunk; unverifiable ones dropped. Partials persisted to `persona_facts` (kind=`chunk`).
- **Reduce** (`pro`, hierarchical): merge partials, **preferring frameworks that recur across chunks**
  (enduring) over one-offs (noise). Group-merges (`reduce_l1`) → final merge → merged facts (kind=`merged`).
- **Exemplars**: verbatim analytical tweets picked in code (zero fabrication). Then a triple-verification
  gate filters weak mental models.
- **Weekly = incremental**: map only the new week's tweets, reduce into the stored `merged` facts. No
  history re-read. Cheap. (`ingest.ts` uses this when a `persona_facts:merged` row exists, else legacy evolve.)

**THE pitfall — Cloudflare's ~100s execution limit (request AND `waitUntil`).** A single `pro` reduce
emitting N tokens takes ~N/65 s; near max output it exceeds the limit and the worker is killed mid-call
(nothing persists). `waitUntil` does **not** survive a ~100s call either. What actually works:

1. **Stage + resume everything.** Map and reduce are split into small steps, each one LLM call, persisted
   as it completes, so a driver calls the endpoint repeatedly and re-runs only skip what's done.
2. **Cap reduce output low** (~4000 group / ~6000 final tokens) so each `pro` call finishes in ~60–85s.
3. **Drive from the client** (repeated `curl`), not from `waitUntil`.

**Endpoint:** `POST /api/admin/persona-distill?kol_id=X&mode=…` (admin-gated). Full backfill runbook:

```bash
# 1. map — repeat until {"remaining":0}
curl -XPOST ".../persona-distill?kol_id=X&mode=map&batch=8" -H "x-admin-key:$K"
# 2. reduce groups — call group=0..(groups-1); add &bg=1 only as a fallback (waitUntil is unreliable)
curl -XPOST ".../persona-distill?kol_id=X&mode=reduce_group&group=0" -H "x-admin-key:$K"
# 3. final reduce — writes merged facts; render/publish step may run past the limit, so if it
#    times out, the merged facts are still saved → finish with publish_merged:
curl -XPOST ".../persona-distill?kol_id=X&mode=reduce_final"   -H "x-admin-key:$K"
curl -XPOST ".../persona-distill?kol_id=X&mode=publish_merged" -H "x-admin-key:$K"   # renders + backs up + writes pack
```

Other modes: `incremental` (weekly), `voice_refine` (re-derive Expression DNA + 金句 from a vivid sample —
**tried, it regressed; left in but don't ship without eval**), `full`/`reduce` (small corpora only).

**Eval + auto-rollback** (`eval.ts`): `POST /api/admin/eval-build` mines a golden Q&A set from the KOL's
tweets; `POST /api/admin/eval-run?limit=4&rollback=0` scores the **live** pack (resumable, flash) on
citation accuracy (hard), voice & stance (LLM-judge, **relative only** — never an absolute gate). A new
version that regresses vs the prior one auto-rolls-back to the last backup. Eval-run is also worker-limited,
so drive `limit=4` batches until `remaining=0`.

**Verified result (qinbafrank, 2026-06-18):** full-corpus **v2** beats the recency pack v1 on the hard
metrics — citation 1.0 vs .86, stance 1.0 vs .67, composite **.806 vs .70**, with deeper cross-cycle mental
models (产业-金融自循环、美元潮汐、切香肠策略) instead of June-only hot takes. A `voice_refine` **v3**
experiment dropped voice/citation and was rolled back — the eval/rollback loop doing its job.

**Costs / time.** One-time full backfill ≈ ~40 LLM calls (~32 flash + ~10 pro) ≈ **~$1 / ~20 min** per KOL.
Weekly incremental ≈ **3–4 calls / ~$cents / cron-automated**. (The multi-hour first run on 2026-06-18 was
one-time *engineering* to discover and stage around the ~100s limit — not recurring compute.)

**Known cleanup.** The `voice_refine` v3 experiment overwrote `persona_facts:merged` (the `expression_dna`
+ `signature_examples` fields) for qinbafrank; the live pack was restored to true v2 from backup, but the
stored merged JSON is v3-tainted on those two fields. Re-run `reduce_final` (the `reduce_l1` intermediates
are intact) to fully reconcile before relying on the weekly incremental.

**Next step to productionize.** The backfill is currently driven by hand (repeated `curl`). To onboard many
KOLs, move the driver into a CF **Queue or cron** that walks map → reduce_group* → reduce_final →
publish_merged → eval automatically.

---

## 3. Changelog (condensed, newest first)

- **Full-corpus map-reduce persona + eval/auto-rollback (2026-06-18):** new `persona-distill.ts` (100% of
  corpus, verbatim-quote verified, staged around the ~100s limit) + `eval.ts` (golden eval, citation/voice/
  stance, regression rollback) + `persona_facts` (migration 0007) + `persona_experiments`/`eval_*`
  (migration 0006). Fixed `buildCorpus` recency-truncation (interleave recent + top-engagement). Made
  persona fallbacks observable in D1. qinbafrank live on v2-mapreduce. See §2.
- **Persona-gen stability (2026-06-18):** typed-error retry ladder; `finish_reason=length` is now a hard
  truncation error (was silently parsed); per-chunk timeout scales with budget; full D1 observability.
- **KOL persona voice fix (2026-06-17):** system prompt now enables authentic first-person KOL voice
  (was forcing third-party-analyst posture). Principle: let the model do the work, not rigid rules.
- **A-share valuation auto-inject (2026-06-17):** `getAshareValuation` (PE/PB/ROE/margins/growth) injected
  into LIVE MARKET DATA for the primary instrument + exposed as `get_ashare_valuation` tool.
- **Speed overhaul (2026-06-17, done):** ~88s→target <30s quick / <50s deep — smart route classification,
  parallel preprocessing (market+retrieval), conditional tool phase, smaller rerank pool, parallel quotes,
  earlier `meta` SSE event, phase-stepper UI, markdown/theme/font fixes.
- **Quoted-tweet context (migration 0005):** quoted content participates in scoring/rerank/prompt + nested
  render; budget-safe `/api/admin/refetch-quotes`.
- **Retrieval = LLM only:** removed hardcoded domain expansion + BM25 force-top-N; reranker is authority;
  instrument detection validated against the live quote feed. Index decoupled (`mode=raw` instant, `tag` async).
- **No-vector migration (0002) + FTS5 rebuild (0003) + per-KOL retrieval mode/A-B (0004).**
- **Foundation:** Cloudflare scaffold, market-data service, persona injection, SSE chat w/ citations,
  mobile-first UI, two corpora, daily/weekly crons.

## 4. Roadmap / open items

- **Productionize the backfill driver** (§2 "Next step") — CF Queue/cron, so onboarding a KOL is one call.
- **Reconcile qinbafrank merged facts** (§2 "Known cleanup") — re-run `reduce_final`.
- **Self-serve KOL marketplace (revenue-share):** submit handle → instant cost quote → pay (Stripe/CF
  Payments) → clone live in minutes (`reindex?mode=raw` + persona distill) → 50/50 end-user revenue split;
  `usage_events` + weekly billing rollup + KOL dashboard.
- **Phase 3 (gated on a stable eval baseline):** DSPy/GEPA-style auto-optimization of the distill/rerank
  prompts, driven by eval scores. Do NOT start before the eval baseline is trusted.
- **Housekeeping:** older (pre-timeline-window) history needs a deeper paid scrape (skipped; self-quote
  fallback covers most). `account.guard.json` secrets were exposed in the initial commit — **rotate keys.**
  Tune `RATES` in `/api/admin/estimate` to real GetXAPI + DeepSeek pricing before charging.
