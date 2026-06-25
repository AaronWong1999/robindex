// Persona Pack auto-generation: distill a KOL's tweet corpus into a structured persona_pack
// using a single structured LLM call (nuwa-skill multi-dimensional framework, adapted for Workers).
// Also handles incremental evolution (colleague-skill pattern) and quality validation.
import type { Env } from "./env";
import { completeChat } from "./chat";

// ---------- Persona-gen LLM primitives ----------

// Distinguishable error classes so the retry layer can decide *what* to do on failure
// rather than guessing from an error string. Truncation and timeout get different responses.
export class PersonaGenError extends Error {
  constructor(public kind: "truncation" | "timeout" | "http_error" | "parse_error" | "empty", message: string) {
    super(message);
    this.name = "PersonaGenError";
  }
}

// What one persona-gen LLM call produced, with enough signal to decide success vs failure.
// `finish_reason === "stop"` + `parse_ok === true` is the only fully-successful path.
export interface PersonaGenAttempt {
  content: string;          // raw model output (may be partial/truncated)
  finish_reason: string;    // 'stop' | 'length' | 'content_filter' | 'body_read_timeout' | 'http_error' | 'unknown'
  content_len: number;
  duration_ms: number;
  parse_ok: boolean;        // did the content parse as our persona JSON?
  error_type: PersonaGenError["kind"] | null;
  note?: string;            // human-readable detail (HTTP body, error message, etc.)
}

// Persist one attempt to persona_experiments so failures survive beyond KV's 1h TTL.
// This is the observability backbone for both diagnose and production paths.
export async function logPersonaExperiment(
  env: Env,
  kolId: string,
  attempt: PersonaGenAttempt,
  maxTokens: number,
  trigger: string,
): Promise<void> {
  const id = `${kolId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  try {
    await env.DB.prepare(
      `INSERT INTO persona_experiments (id, kol_id, max_tokens, finish_reason, content_len, duration_ms, parse_ok, error_type, note, trigger)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      id, kolId, maxTokens, attempt.finish_reason, attempt.content_len,
      attempt.duration_ms, attempt.parse_ok ? 1 : 0, attempt.error_type,
      (attempt.note || "").slice(0, 1000), trigger,
    ).run();
  } catch {
    // Logging must never break generation. Mirror key facts to KV as a fallback.
    if (env.CACHE) {
      await env.CACHE.put(`persona_debug:${kolId}`, `LOG_FAIL: ${JSON.stringify(attempt).slice(0, 500)}`, { expirationTtl: 3600 });
    }
  }
}

