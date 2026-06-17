# Robindex Handoff: Persona Stability + Eval/Auto-Rollback System

> **Context**: This is a Cloudflare-native AI KOL replica system. A persona pack (structured markdown) is distilled from a KOL's tweets via a single LLM call, then injected every chat turn as the system prompt. The system uses **zero fine-tuning, zero embeddings** — everything is prompt + sparse retrieval.

> **Your job**: Finish implementing the persona stability fixes + eval/auto-rollback system. All changes are local (not yet committed). Three files are already modified, one new migration file was created. You need to verify them, finish the remaining work, and run the build check.

---

## 1. Project Quick Reference

- **Monorepo root**: `/Users/aaron/Desktop/aaron/robindex`
- **App dir**: `app/` (Hono Worker, TypeScript, no build step)
- **Build check**: `cd app && npx tsc --noEmit && npm run test:dsl`
- **Deploy**: `cd app && npx wrangler deploy` (or `deploy:cf` for Cloudflare DNS)
- **DB**: D1 `robindex-db`, schema in `app/schema.sql`, migrations in `app/migrations/`
- **LLM**: All calls go through Cloudflare AI Gateway → OpenRouter → `deepseek/deepseek-v4-pro` (MODEL_PRO) / `deepseek/deepseek-v4-flash` (MODEL_FLASH)
- **Key files**:
  - `app/src/index.ts` — routes, chat SSE, admin APIs, cron
  - `app/src/persona-gen.ts` — persona distillation / evolution / **new: diagnose**
  - `app/src/chat.ts` — prompt assembly, `completeChat()`, `streamChat()`
  - `app/src/rag.ts` — FTS5 retrieval + LLM rerank
  - `app/src/query-plan.ts` — bilingual query planning
  - `app/src/ingest.ts` — daily ingest + weekly persona refresh
  - `app/wrangler.jsonc` — bindings (GATEWAY_URL, MODEL_FLASH, MODEL_PRO, etc.)
- **Environment secrets** (gitignored): `CFGATEWAYKEY`, `GETXAPI_KEY`, `ADMIN_KEY`, `OPENROUTER_KEY` in `account.guard.json`
- **Admin auth**: header `x-admin-key: $ADMIN_KEY`

---

## 2. What Was Done (Already Modified, Needs Verification)

### `app/migrations/0006_persona_experiments.sql` (NEW file)
Created migration for three new D1 tables:
- **`persona_experiments`** — one row per persona-gen LLM call (finish_reason, content_len, duration_ms, parse_ok, error_type, trigger). Replaces reliance on 1-hour-TTL KV `persona_debug:*` keys.
- **`eval_cases`** — golden eval set per KOL (questions + ground truth, for Phase 2)
- **`eval_results`** — one row per eval run (scores + regression flag, for Phase 2 auto-rollback)

### `app/schema.sql` (MODIFIED)
Added the same three tables to the idempotent master schema (append after the FTS5 virtual table). This is consistent with the existing pattern.

### `app/src/persona-gen.ts` (MAJOR REWRITE — core of Phase 1)
**The old code** (lines 171-228) had a single inline fetch to deepseek-v4-pro with `max_tokens: 65536`, body-read-loop with flat 120s timeout, and a `finish_reason` that was detected but only written to KV debug logs — never used for decision-making. Failures silently fell through to `raw = ""`.

**The new code** introduces:

#### 2a. `PersonaGenError` class (line ~15)
Distinguishable error types: `"truncation" | "timeout" | "http_error" | "parse_error" | "empty"`. The retry layer branches on `e.kind` instead of guessing from error strings.

#### 2b. `PersonaGenAttempt` interface (line ~30)
Structured record of what each LLM call produced: `finish_reason`, `content_len`, `duration_ms`, `parse_ok`, `error_type`, `note`. This is the atomic unit logged to `persona_experiments`.

