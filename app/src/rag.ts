import type { Env } from "./env";
import { completeChat } from "./chat";

export interface Citation {
  ref: string;        // 'T1'
  tweet_id: string;
  url: string;
  date: string;
  snippet: string;
  relevance_score?: number;
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

function buildTerms(query: string, tickers: string[], expandedTerms: string[]): string[] {
  const terms = new Set<string>();
  for (const t of tickers) {
    const sym = t.trim();
    if (!sym) continue;
    terms.add(sym.toUpperCase());
    terms.add("$" + sym.toUpperCase());
  }
  for (const t of expandedTerms) if (t.trim().length >= 2) terms.add(t.trim());
  for (const t of tokenize(query)) if (t.length >= 2) terms.add(t);
  const q = query.toLowerCase();
  if (/流动性|美债|利率|风险资产|回购|钱荒|准备金|sofr|srf|rrp|tga/i.test(q)) {
    [
      "流动性", "流动性紧张", "准备金", "商业银行准备金", "隔夜逆回购", "逆回购", "RRP",
      "TGA", "财政部TGA", "SOFR", "SRF", "常备回购便利", "回购利率", "钱荒",
      "2019", "19年9月", "美债收益率", "十年美债", "10年期美债", "利率走廊",
      "降息预期", "风险资产", "小盘股", "币市", "联储购债", "扩表",
    ].forEach((t) => terms.add(t));
  }
  if (/打脸指标|风险边界|主矛盾|证伪/i.test(q)) {
    ["打脸", "风险边界", "主矛盾", "杀估值", "杀逻辑", "小级别", "中级别", "大级别"].forEach((t) => terms.add(t));
  }
  return Array.from(terms).slice(0, 60);
}

function priorityTerms(query: string): string[] {
  if (!/流动性|美债|利率|风险资产|回购|钱荒|准备金|sofr|srf|rrp|tga/i.test(query)) return [];
  return [
    "SOFR",
    "SRF",
    "RRP",
    "TGA",
    "准备金",
    "商业银行准备金",
    "流动性紧张",
    "回购利率",
    "钱荒",
    "2019",
    "19年9月",
    "联储购债",
    "扩表",
  ];
}

function lexicalScore(text: string, terms: string[], tickers: string[], expandedTerms: string[]): number {
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
  for (const t of tickers) {
    const sym = t.toLowerCase();
    if (lower.includes(sym) || lower.includes("$" + sym)) score += 7;
  }
  for (const t of expandedTerms) {
    if (t.length >= 2 && lower.includes(t.toLowerCase())) score += 2.2;
  }
  for (const t of priorityTerms(terms.join(" "))) {
    if (lower.includes(t.toLowerCase())) score += 8;
  }
  return score;
}

function timeBoost(createdAtTs: number | null | undefined): number {
  const now = Date.now() / 1000;
  const age = now - (createdAtTs || 0);
  const DAY = 86400;
  if (age < 3 * DAY) return 3;
  if (age < 14 * DAY) return 2.2;
  if (age < 45 * DAY) return 1.5;
  if (age < 120 * DAY) return 0.8;
  if (age < 365 * DAY) return 0.3;
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

async function maybeRerank(
  env: Env,
  query: string,
  rows: { r: any; score: number }[]
): Promise<{ r: any; score: number }[]> {
  if (!rows.length) return rows;
  try {
    const docs = rows.slice(0, 30).map((x) => String(x.r.text || "").slice(0, 900));
    const ai: any = env.AI as any;
    const res: any = await ai.run("@cf/baai/bge-reranker-base", { query, contexts: docs });
    const scores: number[] =
      (Array.isArray(res?.response) && res.response) ||
      (Array.isArray(res?.scores) && res.scores) ||
      (Array.isArray(res?.data) && res.data.map((x: any) => typeof x === "number" ? x : x?.score)) ||
      [];
    if (!scores.length) return rows;
    return rows
      .map((x, i) => {
        const rerank = Number(scores[i]);
        return Number.isFinite(rerank)
          ? { r: x.r, score: x.score * 0.35 + rerank * 18 + timeBoost(x.r.created_at_ts) * 0.25 }
          : x;
      })
      .sort((a, b) => b.score - a.score);
  } catch {
    return rows;
  }
}

// ---- LLM-based query expansion ----
// Uses flash model to generate additional search keywords from user question + identified tickers.
// This bridges the semantic gap between user language and KOL's tweet vocabulary.
export async function expandQuery(
  env: Env,
  model: string,
  userQuestion: string,
  tickers: string[]
): Promise<string[]> {
  const sys =
    `You are a search expansion engine for financial research. ` +
    `Given a user question and identified tickers, generate 6-12 additional search keywords ` +
    `that would help find relevant tweets from a finance KOL. Include: synonyms, related tickers, ` +
    `industry terms, Chinese/English equivalents, sector names. ` +
    `Output ONLY a JSON array of short keywords. No markdown. ` +
    `Example: ["英伟达","NVDA","GPU","算力","芯片","数据中心","AI基础设施","半导体"]`;
  const usr = `Question: ${userQuestion}\nIdentified tickers: ${tickers.join(", ") || "none"}`;
  try {
    const raw = await completeChat(env, model, [
      { role: "system", content: sys },
      { role: "user", content: usr },
    ], { maxTokens: 150, temperature: 0.3 });
    const arr = JSON.parse(raw.match(/\[.*\]/s)?.[0] || "[]");
    return Array.isArray(arr) ? arr.filter((s: any) => typeof s === "string" && s.length >= 2).slice(0, 12) : [];
  } catch {
    return [];
  }
}

// Sparse retrieval, hard-scoped to one kol_id. D1 lexical/recency is the only source of truth.
export async function retrieve(
  env: Env,
  kolId: string,
  handle: string,
  query: string,
  tickers: string[],
  expandedTerms: string[] = []
): Promise<{ citations: Citation[]; knowledge: RetrievedKnowledge[] }> {
  const terms = buildTerms(query, tickers, expandedTerms);
  const matchClauses: string[] = [];
  const binds: any[] = [kolId];
  for (const term of terms.slice(0, 28)) {
    matchClauses.push("instr(lower(text), lower(?)) > 0");
    binds.push(term);
  }
  const where = matchClauses.length ? `AND (${matchClauses.join(" OR ")})` : "";
  let rows: any[] = [];
  if (matchClauses.length) {
    const r = await env.DB.prepare(
      `SELECT id,text,created_at_iso,created_at_ts,views,likes,retweets,replies,quotes FROM tweets
       WHERE kol_id=? AND is_retweet=0 ${where}
       ORDER BY created_at_ts DESC LIMIT 240`
    )
      .bind(...binds)
      .all();
    rows = r.results || [];
  }

  const priority = priorityTerms(query);
  if (priority.length) {
    const focused = await Promise.all(
      priority.map((term) =>
        env.DB.prepare(
          `SELECT id,text,created_at_iso,created_at_ts,views,likes,retweets,replies,quotes FROM tweets
           WHERE kol_id=? AND is_retweet=0 AND instr(lower(text), lower(?)) > 0
           ORDER BY created_at_ts DESC LIMIT 36`
        )
          .bind(kolId, term)
          .all()
          .then((r) => r.results || [])
          .catch(() => [])
      )
    );
    rows.push(...focused.flat());
  }

  const [recent, popular] = await Promise.all([
    env.DB.prepare(
      `SELECT id,text,created_at_iso,created_at_ts,views,likes,retweets,replies,quotes FROM tweets
       WHERE kol_id=? AND is_retweet=0 ORDER BY created_at_ts DESC LIMIT 80`
    ).bind(kolId).all(),
    env.DB.prepare(
      `SELECT id,text,created_at_iso,created_at_ts,views,likes,retweets,replies,quotes FROM tweets
       WHERE kol_id=? AND is_retweet=0
       ORDER BY (likes + retweets * 2 + replies + quotes) DESC LIMIT 80`
    ).bind(kolId).all(),
  ]);
  const seen = new Set(rows.map((r) => String(r.id)));
  const mergedRows: any[] = [];
  for (const r of rows) {
    const id = String(r.id);
    if (!id || seen.has(`merged:${id}`)) continue;
    seen.add(`merged:${id}`);
    mergedRows.push(r);
  }
  rows = mergedRows;
  const existing = new Set(rows.map((r) => String(r.id)));
  for (const r of [...(recent.results || []), ...(popular.results || [])] as any[]) {
    if (!existing.has(String(r.id))) {
      existing.add(String(r.id));
      rows.push(r);
    }
  }

  let scoredRows = rows
    .map((r) => {
      const score = lexicalScore(r.text || "", terms, tickers, expandedTerms) + timeBoost(r.created_at_ts) + engagementBoost(r);
      return { r, score };
    })
    .filter((x) => x.score > 0.5)
    .sort((a, b) => b.score - a.score);

  scoredRows = await maybeRerank(env, query, scoredRows);

  const top = scoredRows.map((x) => x.r).slice(0, 28);
  // Dedup: remove highly similar tweets, keep the first (highest scored)
  const deduped: any[] = [];
  for (const row of top) {
    if (deduped.some((d) => textSimilarity(d.text, row.text) > DEDUP_COSINE_THRESHOLD)) continue;
    deduped.push(row);
    if (deduped.length >= 20) break;
  }
  const citations: Citation[] = deduped.map((r, i) => ({
    ref: `T${i + 1}`,
    tweet_id: r.id,
    url: `https://x.com/${handle}/status/${r.id}`,
    date: (r.created_at_iso || "").slice(0, 10),
    snippet: r.text,
    relevance_score: scoredRows.find((s) => String(s.r.id) === String(r.id))?.score,
  }));

  // 3) Knowledge chunks (methodology / theses / weekly_stance / persona_snapshot / sector_map / track_record),
  // ranked by lexical fit and source priority only.
  const kr = await env.DB.prepare(
    `SELECT source,title,text FROM knowledge_chunks WHERE kol_id=? LIMIT 120`
  )
    .bind(kolId)
    .all();
  let kchunks = kr.results || [];
  const scoredKnowledge: { k: any; s: number }[] = [];
  for (const k of kchunks as any[]) {
    let s = lexicalScore(`${k.title || ""}\n${k.text || ""}`, terms, tickers, expandedTerms);
    if (String(k.source || "").includes("methodology")) s += 1;
    if (String(k.source || "").includes("analysis")) s += 0.7;
    if (s > 0.5) scoredKnowledge.push({ k, s });
  }
  scoredKnowledge.sort((a, b) => b.s - a.s);
  if (scoredKnowledge.length) kchunks = scoredKnowledge.map((x) => x.k);
  const knowledge: RetrievedKnowledge[] = kchunks
    .slice(0, 4)
    .map((k: any) => ({
      source: k.source,
      title: k.title,
      text: k.text,
      relevance_score: scoredKnowledge.find((sk) => sk.k === k)?.s,
    }));

  return { citations, knowledge };
}