// Single persona-gen LLM call with full observability. Reads the body chunked (AI Gateway
// keeps the connection open for long reasoning outputs) and classifies the outcome by
// finish_reason + parse success. Throws PersonaGenError so callers can branch on the cause.
//
// maxTokens: the request budget (CoT + output share it on deepseek-v4-pro — reasoning
// models consume tokens before emitting the answer, which is the root cause of historical
// `finish_reason=length` with empty content).
export async function callPersonaLLM(
  env: Env,
  messages: { role: string; content: string }[],
  maxTokens: number,
  kolId: string,
  opts: { timeoutMs?: number; systemPrompt?: string } = {},
): Promise<{ content: string; attempt: PersonaGenAttempt }> {
  const timeoutMs = opts.timeoutMs ?? 600000;
  // If a custom systemPrompt is given (e.g. the CoT-suppressing variant for the retry),
  // splice it into the messages; otherwise use whatever was passed.
  const finalMessages = opts.systemPrompt
    ? messages.map((m) => (m.role === "system" ? { role: "system", content: opts.systemPrompt! } : m))
    : messages;
  const debug = async (s: string) => {
    if (env.CACHE) await env.CACHE.put(`persona_debug:${kolId}`, s, { expirationTtl: 3600 }).catch(() => {});
  };
  const start = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let finishReason = "unknown";
  let content = "";
  let errorType: PersonaGenAttempt["error_type"] = null;
  let note: string | undefined;
  let bodyReadTimedOut = false;

  try {
    await debug(`BEFORE_FETCH: max_tokens=${maxTokens} timeout=${timeoutMs}ms at ${new Date().toISOString()}`);
    const res = await fetch(env.GATEWAY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "cf-aig-authorization": `Bearer ${env.CFGATEWAYKEY}`,
        "cf-aig-request-timeout": String(timeoutMs),
        ...(env.OPENROUTER_KEY ? { Authorization: `Bearer ${env.OPENROUTER_KEY}` } : {}),
        "HTTP-Referer": "https://robindex.ai",
        "X-Title": "Robindex",
      },
      body: JSON.stringify({ model: env.MODEL_PRO, messages: finalMessages, temperature: 0.2, max_tokens: maxTokens }),
      signal: controller.signal,
    });
    await debug(`FETCH_RETURNED: status=${res.status} at ${new Date().toISOString()}`);
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      errorType = "http_error";
      finishReason = "http_error";
      note = `HTTP ${res.status}: ${errText.slice(0, 400)}`;
      await debug(`HTTP_ERR: ${note}`);
      throw new PersonaGenError("http_error", note);
    }
    // Read body chunked — AI Gateway keeps the connection open for long reasoning outputs.
    // Per-chunk timeout (was a flat 120s) scales with the budget so a large max_tokens
    // request isn't killed mid-stream, while still bounding a stalled connection.
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let bodyText = "";
    const bodyStart = Date.now();
    const perChunkTimeout = Math.max(120000, Math.min(timeoutMs, maxTokens * 200)); // ~200ms/token headroom
    while (true) {
      const readPromise = reader.read();
      const timeoutPromise = new Promise<{ done: boolean; value?: Uint8Array }>((_, reject) =>
        setTimeout(() => reject(new Error("body_read_timeout")), perChunkTimeout),
      );
      try {
        const { done, value } = await Promise.race([readPromise, timeoutPromise]);
        if (done) break;
        bodyText += decoder.decode(value, { stream: true });
      } catch {
        bodyReadTimedOut = true;
        await debug(`BODY_READ_TIMEOUT: got ${bodyText.length} chars after ${Date.now() - bodyStart}ms`);
        break;
      }
    }
    await debug(`BODY: ${bodyText.length} chars in ${Date.now() - bodyStart}ms at ${new Date().toISOString()}`);
    let j: any;
    try { j = JSON.parse(bodyText); } catch {
      errorType = "parse_error";
      finishReason = bodyReadTimedOut ? "body_read_timeout" : "parse_error";
      note = `body JSON parse failed (len=${bodyText.length}${bodyReadTimedOut ? ", read timed out" : ""}); head=${bodyText.slice(0, 200)}`;
      throw new PersonaGenError(bodyReadTimedOut ? "timeout" : "parse_error", note);
    }
    content = j?.choices?.[0]?.message?.content || "";
    finishReason = j?.choices?.[0]?.finish_reason || "unknown";
    await debug(`PARSED: raw=${content.length} chars, finish=${finishReason} at ${new Date().toISOString()}`);
  } catch (e: any) {
    if (e instanceof PersonaGenError) throw e;
    const msg = String(e?.message || e);
    if (controller.signal.aborted || /abort/i.test(msg)) {
      errorType = "timeout";
      finishReason = "abort_timeout";
      note = `aborted after ${Date.now() - start}ms: ${msg}`;
    } else {
      errorType = errorType ?? "parse_error";
      note = note ?? msg.slice(0, 400);
    }
    await debug(`ERROR: ${note}`);
    throw new PersonaGenError(errorType === "timeout" ? "timeout" : "parse_error", note);
  } finally {
    clearTimeout(timeout);
  }

  const duration_ms = Date.now() - start;
  // finish_reason === "length" means the budget ran out — on reasoning models this usually
  // means CoT consumed the tokens and content is empty/truncated. This is NOT success.
  if (finishReason === "length") {
    const note = `finish_reason=length (truncated; likely CoT ate the budget). content_len=${content.length}`;
    throw new PersonaGenError("truncation", note);
  }
  if (!content) {
    const note = `empty content (finish_reason=${finishReason})`;
    throw new PersonaGenError("empty", note);
  }
  const attempt: PersonaGenAttempt = { content, finish_reason: finishReason, content_len: content.length, duration_ms, parse_ok: false, error_type: null };
  return { content, attempt };
}

// ---------- Types ----------

// Each mental model carries a machine-checkable verification block (the "triple gate"): it must span
// ≥2 distinct topics (cross-domain), let us infer a NEW stance (generative), and be specific to this
// KOL rather than generic (exclusive). The gate is enforced in code, not just requested in the prompt.
interface ModelVerification {
  cross_domain_topics: string[]; // distinct topics where this model shows up (need ≥2)
  generative_test: string;       // a fresh stance this model lets us predict
  exclusive: boolean;            // true = specific to this KOL, false = generic truism
}
interface MentalModel {
  name: string;
  description: string;
  evidence: string[];
  limitation: string;
  verification?: ModelVerification;
}
interface DecisionHeuristic {
  rule: string;
  example: string;
}
interface ExpressionDna {
  sentence_style: string;
  vocabulary: string[];
  humor: string;
  certainty: string;
  opening_pattern: string;
}
// A dated prediction + how it played out — the "track record" dimension (serenity evidence ladder).
interface TrackRecordItem {
  date: string;
  call: string;
  outcome: string;
}
export interface PersonaJson {
  mental_models: MentalModel[];
  decision_heuristics: DecisionHeuristic[];
  expression_dna: ExpressionDna;
  values: string[];
  anti_patterns: string[];
  tensions: string[];
  honest_boundaries?: string[];      // legacy: no longer rendered or collected by new distillation prompts
  uncertainty_style?: string[];      // reserved; new distillation intentionally returns [] for now
  track_record?: TrackRecordItem[];   // C1: dated calls + outcomes
  counter_views?: string[];           // C1: blind spots / what critics would say
  sector_focus?: string[];            // C1: sectors/tickers this KOL covers most
  signature_examples?: string[];      // C1: representative quotes / 金句 (voice exemplars)
  analytical_exemplars?: string[];    // C2: full analytical paragraphs where the KOL applies their framework to a specific instrument
}

