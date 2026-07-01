import type { Env } from "./env";
import { completeChat } from "./chat";
import type { QueryPlan } from "./query-plan";
import { EMPTY_PLAN } from "./query-plan";
import { getEtfHoldings } from "./etf";

export interface QuotedTweet {
  id: string;
  text: string;
  handle: string;
  name: string;
  url: string;
  date?: string;
}
export interface Citation {
  ref: string;        // 'T1'
  tweet_id: string;
  url: string;
  date: string;
  snippet: string;
  relevance_score?: number;
  quoted?: QuotedTweet | null;  // nested quoted tweet (themarketbrew-style), when available
}
export interface RetrievedKnowledge {
  source: string;
  title: string | null;
  text: string;
  relevance_score?: number;
}

const DEDUP_COSINE_THRESHOLD = 0.95;  // tweets this similar to each other → keep only the best

// Lightweight text similarity using Jaccard coefficient on word bigrams.
// Used for dedup — avoids including near-duplicate tweets in citations.
function textSimilarity(a: string, b: string): number {
  const bigrams = (s: string) => {
    const compact = s.toLowerCase().replace(/\s+/g, " ").trim();
    const words = /[\u3400-\u9fff]/.test(compact)
      ? Array.from(compact.replace(/\s+/g, ""))
      : compact.split(/\s+/);
    const set = new Set<string>();
    for (let i = 0; i < words.length - 1; i++) set.add(`${words[i]} ${words[i + 1]}`);
    return set;
  };
  const sa = bigrams(a);
  const sb = bigrams(b);
  if (!sa.size || !sb.size) return 0;
  let intersection = 0;
  for (const bg of sa) if (sb.has(bg)) intersection++;
  return intersection / (sa.size + sb.size - intersection);
}

function tokenize(text: string): string[] {
  const raw = String(text || "").toLowerCase();
  const tokens = new Set<string>();
  for (const m of raw.matchAll(/\$?[a-z][a-z0-9.]{1,12}|[\u3400-\u9fff]{2,}/gi)) {
    const t = m[0].replace(/^\$/, "");
    if (t.length >= 2) tokens.add(t);
  }
  const cjk = raw.match(/[\u3400-\u9fff]{2,}/g) || [];
  for (const span of cjk) {
    for (let n = 2; n <= 4; n++) {
      for (let i = 0; i <= span.length - n; i++) tokens.add(span.slice(i, i + n));
    }
  }
  return Array.from(tokens).slice(0, 80);
}

const RAW_QUERY_NOISE = new Set([
  "etf", "stock", "stocks", "fund", "个股", "股票", "基金", "行业", "周期",
  "现在", "当前", "买入", "值得", "判断", "如何", "怎么", "请区分", "认为",
]);
const INSTRUMENT_ANCHOR_NOISE = new Set([
  ...RAW_QUERY_NOISE,
  "ai", "科技", "技术", "半导体", "芯片", "市场", "宏观", "流动性", "估值", "风险",
  "technology", "semiconductor", "market", "macro", "liquidity", "valuation", "risk",
]);

function deterministicRawAnchors(query: string): string[] {
  const noisyFragment = /(?:你|我|认为|如何|怎么|现在|当前|是否|值得|买入|能买吗|能买|判断|请|区分|个股|股票|基金|行业|周期)/;
  const anchors = tokenize(query).filter((term) => {
    const normalized = term.toLowerCase().replace(/^\$/, "");
    if (RAW_QUERY_NOISE.has(normalized)) return false;
    if (/^[a-z]/.test(normalized)) return !["the", "and", "with"].includes(normalized);
    return !noisyFragment.test(normalized);
  });
  return anchors.length ? anchors : tokenize(query);
}

function explicitTickerTerms(query: string): string[] {
  return Array.from(query.matchAll(/(?:\$|\b)([A-Z][A-Z0-9.-]{1,8})(?=\b)/g))
    .map((match) => match[1].toUpperCase())
    .filter((term) => !["ETF", "FOMC", "PE", "PB", "EPS", "AI"].includes(term));
}

function instrumentEvidenceTerms(plan: QueryPlan, tickers: string[], query: string): string[] {
  const terms = [
    ...tickers,
    ...plan.exact_entities,
    ...plan.aliases,
    ...plan.related_entities.map((item) => item.name),
    ...plan.concepts,
    ...explicitTickerTerms(query),
  ];
  return Array.from(new Set(terms
    .map((term) => String(term || "").replace(/^\$/, "").trim().toLowerCase())
    .filter((term) => term.length >= 2 && !INSTRUMENT_ANCHOR_NOISE.has(term))
    .filter((term) => !/(?:怎么买|能买吗|买入|卖出|仓位|当前|现在)/.test(term))));
}

