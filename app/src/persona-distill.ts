// Full-corpus persona distillation via map-reduce.
//
// WHY: the single-call distiller (persona-gen.ts) can only fit an ~80K-char window — for a prolific KOL
// that is the last couple of weeks (~3.8% of the corpus). This module reads 100% of the corpus by
// chunking it chronologically, MAPPING each chunk to a compact partial persona (flash, cheap), then
// hierarchically REDUCING the partials into one consolidated persona (pro, high quality).
//
// Anti-hallucination is enforced in CODE, not just prompts:
//   1. Map asks for VERBATIM evidence quotes; we verify each quote is an exact substring of the chunk
//      it came from and DROP unverifiable evidence (and any model left with none).
//   2. After reduce, we re-verify every carried-forward quote against the FULL corpus.
//   3. analytical_exemplars are not generated at all — they are VERBATIM tweets selected in code, so
//      they cannot be fabricated.
//
// The merged facts are persisted (persona_facts) so the weekly refresh is INCREMENTAL: map only the new
// tweets and reduce them into the stored facts — no re-reading history, no fragile text-append drift.
import type { Env } from "./env";
import {
  type PersonaJson, buildMarkdown, extractPersonaJson, validatePersona, logPersonaExperiment,
} from "./persona-gen";

// ---------- LLM primitive (sets the gateway long-timeout header; reads non-chunked JSON) ----------

async function llmJson(
  env: Env, model: string, messages: { role: string; content: string }[],
  opts: { maxTokens: number; timeoutMs: number; temperature?: number },
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await fetch(env.GATEWAY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "cf-aig-authorization": `Bearer ${env.CFGATEWAYKEY}`,
        "cf-aig-request-timeout": String(opts.timeoutMs),
        ...(env.OPENROUTER_KEY ? { Authorization: `Bearer ${env.OPENROUTER_KEY}` } : {}),
        "HTTP-Referer": "https://robindex.ai",
        "X-Title": "Robindex",
      },
      // Disable the model's chain-of-thought. deepseek-v4 (flash+pro) are reasoning models whose CoT
      // tokens SHARE the max_tokens budget: at our low map/reduce caps the reasoning consumes the whole
      // budget and the response comes back finish_reason=length with EMPTY content (then we'd fall back to
      // a single partial). Map/reduce are structured JSON-extraction/merge tasks — the verbatim-quote gate
      // and triple gate provide the rigor, not CoT — so disabling reasoning makes them emit content
      // directly: non-empty AND fast (well under the ~100s worker limit).
      body: JSON.stringify({ model, messages, temperature: opts.temperature ?? 0.2, max_tokens: opts.maxTokens, reasoning: { enabled: false } }),
      signal: controller.signal,
    });
    if (!res.ok) { console.warn(`llmJson HTTP ${res.status} model=${model}: ${(await res.text().catch(() => "")).slice(0, 300)}`); return ""; }
    const j: any = await res.json().catch(() => null);
    const content = j?.choices?.[0]?.message?.content || "";
    if (!content) console.warn(`llmJson empty content model=${model} finish=${j?.choices?.[0]?.finish_reason} keys=${j ? Object.keys(j).join(",") : "null"}`);
    return content;
  } catch (e) {
    console.warn(`llmJson threw model=${model}: ${String(e).slice(0, 200)}`);
    return "";
  } finally {
    clearTimeout(timer);
  }
}

// Run async fn over items with bounded concurrency (keeps us under gateway rate limits).
async function pool<T, R>(items: T[], n: number, fn: (item: T, idx: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx], idx);
      }
    }),
  );
  return out;
}

// ---------- Corpus loading + chunking ----------

interface Tw { id: string; text: string; created_at_iso: string; created_at_ts: number; likes: number; retweets: number; }

// Page through ALL non-retweet tweets (D1 caps result size, so we paginate) in chronological order.
async function loadAllTweets(env: Env, kolId: string): Promise<Tw[]> {
  const all: Tw[] = [];
  const PAGE = 2000;
  let offset = 0;
  while (true) {
    const r = await env.DB.prepare(
      `SELECT id,text,created_at_iso,created_at_ts,likes,retweets FROM tweets
       WHERE kol_id=? AND is_retweet=0 AND length(text)>=20
       ORDER BY created_at_ts ASC LIMIT ? OFFSET ?`
    ).bind(kolId, PAGE, offset).all();
    const rows = (r.results || []) as any[];
    for (const t of rows) all.push(t as Tw);
    if (rows.length < PAGE) break;
    offset += PAGE;
    if (offset > 60000) break; // hard safety cap
  }
  return all;
}

const fmtTweet = (t: Tw) => `[${(t.created_at_iso || "").slice(0, 10)}] ❤${t.likes} RT${t.retweets} ${t.text}`;

interface Chunk { idx: number; tweets: Tw[]; corpus: string; dateMin: string; dateMax: string; }