interface EvolutionResult {
  new_models: MentalModel[];
  updated_heuristics: DecisionHeuristic[];
  style_drift: boolean;
  contradictions: string[];
}

// ---------- Prompt templates ----------

const DISTILL_SYSTEM = `You are a financial KOL analyst. Analyze the tweet corpus and extract a complete persona profile.
Output ONLY valid JSON (no markdown fences). Be precise and evidence-based.

Output JSON schema:
{
  "mental_models": [
    {
      "name": "model name",
      "description": "one-line",
      "evidence": ["tweet snippet1","snippet2"],
      "limitation": "when this fails",
      "verification": {
        "cross_domain_topics": ["topic A","topic B"],
        "generative_test": "a NEW stance this model lets us predict",
        "exclusive": true
      }
    }
  ],
  "decision_heuristics": [
    { "rule": "if X then Y", "example": "concrete tweet example" }
  ],
  "expression_dna": {
    "sentence_style": "short/long/mixed",
    "vocabulary": ["frequent word1","word2"],
    "humor": "sarcastic/self-deprecating/none",
    "certainty": "cautious/assertive",
    "opening_pattern": "conclusion-first/buildup-first"
  },
  "values": ["core value1","value2"],
  "anti_patterns": ["what this person explicitly opposes"],
  "tensions": ["value A vs value B internal contradiction"],
  "uncertainty_style": [],
  "track_record": [ { "date": "YYYY-MM-DD", "call": "what they predicted", "outcome": "what happened / TBD" } ],
  "counter_views": ["blind spot or what a smart critic would say against this persona"],
  "sector_focus": ["sectors/tickers/themes this KOL covers most"],
  "signature_examples": ["a verbatim representative quote / 金句 that captures their voice"],
  "analytical_exemplars": ["a complete analytical paragraph (3-8 sentences) where the KOL applies their framework to a specific instrument — showing reasoning chain, data usage, and conclusion style. Copy verbatim from tweets, do not summarize."]
}

Rules:
- mental_models: produce 5-8 CANDIDATES. For EACH, fill "verification": cross_domain_topics MUST list
  the distinct topics where the model recurs (a real model recurs in ≥2), generative_test MUST state a
  fresh stance it predicts, exclusive=false if it is a generic market truism (e.g. "buy low sell high").
  Weak candidates will be filtered out downstream, so be honest in verification rather than inflating.
- decision_heuristics: 5-10 rules grounded in actual tweets.
- tensions: at least 2 pairs of internal contradictions.
- track_record: 3-8 dated calls actually found in the tweets (with outcome if determinable, else "TBD").
- signature_examples: 3-6 verbatim short quotes copied from the tweets (do not paraphrase).
- analytical_exemplars: 2-4 complete analytical paragraphs where the KOL applies their framework to a specific instrument or question. Copy VERBATIM (3-8 sentences each). Pick ones that show the KOL's reasoning chain: how they use data, how they weigh evidence, how they reach conclusions. These teach the answer model HOW to analyze, not just what methodology to use.
- uncertainty_style: always return [] for now. Do not collect, summarize, paraphrase, or transform refusal/prohibition statements, investment disclaimers, risk warnings, uncertainty/time-horizon/could-be-wrong style, or "I don't do/provide/touch/recommend X" statements. Do not move them into other fields.
- All evidence/examples must come from the provided tweets. Do not fabricate.`;

// CoT-suppressing variant used by the retry path. deepseek-v4-pro is a reasoning model: CoT
// tokens share the max_tokens budget with the output, so when a generation fails with
// finish_reason=length, an over-long chain-of-thought has usually consumed the budget before
// the JSON was emitted. This prompt asks for the JSON directly with minimal preamble, which
// both shortens the reasoning and makes truncation less destructive if it still happens.
const DISTILL_SYSTEM_DIRECT = `You are a financial KOL analyst. Output ONLY valid JSON (no markdown fences, no preamble, no chain-of-thought, no explanation). Begin your response with the character "{" and end with "}". Do not think step by step; emit the JSON object directly.

Schema (same as standard distillation):
{ "mental_models": [{ "name": "", "description": "", "evidence": [], "limitation": "", "verification": { "cross_domain_topics": [], "generative_test": "", "exclusive": true } }], "decision_heuristics": [{ "rule": "", "example": "" }], "expression_dna": { "sentence_style": "", "vocabulary": [], "humor": "", "certainty": "", "opening_pattern": "" }, "values": [], "anti_patterns": [], "tensions": [], "uncertainty_style": [], "track_record": [{ "date": "YYYY-MM-DD", "call": "", "outcome": "" }], "counter_views": [], "sector_focus": [], "signature_examples": [], "analytical_exemplars": [] }

Produce 5-8 mental_models (fill verification honestly: cross_domain_topics ≥2, exclusive=false for generic truisms), 5-10 decision_heuristics, ≥2 tensions, 3-8 track_record items, 3-6 verbatim signature_examples, 2-4 verbatim analytical_exemplars (3-8 sentences each). uncertainty_style must be []. All evidence/examples MUST come from the provided tweets — do not fabricate. Keep the JSON as compact as the schema allows.`;