function lexicalScore(text: string, terms: string[]): number {
  const raw = String(text || "");
  const lower = raw.toLowerCase();
  const textTokens = tokenize(raw);
  const textSet = new Set(textTokens);
  const queryTokens = tokenize(terms.join(" "));
  let score = 0;
  let coverage = 0;
  for (const t of queryTokens) {
    if (textSet.has(t) || lower.includes(t.toLowerCase())) {
      coverage++;
      score += t.length >= 4 ? 2.4 : 1.4;
    }
  }
  if (queryTokens.length) score += (coverage / queryTokens.length) * 8;
  for (const t of terms) {
    const term = t.toLowerCase();
    if (!term) continue;
    const hits = lower.split(term).length - 1;
    if (hits) score += Math.min(hits, 3) * (term.length >= 4 ? 1.6 : 0.9);
  }
  return score;
}

function timeBoost(createdAtTs: number | null | undefined): number {
  // Recency is a mild TIE-BREAKER, not a dominator. Earlier values (up to 3) let this-week tweets
  // crowd out the KOL's core framework tweets on thesis questions ("重点分析流动性...准备金...钱荒"),
  // which are timeless. Keep it small so lexical/FTS relevance leads.
  const now = Date.now() / 1000;
  const age = now - (createdAtTs || 0);
  const DAY = 86400;
  if (age < 3 * DAY) return 1.2;
  if (age < 14 * DAY) return 0.9;
  if (age < 45 * DAY) return 0.6;
  if (age < 120 * DAY) return 0.35;
  if (age < 365 * DAY) return 0.15;
  return 0;
}

function engagementBoost(row: any): number {
  const engagement =
    (Number(row.likes) || 0) +
    (Number(row.retweets) || 0) * 2 +
    (Number(row.replies) || 0) * 1.2 +
    (Number(row.quotes) || 0) * 1.5 +
    Math.log10((Number(row.views) || 0) + 10);
  return Math.log10(engagement + 1) * 2.4;
}

const TWEET_COLS =
  "id,text,created_at_iso,created_at_ts,views,likes,retweets,replies,quotes,quoted";

// Attach the nested quoted tweet to each citation. Prefer the natively-stored `quoted` JSON (from
// GetXAPI). Fallback: parse a self-quote x.com/<handle>/status/<id> link out of the tweet text and look
// the original up in our own corpus (covers most cases for free, before/without a paid re-fetch).
async function attachQuoted(env: Env, scope: string, handle: string, citations: Citation[], rowsById: Map<string, any>): Promise<void> {
  const needLookup = new Map<string, Citation[]>(); // referenced tweet id -> citations awaiting it
  for (const c of citations) {
    const row = rowsById.get(String(c.tweet_id));
    const stored = row?.quoted ? safeParse(row.quoted) : null;
    if (stored && stored.text) {
      c.quoted = stored;
      continue;
    }
    const m = String(c.snippet || "").match(/(?:x|twitter)\.com\/([A-Za-z0-9_]+)\/status\/(\d+)/i);
    if (m) {
      const qid = m[2];
      const arr = needLookup.get(qid) || [];
      arr.push(c);
      needLookup.set(qid, arr);
      continue;
    }
    const shortLinks = Array.from(String(c.snippet || "").matchAll(/https?:\/\/t\.co\/[A-Za-z0-9_%-]+/gi)).map((x) => x[0]);
    for (const short of shortLinks.slice(0, 3)) {
      const qid = await resolveTcoStatusId(short, handle).catch(() => null);
      if (!qid) continue;
      const arr = needLookup.get(qid) || [];
      arr.push(c);
      needLookup.set(qid, arr);
      break;
    }
  }
  const ids = Array.from(needLookup.keys()).slice(0, 60);
  if (!ids.length) return;
  const rows = await env.DB.prepare(
    `SELECT id,text,created_at_iso FROM tweets WHERE kol_id=? AND id IN (${ids.map(() => "?").join(",")})`
  ).bind(scope, ...ids).all().then((r) => (r.results || []) as any[]).catch(() => []);
  for (const r of rows) {
    const cs = needLookup.get(String(r.id));
    if (!cs) continue;
    const q: QuotedTweet = {
      id: String(r.id),
      text: r.text || "",
      handle,
      name: "",
      url: `https://x.com/${handle}/status/${r.id}`,
      date: (r.created_at_iso || "").slice(0, 10),
    };
    for (const c of cs) c.quoted = q;
  }
}