// Split tweets into ~chunkChars windows (chronological), capped at maxChunks (older overflow is sampled
// out only for extreme cases; qinbafrank's 2.1M chars → ~30 chunks well under the cap).
function chunkTweets(tweets: Tw[], maxChunks = 32, minChunkChars = 60000): Chunk[] {
  const totalChars = tweets.reduce((a, t) => a + (t.text?.length || 0) + 24, 0);
  const chunkChars = Math.max(minChunkChars, Math.ceil(totalChars / maxChunks));
  const chunks: Chunk[] = [];
  let cur: Tw[] = [];
  let curLen = 0;
  const flush = () => {
    if (!cur.length) return;
    chunks.push({
      idx: chunks.length, tweets: cur, corpus: cur.map(fmtTweet).join("\n"),
      dateMin: (cur[0].created_at_iso || "").slice(0, 10),
      dateMax: (cur[cur.length - 1].created_at_iso || "").slice(0, 10),
    });
    cur = []; curLen = 0;
  };
  for (const t of tweets) {
    const l = fmtTweet(t).length + 1;
    if (curLen + l > chunkChars && cur.length) flush();
    cur.push(t); curLen += l;
  }
  flush();
  return chunks;
}

// FNV-1a hash of the corpus identity (tweet count + first/last id) — invalidates stored chunks when the
// corpus changes so a re-run re-maps rather than reusing stale partials.
function corpusHash(tweets: Tw[]): string {
  const sig = `${tweets.length}:${tweets[0]?.id || ""}:${tweets[tweets.length - 1]?.id || ""}`;
  return fnv1a(sig);
}

function fnv1a(sig: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < sig.length; i++) { h ^= sig.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}

// ---------- Quote verification (the hard anti-hallucination gate) ----------

const normWs = (s: string) => s.replace(/\s+/g, "").toLowerCase();

// A quote is verified if every non-trivial fragment (split on ellipsis / pipe) is an exact substring of
// the normalized corpus. Elided quotes ("A...B") must have both A and B present.
function quoteVerified(quote: string, normCorpus: string): boolean {
  const segs = String(quote || "").split(/\.{2,}|…|\s\|\s/).map(normWs).filter((s) => s.length >= 8);
  if (!segs.length) return true; // too short to verify meaningfully — keep
  return segs.every((s) => normCorpus.includes(s));
}

// Drop unverifiable evidence/quotes from a partial; drop a model that had evidence but kept none.
function verifyPartial(pj: PersonaJson, normCorpus: string): PersonaJson {
  if (pj.mental_models?.length) {
    pj.mental_models = pj.mental_models
      .map((m) => {
        const ev = (m.evidence || []).filter((e) => quoteVerified(e, normCorpus));
        return { ...m, evidence: ev };
      })
      .filter((m) => (m.evidence?.length || 0) > 0 || !(m as any)._hadEvidence);
  }
  if (pj.signature_examples?.length) {
    pj.signature_examples = pj.signature_examples.filter((s) => quoteVerified(s, normCorpus));
  }
  if (pj.analytical_exemplars?.length) {
    pj.analytical_exemplars = pj.analytical_exemplars.filter((s) => quoteVerified(s, normCorpus));
  }
  return pj;
}

// ---------- Prompts ----------

const MAP_SYSTEM = `You extract a PARTIAL persona profile from a BATCH of one finance KOL's tweets.
Output ONLY valid JSON (no markdown fences). Copy every "evidence" string VERBATIM from the tweets in
this batch (you may elide the middle with "..." but each kept fragment must be an exact quote). Do NOT
invent or paraphrase. Only include what THIS batch actually supports.

Schema:
{ "mental_models":[{"name":"","description":"","evidence":["verbatim quote"],"limitation":""}],
  "decision_heuristics":[{"rule":"if X then Y","example":"verbatim or paraphrase"}],
  "expression_dna":{"sentence_style":"","vocabulary":[""],"humor":"","certainty":"","opening_pattern":""},
  "values":[""],"anti_patterns":[""],"tensions":[""],"honest_boundaries":[""],
  "track_record":[{"date":"YYYY-MM-DD","call":"","outcome":""}],
  "counter_views":[""],"sector_focus":[""],"signature_examples":["verbatim short quote"] }

Limits: ≤5 mental_models (≤2 evidence each, each ≤200 chars), ≤6 decision_heuristics, ≤4 track_record
(only dated calls actually in the batch), ≤4 sector_focus, ≤3 signature_examples. Keep it compact.`;

const REDUCE_SYSTEM = `You MERGE several PARTIAL persona JSONs — each distilled from a different time-slice
of ONE finance KOL's tweets — into a single consolidated persona JSON. Output ONLY valid JSON (no fences).

Rules:
- mental_models: merge semantically-equivalent models across partials into one. PREFER models that recur
  in MULTIPLE partials — those are the KOL's enduring frameworks; rank them first. Keep up to 8. Merge
  their evidence (keep up to 4 quotes each). For each model add a "verification" block:
  {"cross_domain_topics":["topicA","topicB"],"generative_test":"a fresh stance it predicts","exclusive":true}
  (exclusive=false for generic market truisms).
- decision_heuristics: dedupe, keep 6-12.
- expression_dna: synthesize the single best-supported profile.
- values / anti_patterns / tensions / honest_boundaries / counter_views / sector_focus: union, dedupe,
  keep the ~8 most representative each.
- track_record: union, dedupe by date+call, newest first, keep up to 10.
- signature_examples: union, keep up to 6.
- CRITICAL: never fabricate or alter evidence/quotes. Only carry forward strings that appear in the
  inputs, verbatim.

Output schema = a full persona JSON: mental_models (with verification), decision_heuristics,
expression_dna, values, anti_patterns, tensions, honest_boundaries, track_record, counter_views,
sector_focus, signature_examples.`;