const EVOLUTION_SYSTEM = `You are a financial KOL analyst performing incremental persona evolution.
Compare NEW tweets against the EXISTING persona pack. Output ONLY valid JSON (no markdown fences).

Rules:
- Only APPEND or REFINE. Never delete existing mental models (anti-drift).
- If new tweets contradict an existing model, report it as a contradiction (do NOT auto-fix).
- If expression style shifted noticeably, set style_drift=true.
- New recurring terms/themes (≥5 occurrences) → new decision_heuristic.
- More evidence for existing models → append to evidence list.

Output JSON:
{
  "new_models": [{ "name": "", "description": "", "evidence": [], "limitation": "" }],
  "updated_heuristics": [{ "rule": "", "example": "" }],
  "style_drift": false,
  "contradictions": ["description of conflict between old model and new tweets"]
}`;

// Best-effort JSON extraction from a possibly-noisy / fenced model output.
export function extractPersonaJson(raw: string): PersonaJson | null {
  const cleaned = raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
  try {
    return JSON.parse(cleaned) as PersonaJson;
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]) as PersonaJson;
      } catch (e2) {
        console.log(`persona-gen JSON parse failed (raw len ${raw.length}, match len ${match[0].length}): ${e2}`);
        return null;
      }
    }
    console.log(`persona-gen: no JSON found in output (raw len ${raw.length}), first 200 chars: ${raw.slice(0, 200)}`);
    return null;
  }
}

// ---------- Corpus + message assembly (shared by generate / diagnose) ----------

async function buildCorpus(env: Env, kolId: string): Promise<{ kol: any; tweets: any[]; corpus: string }> {
  const kol = await env.DB.prepare(
    `SELECT id,display_name,handle,tagline FROM kols WHERE id=?`
  ).bind(kolId).first<any>();
  if (!kol) throw new Error(`KOL not found: ${kolId}`);

  const [recentR, topR] = await Promise.all([
    env.DB.prepare(
      `SELECT text,created_at_iso,created_at_ts,likes,retweets FROM tweets
       WHERE kol_id=? AND is_retweet=0 ORDER BY created_at_ts DESC LIMIT 1200`
    ).bind(kolId).all(),
    env.DB.prepare(
      `SELECT text,created_at_iso,created_at_ts,likes,retweets FROM tweets
       WHERE kol_id=? AND is_retweet=0 ORDER BY (likes + retweets * 2) DESC LIMIT 800`
    ).bind(kolId).all(),
  ]);

  // Fill an ~80K-char corpus by INTERLEAVING the recent feed and the all-time top-engagement feed so
  // both share the budget. (Previously the two lists were concatenated recent-first then sliced to 80K,
  // which for a prolific KOL truncated the entire engagement list away — the persona ended up distilled
  // from only the last couple of weeks. Interleaving guarantees historical high-signal posts are seen.)
  const CORPUS_BUDGET = 80000;
  const fmt = (t: any) => `[${(t.created_at_iso || "").slice(0, 10)}] ❤${t.likes} RT${t.retweets} ${t.text}`;
  const recent = (recentR.results || []) as any[];
  const top = (topR.results || []) as any[];
  const seen = new Set<string>();
  const tweets: any[] = [];
  let size = 0;
  let ri = 0, ti = 0, turn = 0;
  while (size < CORPUS_BUDGET && (ri < recent.length || ti < top.length)) {
    // Pull the next not-yet-seen row from whichever feed's turn it is.
    let row: any = null;
    if (turn === 0) {
      while (ri < recent.length) { const r = recent[ri++]; const k = String(r.text || "").slice(0, 80); if (!seen.has(k)) { seen.add(k); row = r; break; } }
    } else {
      while (ti < top.length) { const r = top[ti++]; const k = String(r.text || "").slice(0, 80); if (!seen.has(k)) { seen.add(k); row = r; break; } }
    }
    turn ^= 1;
    if (!row) continue; // this feed is exhausted/all-dup; the while-condition ends the loop when both are
    const lineLen = fmt(row).length + 1;
    if (size + lineLen > CORPUS_BUDGET) continue; // skip this oversized one, try to fit smaller ones
    tweets.push(row);
    size += lineLen;
  }
  if (tweets.length < 10) throw new Error(`Not enough tweets (${tweets.length}) for ${kolId}`);

  // Present chronologically (newest first) so dated reasoning reads naturally; each line is self-dated.
  tweets.sort((a, b) => (b.created_at_ts || 0) - (a.created_at_ts || 0));
  const corpus = tweets.map(fmt).join("\n").slice(0, CORPUS_BUDGET);
  return { kol, tweets, corpus };
}