async function resolveTcoStatusId(shortUrl: string, expectedHandle: string): Promise<string | null> {
  const res = await fetch(shortUrl, { redirect: "manual" });
  const dest = res.headers.get("location") || res.url || "";
  const m = dest.match(/(?:x|twitter)\.com\/([A-Za-z0-9_]+)\/status\/(\d+)/i);
  if (!m) return null;
  if (expectedHandle && m[1].toLowerCase() !== expectedHandle.toLowerCase()) return null;
  return m[2];
}

function safeParse(s: string): QuotedTweet | null {
  try {
    const o = JSON.parse(s);
    return o && o.text ? o : null;
  } catch {
    return null;
  }
}

function quotedFromRow(row: any): QuotedTweet | null {
  return row?.quoted ? safeParse(row.quoted) : null;
}

function rowTextWithQuote(row: any): string {
  const base = String(row?.text || "");
  const q = quotedFromRow(row);
  if (!q?.text) return base;
  return `${base}\nQUOTED CONTEXT @${q.handle || "unknown"}: ${q.text}`;
}

// ---------------- FTS5 query planning + multi-route retrieval ----------------

// Trigram requires terms of >=3 characters. Shorter terms are routed through instr() instead.
function charLen(s: string): number {
  return Array.from(s).length;
}