#### 2c. `logPersonaExperiment()` (line ~45)
Writes a `PersonaGenAttempt` to D1 `persona_experiments`. Falls back to KV if D1 write fails. This is the observability backbone — every production and diagnostic call is now auditable.

#### 2d. `callPersonaLLM()` (line ~70)
Extracted from the old inline fetch into a reusable function. Key changes:
- **Per-chunk timeout now scales with budget**: `Math.max(120000, Math.min(timeoutMs, maxTokens * 200))` instead of flat 120s. A 16k token request gets ~3.2min per chunk; a 64k request gets ~12.8min. This prevents mid-stream kills on large budgets.
- **`finish_reason: "length"` is now a hard error** (throws `PersonaGenError("truncation", ...)` instead of silently returning truncated content). This is the core fix — on reasoning models like deepseek-v4-pro, CoT tokens share the `max_tokens` budget with output. If CoT is too long, the JSON never gets emitted.
- **Empty content is a hard error** too.
- **All failures are logged** to KV + (optionally) D1 via `PersonaGenAttempt`.
- Accepts optional `systemPrompt` override — used by the retry path to swap in a CoT-suppressing prompt.

#### 2e. `DISTILL_SYSTEM_DIRECT` prompt (line ~220)
A new system prompt variant that explicitly suppresses chain-of-thought: "Do not think step by step; emit the JSON object directly." Used by the **retry path only** — the standard `DISTILL_SYSTEM` is unchanged for the first attempt.

#### 2f. `GEN_BUDGETS` retry ladder (line ~290)
```ts
const GEN_BUDGETS = [
  { maxTokens: 16384, systemPrompt: undefined, timeoutMs: 600000 },
  { maxTokens: 8192,  systemPrompt: DISTILL_SYSTEM_DIRECT, timeoutMs: 300000 },
];
```
- **First attempt**: 16k budget, standard prompt, 10min timeout. This is the production default — enough for the ~4-8k token persona JSON plus reasonable CoT.
- **Retry (on truncation/timeout/empty)**: drops to 8k budget AND switches to CoT-suppressing prompt. Smaller budget = less room for CoT to explode; direct prompt = shorter reasoning chain.
- Each attempt is logged to `persona_experiments` with `trigger='generate'`.
- If both fail, `generatePersonaPack` still returns a pack (built from `pj=null`), but `validation` array will contain `"FAIL: All 2 distillation attempts failed. Last error: ..."`. The existing `<500` length guard in `index.ts:847` will then prevent overwriting a good existing pack.

#### 2g. `diagnosePersonaGeneration()` (line ~268, exported)
A diagnostic function that probes multiple `max_tokens` budgets **without writing to kols**. Each probe logs to `persona_experiments` with `trigger='diagnose'`. Returns `{ probes: [...], best: number | null }` — the first budget that successfully parsed a usable persona. This drives data-driven budget decisions instead of guessing.

#### 2h. `buildCorpus()` and `buildDistillMessages()` (line ~255)
Extracted shared logic from `generatePersonaPack` so `diagnosePersonaGeneration` can reuse the exact same corpus/message assembly.

### `app/src/index.ts` (MODIFIED — 3 additions)

#### Import updated (line 10)
```ts
import { generatePersonaPack, evolvePersona, diagnosePersonaGeneration } from "./persona-gen";
```

#### New endpoint: `POST /api/admin/persona-diagnose` (after line 862)
- Admin-gated. Query: `?kol_id=X&budgets=8192,16384,32768` (defaults to `[8192, 16384, 32768]`)
- Calls `diagnosePersonaGeneration()`, returns probes + best budget
- **Does NOT modify kols table** — purely diagnostic

#### New endpoint: `GET /api/admin/persona-experiments` (after diagnose)
- Admin-gated. Query: `?kol_id=X&limit=50`
- Reads from `persona_experiments` table — shows the audit trail of all persona-gen attempts
- For post-mortems on failed onboarding or cron failures

---

## 3. What Remains To Be Done

### 3.1 (Immediate) Verify the existing changes compile