function buildDistillMessages(kol: any, corpus: string, tweetCount: number): { role: string; content: string }[] {
  return [
    { role: "system", content: DISTILL_SYSTEM },
    { role: "user", content: `KOL: ${kol.display_name} (@${kol.handle})${kol.tagline ? ` — ${kol.tagline}` : ""}\n\nTweet corpus (${tweetCount} tweets):\n${corpus}` },
  ];
}

// ---------- Diagnose: probe multiple max_tokens budgets to find the real bottleneck ----------
// Returns the outcome of each probe WITHOUT writing to kols. Drives the decision of what
// production max_tokens / strategy to use, instead of guessing.
export async function diagnosePersonaGeneration(
  env: Env,
  kolId: string,
  budgets: number[] = [8192, 16384, 32768],
): Promise<{ probes: Array<{ max_tokens: number; ok: boolean; attempt: PersonaGenAttempt | null; error: string | null }>; best: number | null }> {
  const { kol, corpus, tweets } = await buildCorpus(env, kolId);
  const messages = buildDistillMessages(kol, corpus, tweets.length);
  const probes: Array<{ max_tokens: number; ok: boolean; attempt: PersonaGenAttempt | null; error: string | null }> = [];
  let best: number | null = null;

  for (const maxTokens of budgets) {
    let attempt: PersonaGenAttempt | null = null;
    let errorMsg: string | null = null;
    let ok = false;
    try {
      const { content, attempt: att } = await callPersonaLLM(env, messages, maxTokens, kolId, { timeoutMs: 600000 });
      attempt = att;
      const pj = extractPersonaJson(content);
      ok = !!(pj && (pj.mental_models?.length || 0) >= 3);
      attempt = { ...att, parse_ok: !!pj };
      if (ok && best === null) best = maxTokens;
    } catch (e: any) {
      errorMsg = e instanceof PersonaGenError ? `${e.kind}: ${e.message}` : String(e?.message || e);
      attempt = {
        content: "", finish_reason: e instanceof PersonaGenError ? e.kind : "error",
        content_len: 0, duration_ms: 0, parse_ok: false,
        error_type: e instanceof PersonaGenError ? e.kind : "parse_error", note: errorMsg,
      };
    }
    probes.push({ max_tokens: maxTokens, ok, attempt, error: errorMsg });
    // Log every probe so the diagnose run is fully auditable in D1.
    if (attempt) await logPersonaExperiment(env, kolId, attempt, maxTokens, "diagnose");
  }
  return { probes, best };
}

// ---------- Core: generate persona from scratch ----------

// Token budget ladder for the auto-retry. The first (production) attempt uses a moderate
// budget; on truncation/timeout we shrink the budget AND switch to the direct (CoT-suppressed)
// system prompt, since an over-long reasoning trace is the usual culprit. Values are deliberately
// far below deepseek-v4-pro's 384k ceiling: a persona JSON realistically needs ~4-8k tokens of
// output, so giving the model more headroom mostly grows the CoT, not the answer.
const GEN_BUDGETS = [
  { maxTokens: 16384, systemPrompt: undefined as string | undefined, timeoutMs: 600000 },
  { maxTokens: 8192, systemPrompt: DISTILL_SYSTEM_DIRECT, timeoutMs: 300000 },
];

export async function generatePersonaPack(
  env: Env,
  kolId: string
): Promise<{ persona_pack: string; persona_json: PersonaJson | null; validation: string[] }> {
  const { kol, tweets, corpus } = await buildCorpus(env, kolId);
  const baseMessages = buildDistillMessages(kol, corpus, tweets.length);

  // 3. Distillation with auto-retry: try each budget in GEN_BUDGETS until one parses into a
  // usable persona. Every attempt is logged to persona_experiments so failures are observable
  // (not silently swallowed to "" like the old code).
  let pj: PersonaJson | null = null;
  let usedMaxTokens = 0;
  let lastError: string | null = null;
  for (const { maxTokens, systemPrompt, timeoutMs } of GEN_BUDGETS) {
    try {
      const { content, attempt } = await callPersonaLLM(env, baseMessages, maxTokens, kolId, { timeoutMs, systemPrompt });
      pj = extractPersonaJson(content);
      usedMaxTokens = maxTokens;
      await logPersonaExperiment(env, kolId, { ...attempt, parse_ok: !!pj }, maxTokens, "generate");
      if (pj && (pj.mental_models?.length || 0) >= 1) break; // got something usable
    } catch (e: any) {
      lastError = e instanceof PersonaGenError ? `${e.kind}: ${e.message}` : String(e?.message || e);
      const failAttempt: PersonaGenAttempt = {
        content: "", finish_reason: e instanceof PersonaGenError ? e.kind : "error",
        content_len: 0, duration_ms: 0, parse_ok: false,
        error_type: e instanceof PersonaGenError ? e.kind : "parse_error", note: lastError,
      };
      await logPersonaExperiment(env, kolId, failAttempt, maxTokens, "generate");
      // continue to next budget
    }
  }

  // 4b. Mechanical triple-verification gate (Plan §6c C2): enforce the gate in code, not just the
  // prompt. Drop candidates that recur in <2 topics or are flagged non-exclusive (generic truisms).
  // Models without a verification block are kept (we don't punish the model for omitting it), but if
  // gating would wipe everything we fall back to the raw candidates to avoid an empty pack.
  if (pj?.mental_models?.length) {
    const passed = pj.mental_models.filter((m) => {
      const v = m.verification;
      if (!v) return true;
      const crossDomain = Array.isArray(v.cross_domain_topics) && v.cross_domain_topics.length >= 2;
      const exclusive = v.exclusive !== false;
      return crossDomain && exclusive;
    });
    if (passed.length >= 3) pj.mental_models = passed.slice(0, 7);
  }

  // 5. Build Markdown persona_pack
  const pack = buildMarkdown(kol, pj);

  // 6. Quality validation (lightweight sanity checks)
  const validation = await validatePersona(env, kol, pj, tweets);
  if (!pj) validation.unshift(`FAIL: All ${GEN_BUDGETS.length} distillation attempts failed. Last error: ${lastError || "unknown"}`);

  // Stash which budget succeeded (useful for the caller / logs); harmless if unused by caller.
  void usedMaxTokens;

  return { persona_pack: pack, persona_json: pj, validation };
}