// ---------- Map ----------

async function mapChunk(env: Env, chunk: Chunk): Promise<PersonaJson | null> {
  const user = `Tweet batch (${chunk.tweets.length} tweets, ${chunk.dateMin}..${chunk.dateMax}):\n${chunk.corpus}`;
  // Two attempts: dense/older chunks sometimes overflow the token cap (truncated → invalid JSON) or
  // return empty under load. Retry once with a bigger budget, temp 0, and a hard JSON-only reminder.
  const attempts: Array<{ maxTokens: number; sys: string; temp: number }> = [
    { maxTokens: 4096, sys: MAP_SYSTEM, temp: 0.2 },
    { maxTokens: 6000, sys: MAP_SYSTEM + `\n\nIMPORTANT: output ONLY the JSON object, starting with "{" and ending with "}". Keep it compact (fewer items) so it is COMPLETE and valid.`, temp: 0 },
  ];
  for (const a of attempts) {
    const raw = await llmJson(env, env.MODEL_FLASH, [
      { role: "system", content: a.sys },
      { role: "user", content: user },
    ], { maxTokens: a.maxTokens, timeoutMs: 180000, temperature: a.temp });
    const pj = extractPersonaJson(raw);
    if (pj && (pj.mental_models?.length || pj.decision_heuristics?.length)) {
      for (const m of pj.mental_models || []) (m as any)._hadEvidence = (m.evidence?.length || 0) > 0;
      return verifyPartial(pj, normWs(chunk.corpus));
    }
  }
  return null;
}

// ---------- Reduce (hierarchical; single pro call when the partials fit) ----------

const REDUCE_INPUT_BUDGET = 90000; // chars of combined partial JSON we'll send to one reduce call

// HARD output limits for the FINAL merge. Without them the model fills ANY max_tokens budget (it emits all
// evidence from every partial and never finishes — tested: finish=length at both 6k AND 16k tokens, the
// latter taking 247s) so the JSON comes back truncated/unparseable. With these caps it finishes naturally
// (finish=stop) at ~2.9k tokens / ~57s — complete, parseable, AND well under the ~100s worker limit.
const FINAL_REDUCE_LIMITS = `\n\nHARD OUTPUT LIMITS (the JSON MUST be COMPLETE and valid — do not exceed): ≤6 mental_models, each with ≤2 short evidence quotes and a description ≤200 chars; ≤8 decision_heuristics; ≤6 track_record; ≤6 items in every other list. Prefer the most enduring/recurring items. Be concise.`;

async function reducePartials(
  env: Env, partials: PersonaJson[], maxTokens = 16384, compact = false, finalLimits = false,
): Promise<PersonaJson | null> {
  if (!partials.length) return null;
  if (partials.length === 1) return partials[0];

  const serialized = partials.map((p) => JSON.stringify(stripInternal(p)));
  const combined = serialized.reduce((a, s) => a + s.length, 0);

  // Split if the combined partials would overflow a single reduce call's input budget.
  if (combined > REDUCE_INPUT_BUDGET && partials.length > 2) {
    const mid = Math.ceil(partials.length / 2);
    const [a, b] = await Promise.all([
      reducePartials(env, partials.slice(0, mid), maxTokens, compact, finalLimits),
      reducePartials(env, partials.slice(mid), maxTokens, compact, finalLimits),
    ]);
    return reducePartials(env, [a, b].filter(Boolean) as PersonaJson[], maxTokens, compact, finalLimits);
  }

  const sys = (compact
    ? REDUCE_SYSTEM + `\n\nThis is an INTERMEDIATE merge — be concise: keep evidence to ≤3 short quotes per model and prefer brevity so the JSON stays compact and COMPLETE.`
    : REDUCE_SYSTEM) + (finalLimits ? FINAL_REDUCE_LIMITS : "");
  const raw = await llmJson(env, env.MODEL_PRO, [
    { role: "system", content: sys },
    { role: "user", content: `PARTIAL persona JSONs to merge (${partials.length}):\n${serialized.map((s, i) => `--- partial ${i + 1} ---\n${s}`).join("\n")}` },
  ], { maxTokens, timeoutMs: 480000, temperature: 0.2 });
  return extractPersonaJson(raw) || partials[0];
}

function stripInternal(p: PersonaJson): PersonaJson {
  const c: any = JSON.parse(JSON.stringify(p));
  for (const m of c.mental_models || []) delete m._hadEvidence;
  return c;
}

// ---------- analytical_exemplars: verbatim tweet selection (zero hallucination risk) ----------

const ANALYTIC_RE = /(因为|所以|逻辑|估值|增速|本质|意味着|代表|拆解|复盘|框架|趋势|because|valuation|implies|therefore|margin|growth)/i;