```bash
cd app && npx tsc --noEmit && npm run test:dsl
```

If `tsc` fails, the likely issues are:
- **`PersonaGenError` / `PersonaGenAttempt` / `logPersonaExperiment` are exported** but only used within persona-gen.ts and index.ts — if tsc complains about unused exports, that's fine (they'll be used by the eval module in Phase 2).
- The `callPersonaLLM` function has a subtle code-path issue: on the `finish_reason: "length"` and `empty content` branches at the bottom, a `PersonaGenError` is thrown **after** the `finally` block runs. The `attempt` variable in those throw lines references a local variable that may not be in scope in all paths. **Check this carefully** — the error is thrown, not the attempt variable, so it should be fine, but verify.

### 3.2 (Immediate) Apply the D1 migration

```bash
cd app && npx wrangler d1 execute robindex-db --remote --file=./migrations/0006_persona_experiments.sql
```

This creates the three new tables on the production D1 database. Without this, all `logPersonaExperiment` calls will silently fail (caught by the `try/catch` in `logPersonaExperiment`), and the diagnose/experiments endpoints will 500 on the D1 queries.

### 3.3 (High Priority) Fix `ingest.ts` — weekly persona refresh error observability

**File**: `app/src/ingest.ts`, lines 326-331.

**Current code** (the `evolvePersona` catch block inside `runWeeklyPersonaRefresh`):
```ts
try {
  const evo = await evolvePersona(env, k.id);
  console.log(`persona evolve ${k.id}: evolved=${evo.evolved} v=${evo.version} notes=${evo.notes.join("; ")} review=${evo.needs_review}`);
} catch (e) {
  console.log(`persona evolve ${k.id} error: ${e}`);
}
```

**Problem**: Errors are only `console.log`'d — they don't reach D1, so they're invisible after the Worker log rotates. The outer catch (line 337-338) has the same problem.

**Fix**: Import `logPersonaExperiment` from `./persona-gen` and, on error, write a row to `persona_experiments` with `trigger='evolve'` and the error details. Similarly for the outer catch (write with `trigger='cron'`).

Also, the outer catch (line 337-338) currently swallows errors for KOLs that don't have a `persona_pack` — that's fine, but mark it in the note so the experiment log distinguishes "no persona yet" from "actual failure".

### 3.4 (High Priority) Make DEFAULT_PERSONA fallback observable in chat

**File**: `app/src/index.ts`, line 372.

**Current code**:
```ts
persona: kol.persona_pack || DEFAULT_PERSONA(kol),
```

**Problem**: When persona generation fails and `persona_pack` is NULL, every chat reply silently uses a 3-line generic persona (`DEFAULT_PERSONA` defined at `index.ts:22-24`). There is no telemetry, no flag, no way to know a KOL is running on the fallback.

**Fix options** (pick one):
1. **Add a `persona_status` field to the response metadata** (e.g., in the initial SSE `meta` event or a new `event: persona_status`). When `!kol.persona_pack`, include `{ status: "fallback", kol_id: kol.id }`.
2. **Log to D1 when fallback is used** — write a row to `persona_experiments` with `trigger='chat_fallback'` so you can see how often and for which KOLs this happens.
3. **Both**.

Option 2 is simplest and most consistent with the new observability pattern. Don't over-engineer — a single D1 write on the first message of each conversation that detects fallback is enough.

### 3.5 (Medium Priority) Phase 2: Create `app/src/eval.ts`

This is the eval/auto-rollback skeleton. The D1 tables (`eval_cases`, `eval_results`) already exist from the migration. You need to create the file with three functions:

