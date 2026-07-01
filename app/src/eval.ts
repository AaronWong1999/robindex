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

// Chat presents pure numeric [1] while prompt sources use [T1]. Accept both and normalize to T refs.
const CITE_RE = /(?:\[|【)\s*T?(\d+)\s*(?:\]|】)/gi;

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

function parseKeyedScores(raw: string, ids: string[]): Record<string, number> {
  let value: any = {};
  try {
    value = JSON.parse(raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim());
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) { try { value = JSON.parse(match[0]); } catch {} }
    if (!value || !Object.keys(value).length) {
      const arrayMatch = raw.match(/\[[\s\S]*\]/);
      if (arrayMatch) { try { value = JSON.parse(arrayMatch[0]); } catch {} }
    }
  }
  const rows = Array.isArray(value) ? value : (Array.isArray(value?.scores) ? value.scores : []);
  const rowMap = new Map(rows
    .filter((row: any) => row && typeof row === "object")
    .map((row: any) => [String(row?.id || "").trim(), row]));
  const obj = (!Array.isArray(value) && value && typeof value === "object") ? value : {};
  const scoreFrom = (candidate: any): number | null => {
    if (typeof candidate === "number") return Math.max(0, Math.min(1, candidate));
    if (typeof candidate === "string") return parseScore(candidate);
    if (!candidate || typeof candidate !== "object") return null;
    for (const key of ["score", "value", "voice", "voice_score", "stance", "stance_score"]) {
      const score = scoreFrom(candidate[key]);
      if (score !== null) return score;
    }
    for (const [key, nested] of Object.entries(candidate)) {
      if (key === "id" || key === "reason" || key === "comment") continue;
      const score = scoreFrom(nested);
      if (score !== null) return score;
    }
    return null;
  };
  const out: Record<string, number> = {};
  for (const [index, id] of ids.entries()) {
    const rawScore = rowMap.has(id) ? rowMap.get(id) :
      (Array.isArray(value) && typeof value[index] !== "object" ? value[index] :
      obj[id]);
    const score = scoreFrom(rawScore);
    out[id] = score === null ? 0 : score;
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
  citations?: any[];
}

async function completeJudge(
  env: Env,
  messages: { role: string; content: string }[],
  expectedIds: string[],
  maxTokens: number,
): Promise<string> {
  let raw = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    raw = await completeChat(env, env.MODEL_FLASH, messages, {
      maxTokens,
      temperature: 0,
      timeoutMs: 60000,
    });
    if (raw.trim() && expectedIds.some((id) => raw.includes(id))) return raw;
    if (attempt < 1) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return raw;
}

async function judgeCitationQualityBatch(
  env: Env,
  drafts: EvalDraft[],
): Promise<Record<string, { relevance: number; entailment: number }>> {
  const out: Record<string, { relevance: number; entailment: number }> = {};
  const BATCH = 4;
  for (let i = 0; i < drafts.length; i += BATCH) {
    const batch = drafts.slice(i, i + BATCH);
    const withRefs = batch.filter((d) => Array.from(d.response.matchAll(CITE_RE)).length > 0);
    const aliases = new Map(withRefs.map((d, index) => [d.ec.id, `c${index + 1}`]));
    for (const d of batch) {
      if (!withRefs.includes(d)) out[d.ec.id] = { relevance: 1, entailment: 1 };
    }
    if (!withRefs.length) continue;
    const raw = await completeJudge(env, [
      {
        role: "system",
        content:
          `Judge citation quality. Output ONLY one JSON object keyed by the exact case id: {"case-id":{"relevance":0.0,"entailment":0.0}}. ` +
          `relevance=how directly the supplied sources address the question/answer; entailment=whether each cited source actually supports the claim carrying its number. Penalize unused/tangential source stuffing and unsupported claims. Score 0..1.`,
      },
      {
        role: "user",
        content: withRefs.map((d) =>
          `ID: ${aliases.get(d.ec.id)}\nQUESTION: ${d.ec.question || ""}\nANSWER:\n${d.response.slice(0, 1800)}\nCITED SOURCES:\n` +
          (() => {
            const refs = new Set(Array.from(d.response.matchAll(CITE_RE)).map((m) => `T${m[1]}`));
            return (d.citations || [])
              .filter((c) => refs.has(String(c.ref || "")))
              .map((c) => `[${String(c.ref || "").replace(/^T/, "")}] ${String(c.snippet || "").slice(0, 600)}`)
              .join("\n");
          })()
        ).join("\n\n---\n\n"),
      },
    ], Array.from(aliases.values()), Math.max(180, batch.length * 60));
    let parsed: any = {};
    try {
      parsed = JSON.parse(raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim());
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) { try { parsed = JSON.parse(match[0]); } catch {} }
      if (!parsed || !Object.keys(parsed).length) {
        const arrayMatch = raw.match(/\[[\s\S]*\]/);
        if (arrayMatch) { try { parsed = JSON.parse(arrayMatch[0]); } catch {} }
      }
    }
    const rows = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.scores) ? parsed.scores : []);
    const rowMap = new Map(rows.map((row: any) => [String(row?.id || "").trim(), row]));
    for (const d of withRefs) {
      const alias = aliases.get(d.ec.id) || "";
      const row = rowMap.get(alias) || parsed?.[alias] || {};
      out[d.ec.id] = {
        relevance: Math.max(0, Math.min(1, Number(row.relevance) || 0)),
        entailment: Math.max(0, Math.min(1, Number(row.entailment) || 0)),
      };
    }
  }
  return out;
}

