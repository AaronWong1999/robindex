# Robindex Plan

Last updated: 2026-06-19.

This file tracks what is live, what changed recently, and what should be done next. Read `README.md`
first for architecture and operations.

## Live Status

- Production: https://robindex.ai
- Live personas:
  - `qinbafrank`: `v2-mapreduce-2026-06-18`
  - `aleabitoreddit`: `v2-mapreduce-2026-06-19`
- Both live KOLs are on full-corpus map-reduce with `persona_facts:merged`.
- The product keeps one persona per Twitter handle.
- Local raw tweet snapshots and hand-written persona files were removed from git. D1 and R2 are the source
  of truth.

## Current Pipeline

### Full backfill

`POST /api/admin/distill-auto?kol_id=<id>&reset=1`

The Worker runs:

1. `map` — flash partial persona over dynamic corpus chunks.
2. `group` — pro group reduce.
3. `final` — pro final draft.
4. `finalize` — LLM-free quote verification, exemplars, publish.
5. `eval` — flash answer/judge loop, rollback only if the full eval regresses vs baseline.

`distill-auto` uses two drivers:

- self-fetch chain for map/group/final/finalize and the first eval step;
- per-minute cron for long eval sequences.

### Weekly update

`runWeeklyPersonaRefresh()`:

1. Writes a weekly stance chunk when enough new tweets exist.
2. Runs `distillPersonaIncremental()` if `persona_facts:merged` exists.
3. Runs 12-case smoke eval.
4. If smoke is suspicious, enqueues full eval via `distill_job:<kol>`.

### Cost controls now live

- GetXAPI only fetches canonical corpora (`corpus_id IS NULL OR ''`).
- Eval reserves cases before model calls, preventing duplicate scoring during cron/self-chain overlap.
- Voice and stance judges are batched six answers per flash call.
- Weekly smoke eval avoids full eval unless suspicious.
- Dynamic chunk sizing avoids 32-map-call backfills for small KOLs:
  - <=150 tweets or <80k chars: 1 chunk
  - <=1000 tweets or <350k chars: 2-8 chunks
  - <=6000 tweets: 8-24 chunks
  - >6000 tweets: up to 32 chunks

## Recent Changelog

- 2026-06-19:
  - Migrated `aleabitoreddit` to full-corpus map-reduce.
  - Validated the new `aleabitoreddit` map-reduce persona against the previous pack; the new pack won on
    composite eval (`0.571` vs `0.338` in the baseline comparison).
  - Removed the old tagged retrieval A/B persona from frontend, D1, and docs.
  - Added eval case reservation, batch judges, weekly smoke eval, and dynamic chunk sizing.
  - Removed tracked local raw tweet JSON, old hand-written persona files, and old one-off import scripts.
- 2026-06-18:
  - Built the automated `distill-auto` orchestrator.
  - Reconciled `qinbafrank` to `v2-mapreduce-2026-06-18`.
  - Added `persona_facts`, eval tables, and rollback audit logs.
- 2026-06-17:
  - Fixed chat system prompt to keep first-person KOL voice.
  - Added richer live market data and tool phase improvements.

## Known Constraints

- Cloudflare Worker execution is still the main design constraint. Long pro calls and full eval runs must
  stay staged and resumable.
- Eval scores are regression signals, not absolute truth. Voice/stance are LLM-judge metrics; citation is
  the hard verifiable metric.
- GetXAPI timeline depth is finite. Older missing quoted context may need a paid deeper scrape later.
- `account.guard.json` contains live secrets locally and must never be committed. Keys exposed in early
  history should be rotated.

## Next Work

1. Improve eval quality:
   - Add pairwise old-vs-new comparison mode.
   - Judge citation relevance, not just citation validity.
   - Add real user questions to eval sets.
2. Improve answer quality:
   - Add a few voice examples from `signature_examples` into the system prompt.
   - Separate historical KOL stance, live market data, and model inference more explicitly in answers.
3. Product roadmap:
   - Self-serve KOL onboarding and pricing.
   - KOL dashboard for usage/revenue share.
   - Better observability UI for distill/eval jobs.