// Sanitize a term into a quoted FTS5 phrase. Returns null if too short for the trigram index.
function ftsPhrase(term: string): string | null {
  const t = String(term || "")
    .replace(/[“”"]/g, "")
    .replace(/[\x00-\x1F]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^\$/, "")
    .trim();
  if (charLen(t) < 3) return null;
  return `"${t}"`;
}

// Build an FTS5 MATCH expression OR-ing the (long-enough) terms; returns null when nothing usable.
function buildMatch(terms: string[], maxPhrases = 12): string | null {
  const phrases: string[] = [];
  const seen = new Set<string>();
  for (const t of terms) {
    const p = ftsPhrase(t);
    if (!p || seen.has(p)) continue;
    seen.add(p);
    phrases.push(p);
    if (phrases.length >= maxPhrases) break;
  }
  return phrases.length ? phrases.join(" OR ") : null;
}

// Per-route BM25 column weight vectors over (text, entities, aliases, topics, stances, style).
const W_EXACT = [10, 9, 5, 3, 3, 1];
const W_ALIAS = [7, 6, 10, 3, 3, 1];
const W_CONCEPT = [6, 4, 4, 9, 5, 2];
const W_RELATED = [6, 8, 5, 4, 3, 1];
const W_STANCE = [5, 3, 3, 5, 8, 4];
const W_DEFAULT = [10, 8, 6, 4, 5, 1.5];

// Run one FTS5 route. Returns tweet_id -> positive score (-bm25). Throws if the table is absent
// (caller treats that as "FTS not provisioned yet" and falls back to legacy retrieval).
async function ftsRoute(
  env: Env,
  kolId: string,
  terms: string[],
  weights: number[],
  limit: number,
  columnFilter?: string // e.g. "{text}" to match ONLY the original-text column (query-side mode)
): Promise<Map<string, number>> {
  const match = buildMatch(terms);
  const out = new Map<string, number>();
  if (!match) return out;
  const w = weights.join(",");
  const matchExpr = columnFilter ? `${columnFilter}: (${match})` : match;
  const r = await env.DB.prepare(
    `SELECT tweet_id, bm25(tweet_search, ${w}) AS s
     FROM tweet_search
     WHERE tweet_search MATCH ? AND kol_id = ?
     ORDER BY s LIMIT ?`
  )
    .bind(matchExpr, kolId, limit)
    .all();
  for (const row of (r.results || []) as any[]) {
    const id = String(row.tweet_id);
    const pos = -(Number(row.s) || 0); // bm25 is negative; flip so larger = better
    const prev = out.get(id);
    if (prev === undefined || pos > prev) out.set(id, pos);
  }
  return out;
}

// instr() route for SHORT terms (< 3 chars) the trigram index can't match (e.g. 美债, AI, JD).
async function instrRoute(
  env: Env,
  kolId: string,
  terms: string[],
  limit: number
): Promise<Set<string>> {
  const ids = new Set<string>();
  const short = Array.from(new Set(terms.map((t) => String(t || "").replace(/^\$/, "").trim())))
    .filter((t) => charLen(t) === 2) // trigram can't match these; instr() can
    .slice(0, 8);
  if (!short.length) return ids;
  const results = await Promise.all(
    short.map((term) =>
      env.DB.prepare(
        `SELECT id FROM tweets WHERE kol_id=? AND is_retweet=0 AND instr(lower(text), lower(?)) > 0
         ORDER BY created_at_ts DESC LIMIT ?`
      )
        .bind(kolId, term, limit)
        .all()
        .then((r) => (r.results || []) as any[])
        .catch(() => [])
    )
  );
  for (const rows of results) for (const row of rows) ids.add(String(row.id));
  return ids;
}

function flattenPlanTerms(plan: QueryPlan): string[] {
  return [
    ...plan.exact_entities,
    ...plan.aliases,
    ...plan.concepts,
    ...plan.related_entities.map((r) => r.name),
    ...plan.required_stances,
  ];
}

// Step 3: ask the answer-tier-cheaper model to rerank candidates by the KOL-faithfulness criteria.
// Returns an ordered list of tweet_ids (best first). Best-effort: [] on any failure → keep prior order.
async function llmRerank(
  env: Env,
  model: string,
  question: string,
  plan: QueryPlan,
  cands: { id: string; date: string; text: string }[],
  keep: number,
  snippetChars = 140
): Promise<string[] | null> {
  if (!cands.length) return [];
  const list = cands
    .map((c, i) => `${i}\t(${c.date})\t${String(c.text || "").replace(/\s+/g, " ").slice(0, snippetChars)}`)
    .join("\n");
  const sys =
    "Select finance-KOL tweets that DIRECTLY help answer the question AS that KOL. Prefer exact subject match, the KOL's own view/framework, concrete mechanisms/data, and useful facet coverage. Reject tangential market recaps, generic timing comments, relayed news without a stance, near-duplicates, and pure recency. It is correct to return fewer results or [] when evidence is weak.\n" +
    "If the exact fund/instrument is absent, a focused post about ONE constituent or ONE industry theme can be valid evidence when its analysis materially informs the fund question. A single-constituent post must contain a real view on fundamentals, demand/supply, cycle, valuation, risk, or an actionable stance. Reject mere name-drops, guesses about what another investor may own, and mentions inside unrelated recaps. When good evidence exists, prefer 3-8 complementary sources over one passing mention.\n" +
    `Return ONLY a JSON array of relevant candidate indices, best first, at most ${keep} items. No markdown.`;
  const usr =
    `User question: ${question}\n` +
    `Intent: ${plan.intent || "(n/a)"}\n` +
    (plan.exclude_topics.length ? `Avoid off-target topics: ${plan.exclude_topics.join(", ")}\n` : "") +
    `\nCandidates (index<TAB>date<TAB>text):\n${list}`;
  try {
    const raw = await completeChat(env, model, [
      { role: "system", content: sys },
      { role: "user", content: usr },
    ], { maxTokens: Math.max(120, keep * 7), temperature: 0.1 });
    const arr = JSON.parse(raw.match(/\[[\s\S]*\]/)?.[0] || "[]");
    if (!Array.isArray(arr)) return null;
    const order: string[] = [];
    const seen = new Set<string>();
    for (const x of arr) {
      const i = Number(x);
      if (Number.isInteger(i) && cands[i] && !seen.has(cands[i].id)) {
        order.push(cands[i].id);
        seen.add(cands[i].id);
      }
    }
    return order;
  } catch {
    return null;
  }
}

function deterministicRelevantFallback(
  pool: { r: any; score: number }[],
  exactRouteIds: Set<string>,
  keep: number,
): { r: any; score: number }[] {
  if (!pool.length) return [];
  const top = Math.max(0.01, pool[0].score);
  const floor = Math.max(1.5, top * 0.28);
  const exact = pool.filter((x) => exactRouteIds.has(String(x.r.id)));
  const adjacent = pool.filter((x) => !exactRouteIds.has(String(x.r.id)) && x.score >= floor);
  const base = exact.length ? [...exact, ...adjacent] : adjacent;
  return base.slice(0, keep);
}

export function shouldSkipLlmRerank(
  pool: { r: any; score: number }[],
  exactRouteIds: Set<string> = new Set()
): boolean {
  if (pool.length < 6) return true;

  const top1 = pool[0]?.score || 0;
  const top2 = pool[1]?.score || 0;
  if (top2 > 0 && top1 >= top2 * 1.8 && top1 - top2 >= 8) return true;

  if (pool.length >= 4 && exactRouteIds.size) {
    const top3 = pool.slice(0, 3);
    const next = pool[3]?.score || 0;
    const allExact = top3.every((x) => exactRouteIds.has(String(x.r.id)));
    const stableLead = top3[2].score >= next + 4 && top3[0].score - top3[2].score <= 10;
    if (allExact && stableLead) return true;
  }

  return false;
}

// ---------------- Public retrieval ----------------

// Plan-driven retrieval: FTS5 multi-route candidate generation → signal blend → LLM rerank.
// Hard-scoped to one kol_id. The answer model only ever sees the REAL original tweet text.
export async function retrieve(
  env: Env,
  kolId: string,
  handle: string,
  query: string,
  tickers: string[],
  plan?: QueryPlan,
  rerankModel?: string,
  mode: "query_side" | "tagged" = "query_side",
  scopeKolId?: string,
  options: { skipLlmRerank?: boolean } = {},
): Promise<{ citations: Citation[]; knowledge: RetrievedKnowledge[] }> {
  const basePlan: QueryPlan = plan || { ...EMPTY_PLAN, exact_entities: [...tickers] };
  const p: QueryPlan = {
    ...basePlan,
    instruments: [...basePlan.instruments],
    exact_entities: [...basePlan.exact_entities],
    aliases: [...basePlan.aliases],
    concepts: [...basePlan.concepts],
    related_entities: [...basePlan.related_entities],
    required_stances: [...basePlan.required_stances],
    exclude_topics: [...basePlan.exclude_topics],
  };
  // ETF constituents are deterministic retrieval aliases, not model guesses. They let a question about
  // a new fund retrieve the KOL's real views on its holdings while still rejecting generic "ETF" posts.
  const explicitSymbols = explicitTickerTerms(query).slice(0, 2);
  const etfData = await Promise.all(explicitSymbols.map((symbol) => getEtfHoldings(env, symbol).catch(() => null)));
  const constituentTerms = etfData.flatMap((data) => (data?.holdings || []).slice(0, 15)
    .flatMap((holding) => [holding.symbol, holding.name]).filter(Boolean));
  if (constituentTerms.length) p.aliases = Array.from(new Set([...p.aliases, ...constituentTerms]));
  const plannedTerms = [...flattenPlanTerms(p), ...tickers].filter(Boolean);
  // Once the planner has produced structured entities/concepts, feeding every raw CJK 2-4 gram into
  // FTS mostly retrieves generic phrases such as "你认为/现在/能买吗". Raw tokenization is a failure
  // fallback only, not an additional noisy route.
  const allTerms = Array.from(new Set(plannedTerms.length ? plannedTerms : deterministicRawAnchors(query)));
  const scope = scopeKolId || kolId; // which KOL's corpus to search (supports a tagged A/B control)
  // The planner is the (LLM) domain expander — it returns concepts incl. jargon (RRP/TGA/SOFR or
  // Starlink/Neutron/代理溢价). We split concepts across routes so the 12-phrase MATCH cap can't drop
  // any of them. No hardcoded term dictionaries — quality rides on the planner + reranker improving.
  const concepts1 = p.concepts.slice(0, 12);
  const concepts2 = p.concepts.slice(12, 24);

  // Step 2: multi-route FTS5. If the FTS table isn't provisioned, fall back to legacy retrieval.
  const ftsScores = new Map<string, number>();
  let exactRouteIds = new Set<string>();
  const mergeRoute = (m: Map<string, number>) => {
    for (const [id, s] of m) ftsScores.set(id, Math.max(ftsScores.get(id) || 0, s));
  };
  try {
    if (mode === "tagged") {
      // Tagged mode (A/B control): match across the machine tag columns with per-route BM25 weights.
      const routes = await Promise.all([
        ftsRoute(env, scope, [...p.exact_entities, ...tickers], W_EXACT, 20),
        ftsRoute(env, scope, p.aliases, W_ALIAS, 18),
        ftsRoute(env, scope, concepts1, W_CONCEPT, 24),
        concepts2.length ? ftsRoute(env, scope, concepts2, W_CONCEPT, 16) : Promise.resolve(new Map<string, number>()),
        ftsRoute(env, scope, p.related_entities.map((r) => r.name), W_RELATED, 14),
        ftsRoute(env, scope, allTerms, W_DEFAULT, 30),
      ]);
      exactRouteIds = new Set(routes[0].keys());
      for (const m of routes) mergeRoute(m);
    } else {
      // Default query-side-only: match ONLY the original-text column with the planner's bilingual terms.
      const TEXT_ONLY = [10, 0, 0, 0, 0, 0];
      // Eval/background callers intentionally skip the online planner. In that case the raw tokenizer
      // is the fallback plan, so it still needs a real FTS route (not only the 2-char instr safety net).
      // Raw spans preserve isolated tickers/industry terms near the front: DRAM, 存储, ETF, MU, etc.
      const rawFallback = plannedTerms.length
        ? Promise.resolve(new Map<string, number>())
        : ftsRoute(env, scope, allTerms, TEXT_ONLY, 40, "{text}");
      const routes = await Promise.all([
        ftsRoute(env, scope, [...p.exact_entities, ...p.aliases, ...tickers], TEXT_ONLY, 40, "{text}"),
        ftsRoute(env, scope, concepts1, TEXT_ONLY, 40, "{text}"),
        concepts2.length ? ftsRoute(env, scope, concepts2, TEXT_ONLY, 30, "{text}") : Promise.resolve(new Map<string, number>()),
        ftsRoute(env, scope, [...p.related_entities.map((r) => r.name), ...p.required_stances], TEXT_ONLY, 20, "{text}"),
        rawFallback,
      ]);
      exactRouteIds = new Set([...routes[0].keys(), ...routes[4].keys()]);
      for (const m of routes) mergeRoute(m);
    }
  } catch (e) {
    if (String(e).includes("no such table")) {
      return retrieveLegacy(env, scope, handle, query, tickers, allTerms);
    }
    // Other FTS errors: continue with whatever we have + safety nets below.
  }

  // Short-term instr fallback (trigram can't match < 3 char terms).
  try {
    const shortIds = await instrRoute(env, scope, allTerms, 24);
    for (const id of shortIds) if (!ftsScores.has(id)) ftsScores.set(id, 1.5);
  } catch {}

  // Hydrate candidates with full tweet rows (original text + metadata). Chunk the IN() list: D1 caps a
  // statement at ~100 bound parameters, so a large FTS candidate set must be fetched in batches.
  const ftsIds = Array.from(ftsScores.keys()).slice(0, 120);
  const fetched: any[] = [];
  for (let i = 0; i < ftsIds.length; i += 80) {
    const chunk = ftsIds.slice(i, i + 80);
    const rows = await env.DB.prepare(
      `SELECT ${TWEET_COLS} FROM tweets WHERE kol_id=? AND id IN (${chunk.map(() => "?").join(",")})`
    )
      .bind(scope, ...chunk)
      .all()
      .then((r) => (r.results || []) as any[])
      .catch(() => []);
    fetched.push(...rows);
  }

  // Recency/popularity are GAP-FILLERS only — small, and given a near-zero base score so they never
  // out-rank real FTS matches on a thesis question. (Previously 40+40 flooded the pool and pulled the
  // answer toward this-week headlines instead of the asked-for framework.)
  const SAFETY = ftsIds.length >= 12 ? 0 : 24; // no popular-noise injection once FTS has enough hits
  const [recent, popular] = await Promise.all([
    env.DB.prepare(
      `SELECT ${TWEET_COLS} FROM tweets WHERE kol_id=? AND is_retweet=0 ORDER BY created_at_ts DESC LIMIT ?`
    ).bind(scope, SAFETY).all(),
    env.DB.prepare(
      `SELECT ${TWEET_COLS} FROM tweets WHERE kol_id=? AND is_retweet=0
       ORDER BY (likes + retweets * 2 + replies + quotes) DESC LIMIT ?`
    ).bind(scope, SAFETY).all(),
  ]);

  const byId = new Map<string, any>();
  const fromFts = new Set<string>();
  for (const r of fetched) { byId.set(String(r.id), r); fromFts.add(String(r.id)); }
  for (const r of [...(recent.results || []), ...(popular.results || [])] as any[]) {
    if (!byId.has(String(r.id))) byId.set(String(r.id), r);
  }
  // Emergency fallback: never return empty. If hydration somehow yielded nothing, grab recent originals.
  if (byId.size === 0) {
    const er = await env.DB.prepare(
      `SELECT ${TWEET_COLS} FROM tweets WHERE kol_id=? AND is_retweet=0 ORDER BY created_at_ts DESC LIMIT 20`
    ).bind(scope).all().then((r) => (r.results || []) as any[]).catch(() => []);
    for (const r of er) byId.set(String(r.id), r);
  }

  // Blend signals: FTS (dominant) + lexical fit + recency + engagement. Non-FTS safety-net rows get a
  // penalty so they only surface when FTS truly found nothing relevant.
  let scored = Array.from(byId.values())
    .map((r) => {
      const fts = ftsScores.get(String(r.id)) || 0;
      const safetyPenalty = fromFts.has(String(r.id)) ? 0 : -3;
      const score = fts * 8 + lexicalScore(rowTextWithQuote(r), allTerms) + timeBoost(r.created_at_ts) + engagementBoost(r) + safetyPenalty;
      return { r, score };
    })
    .filter((x) => x.score > 0.5)
    .sort((a, b) => b.score - a.score);

  // Step 3: the LLM reranker is the authority on relevance (semantic judgment the lexical blend can't
  // make). The blend only builds the candidate POOL; the reranker selects + orders the final set. If
  // the reranker fails, we fall back to the blend order (which is FTS-led, so still sensible).
  const isQuick = p.route === "quick" && !p.needs_tools;
  const POOL = isQuick ? 16 : 26;
  const KEEP = isQuick ? 8 : 10;
  const RERANK_SNIPPET = isQuick ? 360 : 500;
  const pool = scored.slice(0, POOL);
  // Explicit ticker questions must still be semantically judged when the lexical pool is small.
  // Otherwise a single incidental constituent mention bypasses the reranker and becomes a citation.
  const skipped = options.skipLlmRerank ||
    (shouldSkipLlmRerank(pool, exactRouteIds) && explicitTickerTerms(query).length === 0);
  const order = skipped
    ? null
    : await llmRerank(
        env,
        rerankModel || env.MODEL_FLASH,
        query,
        p,
        pool.map((x) => ({ id: String(x.r.id), date: (x.r.created_at_iso || "").slice(0, 10), text: rowTextWithQuote(x.r) })),
        KEEP,
        RERANK_SNIPPET
      );
  if (order !== null && order.length > 0) {
    const rank = new Map(order.map((id, i) => [id, i]));
    // The reranker is a selector, not just a sorter. Never append rejected candidates back.
    scored = scored
      .filter((x) => rank.has(String(x.r.id)))
      .sort((a, b) => rank.get(String(a.r.id))! - rank.get(String(b.r.id))!);
  } else {
    scored = deterministicRelevantFallback(pool, exactRouteIds, KEEP);
  }

  // For an explicit ticker question, a citation must contain the ticker or at least one concrete,
  // non-generic alias/constituent/industry concept. Do not require two different anchors: a focused
  // post about one core constituent (for example MU inside DRAM) can be strong evidence by itself.
  // Generic words such as "ETF" remain excluded, so crypto ETF chatter and "卖飞ETF" jokes still fail.
  if (explicitTickerTerms(query).length) {
    const explicitSymbols = explicitTickerTerms(query).map((term) => term.toLowerCase());
    const evidenceTerms = instrumentEvidenceTerms(p, tickers, query);
    scored = scored.filter((item) => {
      const text = rowTextWithQuote(item.r).toLowerCase().replace(/https?:\/\/\S+/g, " ");
      if (text.replace(/\s+/g, "").length < 80) return false;
      const matches = evidenceTerms.filter((term) => {
        if (/^[a-z0-9.$-]+$/i.test(term)) {
          const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          return new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, "i").test(text);
        }
        return text.includes(term);
      });
      const directlyNamesTicker = explicitSymbols.some((term) => {
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, "i").test(text);
      });
      return directlyNamesTicker || new Set(matches).size >= 1;
    });
  }

  // Dedup near-identical tweets, cap citations.
  const deduped: { r: any; score: number }[] = [];
  for (const x of scored) {
    if (deduped.some((d) => textSimilarity(d.r.text, x.r.text) > DEDUP_COSINE_THRESHOLD)) continue;
    deduped.push(x);
    if (deduped.length >= KEEP) break;
  }
  const citations: Citation[] = deduped.map((x, i) => ({
    ref: `T${i + 1}`,
    tweet_id: x.r.id,
    url: `https://x.com/${handle}/status/${x.r.id}`,
    date: (x.r.created_at_iso || "").slice(0, 10),
    snippet: x.r.text,
    relevance_score: x.score,
  }));
  await attachQuoted(env, scope, handle, citations, byId).catch(() => {});

  const knowledge = await retrieveKnowledge(env, scope, allTerms);
  return { citations, knowledge };
}

