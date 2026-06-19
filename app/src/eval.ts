// Persona eval + auto-rollback harness (Phase 2).
//
// Goal: detect when a persona pack regresses (after a fresh generate, a weekly evolve, or a model
// upgrade) and, if so, automatically restore the last-known-good pack — no human in the loop.
//
// Design notes:
// - Eval cases are MINED, not hand-labeled: real follower-style Q&A is synthesized from the KOL's own
//   substantive tweets (so the "ground truth" voice/stance is the KOL's actual post), plus a handful of
//   generic follower questions. See buildEvalSet.
// - Three scores per case: citation accuracy (HARD, verifiable), voice fidelity (LLM-judge, RELATIVE
//   only), stance consistency (LLM-judge, RELATIVE only). Per Second-Me §3.6 the LLM judge
//   underestimates absolute fidelity, so voice/stance drive *regression* detection vs the prior persona
//   version, never an absolute gate. Citation accuracy is the one absolute signal.
// - Everything is bounded (case count capped per run) so it fits a Worker invocation.
import type { Env, KolRow } from "./env";
import { completeChat, buildMessages, type MarketData } from "./chat";
import { retrieve } from "./rag";
import { logPersonaExperiment } from "./persona-gen";

// Eval responses are about voice/citation/stance, not live prices — no market data is fetched.
const EMPTY_MARKET: MarketData = { quotes: [], benchmarks: [], klineText: "", primary: null, news: [], extraContext: "" };

// Match the citation syntax used in chat (index.ts:497): [T1] / 【T1】, tolerant of inner spaces.
const CITE_RE = /(?:\[|【)\s*(T\d+)\s*(?:\]|】)/g;

// Composite passing thresholds. Citation is the absolute gate; voice/stance are loose floors.
const TH_CITATION = 0.7;
const TH_VOICE = 0.5;
const TH_STANCE = 0.5;
// A run is flagged regressed if its composite drops more than this below the previous version's.
const REGRESSION_MARGIN = 0.1;

// ---------- Small helpers ----------

function safeJsonArray(raw: string): any[] {
  const cleaned = raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
  try {
    const v = JSON.parse(cleaned);
    return Array.isArray(v) ? v : [];
  } catch {
    const m = cleaned.match(/\[[\s\S]*\]/);
    if (m) { try { return JSON.parse(m[0]); } catch {} }
    return [];
  }
}

// Pull a 0..1 number out of a judge response that should be just a float.
function parseScore(raw: string): number | null {
  const m = (raw || "").match(/(?:0?\.\d+|[01](?:\.0+)?)/);
  if (!m) return null;
  const n = parseFloat(m[0]);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null;
}

function parseScoreObject(raw: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const o of safeJsonArray(raw)) {
    const id = String(o?.id || "").trim();
    const score = typeof o?.score === "number" ? o.score : parseScore(String(o?.score ?? ""));
    if (id && score !== null) out[id] = score;
  }
  return out;
}