// ---------- Markdown assembly ----------

export function buildMarkdown(kol: any, pj: PersonaJson | null): string {
  const lines: string[] = [];
  const tagline = pj?.mental_models?.[0]?.description || kol.tagline || "Finance commentator";
  lines.push(`## Identity`);
  lines.push(`${kol.display_name} (@${kol.handle}) — ${tagline}`);
  lines.push("");

  if (pj?.mental_models?.length) {
    lines.push(`## Mental Models（心智模型）`);
    pj.mental_models.forEach((m, i) => {
      lines.push(`${i + 1}. **${m.name}**: ${m.description}`);
      if (m.evidence?.length) lines.push(`   - Evidence: ${m.evidence.join(" | ")}`);
      if (m.limitation) lines.push(`   - Limitation: ${m.limitation}`);
    });
    lines.push("");
  }

  if (pj?.decision_heuristics?.length) {
    lines.push(`## Decision Heuristics（决策启发式）`);
    pj.decision_heuristics.forEach((h) => {
      lines.push(`- ${h.rule} — Example: ${h.example}`);
    });
    lines.push("");
  }

  if (pj?.expression_dna) {
    const e = pj.expression_dna;
    lines.push(`## Expression DNA（表达风格）`);
    lines.push(`- Sentence: ${e.sentence_style || "mixed"}`);
    lines.push(`- Vocabulary: ${(e.vocabulary || []).join(", ") || "finance jargon"}`);
    lines.push(`- Humor: ${e.humor || "none"}`);
    lines.push(`- Certainty: ${e.certainty || "assertive"}`);
    lines.push(`- Opening: ${e.opening_pattern || "conclusion-first"}`);
    lines.push("");
  }

  if (pj?.values?.length || pj?.anti_patterns?.length) {
    lines.push(`## Values & Anti-Patterns`);
    if (pj.values?.length) lines.push(`Values: ${pj.values.join(" > ")}`);
    if (pj.anti_patterns?.length) lines.push(`Anti-patterns (NEVER do): ${pj.anti_patterns.join("; ")}`);
    lines.push("");
  }

  if (pj?.tensions?.length) {
    lines.push(`## Internal Tensions`);
    pj.tensions.forEach((t) => lines.push(`- ${t}`));
    lines.push("");
  }

  if (pj?.sector_focus?.length) {
    lines.push(`## Sector Focus（覆盖领域）`);
    lines.push(pj.sector_focus.join(" · "));
    lines.push("");
  }

  if (pj?.track_record?.length) {
    lines.push(`## Track Record（历史判断与结果）`);
    pj.track_record.forEach((t) => lines.push(`- (${t.date}) ${t.call} → ${t.outcome}`));
    lines.push("");
  }

  if (pj?.counter_views?.length) {
    lines.push(`## Counter-Views & Blind Spots（反方视角/盲区）`);
    pj.counter_views.forEach((c) => lines.push(`- ${c}`));
    lines.push("");
  }

  if (pj?.signature_examples?.length) {
    lines.push(`## Signature Examples（金句/语气范例）`);
    pj.signature_examples.forEach((s) => lines.push(`- "${s}"`));
    lines.push("");
  }

  if (pj?.analytical_exemplars?.length) {
    lines.push(`## Analytical Exemplars（分析范例 — 展示博主如何应用框架）`);
    pj.analytical_exemplars.forEach((e, i) => {
      lines.push(`### Exemplar ${i + 1}`);
      lines.push(e);
      lines.push("");
    });
  }

  if (pj?.uncertainty_style?.length) {
    lines.push(`## Uncertainty Style`);
    pj.uncertainty_style.forEach((b) => lines.push(`- ${b}`));
    lines.push("");
  }

  // Auto-generated Agentic Protocol (serenity-style, derived from mental_models)
  lines.push(`## Agentic Protocol（工具调用 SOP）`);
  const dims = deriveAgenticDimensions(pj);
  dims.forEach((d, i) => {
    lines.push(`${i + 1}. **${d.dimension}**: ${d.rationale}`);
    lines.push(`   Tools: ${d.tools.join(" → ")}`);
  });
  lines.push("");

  return lines.join("\n");
}