async function judgeVoiceBatch(env: Env, dna: string, drafts: EvalDraft[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const BATCH = 6;
  for (let i = 0; i < drafts.length; i += BATCH) {
    const batch = drafts.slice(i, i + BATCH);
    const aliases = new Map(batch.map((d, index) => [d.ec.id, `c${index + 1}`]));
    const raw = await completeJudge(env, [
      {
        role: "system",
        content:
          `You judge whether replies match a finance KOL's documented voice. Given the Expression DNA and ` +
          `several replies, output ONLY a JSON object keyed by exact ID: {"case-id":0.0}. Score 0..1 = average ` +
          `agreement across sentence style, vocabulary, humor, certainty, opening pattern. No commentary.`,
      },
      {
        role: "user",
        content:
          `Expression DNA:\n${dna}\n\nReplies:\n` +
          batch.map((d) => `ID: ${aliases.get(d.ec.id)}\n${d.response.slice(0, 1500)}`).join("\n\n---\n\n"),
      },
    ], Array.from(aliases.values()), Math.max(180, batch.length * 64));
    const parsed = parseKeyedScores(raw, Array.from(aliases.values()));
    for (const d of batch) out[d.ec.id] = parsed[aliases.get(d.ec.id) || ""] ?? 0;
  }
  return out;
}

async function judgeStanceBatch(env: Env, drafts: EvalDraft[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const withStance = drafts.filter((d) => d.ec.expected_stance);
  const BATCH = 6;
  for (let i = 0; i < withStance.length; i += BATCH) {
    const batch = withStance.slice(i, i + BATCH);
    const aliases = new Map(batch.map((d, index) => [d.ec.id, `c${index + 1}`]));
    const raw = await completeJudge(env, [
      {
        role: "system",
        content:
          `Output ONLY a JSON object keyed by exact ID: {"case-id":0.0}. For each item, score 0..1: how well ` +
          `does the reply's directional stance agree with EXPECTED? 1=same direction & subject, 0=opposite. No commentary.`,
      },
      {
        role: "user",
        content: batch.map((d) =>
          `ID: ${aliases.get(d.ec.id)}\nEXPECTED: ${d.ec.expected_stance}\nREPLY:\n${d.response.slice(0, 1200)}`
        ).join("\n\n---\n\n"),
      },
    ], Array.from(aliases.values()), Math.max(180, batch.length * 64));
    const parsed = parseKeyedScores(raw, Array.from(aliases.values()));
    for (const d of batch) out[d.ec.id] = parsed[aliases.get(d.ec.id) || ""] ?? 0;
  }
  return out;
}

interface CombinedJudgeScore {
  voice: number;
  stance: number | null;
  relevance: number;
  entailment: number;
  reason: string;
}

async function judgeQualityBatch(
  env: Env,
  dna: string,
  drafts: EvalDraft[],
): Promise<{ scores: Record<string, CombinedJudgeScore>; raw: string }> {
  if (!drafts.length) return { scores: {}, raw: "{}" };
  const aliases = new Map(drafts.map((d, index) => [d.ec.id, `c${index + 1}`]));
  const raw = await completeJudge(env, [
    {
      role: "system",
      content:
        `Audit finance-KOL answers. Return ONLY JSON keyed by the supplied id. Each value must be ` +
        `{"voice":0.0,"stance":null,"relevance":0.0,"entailment":0.0,"reason":"short evidence-based reason"}. ` +
        `voice=match to Expression DNA; relevance=answer and cited sources directly address the question; ` +
        `entailment=cited sources support the claims carrying their citation numbers. ` +
        `Only score stance when EXPECTED STANCE is present; otherwise return null. ` +
        `Do not reward confident unsupported detail. Scores are 0..1.`,
    },
    {
      role: "user",
      content:
        `EXPRESSION DNA:\n${dna.slice(0, 2500)}\n\n` +
        drafts.map((d) => {
          const refs = new Set(Array.from(d.response.matchAll(CITE_RE)).map((m) => `T${m[1]}`));
          const sources = (d.citations || [])
            .filter((c) => refs.has(String(c.ref || "")))
            .map((c) => `[${String(c.ref || "").replace(/^T/, "")}] ${String(c.snippet || "").slice(0, 500)}`)
            .join("\n");
          return `ID: ${aliases.get(d.ec.id)}\nQUESTION: ${d.ec.question || ""}\n` +
            `EXPECTED STANCE: ${d.ec.expected_stance || "(none)"}\nANSWER:\n${d.response.slice(0, 1800)}\n` +
            `CITED SOURCES:\n${sources || "(none)"}`;
        }).join("\n\n---\n\n"),
    },
  ], Array.from(aliases.values()), Math.max(300, drafts.length * 180));

  let parsed: any = {};
  try {
    parsed = JSON.parse(raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim());
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) { try { parsed = JSON.parse(match[0]); } catch {} }
  }
  const scores: Record<string, CombinedJudgeScore> = {};
  for (const d of drafts) {
    const alias = aliases.get(d.ec.id) || "";
    const row = parsed?.[alias] || {};
    const bounded = (value: any) => Math.max(0, Math.min(1, Number(value) || 0));
    scores[d.ec.id] = {
      voice: bounded(row.voice),
      stance: d.ec.expected_stance ? bounded(row.stance) : null,
      relevance: bounded(row.relevance),
      entailment: bounded(row.entailment),
      reason: String(row.reason || "").slice(0, 500),
    };
  }
  return { scores, raw };
}

// ---------- buildEvalSet: mine a golden set from the KOL's own corpus ----------

export async function buildEvalSet(
  env: Env,
  kolId: string,
  opts: { realQa?: number; synth?: number } = {},
): Promise<{ built: number; real_qa: number; synth_follower: number }> {
  // Keep the release gate compact. A focused 12-case audit is substantially more useful than the
  // previous 39-case grab bag and costs a fraction as much to rerun.
  const realTarget = opts.realQa ?? 8;
  const synthTarget = opts.synth ?? 4;

  const kol = await env.DB.prepare(`SELECT id,display_name,handle,tagline,persona_pack FROM kols WHERE id=?`)
    .bind(kolId).first<KolRow>();
  if (!kol) throw new Error(`KOL not found: ${kolId}`);

  // Substantive tweets only: skip short quips / pure links. Favor engagement (those are the takes
  // followers actually reacted to) — exactly the kind of question we want the replica to handle.
  const r = await env.DB.prepare(
    `SELECT id, text FROM tweets
     WHERE kol_id=? AND is_retweet=0 AND length(text)>=80
     ORDER BY (likes + retweets * 2) DESC LIMIT ?`
  ).bind(kolId, 200).all();
  const financeTweet = (text: string) =>
    /(?:\$[A-Z]{1,6}\b|\b[A-Z]{2,6}\b|股票|美股|港股|A股|ETF|基金|仓位|估值|市值|财报|盈利|营收|利率|通胀|流动性|美联储|国债|美元|比特币|加密|芯片|半导体|存储|AI|投资|交易|买入|卖出|减仓|加仓|周期)/i.test(text);
  const tweets = ((r.results || []) as any[])
    .filter((tweet) => financeTweet(String(tweet.text || "")))
    .slice(0, realTarget);
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
          `and the KOL's explicit INVESTMENT STANCE in it. Output ONLY a JSON array; one object per input number: ` +
          `[{"n":1,"question":"...","stance":"bullish on X | bearish on X | n/a"}]. ` +
          `The question must concern investing, markets, companies, sectors, macro or tradable assets and be ` +
          `answerable from the tweet alone. Use n/a for factual/explanatory posts or when direction is not explicit. No commentary.`,
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

  // Deterministic regression probes for domains that are materially present in the corpus. These stop
  // a reducer from dropping a current focus merely because the highest-engagement generic questions
  // dominated the generated set.
  const memoryProbe = await env.DB.prepare(
    `SELECT id FROM tweets WHERE kol_id=? AND is_retweet=0
     AND (lower(text) LIKE '%dram%' OR lower(text) LIKE '%memory%' OR text LIKE '%存储%' OR text LIKE '%美光%')
     ORDER BY created_at_ts DESC LIMIT 1`
  ).bind(kolId).first<any>();
  if (memoryProbe?.id) {
    cases.push({
      question: "你如何判断 DRAM 存储 ETF 与美光（MU）当前是否值得买入？请区分 ETF、个股和行业周期。",
      type: "regression",
      stance: null,
      sourceId: String(memoryProbe.id),
    });
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
  avg_relevance: number;
  avg_entailment: number;
  passed: number;        // # of cases that passed all thresholds
  composite: number;     // run-level composite (mean of available metrics)
  baseline_composite: number | null;
  regressed: boolean;
  processed: number;     // cases scored in THIS call
  remaining: number;     // cases still un-scored for this version (0 = complete)
}

function citationScore(response: string, citations: { ref: string }[]): number {
  const validRefs = new Set(citations.map((c) => c.ref));
  const cited = new Set(Array.from(response.matchAll(CITE_RE)).map((m) => `T${m[1]}`));
  return cited.size === 0
    ? (validRefs.size === 0 ? 1 : 0)
    : Array.from(cited).filter((r) => validRefs.has(r)).length / cited.size;
}

async function evalAnswerDraft(
  env: Env,
  kol: KolRow,
  kolId: string,
  question: string,
  personaPack: string,
): Promise<EvalDraft & { citations: any[]; knowledge_count: number }> {
  const mode = (kol.retrieval_mode === "tagged" ? "tagged" : "query_side") as "tagged" | "query_side";
  const scope = kol.corpus_id || kol.id;
  const { citations, knowledge } = await retrieve(
    env, kolId, kol.handle, question, [], undefined, env.MODEL_FLASH, mode, scope,
  );
  const messages = buildMessages({
    kol, persona: personaPack, knowledge, citations,
    market: EMPTY_MARKET, history: [], userMessage: question,
  });
  const response = await completeChat(env, env.MODEL_FLASH, messages, { maxTokens: 1600, temperature: 0.3 });
  return {
    ec: null,
    response,
    scoreCitation: citationScore(response, citations),
    citations,
    knowledge_count: knowledge.length,
  };
}

export async function runEvalPreview(
  env: Env,
  kolId: string,
  opts: { limit?: number; candidatePack?: string; caseIds?: string[]; questions?: string[] } = {},
): Promise<{ kol_id: string; cases: any[]; live_version: string; candidate: boolean }> {
  const limit = Math.min(Math.max(opts.limit ?? 3, 1), 6);
  const kol = await env.DB.prepare(`SELECT * FROM kols WHERE id=?`).bind(kolId).first<KolRow>();
  if (!kol) throw new Error(`KOL not found: ${kolId}`);
  if (!kol.persona_pack) throw new Error(`No persona_pack for ${kolId}`);
  const customQuestions = (opts.questions || []).map((q) => String(q || "").trim()).filter((q) => q.length >= 3);
  const caseRows = customQuestions.length
    ? customQuestions.slice(0, limit).map((question, i) => ({
        id: `${kolId}:custom:${i}`,
        question,
        expected_stance: null,
      }))
    : opts.caseIds?.length
    ? ((await env.DB.prepare(
        `SELECT id, question, expected_stance FROM eval_cases WHERE kol_id=? AND id IN (${opts.caseIds.map(() => "?").join(",")}) ORDER BY id`
      ).bind(kolId, ...opts.caseIds).all()).results || []) as any[]
    : ((await env.DB.prepare(
        `SELECT id, question, expected_stance FROM eval_cases WHERE kol_id=? ORDER BY id LIMIT ?`
      ).bind(kolId, limit).all()).results || []) as any[];
  if (!caseRows.length) throw new Error(`No eval cases for ${kolId}`);

  const out: any[] = [];
  for (const ec of caseRows.slice(0, limit)) {
    const live = await evalAnswerDraft(env, kol, kolId, String(ec.question), kol.persona_pack,);
    const drafts: EvalDraft[] = [{ ec: { id: `${ec.id}:live`, question: ec.question, expected_stance: ec.expected_stance }, response: live.response, scoreCitation: live.scoreCitation, citations: live.citations }];
    let cand: Awaited<ReturnType<typeof evalAnswerDraft>> | null = null;
    if (opts.candidatePack) {
      cand = await evalAnswerDraft(env, kol, kolId, String(ec.question), opts.candidatePack);
      drafts.push({ ec: { id: `${ec.id}:candidate`, question: ec.question, expected_stance: ec.expected_stance }, response: cand.response, scoreCitation: cand.scoreCitation, citations: cand.citations });
    }
    const liveDna = extractExpressionDna(kol.persona_pack);
    const candDna = extractExpressionDna(opts.candidatePack || kol.persona_pack);
    const liveVoice = await judgeVoiceBatch(env, liveDna, [drafts[0]]);
    const candVoice = cand ? await judgeVoiceBatch(env, candDna, [drafts[1]]) : {};
    const stance = await judgeStanceBatch(env, drafts);
    const citationQuality = await judgeCitationQualityBatch(env, drafts);
    out.push({
      id: ec.id,
      question: ec.question,
      expected_stance: ec.expected_stance,
      live: {
        answer: live.response,
        citations: live.citations,
        knowledge_count: live.knowledge_count,
        score_citation: live.scoreCitation,
        score_voice: liveVoice[`${ec.id}:live`] ?? 0,
        score_stance: stance[`${ec.id}:live`] ?? null,
        score_relevance: citationQuality[`${ec.id}:live`]?.relevance ?? 0,
        score_entailment: citationQuality[`${ec.id}:live`]?.entailment ?? 0,
      },
      candidate: cand ? {
        answer: cand.response,
        citations: cand.citations,
        knowledge_count: cand.knowledge_count,
        score_citation: cand.scoreCitation,
        score_voice: candVoice[`${ec.id}:candidate`] ?? 0,
        score_stance: stance[`${ec.id}:candidate`] ?? null,
        score_relevance: citationQuality[`${ec.id}:candidate`]?.relevance ?? 0,
        score_entailment: citationQuality[`${ec.id}:candidate`]?.entailment ?? 0,
      } : null,
    });
  }
  return { kol_id: kolId, live_version: kol.persona_version || "unknown", candidate: !!opts.candidatePack, cases: out };
}

export async function runEval(
  env: Env,
  kolId: string,
  opts: { limit?: number; personaPack?: string; personaVersion?: string } = {},
): Promise<EvalSummary> {
  const limit = Math.min(opts.limit ?? 12, 40);
  const kol = await env.DB.prepare(`SELECT * FROM kols WHERE id=?`).bind(kolId).first<KolRow>();
  if (!kol) throw new Error(`KOL not found: ${kolId}`);
  const personaPack = opts.personaPack || kol.persona_pack;
  if (!personaPack) throw new Error(`No persona_pack for ${kolId} — nothing to eval`);
  const evalPersona = personaPack.slice(0, 20000);

  const personaVersion = opts.personaVersion || kol.persona_version || "unknown";
  // Generate eval responses with flash — it is the production chat default AND fast enough that a batch
  // of cases fits the worker's ~100s execution limit (pro would blow it on the first few cases).
  const modelVersion = env.MODEL_FLASH;
  const dna = extractExpressionDna(evalPersona);
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
  // released after four minutes. A distill step owns a three-minute D1 lease, so this leaves a safety
  // margin for a legitimate slow case while allowing the next cron ticks to recover without operators.
  await env.DB.prepare(
    `DELETE FROM eval_results
     WHERE kol_id=? AND persona_version=? AND score_citation IS NULL
       AND datetime(created_at) < datetime('now','-4 minutes')`
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

  const generatedDrafts = await Promise.all(cases.map(async (ec) => {
    const question = String(ec.question);
    // Generate a persona answer the same way production chat does (persona + retrieved SOURCE TWEETS),
    // minus live market data.
    const { citations, knowledge } = await retrieve(
      env, kolId, kol.handle, question, [], undefined, env.MODEL_FLASH, mode, scope,
      { skipLlmRerank: true },
    );
    const messages = buildMessages({
      kol, persona: evalPersona, knowledge, citations,
      market: EMPTY_MARKET, history: [], userMessage: question,
    });
    const response = await completeChat(env, modelVersion, messages, { maxTokens: 700, temperature: 0.3 });

    // 1) Citation accuracy — fraction of cited [T#] that resolve to a retrieved source tweet.
    const scoreCitation = citationScore(response, citations);

    return { ec, response, scoreCitation, citations };
  }));
  drafts.push(...generatedDrafts);

  // One compact judge replaces the former voice + stance + citation calls. This cuts judge traffic
  // by roughly two thirds and keeps one auditable rationale for all semantic scores.
  const judged = await judgeQualityBatch(env, dna, drafts);

  for (const d of drafts) {
    const ec = d.ec;
    const scoreCitation = d.scoreCitation;
    const quality = judged.scores[ec.id] || {
      voice: 0, stance: ec.expected_stance ? 0 : null, relevance: 0, entailment: 0, reason: "judge parse failed",
    };
    const scoreVoice = quality.voice;
    const scoreStance = quality.stance;
    const scoreRelevance = quality.relevance;
    const scoreEntailment = quality.entailment;

    sumCite += scoreCitation;
    sumVoice += scoreVoice;
    if (scoreStance !== null) { sumStance += scoreStance; stanceN++; }

    const passed = scoreCitation >= TH_CITATION && scoreVoice >= TH_VOICE &&
      scoreRelevance >= 0.6 && scoreEntailment >= 0.6 &&
      (scoreStance === null || scoreStance >= TH_STANCE);
    if (passed) passedN++;

    await env.DB.prepare(
      `UPDATE eval_results
       SET score_citation=?, score_voice=?, score_stance=?, score_relevance=?,score_entailment=?,
           passed=?,regressed=0,case_question=?,answer_text=?,citations_json=?,judge_json=?,input_chars=?
       WHERE id=?`
    ).bind(
      scoreCitation, scoreVoice, scoreStance, scoreRelevance, scoreEntailment, passed ? 1 : 0,
      String(ec.question || "").slice(0, 2000),
      d.response.slice(0, 12000),
      JSON.stringify(d.citations || []).slice(0, 30000),
      JSON.stringify({ score: quality, raw: judged.raw }).slice(0, 16000),
      evalPersona.length + JSON.stringify(d.citations || []).length,
      `${kolId}:${personaVersion}:${modelVersion}:${ec.id}`,
    ).run();
  }

  // Aggregate over ALL results for this version so far (the run may be spread across several batches).
  const agg = await env.DB.prepare(
    `SELECT AVG(score_citation) c, AVG(score_voice) v, AVG(score_stance) s,
            AVG(score_relevance) r,AVG(score_entailment) e,SUM(passed) p, COUNT(*) n
     FROM eval_results WHERE kol_id=? AND persona_version=? AND score_citation IS NOT NULL`
  ).bind(kolId, personaVersion).first<any>();
  const n = agg?.n || cases.length;
  const avgCite = agg?.c ?? 0;
  const avgVoice = agg?.v ?? 0;
  const avgStance = agg?.s ?? null;
  const avgRelevance = agg?.r ?? 0;
  const avgEntailment = agg?.e ?? 0;
  passedN = agg?.p ?? passedN;
  // Run composite = mean of the metrics we actually have.
  const parts = [avgCite, avgVoice, avgRelevance, avgEntailment, ...(avgStance !== null ? [avgStance] : [])];
  const composite = parts.reduce((a, b) => a + b, 0) / parts.length;

  // Baseline = the mean composite of the most recent eval run for a DIFFERENT persona_version. This is
  // the meaningful regression question: did the *new* pack get worse than the *previous* pack?
  const base = await env.DB.prepare(
    `SELECT AVG(r.score_citation) c,AVG(r.score_voice) v,AVG(r.score_stance) s,
            AVG(r.score_relevance) r,AVG(r.score_entailment) e,COUNT(*) n
     FROM eval_results r
     JOIN eval_cases ec ON ec.id=r.case_id AND ec.question=r.case_question
     WHERE r.kol_id=? AND r.persona_version=?
       AND r.answer_text IS NOT NULL AND r.score_citation IS NOT NULL AND ec.kol_id=?`
  ).bind(kolId, kol.persona_version || "", kolId).first<any>();
  let baselineComposite: number | null = null;
  if (base && base.c !== null && Number(base.n || 0) === allCases.length) {
    const bp = [base.c, base.v, ...(base.r !== null ? [base.r] : []), ...(base.e !== null ? [base.e] : []), ...(base.s !== null ? [base.s] : [])].filter((x) => x !== null);
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
    avg_relevance: avgRelevance, avg_entailment: avgEntailment,
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