function selectExemplars(tweets: Tw[], count = 5): string[] {
  const cands = tweets
    .filter((t) => { const L = (t.text || "").length; return L >= 280 && L <= 2200 && ANALYTIC_RE.test(t.text); })
    .map((t) => ({ t, score: (t.text.length) * Math.log10(2 + (t.likes || 0) + (t.retweets || 0) * 2) }))
    .sort((a, b) => b.score - a.score);
  const out: string[] = [];
  const seenMonth = new Set<string>();
  // First pass: enforce date diversity (one per month) for breadth.
  for (const { t } of cands) {
    const mo = (t.created_at_iso || "").slice(0, 7);
    if (seenMonth.has(mo)) continue;
    seenMonth.add(mo); out.push(t.text);
    if (out.length >= count) return out;
  }
  // Fill remaining slots with the next-best regardless of month.
  for (const { t } of cands) {
    if (out.includes(t.text)) continue;
    out.push(t.text);
    if (out.length >= count) break;
  }
  return out;
}

// ---------- Triple-verification gate (same policy as persona-gen) ----------

function applyTripleGate(pj: PersonaJson): void {
  if (!pj.mental_models?.length) return;
  const passed = pj.mental_models.filter((m) => {
    const v = m.verification;
    if (!v) return true;
    const cross = Array.isArray(v.cross_domain_topics) && v.cross_domain_topics.length >= 2;
    return cross && v.exclusive !== false;
  });
  if (passed.length >= 3) pj.mental_models = passed.slice(0, 8);
}

// ---------- persona_facts persistence ----------

async function saveMerged(env: Env, kolId: string, pj: PersonaJson, tweets: Tw[]): Promise<void> {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO persona_facts (id,kol_id,kind,chunk_idx,corpus_hash,json,tweets_covered,date_min,date_max,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))`
  ).bind(
    `${kolId}:merged`, kolId, "merged", null, corpusHash(tweets), JSON.stringify(pj),
    tweets.length, (tweets[0]?.created_at_iso || "").slice(0, 10), (tweets[tweets.length - 1]?.created_at_iso || "").slice(0, 10),
  ).run();
}

export async function loadMergedFacts(env: Env, kolId: string): Promise<PersonaJson | null> {
  const r = await env.DB.prepare(`SELECT json FROM persona_facts WHERE id=?`).bind(`${kolId}:merged`).first<any>();
  if (!r?.json) return null;
  try { return JSON.parse(r.json) as PersonaJson; } catch { return null; }
}

// Voice-refine iteration: the full-corpus reduce captures durable FRAMEWORKS well but tends to abstract
// away the KOL's vivid VOICE (eval showed a voice-fidelity dip vs the recency pack). This re-derives the
// Expression DNA + signature 金句 from a vivid recent+top sample and splices them into the merged facts,
// keeping the full-corpus mental models / track record. One flash call; finishes instantly.
export async function refineVoice(env: Env, kolId: string): Promise<DistillResult> {
  const kol = await env.DB.prepare(`SELECT id,display_name,handle,tagline FROM kols WHERE id=?`).bind(kolId).first<any>();
  if (!kol) throw new Error(`KOL not found: ${kolId}`);
  const merged = await loadMergedFacts(env, kolId);
  if (!merged) throw new Error(`No merged facts for ${kolId} — run reduce first`);

  // Vivid sample: recent + most-engaged tweets (the voice that resonates).
  const [recentR, topR] = await Promise.all([
    env.DB.prepare(`SELECT text,likes,retweets FROM tweets WHERE kol_id=? AND is_retweet=0 AND length(text)>=12 ORDER BY created_at_ts DESC LIMIT 200`).bind(kolId).all(),
    env.DB.prepare(`SELECT text,likes,retweets FROM tweets WHERE kol_id=? AND is_retweet=0 AND length(text)>=12 ORDER BY (likes+retweets*2) DESC LIMIT 200`).bind(kolId).all(),
  ]);
  const seen = new Set<string>();
  const sample: any[] = [];
  for (const t of [...(recentR.results || []), ...(topR.results || [])] as any[]) {
    const k = String(t.text || "").slice(0, 60);
    if (!seen.has(k)) { seen.add(k); sample.push(t); }
  }
  const voiceCorpus = sample.map((t) => t.text).join("\n").slice(0, 30000);

  // Re-derive Expression DNA from the vivid sample (flash).
  const dnaRaw = await llmJson(env, env.MODEL_FLASH, [
    { role: "system", content: `Extract this finance KOL's VOICE fingerprint from their tweets. Output ONLY JSON: {"sentence_style":"short/long/mixed (with nuance)","vocabulary":["8-16 signature recurring words/phrases VERBATIM"],"humor":"","certainty":"","opening_pattern":""}. Be specific and vivid — capture what makes them sound like THEM.` },
    { role: "user", content: voiceCorpus },
  ], { maxTokens: 800, timeoutMs: 120000, temperature: 0.2 });
  let dnaObj: any = null;
  try { dnaObj = JSON.parse(dnaRaw.replace(/```json?\n?/g, "").replace(/```/g, "").trim()); }
  catch { const m = dnaRaw.match(/\{[\s\S]*\}/); if (m) { try { dnaObj = JSON.parse(m[0]); } catch {} } }
  if (dnaObj?.sentence_style) merged.expression_dna = dnaObj;

  // Signature 金句: verbatim short punchy high-engagement tweets (zero hallucination).
  const sigs = sample
    .filter((t) => { const L = (t.text || "").length; return L >= 12 && L <= 140; })
    .map((t) => ({ t, s: Math.log10(2 + (t.likes || 0) + (t.retweets || 0) * 2) }))
    .sort((a, b) => b.s - a.s)
    .map((x) => String(x.t.text).replace(/\s+/g, " ").trim());
  const uniqSigs: string[] = [];
  for (const s of sigs) { if (!uniqSigs.some((u) => u.slice(0, 20) === s.slice(0, 20))) uniqSigs.push(s); if (uniqSigs.length >= 6) break; }
  if (uniqSigs.length >= 3) merged.signature_examples = uniqSigs;

  await saveMerged(env, kolId, merged, sample as Tw[]);
  const pack = buildMarkdown(kol, merged);
  return {
    persona_pack: pack, persona_json: merged,
    validation: [`INFO: voice-refined (DNA + ${merged.signature_examples?.length || 0} 金句 from vivid sample) over full-corpus frameworks`],
    stats: { tweets: sample.length, chunks: 0, mapped_ok: 0, models: merged.mental_models?.length || 0, exemplars: merged.analytical_exemplars?.length || 0 },
  };
}

