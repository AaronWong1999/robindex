# Robindex — Persona Pipeline & Roadmap

> Read `README.md` first (what it is, architecture, data model, ops, the "why" behind no-vector /
> query-side / no-fine-tuning). This file holds only what README doesn't: the **persona pipeline runbook**
> (the one genuinely tricky part), the condensed **changelog**, and the **roadmap**. Keep it lean.

Last updated: 2026-06-18. Live personas: `qinbafrank` = **v2-mapreduce-2026-06-18** (full-corpus, via the
automated `distill-auto` orchestrator); `aleabitoreddit`, `qinbafrank-tag` on earlier packs.

## ▶ AUTOMATED BACKFILL — `distill-auto` orchestrator (built 2026-06-18; qinbafrank reconciled)

`POST /api/admin/distill-auto?kol_id=X&reset=1` runs the **whole** map→group→final→finalize→eval pipeline
**server-side on the worker** (no client driving), then poll
`/api/admin/persona-experiments?kol_id=X` (trigger=`distill_auto`) for the `DONE` row. It regenerated clean
`merged` facts for qinbafrank (the old `voice_refine` v3 had tainted `expression_dna`+`signature_examples`)
and is the primary backfill path now; the §1 manual modes are the fallback / building blocks.

**Two-driver design (this is the subtle part — read before touching).** Each step does its LLM work
**in-request** (deferring it to `waitUntil` and returning early does NOT keep the worker alive — the work
just never runs), then chains the next step via `waitUntil(SELF.fetch(...))`.
- **Self-chain** handles the fast + single-heavy steps: map → group* → final → finalize → *first* eval
  batch. It can't drive a long *sequence* of slow steps, though: the parent must `waitUntil` the child's
  response, and a ~55s parent has too little of its ~100s budget left to await a ~55s child, so the chain
  dies after one slow hop.
- **Cron driver** (`* * * * *` → `driveDistillJobs`) finishes the rest. Each in-progress job is recorded in
  KV (`distill_job:<kol>`); every minute the cron advances each job by ONE step in a fresh invocation (its
  own ~100s budget), so the long eval sequence (~13 batches) completes hands-off in ~13 min. Steps are
  idempotent, so self-chain/cron overlap is safe. KV `distill_steps:<kol>` (TTL 2h) hard-caps runaway.

Phase machine: `map`(batch 6, skips cached chunks) → `group&i=N`(skips existing `reduce_l1[N]`) →
`final`(`reduceFinalDraft`: pro merge ONLY → `merged_draft`, LLM-only so it fits the limit) →
`finalize`(LLM-free verify+exemplars+gate, publish as `v2-mapreduce-<date>`) →
`eval`(`runEval(limit=2)` batches, auto-rollback if regressed) → done (clears `distill_job`+`distill_steps`).
Every transition logs to `persona_experiments` (trigger=`distill_auto`).

**Four CF/model gotchas that had to be solved (all live in `persona-distill.ts`/`index.ts`):**
1. **Reasoning eats the token budget.** deepseek-v4 (flash+pro) are reasoning models; at low map/reduce
   caps the CoT consumes the whole `max_tokens` and the response is `finish_reason=length` with **empty
   content**. Fix: send `reasoning:{enabled:false}` on every distill LLM call (in `llmJson`).
2. **The final merge is unbounded.** With reasoning off it still fills any cap (tested: `finish=length` at
   both 6k AND 16k tokens). Fix: `FINAL_REDUCE_LIMITS` hard caps (≤6 models, ≤2 quotes, …) so it finishes
   naturally (`finish=stop`) at ~3k tokens / ~60s and parses.
3. **`reduceFinal` was too heavy for one invocation** (corpus load + pro call + verify ≈ 100s, killed at the
   edge). Fix: split into `reduceFinalDraft` (pro only, no corpus load) + `finalizeMerged` (LLM-free).
4. **Eval batch size.** `limit=4` (~110s) is killed mid-step; `limit=2` (~55s) fits — that sizing is what
   lets the cron advance one batch per tick.

```bash
curl -XPOST "https://robindex.ai/api/admin/distill-auto?kol_id=qinbafrank&reset=1" -H "x-admin-key:$K"
curl     ".../api/admin/persona-experiments?kol_id=qinbafrank" -H "x-admin-key:$K"   # poll for DONE
```

## 1. Persona distillation pipeline (the tricky part — read this before touching it)

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
   as it completes, so a driver calls the endpoint repeatedly and re-running skips what's already done.
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

**Reconciled (2026-06-18):** the `voice_refine` v3 taint of qinbafrank's `merged` facts is fixed — the
`distill-auto` orchestrator (top section) regenerated clean `merged` and republished a date-stamped
`v2-mapreduce` pack. Onboarding/backfill is now one call to `distill-auto` (no hand-driven `curl`); the
manual modes below remain the fallback / building blocks.

---

## 2. Changelog (condensed, newest first)

- **Automated backfill orchestrator (`distill-auto`) + CF/model fixes (2026-06-18):** whole
  map→reduce→finalize→eval pipeline runs server-side (self-chain for fast/single-heavy steps + a
  `* * * * *` cron `driveDistillJobs` for the slow eval sequence). Solved four blockers: reasoning models
  emitting empty content (`reasoning:{enabled:false}`), unbounded final merge (`FINAL_REDUCE_LIMITS`),
  `reduceFinal` over the ~100s limit (split into `reduceFinalDraft`+`finalizeMerged`), eval batch sizing
  (`limit=2`). qinbafrank reconciled to a clean date-stamped `v2-mapreduce-2026-06-18`. See top section.
- **Full-corpus map-reduce persona + eval/auto-rollback (2026-06-18):** new `persona-distill.ts` (100% of
  corpus, verbatim-quote verified, staged around the ~100s limit) + `eval.ts` (golden eval, citation/voice/
  stance, regression rollback) + `persona_facts` (migration 0007) + `persona_experiments`/`eval_*`
  (migration 0006). Fixed `buildCorpus` recency-truncation (interleave recent + top-engagement). Made
  persona fallbacks observable in D1. qinbafrank live on v2-mapreduce. See §1.
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

## 3. Roadmap / open items

- **Self-serve KOL marketplace (revenue-share):** submit handle → instant cost quote → pay (Stripe/CF
  Payments) → clone live in minutes (`reindex?mode=raw` + persona distill) → 50/50 end-user revenue split;
  `usage_events` + weekly billing rollup + KOL dashboard.
- **Phase 3 (gated on a stable eval baseline):** DSPy/GEPA-style auto-optimization of the distill/rerank
  prompts, driven by eval scores. Do NOT start before the eval baseline is trusted.
- **Housekeeping:** older (pre-timeline-window) history needs a deeper paid scrape (skipped; self-quote
  fallback covers most). `account.guard.json` secrets were exposed in the initial commit — **rotate keys.**
  Tune `RATES` in `/api/admin/estimate` to real GetXAPI + DeepSeek pricing before charging.