#### `buildEvalSet(env, kolId)` — populate `eval_cases` for a KOL
- Query the KOL's tweets for reply threads and Q&A patterns (tweets that start with "@handle" or are replies to questions)
- Extract the question (the parent tweet's text, if available, or synthesize from context)
- Store as `eval_cases` rows with `ground_truth_type='real_qa'`
- Also synthesize 10-20 follower-style questions ("你怎么看 X？", "X 还能买吗？") using flash, store as `ground_truth_type='synth_follower'`
- Target: 30-50 cases per KOL

#### `runEval(env, kolId)` — run the golden eval set against the current persona
- For each case in `eval_cases`, generate a chat response using the current persona pack (reuse `buildMessages` from `chat.ts` or call the `/api/chat` endpoint internally)
- Score each response on three metrics:
  1. **Citation accuracy** (`score_citation`): parse `[T#]` refs from the response, check if they resolve to real tweets in the KOL's corpus. The existing citation parsing logic in `index.ts:484-485` can be extracted/reused.
  2. **Voice fidelity** (`score_voice`): use flash as an LLM judge — give it the Expression DNA from the persona pack and the generated response, ask it to rate 0-1 agreement on each DNA dimension. Average across dimensions. **Note**: Second-Me's paper (§3.6) warns that LLM-as-judge systematically underestimates fidelity — so use this for *relative* regression detection only, never as an absolute quality gate.
  3. **Stance consistency** (`score_stance`): compare the response's directional stance (bullish/bearish/neutral on X) against `expected_stance` in the eval case. If no expected_stance, skip.
- Write results to `eval_results` with the current `persona_version` and `MODEL_PRO` value
- Set `passed=1` if all three scores ≥ threshold (e.g., citation ≥ 0.7, voice ≥ 0.5, stance ≥ 0.5)
- Set `regressed=1` if this run's scores are significantly worse than the baseline (last `passed=1` run for this KOL)

#### `autoRollback(env, kolId)` — triggered when regression detected
- Query the most recent backup in `knowledge_chunks` where `source LIKE 'persona_backup:%'` or `source LIKE 'persona_snapshot:%'`
- Restore that pack to `kols.persona_pack`
- Log the rollback to `persona_experiments` with `trigger='auto_rollback'` and `note='regression detected in eval, rolled back to backup'`
- This is the **automated** self-healing the user explicitly requested — no human in the loop

#### Wire it up:
- Add `POST /api/admin/eval-build?kol_id=X` and `POST /api/admin/eval-run?kol_id=X` endpoints in `index.ts`
- Add eval trigger to the weekly cron: after `runWeeklyPersonaRefresh`, if persona evolved, run `runEval` and call `autoRollback` if regressed
- Add eval trigger to `persona-generate` endpoint: after a new pack is written, run `runEval` and auto-rollback if regressed

### 3.6 (Lower Priority, Post-Phase 2) Future directions documented but NOT to implement now

These were discussed and agreed upon but are out of scope for this handoff:
- **Phase 3: DSPy/GEPA-style eval-driven prompt optimization** — automatically iterate `DISTILL_SYSTEM` and retrieval rerank prompts based on eval feedback. Gate this behind Phase 2 eval stability (must have passing baseline before auto-optimizing prompts).
- **Multi-tier synthesis for knowledge_chunks** — use Second-Me-style Weak/Strong-CoT multi-tier QA synthesis to expand knowledge coverage beyond what the KOL explicitly tweeted. Must keep `[T#]` citations strictly to real tweets.
- **Entity-relation graph retrieval route** — a non-embedding lightweight entity co-occurrence graph as an additional FTS5-parallel retrieval path for multi-hop reasoning questions ("how does X connect to Y to Z").

---

## 4. How to Verify Everything Works

### Step 1: Build check
```bash
cd app && npx tsc --noEmit && npm run test:dsl
```

### Step 2: Apply migration
```bash
cd app && npx wrangler d1 execute robindex-db --remote --file=./migrations/0006_persona_experiments.sql
```

### Step 3: Run the diagnose endpoint (this makes real LLM calls, ~$0.01-0.05)
```bash
curl -X POST "https://robindex.ai/api/admin/persona-diagnose?kol_id=qinbafrank&budgets=8192,16384,32768" \
  -H "x-admin-key: $ADMIN_KEY"
```
Expected: returns `{ ok: true, probes: [...], best_budget: <number> }`. Each probe shows `finish_reason`, `content_len`, `parse_ok`. A successful probe has `finish_reason: "stop"` and `parse_ok: true`.

### Step 4: Check experiments table
```bash
curl "https://robindex.ai/api/admin/persona-experiments?kol_id=qinbafrank" \
  -H "x-admin-key: $ADMIN_KEY"
```
Expected: returns the rows just logged by diagnose.

### Step 5: Trigger persona generation and verify it uses the new retry path
```bash
curl -X POST "https://robindex.ai/api/persona-generate?kol_id=qinbafrank" \
  -H "x-admin-key: $ADMIN_KEY"
```
Expected: if the first attempt (16k budget) succeeds, returns `{ ok: true, validation: [...PASS/WARN...], pack_length: <number> }`. If it fails, the retry (8k + direct prompt) kicks in automatically. Check `persona_experiments` table afterward — you should see one or two rows with `trigger='generate'`.

### Step 6 (Phase 2): Build and run eval set
```bash
curl -X POST "https://robindex.ai/api/admin/eval-build?kol_id=qinbafrank" -H "x-admin-key: $ADMIN_KEY"
curl -X POST "https://robindex.ai/api/admin/eval-run?kol_id=qinbafrank" -H "x-admin-key: $ADMIN_KEY"
```

---

## 5. Key Design Decisions (Why The Code Looks Like This)

| Decision | Why |
|---|---|
| **No fine-tuning (zero-shot harness)** | User's explicit requirement. Ride model upgrades for free. Quality improves as deepseek/gpt improve. |
| **max_tokens: 16384 (not 384000)** | deepseek-v4-pro max output is 384k, but it's a reasoning model — CoT tokens share the budget. 384k would let CoT explode and timeout. 16k is enough for ~4-8k persona JSON + reasonable CoT. The retry drops to 8k with CoT suppression. |
| **FTS5 over embeddings** | Existing architecture decision (migration `0002_remove_embeddings`). Short, jargon-dense, bilingual finance text retrieves better with full-text + LLM expansion than with embeddings. |
| **finish_reason as hard error** | Old code detected it but only logged to KV — the truncated content was passed through to JSON.parse, which failed silently. Now it's a typed error that drives retry logic. |
| **Per-chunk timeout scales with budget** | Old code had flat 120s per body chunk. At 65k tokens × ~33 token/s, generation takes ~33 minutes — way over 120s. The new formula `Math.max(120s, min(timeout, maxTokens × 200ms))` gives proportional headroom. |
| **LLM-as-judge only for relative regression** | Second-Me paper (§3.6) shows LLM-judge underestimates absolute fidelity. So voice/stance scores are only compared against prior runs (regression detection), never used as absolute quality gates. Citation accuracy (hard, verifiable) is the absolute gate. |
| **Auto-rollback, not auto-prompt-edit** | User wants automation, not manual review. But editing prompts automatically (DSPy-style) is too risky without a stable eval baseline. Phase 2 builds the baseline; Phase 3 (future) adds prompt optimization gated on eval stability. |

---

## 6. Git State

```
On branch main (clean working tree at start of session)

Current uncommitted changes:
  M app/schema.sql         (+48 lines — 3 new tables)
  M app/src/index.ts       (+35 lines — diagnose endpoint, experiments endpoint, updated import)
  M app/src/persona-gen.ts (+369/-76 lines — major rewrite: PersonaGenError, PersonaGenAttempt,
                              logPersonaExperiment, callPersonaLLM, diagnosePersonaGeneration,
                              DISTILL_SYSTEM_DIRECT, GEN_BUDGETS retry ladder, extracted helpers)
  ?? app/migrations/0006_persona_experiments.sql (new file)
```

**Do NOT commit yet** — first run `tsc --noEmit` to verify, then deploy-test, then commit.
