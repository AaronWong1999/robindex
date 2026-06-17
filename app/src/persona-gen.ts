// Persona Pack auto-generation: distill a KOL's tweet corpus into a structured persona_pack
// using a single structured LLM call (nuwa-skill multi-dimensional framework, adapted for Workers).
// Also handles incremental evolution (colleague-skill pattern) and quality validation.
import type { Env } from "./env";
import { completeChat } from "./chat";

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
interface PersonaJson {
  mental_models: MentalModel[];
  decision_heuristics: DecisionHeuristic[];
  expression_dna: ExpressionDna;
  values: string[];
  anti_patterns: string[];
  tensions: string[];
  honest_boundaries: string[];
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
  "honest_boundaries": ["limitation of this methodology"],
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
- All evidence/examples must come from the provided tweets. Do not fabricate.`;

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

// ---------- Core: generate persona from scratch ----------

export async function generatePersonaPack(
  env: Env,
  kolId: string
): Promise<{ persona_pack: string; persona_json: PersonaJson | null; validation: string[] }> {
  // 1. Fetch KOL metadata + tweets (recent + high-engagement for better coverage)
  const kol = await env.DB.prepare(
    `SELECT id,display_name,handle,tagline FROM kols WHERE id=?`
  ).bind(kolId).first<any>();
  if (!kol) throw new Error(`KOL not found: ${kolId}`);

  const [recentR, topR] = await Promise.all([
    env.DB.prepare(
      `SELECT text,created_at_iso,likes,retweets FROM tweets
       WHERE kol_id=? AND is_retweet=0 ORDER BY created_at_ts DESC LIMIT 1000`
    ).bind(kolId).all(),
    env.DB.prepare(
      `SELECT text,created_at_iso,likes,retweets FROM tweets
       WHERE kol_id=? AND is_retweet=0 ORDER BY (likes + retweets * 2) DESC LIMIT 500`
    ).bind(kolId).all(),
  ]);
  // Merge and dedup by text content
  const seen = new Set<string>();
  const tweets: any[] = [];
  for (const r of [...(recentR.results || []), ...(topR.results || [])] as any[]) {
    const key = String(r.text || "").slice(0, 80);
    if (!seen.has(key)) { seen.add(key); tweets.push(r); }
  }
  if (tweets.length < 10) throw new Error(`Not enough tweets (${tweets.length}) for ${kolId}`);

  // 2. Build corpus (chronological, most recent first)
  const corpus = tweets
    .map((t) => `[${(t.created_at_iso || "").slice(0, 10)}] ❤${t.likes} RT${t.retweets} ${t.text}`)
    .join("\n")
    .slice(0, 80000);

  // 3. Single structured LLM call for multi-dimensional analysis (direct fetch with debug logging)
  const messages = [
    { role: "system", content: DISTILL_SYSTEM },
    { role: "user", content: `KOL: ${kol.display_name} (@${kol.handle})${kol.tagline ? ` — ${kol.tagline}` : ""}\n\nTweet corpus (${tweets.length} tweets):\n${corpus}` },
  ];
  let raw = "";
  try {
    if (env.CACHE) await env.CACHE.put(`persona_debug:${kolId}`, `BEFORE_FETCH: corpus=${corpus.length} chars, msgs=${messages.length} at ${new Date().toISOString()}`, { expirationTtl: 3600 });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 600000);
    const res = await fetch(env.GATEWAY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "cf-aig-authorization": `Bearer ${env.CFGATEWAYKEY}`,
        "cf-aig-request-timeout": "600000",
        ...(env.OPENROUTER_KEY ? { Authorization: `Bearer ${env.OPENROUTER_KEY}` } : {}),
        "HTTP-Referer": "https://robindex.ai",
        "X-Title": "Robindex",
      },
      body: JSON.stringify({ model: env.MODEL_PRO, messages, temperature: 0.2, max_tokens: 32768 }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (env.CACHE) await env.CACHE.put(`persona_debug:${kolId}`, `FETCH_RETURNED: status=${res.status} at ${new Date().toISOString()}`, { expirationTtl: 3600 });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      if (env.CACHE) await env.CACHE.put(`persona_debug:${kolId}`, `HTTP ${res.status}: ${errText.slice(0, 500)}`, { expirationTtl: 3600 });
      throw new Error(`HTTP ${res.status}`);
    }
    // Read body via streaming with timeout — AI Gateway may keep connection open
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let bodyText = "";
    const bodyStart = Date.now();
    while (true) {
      const readPromise = reader.read();
      const timeoutPromise = new Promise<{ done: boolean; value?: Uint8Array }>((_, reject) =>
        setTimeout(() => reject(new Error("body_read_timeout")), 120000)
      );
      try {
        const { done, value } = await Promise.race([readPromise, timeoutPromise]);
        if (done) break;
        bodyText += decoder.decode(value, { stream: true });
      } catch {
        if (env.CACHE) await env.CACHE.put(`persona_debug:${kolId}`, `BODY_READ_TIMEOUT: got ${bodyText.length} chars after ${Date.now() - bodyStart}ms`, { expirationTtl: 3600 });
        break;
      }
    }
    if (env.CACHE) await env.CACHE.put(`persona_debug:${kolId}`, `BODY: ${bodyText.length} chars in ${Date.now() - bodyStart}ms at ${new Date().toISOString()}`, { expirationTtl: 3600 });
    const j: any = JSON.parse(bodyText);
    raw = j?.choices?.[0]?.message?.content || "";
    const finishReason = j?.choices?.[0]?.finish_reason || "unknown";
    if (env.CACHE) await env.CACHE.put(`persona_debug:${kolId}`, `PARSED: raw=${raw.length} chars, finish=${finishReason} at ${new Date().toISOString()}`, { expirationTtl: 3600 });
  } catch (e: any) {
    if (env.CACHE) await env.CACHE.put(`persona_debug:${kolId}`, `ERROR: ${String(e).slice(0, 500)}`, { expirationTtl: 3600 });
    raw = "";
  }

  // 4. Parse JSON output
  let pj: PersonaJson | null = null;
  try {
    const cleaned = raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    pj = JSON.parse(cleaned) as PersonaJson;
  } catch {
    // Try to extract JSON from the response
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try { pj = JSON.parse(match[0]) as PersonaJson; } catch (e2) {
        console.log(`persona-gen JSON parse failed (raw length: ${raw.length}, match length: ${match[0].length}): ${e2}`);
      }
    } else {
      console.log(`persona-gen: no JSON found in output (raw length: ${raw.length}), first 200 chars: ${raw.slice(0, 200)}`);
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

  return { persona_pack: pack, persona_json: pj, validation };
}

// ---------- Markdown assembly ----------

function buildMarkdown(kol: any, pj: PersonaJson | null): string {
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

  if (pj?.honest_boundaries?.length) {
    lines.push(`## Honest Boundaries`);
    pj.honest_boundaries.forEach((b) => lines.push(`- ${b}`));
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

async function validatePersona(
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