// Render the pack from the already-merged facts — no LLM calls, so it always finishes instantly. Used to
// publish a merged result whose reduce completed but whose render/validate step ran past the worker limit.
export async function renderMergedPack(env: Env, kolId: string): Promise<DistillResult> {
  const kol = await env.DB.prepare(`SELECT id,display_name,handle,tagline FROM kols WHERE id=?`).bind(kolId).first<any>();
  if (!kol) throw new Error(`KOL not found: ${kolId}`);
  const merged = await loadMergedFacts(env, kolId);
  if (!merged) throw new Error(`No merged facts for ${kolId} — run reduce first`);
  const pack = buildMarkdown(kol, merged);
  const m = merged.mental_models?.length || 0;
  const validation = [
    `INFO: rendered from stored merged facts (map-reduce full corpus)`,
    m >= 3 ? `PASS: ${m} mental models` : `WARN: only ${m} mental models`,
    `INFO: ${merged.analytical_exemplars?.length || 0} verbatim exemplars, ${merged.track_record?.length || 0} track-record items`,
  ];
  return {
    persona_pack: pack, persona_json: merged, validation,
    stats: { tweets: 0, chunks: 0, mapped_ok: 0, models: m, exemplars: merged.analytical_exemplars?.length || 0 },
  };
}

// ---------- Public: full distillation ----------

export interface DistillResult {
  persona_pack: string;
  persona_json: PersonaJson | null;
  validation: string[];
  stats: { tweets: number; chunks: number; mapped_ok: number; models: number; exemplars: number };
}

// MAP STAGE (resumable, bounded). Maps up to `batch` not-yet-cached chunks and persists each partial.
// Returns progress so a driver can call this repeatedly until remaining===0 — each call stays well under
// Cloudflare's ~100s edge timeout (the whole corpus can't be mapped in one synchronous request).
export async function mapStage(
  env: Env, kolId: string, opts: { batch?: number; maxChunks?: number } = {},
): Promise<{ total: number; cached: number; mapped: number; remaining: number; hash: string }> {
  const tweets = await loadAllTweets(env, kolId);
  if (tweets.length < 20) throw new Error(`Not enough tweets (${tweets.length}) for ${kolId}`);
  const chunks = chunkTweets(tweets, opts.maxChunks ?? 32);
  const hash = corpusHash(tweets);

  const existing = await env.DB.prepare(
    `SELECT chunk_idx FROM persona_facts WHERE kol_id=? AND kind='chunk' AND corpus_hash=?`
  ).bind(kolId, hash).all();
  const cachedIdx = new Set<number>(((existing.results || []) as any[]).map((r) => r.chunk_idx));

  const todo = chunks.filter((c) => !cachedIdx.has(c.idx)).slice(0, opts.batch ?? chunks.length);
  let mapped = 0;
  await pool(todo, 6, async (chunk) => {
    const pj = await mapChunk(env, chunk);
    if (pj) {
      await env.DB.prepare(
        `INSERT OR REPLACE INTO persona_facts (id,kol_id,kind,chunk_idx,corpus_hash,json,tweets_covered,date_min,date_max,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))`
      ).bind(
        `${kolId}:chunk:${chunk.idx}:${hash}`, kolId, "chunk", chunk.idx, hash,
        JSON.stringify(stripInternal(pj)), chunk.tweets.length, chunk.dateMin, chunk.dateMax,
      ).run();
      mapped++;
    }
  });
  const cachedNow = cachedIdx.size + mapped;
  return { total: chunks.length, cached: cachedNow, mapped, remaining: chunks.length - cachedNow, hash };
}

const REDUCE_GROUP_SIZE = 4; // chunk partials merged per group-reduce (one pro call each; small = fast)