// ---------- Agentic Protocol auto-derivation ----------

interface AgenticDim {
  dimension: string;
  rationale: string;
  tools: string[];
}

function deriveAgenticDimensions(pj: PersonaJson | null): AgenticDim[] {
  const dims: AgenticDim[] = [];
  if (!pj?.mental_models?.length) {
    // Default dimensions when no persona analysis available
    return [
      { dimension: "Price Action", rationale: "Check current price and recent movement", tools: ["get_quote", "get_kline"] },
      { dimension: "Fundamentals", rationale: "Verify valuation and financial health", tools: ["get_financials", "get_key_indicators"] },
      { dimension: "Market Context", rationale: "Understand macro environment and sector trends", tools: ["get_news", "get_ashare_detail"] },
    ];
  }

  // Derive dimensions from mental model keywords
  const allText = pj.mental_models.map((m) => `${m.name} ${m.description}`).join(" ").toLowerCase();

  if (/value|valuation|fundamental|earnings|pe|cash flow|估值|基本面|盈利/.test(allText)) {
    dims.push({
      dimension: "Fundamental Analysis",
      rationale: "This persona thinks in terms of valuation and business quality",
      tools: ["get_financials", "get_key_indicators", "get_analyst_data"],
    });
  }
  if (/momentum|trend|breakout|technic|volume|动量|趋势|技术|量价/.test(allText)) {
    dims.push({
      dimension: "Technical / Momentum",
      rationale: "This persona focuses on price action and market microstructure",
      tools: ["get_kline", "get_ashare_detail"],
    });
  }
  if (/macro|policy|rate|fed|sector|industry|chain|宏观|政策|产业链|行业/.test(allText)) {
    dims.push({
      dimension: "Macro & Sector Context",
      rationale: "This persona reasons top-down from macro to sector to stock",
      tools: ["get_news", "get_ashare_detail", "get_market_ranking"],
    });
  }
  if (/sentiment|narrative|crowd|psychology|情绪|叙事|人性/.test(allText)) {
    dims.push({
      dimension: "Sentiment & Narrative",
      rationale: "This persona tracks market sentiment and narrative shifts",
      tools: ["get_news", "get_market_ranking"],
    });
  }

  // Always include a base dimension
  dims.push({
    dimension: "Real-time Verification",
    rationale: "Always verify current price and recent news before forming a view",
    tools: ["get_quote", "get_news"],
  });

  return dims.slice(0, 5);
}

// ---------- Quality validation (3 sanity checks) ----------

export async function validatePersona(
  env: Env,
  kol: any,
  pj: PersonaJson | null,
  tweets: any[]
): Promise<string[]> {
  const results: string[] = [];
  if (!pj) {
    results.push("FAIL: Could not parse LLM output as JSON");
    return results;
  }

  // Check 1: mental_models count + how many carry a passing triple-verification block
  const mmCount = pj.mental_models?.length || 0;
  const verified = (pj.mental_models || []).filter(
    (m) => m.verification && (m.verification.cross_domain_topics?.length || 0) >= 2 && m.verification.exclusive !== false
  ).length;
  results.push(mmCount >= 3 ? `PASS: ${mmCount} mental models (${verified} triple-verified)` : `WARN: Only ${mmCount} mental models (expected ≥3)`);

  // Check 2: evidence grounding — verify evidence snippets exist in corpus
  const corpusText = tweets.map((t) => t.text).join(" ");
  let grounded = 0;
  let total = 0;
  for (const m of pj.mental_models || []) {
    for (const ev of m.evidence || []) {
      total++;
      // Fuzzy: check if at least 60% of the evidence words appear in some tweet
      const words = ev.split(/\s+/).filter((w) => w.length > 3);
      const hits = words.filter((w) => corpusText.includes(w)).length;
      if (words.length && hits / words.length >= 0.5) grounded++;
    }
  }
  const groundingPct = total ? Math.round((grounded / total) * 100) : 0;
  results.push(groundingPct >= 60 ? `PASS: Evidence grounding ${groundingPct}%` : `WARN: Evidence grounding low (${groundingPct}%), possible fabrication`);

  // Check 3: style generation test — generate a reply in persona for 1 tweet, check coherence
  if (tweets.length >= 3) {
    const testTweets = tweets.slice(0, 3).map((t) => t.text).join("\n");
    const pack = buildMarkdown(kol, pj);
    const testReply = await completeChat(
      env,
      env.MODEL_FLASH,
      [
        {
          role: "system",
          content: `You are ${kol.display_name}. Write ONE tweet-length reply (<=280 chars) in your exact voice and style to the following tweets. Only output the reply text, nothing else.`,
        },
        { role: "user", content: `Tweets:\n${testTweets}\n\nPersona:\n${pack.slice(0, 2000)}` },
      ],
      { maxTokens: 150 }
    );
    if (testReply && testReply.length > 10 && testReply.length < 400) {
      results.push("PASS: Style generation test coherent");
    } else {
      results.push("WARN: Style generation test — output length unusual");
    }
  }

  return results;
}