async function retrieveKnowledge(env: Env, kolId: string, terms: string[]): Promise<RetrievedKnowledge[]> {
  const kr = await env.DB.prepare(
    `SELECT source,title,text FROM knowledge_chunks
     WHERE kol_id=?
       AND source NOT LIKE 'persona_backup:%'
       AND source NOT LIKE 'persona_snapshot:%'
     LIMIT 120`
  ).bind(kolId).all();
  const scoredKnowledge: { k: any; s: number }[] = [];
  for (const k of (kr.results || []) as any[]) {
    let s = lexicalScore(`${k.title || ""}\n${k.text || ""}`, terms);
    if (String(k.source || "").includes("methodology")) s += 1;
    if (String(k.source || "").includes("analysis")) s += 0.7;
    if (s > 0.5) scoredKnowledge.push({ k, s });
  }
  scoredKnowledge.sort((a, b) => b.s - a.s);
  const out: RetrievedKnowledge[] = [];
  let remaining = 6000;
  for (const x of scoredKnowledge.slice(0, 4)) {
    if (remaining <= 0) break;
    const text = String(x.k.text || "").slice(0, Math.min(2500, remaining));
    if (!text) continue;
    out.push({
      source: x.k.source,
      title: x.k.title,
      text,
      relevance_score: x.s,
    });
    remaining -= text.length;
  }
  return out;
}