async function loadChunkPartials(env: Env, kolId: string): Promise<{ partials: PersonaJson[]; hash: string; tweets: Tw[] }> {
  const tweets = await loadAllTweets(env, kolId);
  const hash = corpusHash(tweets);
  const rows = await env.DB.prepare(
    `SELECT json FROM persona_facts WHERE kol_id=? AND kind='chunk' AND corpus_hash=? ORDER BY chunk_idx ASC`
  ).bind(kolId, hash).all();
  const partials: PersonaJson[] = [];
  for (const r of (rows.results || []) as any[]) { try { partials.push(JSON.parse(r.json)); } catch {} }
  return { partials, hash, tweets };
}

// REDUCE — LEVEL 1 (resumable, one pro call per group): merge chunk partials [g*8 .. g*8+8) into an
// intermediate, persisted as kind='reduce_l1'. Driver calls group 0..groups-1, each well under the edge
// timeout (a single pro call). This is what makes a 32-chunk reduce fit Cloudflare's request limit.
export async function reduceGroup(env: Env, kolId: string, groupIdx: number): Promise<{ group: number; groups: number; ok: boolean }> {
  const { partials, hash } = await loadChunkPartials(env, kolId);
  if (!partials.length) throw new Error(`No mapped chunks for ${kolId} — run mapStage first`);
  const groups = Math.ceil(partials.length / REDUCE_GROUP_SIZE);
  if (groupIdx < 0 || groupIdx >= groups) return { group: groupIdx, groups, ok: false };
  // Idempotent: if this group's intermediate already exists for the current corpus, skip the pro call.
  const have = await env.DB.prepare(`SELECT 1 FROM persona_facts WHERE id=?`).bind(`${kolId}:reduce_l1:${groupIdx}:${hash}`).first();
  if (have) return { group: groupIdx, groups, ok: true };
  const slice = partials.slice(groupIdx * REDUCE_GROUP_SIZE, (groupIdx + 1) * REDUCE_GROUP_SIZE);
  // Low output cap is critical: a pro reduce emitting N tokens takes ~N/65 s, and the Worker has a hard
  // ~100s execution limit. 4000 tokens (~60s) leaves margin; a 4-partial merge fits easily.
  const merged = await reducePartials(env, slice, 4000, true);
  if (merged) {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO persona_facts (id,kol_id,kind,chunk_idx,corpus_hash,json,tweets_covered,date_min,date_max,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))`
    ).bind(`${kolId}:reduce_l1:${groupIdx}:${hash}`, kolId, "reduce_l1", groupIdx, hash, JSON.stringify(stripInternal(merged)), null, null, null).run();
  }
  return { group: groupIdx, groups, ok: !!merged };
}

// REDUCE — FINAL: merge the level-1 intermediates into the consolidated persona, verify against the full
// corpus, attach verbatim exemplars, persist merged facts, render the pack.
export async function reduceFinal(env: Env, kolId: string): Promise<DistillResult> {
  const kol = await env.DB.prepare(`SELECT id,display_name,handle,tagline FROM kols WHERE id=?`).bind(kolId).first<any>();
  if (!kol) throw new Error(`KOL not found: ${kolId}`);
  const { hash, tweets } = await loadChunkPartials(env, kolId);
  const rows = await env.DB.prepare(
    `SELECT json FROM persona_facts WHERE kol_id=? AND kind='reduce_l1' AND corpus_hash=? ORDER BY chunk_idx ASC`
  ).bind(kolId, hash).all();
  const l1: PersonaJson[] = [];
  for (const r of (rows.results || []) as any[]) { try { l1.push(JSON.parse(r.json)); } catch {} }
  if (!l1.length) throw new Error(`No reduce_l1 groups for ${kolId} — run reduceGroup first`);

  // Cap the final output too (~6000 tokens ≈ 90s, under the worker limit). A complete persona JSON
  // (models + heuristics + lists; exemplars are attached in code) fits well within this.
  let merged = await reducePartials(env, l1, 6000);
  if (!merged) throw new Error(`Final reduce failed for ${kolId}`);

  const normFull = normWs(tweets.map((t) => t.text).join("\n"));
  merged = verifyPartial(merged, normFull);
  merged.analytical_exemplars = selectExemplars(tweets, 5);
  applyTripleGate(merged);
  await saveMerged(env, kolId, merged, tweets);

  // Cheap, no-LLM validation: keeps reduceFinal comfortably under the ~100s worker limit (the LLM
  // style-test in validatePersona would push it over). Deep validation happens in the eval phase.
  const pack = buildMarkdown(kol, merged);
  const mm = merged.mental_models?.length || 0;
  const validation = [
    `INFO: map-reduce over ${tweets.length} tweets, ${l1.length} group-merges → final`,
    mm >= 3 ? `PASS: ${mm} mental models` : `WARN: only ${mm} mental models`,
    `INFO: ${merged.analytical_exemplars?.length || 0} verbatim exemplars, ${merged.track_record?.length || 0} track-record items`,
  ];
  return {
    persona_pack: pack, persona_json: merged, validation,
    stats: { tweets: tweets.length, chunks: l1.length, mapped_ok: l1.length, models: mm, exemplars: merged.analytical_exemplars?.length || 0 },
  };
}

// REDUCE — FINAL, SPLIT INTO TWO BUDGET-SAFE STEPS (for the automated orchestrator). reduceFinal above
// does the pro merge AND the full-corpus load + verification in one invocation — together ~90s+, which
// flirts with the ~100s worker limit and gets killed when chained (no client to retry). These two split
// it so neither step is close to the edge:
//
//   reduceFinalDraft — the ONLY LLM call: merge the l1 intermediates with pro, persist the raw result as
//   a 'merged_draft' fact. No full-corpus load (uses the cheap signature hash), so it's just the pro call.
export async function reduceFinalDraft(env: Env, kolId: string): Promise<{ ok: boolean; groups: number; len: number }> {
  // Derive the corpus_hash from the stored reduce_l1 rows (newest set) rather than recomputing it — that
  // matches the groups by construction (no dependency on hashing large tweet ids identically across read
  // paths) and stays LLM-only (no full-corpus load), keeping this step well under the ~100s limit.
  const latest = await env.DB.prepare(
    `SELECT corpus_hash FROM persona_facts WHERE kol_id=? AND kind='reduce_l1' ORDER BY updated_at DESC, chunk_idx DESC LIMIT 1`
  ).bind(kolId).first<any>();
  const hash = latest?.corpus_hash;
  if (!hash) throw new Error(`No reduce_l1 groups for ${kolId} — run reduceGroup first`);
  const rows = await env.DB.prepare(
    `SELECT json FROM persona_facts WHERE kol_id=? AND kind='reduce_l1' AND corpus_hash=? ORDER BY chunk_idx ASC`
  ).bind(kolId, hash).all();
  const l1: PersonaJson[] = [];
  for (const r of (rows.results || []) as any[]) { try { l1.push(JSON.parse(r.json)); } catch {} }
  if (!l1.length) throw new Error(`No reduce_l1 groups for ${kolId} — run reduceGroup first`);
  // finalLimits=true bounds the output so it finishes naturally and parses; cap 8000 is generous headroom
  // (a bounded merge lands ~3k tokens). A truncated merge would silently fall back to a single partial.
  const merged = await reducePartials(env, l1, 8000, false, true);
  if (!merged) throw new Error(`Final reduce failed for ${kolId}`);
  // Guard: reducePartials returns partials[0] on parse failure. If the merge didn't actually consolidate
  // (result === first partial), treat it as a failure rather than persisting a degraded single-group pack.
  if (l1.length > 1 && JSON.stringify(stripInternal(merged)) === JSON.stringify(stripInternal(l1[0]))) {
    throw new Error(`Final reduce produced no merge (fell back to a single partial) for ${kolId}`);
  }
  await env.DB.prepare(
    `INSERT OR REPLACE INTO persona_facts (id,kol_id,kind,chunk_idx,corpus_hash,json,tweets_covered,date_min,date_max,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,datetime('now'))`
  ).bind(`${kolId}:merged_draft`, kolId, "merged_draft", null, hash, JSON.stringify(stripInternal(merged)), null, null, null).run();
  return { ok: true, groups: l1.length, len: JSON.stringify(merged).length };
}

//   finalizeMerged — LLM-FREE: load the draft + full corpus, verify every quote verbatim (anti-
//   hallucination gate), attach verbatim exemplars, apply the triple gate, persist the 'merged' fact,
//   render the pack. Just D1 + CPU, so it finishes well under the limit.
export async function finalizeMerged(env: Env, kolId: string): Promise<DistillResult> {
  const kol = await env.DB.prepare(`SELECT id,display_name,handle,tagline FROM kols WHERE id=?`).bind(kolId).first<any>();
  if (!kol) throw new Error(`KOL not found: ${kolId}`);
  const draft = await env.DB.prepare(`SELECT json FROM persona_facts WHERE id=?`).bind(`${kolId}:merged_draft`).first<any>();
  if (!draft?.json) throw new Error(`No merged_draft for ${kolId} — run reduceFinalDraft first`);
  let merged: PersonaJson = JSON.parse(draft.json);

  const tweets = await loadAllTweets(env, kolId);
  const normFull = normWs(tweets.map((t) => t.text).join("\n"));
  merged = verifyPartial(merged, normFull);
  merged.analytical_exemplars = selectExemplars(tweets, 5);
  applyTripleGate(merged);
  await saveMerged(env, kolId, merged, tweets);

  const pack = buildMarkdown(kol, merged);
  const mm = merged.mental_models?.length || 0;
  const validation = [
    `INFO: map-reduce final over ${tweets.length} tweets → merged (verified, exemplars attached)`,
    mm >= 3 ? `PASS: ${mm} mental models` : `WARN: only ${mm} mental models`,
    `INFO: ${merged.analytical_exemplars?.length || 0} verbatim exemplars, ${merged.track_record?.length || 0} track-record items`,
  ];
  return {
    persona_pack: pack, persona_json: merged, validation,
    stats: { tweets: tweets.length, chunks: 0, mapped_ok: 0, models: mm, exemplars: merged.analytical_exemplars?.length || 0 },
  };
}

// All-in-one reduce (small corpora / incremental, where partials fit one or two calls).
export async function reduceStage(env: Env, kolId: string): Promise<DistillResult> {
  const kol = await env.DB.prepare(`SELECT id,display_name,handle,tagline FROM kols WHERE id=?`).bind(kolId).first<any>();
  if (!kol) throw new Error(`KOL not found: ${kolId}`);
  const { partials, tweets } = await loadChunkPartials(env, kolId);
  if (!partials.length) throw new Error(`No mapped chunks for ${kolId} — run mapStage first`);
  let merged = await reducePartials(env, partials);
  if (!merged) throw new Error(`Reduce stage failed for ${kolId}`);
  const normFull = normWs(tweets.map((t) => t.text).join("\n"));
  merged = verifyPartial(merged, normFull);
  merged.analytical_exemplars = selectExemplars(tweets, 5);
  applyTripleGate(merged);
  await saveMerged(env, kolId, merged, tweets);
  const pack = buildMarkdown(kol, merged);
  const validation = await validatePersona(env, kol, merged, tweets);
  validation.unshift(`INFO: map-reduce over ${tweets.length} tweets, ${partials.length} chunk partials merged`);
  return {
    persona_pack: pack, persona_json: merged, validation,
    stats: { tweets: tweets.length, chunks: partials.length, mapped_ok: partials.length, models: merged.mental_models?.length || 0, exemplars: merged.analytical_exemplars?.length || 0 },
  };
}

// Convenience for small corpora that finish within one request (map + reduce in one go).
export async function distillPersonaFull(
  env: Env, kolId: string, opts: { maxChunks?: number } = {},
): Promise<DistillResult> {
  await mapStage(env, kolId, opts);
  return reduceStage(env, kolId);
}

// ---------- Public: incremental weekly refresh ----------

// Map only NEW tweets since `sinceTs`, reduce them INTO the stored merged facts, re-render. Falls back to
// a full distill when there are no stored facts yet. Returns changed=false when there's nothing new.
export async function distillPersonaIncremental(
  env: Env, kolId: string, sinceTs: number,
): Promise<{ changed: boolean; result?: DistillResult; note: string }> {
  const prior = await loadMergedFacts(env, kolId);
  if (!prior) {
    const result = await distillPersonaFull(env, kolId);
    return { changed: true, result, note: "no prior facts — ran full distill" };
  }

  const r = await env.DB.prepare(
    `SELECT id,text,created_at_iso,created_at_ts,likes,retweets FROM tweets
     WHERE kol_id=? AND is_retweet=0 AND length(text)>=20 AND created_at_ts>=? ORDER BY created_at_ts ASC`
  ).bind(kolId, sinceTs).all();
  const fresh = (r.results || []) as unknown as Tw[];
  if (fresh.length < 5) return { changed: false, note: `only ${fresh.length} new tweets — skipped` };

  const kol = await env.DB.prepare(`SELECT id,display_name,handle,tagline FROM kols WHERE id=?`).bind(kolId).first<any>();
  const chunks = chunkTweets(fresh, 4);
  const newPartials = (await pool(chunks, 4, (chunk) => mapChunk(env, chunk))).filter(Boolean) as PersonaJson[];
  if (!newPartials.length) return { changed: false, note: "new tweets produced no partials" };

  // Reduce with the existing consolidated persona as the FIRST input so it's preserved/refined.
  let merged = await reducePartials(env, [prior, ...newPartials]);
  if (!merged) return { changed: false, note: "incremental reduce failed" };

  // Re-verify the NEW partials' contribution against the fresh corpus; keep prior exemplars, refresh with
  // recent ones for currency.
  const normFresh = normWs(fresh.map((t) => t.text).join("\n"));
  merged = verifyPartial(merged, normFresh.length > 200 ? normFresh + normWs(JSON.stringify(prior)) : normWs(JSON.stringify(prior)));
  const freshExemplars = selectExemplars(fresh, 2);
  merged.analytical_exemplars = Array.from(new Set([...freshExemplars, ...(prior.analytical_exemplars || [])])).slice(0, 5);
  applyTripleGate(merged);

  // Persist (use full tweet span metadata via a light count query for date bounds).
  await saveMerged(env, kolId, merged, fresh);

  const pack = buildMarkdown(kol, merged);
  const validation = await validatePersona(env, kol, merged, fresh);
  validation.unshift(`INFO: incremental reduce of ${fresh.length} new tweets in ${chunks.length} chunk(s)`);
  await logPersonaExperiment(env, kolId, {
    content: "", finish_reason: "stop", content_len: pack.length, duration_ms: 0,
    parse_ok: true, error_type: null, note: `incremental distill: +${fresh.length} tweets, models=${merged.mental_models?.length}`,
  }, 0, "distill_incremental");

  return { changed: true, result: { persona_pack: pack, persona_json: merged, validation, stats: { tweets: fresh.length, chunks: chunks.length, mapped_ok: newPartials.length, models: merged.mental_models?.length || 0, exemplars: merged.analytical_exemplars?.length || 0 } }, note: "ok" };
}