// ---------- Incremental evolution (colleague-skill pattern) ----------

export async function evolvePersona(
  env: Env,
  kolId: string
): Promise<{ evolved: boolean; version: string; notes: string[]; needs_review: boolean }> {
  const kol = await env.DB.prepare(
    `SELECT id,display_name,handle,persona_pack,persona_version FROM kols WHERE id=?`
  ).bind(kolId).first<any>();
  if (!kol?.persona_pack) throw new Error(`No existing persona_pack for ${kolId}`);

  // Fetch this week's new tweets
  const since = Math.floor(Date.now() / 1000) - 7 * 86400;
  const r = await env.DB.prepare(
    `SELECT text,created_at_iso FROM tweets
     WHERE kol_id=? AND is_retweet=0 AND created_at_ts>=? ORDER BY created_at_ts DESC LIMIT 120`
  ).bind(kolId, since).all();
  const tweets = (r.results || []) as any[];
  if (tweets.length < 5) return { evolved: false, version: kol.persona_version || "", notes: ["Not enough new tweets"], needs_review: false };

  const corpus = tweets.map((t) => `[${(t.created_at_iso || "").slice(0, 10)}] ${t.text}`).join("\n").slice(0, 12000);

  const raw = await completeChat(
    env,
    env.MODEL_PRO,
    [
      { role: "system", content: EVOLUTION_SYSTEM },
      {
        role: "user",
        content: `EXISTING PERSONA PACK:\n${kol.persona_pack}\n\nNEW TWEETS (${tweets.length} this week):\n${corpus}`,
      },
    ],
    { maxTokens: 2000, temperature: 0.2 }
  );

  let evolution: EvolutionResult | null = null;
  try {
    const cleaned = raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    evolution = JSON.parse(cleaned.match(/\{[\s\S]*\}/)?.[0] || cleaned) as EvolutionResult;
  } catch {}

  const notes: string[] = [];
  const needsReview = !!(evolution?.style_drift || evolution?.contradictions?.length);

  if (!evolution) {
    notes.push("Evolution LLM call failed to parse");
    return { evolved: false, version: kol.persona_version || "", notes, needs_review: false };
  }

  if (evolution.contradictions?.length) {
    notes.push(`Contradictions detected: ${evolution.contradictions.join("; ")}`);
  }
  if (evolution.style_drift) {
    notes.push("Style drift detected — manual review recommended");
  }

  // Merge: append new models + heuristics to existing persona_pack
  let evolvedPack = kol.persona_pack;
  let changed = false;

  if (evolution.new_models?.length) {
    const additions = evolution.new_models.map((m) =>
      `- **${m.name}**: ${m.description}\n  Evidence: ${(m.evidence || []).join(" | ")}\n  Limitation: ${m.limitation || "TBD"}`
    ).join("\n");
    // Append after the Mental Models section
    if (evolvedPack.includes("## Mental Models")) {
      evolvedPack = evolvedPack.replace(/(## Mental Models[\s\S]*?)(\n## )/, `$1${additions}\n$2`);
    } else {
      evolvedPack += `\n## Mental Models (evolved)\n${additions}\n`;
    }
    changed = true;
    notes.push(`+${evolution.new_models.length} new mental models`);
  }

  if (evolution.updated_heuristics?.length) {
    const additions = evolution.updated_heuristics.map((h) =>
      `- ${h.rule} — Example: ${h.example}`
    ).join("\n");
    if (evolvedPack.includes("## Decision Heuristics")) {
      evolvedPack = evolvedPack.replace(/(## Decision Heuristics[\s\S]*?)(\n## )/, `$1${additions}\n$2`);
    } else {
      evolvedPack += `\n## Decision Heuristics (evolved)\n${additions}\n`;
    }
    changed = true;
    notes.push(`+${evolution.updated_heuristics.length} new heuristics`);
  }

  const week = new Date().toISOString().slice(0, 10);
  const version = `v${(parseInt(kol.persona_version?.replace(/\D/g, "") || "1", 10) + 1)}-weekly-${week}`;

  if (changed) {
    await env.DB.prepare(`UPDATE kols SET persona_pack=?, persona_version=?, updated_at=datetime('now') WHERE id=?`)
      .bind(evolvedPack, version, kolId)
      .run();

    // Archive old version as knowledge chunk
    const chunkId = `${kolId}:persona_snapshot:${kol.persona_version || "v0"}`;
    await env.DB.prepare(
      `INSERT OR REPLACE INTO knowledge_chunks (id,kol_id,source,title,text) VALUES (?,?,?,?,?)`
    ).bind(chunkId, kolId, `persona_snapshot:${kol.persona_version || "v0"}`, `Persona snapshot ${kol.persona_version}`, kol.persona_pack).run();
  }

  return { evolved: changed, version, notes, needs_review: needsReview };
}