// ---------------- Legacy fallback (pre-FTS provisioning) ----------------
// Pure instr() substring retrieval — kept so the chat path never breaks before the FTS index
// is backfilled. Mirrors the previous production behavior.
async function retrieveLegacy(
  env: Env,
  kolId: string,
  handle: string,
  query: string,
  tickers: string[],
  allTerms: string[]
): Promise<{ citations: Citation[]; knowledge: RetrievedKnowledge[] }> {
  const terms = allTerms.slice(0, 28);
  const clauses = terms.map(() => "instr(lower(text), lower(?)) > 0");
  const where = clauses.length ? `AND (${clauses.join(" OR ")})` : "";
  let rows: any[] = [];
  if (clauses.length) {
    const r = await env.DB.prepare(
      `SELECT ${TWEET_COLS} FROM tweets WHERE kol_id=? AND is_retweet=0 ${where}
       ORDER BY created_at_ts DESC LIMIT 240`
    ).bind(kolId, ...terms).all();
    rows = (r.results || []) as any[];
  }
  const [recent, popular] = await Promise.all([
    env.DB.prepare(`SELECT ${TWEET_COLS} FROM tweets WHERE kol_id=? AND is_retweet=0 ORDER BY created_at_ts DESC LIMIT 60`).bind(kolId).all(),
    env.DB.prepare(`SELECT ${TWEET_COLS} FROM tweets WHERE kol_id=? AND is_retweet=0 ORDER BY (likes + retweets * 2 + replies + quotes) DESC LIMIT 60`).bind(kolId).all(),
  ]);
  const byId = new Map<string, any>();
  for (const r of rows) byId.set(String(r.id), r);
  for (const r of [...(recent.results || []), ...(popular.results || [])] as any[]) {
    if (!byId.has(String(r.id))) byId.set(String(r.id), r);
  }
  const scored = Array.from(byId.values())
    .map((r) => ({ r, score: lexicalScore(rowTextWithQuote(r), allTerms) + timeBoost(r.created_at_ts) + engagementBoost(r) }))
    .filter((x) => x.score > 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, 28);
  const deduped: any[] = [];
  for (const x of scored) {
    if (deduped.some((d) => textSimilarity(d.text, x.r.text) > DEDUP_COSINE_THRESHOLD)) continue;
    deduped.push(x.r);
    if (deduped.length >= 20) break;
  }
  const citations: Citation[] = deduped.map((r, i) => ({
    ref: `T${i + 1}`,
    tweet_id: r.id,
    url: `https://x.com/${handle}/status/${r.id}`,
    date: (r.created_at_iso || "").slice(0, 10),
    snippet: r.text,
  }));
  await attachQuoted(env, kolId, handle, citations, byId).catch(() => {});
  const knowledge = await retrieveKnowledge(env, kolId, allTerms);
  return { citations, knowledge };
}