// Extract the "## Expression DNA" block from a persona pack (the voice fingerprint the judge scores against).
function extractExpressionDna(pack: string): string {
  const m = pack.match(/##\s*Expression DNA[\s\S]*?(?=\n##\s|\n*$)/i);
  return (m ? m[0] : pack.slice(0, 1200)).trim();
}

interface EvalDraft {
  ec: any;
  response: string;
  scoreCitation: number;
}

async function judgeVoiceBatch(env: Env, dna: string, drafts: EvalDraft[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const BATCH = 6;
  for (let i = 0; i < drafts.length; i += BATCH) {
    const batch = drafts.slice(i, i + BATCH);
    const raw = await completeChat(env, env.MODEL_FLASH, [
      {
        role: "system",
        content:
          `You judge whether replies match a finance KOL's documented voice. Given the Expression DNA and ` +
          `several replies, output ONLY a JSON array: [{"id":"...","score":0.0}]. Score 0..1 = average ` +
          `agreement across sentence style, vocabulary, humor, certainty, opening pattern. No commentary.`,
      },
      {
        role: "user",
        content:
          `Expression DNA:\n${dna}\n\nReplies:\n` +
          batch.map((d) => `ID: ${d.ec.id}\n${d.response.slice(0, 1500)}`).join("\n\n---\n\n"),
      },
    ], { maxTokens: Math.max(120, batch.length * 32), temperature: 0 });
    const parsed = parseScoreObject(raw);
    for (const d of batch) out[d.ec.id] = parsed[d.ec.id] ?? 0;
  }
  return out;
}

async function judgeStanceBatch(env: Env, drafts: EvalDraft[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const withStance = drafts.filter((d) => d.ec.expected_stance);
  const BATCH = 6;
  for (let i = 0; i < withStance.length; i += BATCH) {
    const batch = withStance.slice(i, i + BATCH);
    const raw = await completeChat(env, env.MODEL_FLASH, [
      {
        role: "system",
        content:
          `Output ONLY a JSON array: [{"id":"...","score":0.0}]. For each item, score 0..1: how well ` +
          `does the reply's directional stance agree with EXPECTED? 1=same direction & subject, 0=opposite. No commentary.`,
      },
      {
        role: "user",
        content: batch.map((d) =>
          `ID: ${d.ec.id}\nEXPECTED: ${d.ec.expected_stance}\nREPLY:\n${d.response.slice(0, 1200)}`
        ).join("\n\n---\n\n"),
      },
    ], { maxTokens: Math.max(120, batch.length * 32), temperature: 0 });
    const parsed = parseScoreObject(raw);
    for (const d of batch) out[d.ec.id] = parsed[d.ec.id] ?? 0;
  }
  return out;
}

// ---------- buildEvalSet: mine a golden set from the KOL's own corpus ----------

export async function buildEvalSet(
  env: Env,
  kolId: string,
  opts: { realQa?: number; synth?: number } = {},
): Promise<{ built: number; real_qa: number; synth_follower: number }> {
  const realTarget = opts.realQa ?? 24;
  const synthTarget = opts.synth ?? 14;

  const kol = await env.DB.prepare(`SELECT id,display_name,handle,tagline,persona_pack FROM kols WHERE id=?`)
    .bind(kolId).first<KolRow>();
  if (!kol) throw new Error(`KOL not found: ${kolId}`);

  // Substantive tweets only: skip short quips / pure links. Favor engagement (those are the takes
  // followers actually reacted to) — exactly the kind of question we want the replica to handle.
  const r = await env.DB.prepare(
    `SELECT id, text FROM tweets
     WHERE kol_id=? AND is_retweet=0 AND length(text)>=80
     ORDER BY (likes + retweets * 2) DESC LIMIT ?`
  ).bind(kolId, realTarget * 2).all();
  const tweets = ((r.results || []) as any[]).slice(0, realTarget * 2);
  if (tweets.length < 5) throw new Error(`Not enough substantive tweets (${tweets.length}) for ${kolId}`);

  // Rebuild idempotently — an eval set should reflect the current corpus.
  await env.DB.prepare(`DELETE FROM eval_cases WHERE kol_id=?`).bind(kolId).run();

  const cases: Array<{
    question: string; type: string; stance: string | null; sourceId: string | null;
  }> = [];

  // --- Real Q&A: for a batch of tweets, derive the follower question each post answers + its stance. ---
  const batchSize = 12;
  for (let i = 0; i < tweets.length && cases.length < realTarget; i += batchSize) {
    const batch = tweets.slice(i, i + batchSize);
    const numbered = batch.map((t, j) => `[${j + 1}] ${String(t.text).slice(0, 400)}`).join("\n\n");
    const out = await completeChat(env, env.MODEL_FLASH, [
      {
        role: "system",
        content:
          `For each numbered tweet from a finance KOL, infer the concrete follower QUESTION that tweet is answering, ` +
          `and the KOL's STANCE in it. Output ONLY a JSON array; one object per input number: ` +
          `[{"n":1,"question":"...","stance":"bullish on X | bearish on X | neutral | n/a"}]. ` +
          `The question must be answerable from the tweet alone, in the tweet's own language. No commentary.`,
      },
      { role: "user", content: numbered },
    ], { maxTokens: 1400, temperature: 0.2 });
    for (const o of safeJsonArray(out)) {
      const idx = (parseInt(o?.n, 10) || 0) - 1;
      const src = batch[idx];
      const q = String(o?.question || "").trim();
      if (!src || q.length < 6) continue;
      const stance = String(o?.stance || "").trim();
      cases.push({
        question: q, type: "real_qa", sourceId: String(src.id),
        stance: stance && !/^n\/?a$/i.test(stance) ? stance : null,
      });
      if (cases.length >= realTarget) break;
    }
  }

  // --- Synthetic follower questions: generic, sector-flavored "what do you think of X?" probes. ---
  const synthOut = await completeChat(env, env.MODEL_FLASH, [
    {
      role: "system",
      content:
        `Generate ${synthTarget} short follower questions a real follower would ask this finance KOL ` +
        `(mix of "你怎么看X？", "X还能买吗？", "现在该减仓吗？" styles, in the KOL's primary language). ` +
        `Base them on the KOL's actual focus areas. Output ONLY a JSON array of strings.`,
    },
    {
      role: "user",
      content: `KOL: ${kol.display_name} (@${kol.handle})${kol.tagline ? ` — ${kol.tagline}` : ""}\n` +
        `Persona excerpt:\n${(kol.persona_pack || "").slice(0, 1500)}`,
    },
  ], { maxTokens: 800, temperature: 0.6 });
  for (const q of safeJsonArray(synthOut)) {
    const s = String(q || "").trim();
    if (s.length >= 4) cases.push({ question: s, type: "synth_follower", stance: null, sourceId: null });
  }

  // Persist.
  let n = 0;
  for (const c of cases) {
    const id = `${kolId}:${n}`;
    await env.DB.prepare(
      `INSERT OR REPLACE INTO eval_cases (id,kol_id,question,ground_truth_type,expected_stance,source_tweet_id)
       VALUES (?,?,?,?,?,?)`
    ).bind(id, kolId, c.question, c.type, c.stance, c.sourceId).run();
    n++;
  }
  const realCount = cases.filter((c) => c.type === "real_qa").length;
  return { built: n, real_qa: realCount, synth_follower: n - realCount };
}

// ---------- runEval: score the current persona against the golden set ----------

interface EvalSummary {
  kol_id: string;
  persona_version: string;
  model_version: string;
  cases: number;
  avg_citation: number;
  avg_voice: number;
  avg_stance: number | null;
  passed: number;        // # of cases that passed all thresholds
  composite: number;     // run-level composite (mean of available metrics)
  baseline_composite: number | null;
  regressed: boolean;
  processed: number;     // cases scored in THIS call
  remaining: number;     // cases still un-scored for this version (0 = complete)
}

export async function runEval(
  env: Env,
  kolId: string,
  opts: { limit?: number } = {},
): Promise<EvalSummary> {
  const limit = Math.min(opts.limit ?? 12, 40);
  const kol = await env.DB.prepare(`SELECT * FROM kols WHERE id=?`).bind(kolId).first<KolRow>();
  if (!kol) throw new Error(`KOL not found: ${kolId}`);
  if (!kol.persona_pack) throw new Error(`No persona_pack for ${kolId} — nothing to eval`);

  const personaVersion = kol.persona_version || "unknown";
  // Generate eval responses with flash — it is the production chat default AND fast enough that a batch
  // of cases fits the worker's ~100s execution limit (pro would blow it on the first few cases).
  const modelVersion = env.MODEL_FLASH;
  const dna = extractExpressionDna(kol.persona_pack);
  const mode = (kol.retrieval_mode === "tagged" ? "tagged" : "query_side") as "tagged" | "query_side";
  const scope = kol.corpus_id || kol.id;

  // Resumable: only score cases that don't yet have a result for THIS persona_version, up to `limit` per
  // call. A driver calls repeatedly until remaining===0. (One synchronous full run would time out.)
  const allCases = ((await env.DB.prepare(
    `SELECT id, question, expected_stance FROM eval_cases WHERE kol_id=? ORDER BY id`
  ).bind(kolId).all()).results || []) as any[];
  if (!allCases.length) throw new Error(`No eval_cases for ${kolId} — run buildEvalSet first`);

  // Concurrent drivers can overlap (self-chain + cron). Reserve cases before spending model calls so
  // only one invocation scores a given case. If a Worker dies mid-case, the null-score reservation is
  // released after 30 minutes.
  await env.DB.prepare(
    `DELETE FROM eval_results
     WHERE kol_id=? AND persona_version=? AND score_citation IS NULL
       AND datetime(created_at) < datetime('now','-30 minutes')`
  ).bind(kolId, personaVersion).run();
  const occupiedRows = ((await env.DB.prepare(
    `SELECT DISTINCT case_id FROM eval_results WHERE kol_id=? AND persona_version=?`
  ).bind(kolId, personaVersion).all()).results || []) as any[];
  const occupied = new Set(occupiedRows.map((r) => r.case_id));
  const candidates = allCases.filter((c) => !occupied.has(c.id)).slice(0, limit);
  const cases: any[] = [];
  for (const ec of candidates) {
    const resultId = `${kolId}:${personaVersion}:${modelVersion}:${ec.id}`;
    const claimed = await env.DB.prepare(
      `INSERT OR IGNORE INTO eval_results
       (id,kol_id,case_id,persona_version,model_version,regressed)
       VALUES (?,?,?,?,?,0)`
    ).bind(resultId, kolId, ec.id, personaVersion, modelVersion).run();
    if (claimed.meta.changes) cases.push(ec);
  }

  let sumCite = 0, sumVoice = 0, sumStance = 0, stanceN = 0, passedN = 0;
  const drafts: EvalDraft[] = [];

  for (const ec of cases) {
    const question = String(ec.question);
    // Generate a persona answer the same way production chat does (persona + retrieved SOURCE TWEETS),
    // minus live market data.
    const { citations, knowledge } = await retrieve(
      env, kolId, kol.handle, question, [], undefined, env.MODEL_FLASH, mode, scope,
    );
    const messages = buildMessages({
      kol, persona: kol.persona_pack, knowledge, citations,
      market: EMPTY_MARKET, history: [], userMessage: question,
    });
    const response = await completeChat(env, modelVersion, messages, { maxTokens: 700, temperature: 0.3 });

    // 1) Citation accuracy — fraction of cited [T#] that resolve to a retrieved source tweet.
    const validRefs = new Set(citations.map((c) => c.ref));
    const cited = new Set(Array.from(response.matchAll(CITE_RE)).map((m) => m[1]));
    const scoreCitation = cited.size === 0
      ? (validRefs.size === 0 ? 1 : 0)               // nothing to cite → fine; sources existed but none cited → 0
      : Array.from(cited).filter((r) => validRefs.has(r)).length / cited.size;

    drafts.push({ ec, response, scoreCitation });
  }

  const voiceScores = await judgeVoiceBatch(env, dna, drafts);
  const stanceScores = await judgeStanceBatch(env, drafts);

  for (const d of drafts) {
    const ec = d.ec;
    const scoreCitation = d.scoreCitation;
    const scoreVoice = voiceScores[ec.id] ?? 0;
    const scoreStance = ec.expected_stance ? (stanceScores[ec.id] ?? 0) : null;

    sumCite += scoreCitation;
    sumVoice += scoreVoice;
    if (scoreStance !== null) { sumStance += scoreStance; stanceN++; }

    const passed = scoreCitation >= TH_CITATION && scoreVoice >= TH_VOICE &&
      (scoreStance === null || scoreStance >= TH_STANCE);
    if (passed) passedN++;

    await env.DB.prepare(
      `UPDATE eval_results
       SET score_citation=?, score_voice=?, score_stance=?, passed=?, regressed=0
       WHERE id=?`
    ).bind(
      scoreCitation, scoreVoice, scoreStance, passed ? 1 : 0,
      `${kolId}:${personaVersion}:${modelVersion}:${ec.id}`,
    ).run();
  }

  // Aggregate over ALL results for this version so far (the run may be spread across several batches).
  const agg = await env.DB.prepare(
    `SELECT AVG(score_citation) c, AVG(score_voice) v, AVG(score_stance) s, SUM(passed) p, COUNT(*) n
     FROM eval_results WHERE kol_id=? AND persona_version=? AND score_citation IS NOT NULL`
  ).bind(kolId, personaVersion).first<any>();
  const n = agg?.n || cases.length;
  const avgCite = agg?.c ?? 0;
  const avgVoice = agg?.v ?? 0;
  const avgStance = agg?.s ?? null;
  passedN = agg?.p ?? passedN;
  // Run composite = mean of the metrics we actually have.
  const parts = [avgCite, avgVoice, ...(avgStance !== null ? [avgStance] : [])];
  const composite = parts.reduce((a, b) => a + b, 0) / parts.length;

  // Baseline = the mean composite of the most recent eval run for a DIFFERENT persona_version. This is
  // the meaningful regression question: did the *new* pack get worse than the *previous* pack?
  const base = await env.DB.prepare(
    `SELECT AVG(score_citation) c, AVG(score_voice) v, AVG(score_stance) s
     FROM eval_results
     WHERE kol_id=? AND persona_version <> ?
       AND score_citation IS NOT NULL
       AND persona_version = (
         SELECT persona_version FROM eval_results
         WHERE kol_id=? AND persona_version <> ? AND score_citation IS NOT NULL
         ORDER BY created_at DESC LIMIT 1
       )`
  ).bind(kolId, personaVersion, kolId, personaVersion).first<any>();
  let baselineComposite: number | null = null;
  if (base && base.c !== null) {
    const bp = [base.c, base.v, ...(base.s !== null ? [base.s] : [])].filter((x) => x !== null);
    baselineComposite = bp.length ? bp.reduce((a: number, b: number) => a + b, 0) / bp.length : null;
  }
  // Only judge regression once the full set is scored (remaining===0); a partial run isn't comparable.
  const remaining = Math.max(0, allCases.length - n);
  const regressed = remaining === 0 && baselineComposite !== null && composite < baselineComposite - REGRESSION_MARGIN;

  if (regressed) {
    await env.DB.prepare(
      `UPDATE eval_results SET regressed=1 WHERE kol_id=? AND persona_version=?`
    ).bind(kolId, personaVersion).run();
  }

  return {
    kol_id: kolId, persona_version: personaVersion, model_version: modelVersion,
    cases: n, avg_citation: avgCite, avg_voice: avgVoice, avg_stance: avgStance,
    passed: passedN, composite, baseline_composite: baselineComposite, regressed,
    processed: cases.length, remaining,
  };
}

// ---------- autoRollback: restore the last known-good pack ----------

export async function autoRollback(
  env: Env,
  kolId: string,
  reason = "regression detected in eval",
): Promise<{ rolled_back: boolean; restored_from?: string; restored_len?: number; note: string }> {
  const kol = await env.DB.prepare(`SELECT persona_pack, persona_version FROM kols WHERE id=?`)
    .bind(kolId).first<any>();
  if (!kol) return { rolled_back: false, note: `KOL not found: ${kolId}` };

  // Most recent backup/snapshot. knowledge_chunks has no timestamp column, but rowid is insertion
  // order, and persona_backup ids carry a Date.now() suffix — rowid DESC = newest good pack.
  const backup = await env.DB.prepare(
    `SELECT id, source, text FROM knowledge_chunks
     WHERE kol_id=? AND (source LIKE 'persona_backup:%' OR source LIKE 'persona_snapshot:%')
     ORDER BY rowid DESC LIMIT 1`
  ).bind(kolId).first<any>();

  if (!backup || !backup.text || backup.text.length < 100) {
    const note = `no usable backup to roll back to (${reason})`;
    await logPersonaExperiment(env, kolId, {
      content: "", finish_reason: "no_backup", content_len: 0, duration_ms: 0,
      parse_ok: false, error_type: null, note,
    }, 0, "auto_rollback");
    return { rolled_back: false, note };
  }

  // Snapshot the (regressing) current pack first so the rollback is itself reversible.
  if (kol.persona_pack && kol.persona_pack.length > 100) {
    const preId = `${kolId}:persona_backup:${new Date().toISOString().slice(0, 10)}:${Date.now()}`;
    await env.DB.prepare(
      `INSERT OR REPLACE INTO knowledge_chunks (id,kol_id,source,title,text) VALUES (?,?,?,?,?)`
    ).bind(preId, kolId, `persona_backup:${kol.persona_version || "pre-rollback"}`, `Persona backup (pre-rollback) ${new Date().toISOString().slice(0, 10)}`, kol.persona_pack).run();
  }

  const newVersion = `rollback-${new Date().toISOString().slice(0, 10)}`;
  await env.DB.prepare(`UPDATE kols SET persona_pack=?, persona_version=?, updated_at=datetime('now') WHERE id=?`)
    .bind(backup.text, newVersion, kolId).run();

  const note = `${reason}; rolled back to ${backup.source} (len=${backup.text.length})`;
  await logPersonaExperiment(env, kolId, {
    content: "", finish_reason: "rolled_back", content_len: backup.text.length, duration_ms: 0,
    parse_ok: true, error_type: null, note,
  }, 0, "auto_rollback");

  return { rolled_back: true, restored_from: backup.source, restored_len: backup.text.length, note };
}

// ---------- Orchestration: eval, and self-heal if regressed ----------
// The single entry point used by the persona-generate endpoint and the weekly cron. It is a no-op for
// KOLs without a golden set (eval is opt-in via buildEvalSet), and only rolls back when this run is
// measurably worse than the PREVIOUS persona version's baseline — so a first-ever eval never triggers
// a rollback (no baseline to regress against).
export async function evalAndMaybeRollback(
  env: Env,
  kolId: string,
  opts: { limit?: number; smoke?: boolean; smokeRegressionMargin?: number; smokeMinCitation?: number } = {},
): Promise<{ skipped: boolean; reason?: string; summary?: EvalSummary; rolled_back?: boolean; smoke_suspicious?: boolean }> {
  const cnt = await env.DB.prepare(`SELECT COUNT(*) AS c FROM eval_cases WHERE kol_id=?`)
    .bind(kolId).first<{ c: number }>();
  if (!cnt || cnt.c === 0) return { skipped: true, reason: "no eval set (run buildEvalSet first)" };

  const summary = await runEval(env, kolId, opts);
  if (opts.smoke && summary.remaining > 0) {
    const margin = opts.smokeRegressionMargin ?? 0.06;
    const minCitation = opts.smokeMinCitation ?? 0.55;
    const suspicious =
      (summary.baseline_composite !== null && summary.composite < summary.baseline_composite - margin) ||
      summary.avg_citation < minCitation;
    await logPersonaExperiment(env, kolId, {
      content: "", finish_reason: "smoke", content_len: 0, duration_ms: 0,
      parse_ok: true, error_type: null,
      note: `smoke eval: composite=${summary.composite.toFixed(3)} baseline=${summary.baseline_composite?.toFixed(3) ?? "none"} citation=${summary.avg_citation.toFixed(3)} rem=${summary.remaining} suspicious=${suspicious}`,
    }, 0, "eval_smoke");
    return { skipped: false, summary, rolled_back: false, smoke_suspicious: suspicious };
  }
  if (!summary.regressed) return { skipped: false, summary, rolled_back: false };

  const rb = await autoRollback(
    env, kolId,
    `eval regression: composite ${summary.composite.toFixed(3)} < baseline ${summary.baseline_composite?.toFixed(3)}`,
  );
  return { skipped: false, summary, rolled_back: rb.rolled_back };
}
