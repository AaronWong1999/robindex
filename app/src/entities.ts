// Tradeable-instrument detection: from free text (English names, $TICKER / bare tickers,
// Chinese names) detect all mentioned instruments and resolve each to a live Quote.
// Layered: L1 cashtags (strong) > L3 CJK / English-name spans (smartbox) > L2/L4 bare tickers.
import type { Env } from "./env";
import { resolveSymbolCached, searchSymbolHits, getQuotesCached, type Quote } from "./finance";

// Uppercase tokens that look like tickers but almost never are, in finance chatter.
const COMMON_WORDS = new Set([
  "THE","AND","FOR","ARE","BUT","NOT","YOU","ALL","CAN","HER","WAS","ONE","OUR","OUT","DAY","GET","HAS","HIM","HOW","NOW","SEE","TWO","WHO","BOY","DID","ITS","LET","PUT","SAY","SHE","TOO","USE","WHY","WIN","YES","YET","ANY","MAY","NEW","OLD","BIG","BAD","BUY","SELL","HOLD","LONG","CALL","PUT",
  "ETF","CEO","CFO","CTO","COO","USD","CNY","HKD","CPI","PPI","GDP","FED","FOMC","IPO","ATH","ATL","YOY","QOQ","MOM","EPS","WSB","DCA","FYI","LOL","IMO","TBH","AI","ML","LLM","GPU","CPU","API","ETA","ROI","PEG","TTM","GAAP","ARR","TAM","DD","YTD","Q1","Q2","Q3","Q4","FUD","HODL","NFA","DYOR","USA","UK","EU","OK",
]);

// Capitalized English words that begin sentences / are not company names.
const COMMON_CAP_WORDS = new Set([
  "I","Is","Are","The","A","An","And","But","Or","If","So","Do","Does","How","What","When","Where","Why","Who","Which","Should","Could","Would","Will","Can","Use","Get","See","Now","Today","Buy","Sell","Hold","Long","Short","Bull","Bear","Market","Stock","Price","Think","Look","Tell","Give","Help","Please",
]);

// Common Chinese connectives/verbs/particles that glue onto a name in a question.
// We split CJK runs on these so e.g. "宁德时代怎么选" -> "宁德时代", and drop pure-filler spans.
const CJK_STOPWORDS = [
  "怎么样","怎么看","怎么办","怎么","该不该","值不值","买不买","要不要","能不能","可不可","应不应",
  "为什么","什么","怎样","如何","是否","可以","应该","值得","建议","觉得","认为","分析","预测","看好","看空",
  "现在","目前","最近","今天","明天","后天","未来","以后","还能","还会","还有","已经",
  "走势","股价","现价","行情","后市","基本面","技术面","消息","新闻","财报","业绩",
  "分钟","小时","日线","周线","月线","年线","均线",
  "给我","帮我","我想","请问","谢谢","看下","看看","查下","查一下","对比","相比","比较","还是","以及","和","与","跟",
  "的","了","吗","呢","吧","啊","呀","嘛","哦","怎","选","买","卖","涨","跌","该","能","会","要",
];
const CJK_STOP_RE = new RegExp(CJK_STOPWORDS.join("|"), "g");

// Longest-common-substring length between two strings (cheap; strings are short).
function lcsLen(a: string, b: string): number {
  let best = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      let k = 0;
      while (i + k < a.length && j + k < b.length && a[i + k] === b[j + k]) k++;
      if (k > best) best = k;
    }
  }
  return best;
}

// Accept a smartbox hit for a CJK query only if its Chinese name actually overlaps the query
// (rejects fuzzy junk like 分钟 -> 分众传媒). Substring either way, or 2+ shared contiguous chars.
function cjkNameMatches(token: string, name: string): boolean {
  if (!name) return false;
  if (name.includes(token) || token.includes(name)) return true;
  return lcsLen(token, name) >= 2;
}

// Static alias dictionary: common CN/EN names -> internal code. Hit instantly (no smartbox call) and
// disambiguates names that smartbox returns multiple matches for. Latin keys are matched lowercased.
const BASE_DICT: Record<string, string> = {
  // US
  apple: "usAAPL", 苹果: "usAAPL", nvidia: "usNVDA", 英伟达: "usNVDA", tesla: "usTSLA", 特斯拉: "usTSLA",
  microsoft: "usMSFT", 微软: "usMSFT", google: "usGOOGL", alphabet: "usGOOGL", 谷歌: "usGOOGL",
  amazon: "usAMZN", 亚马逊: "usAMZN", meta: "usMETA", 脸书: "usMETA", netflix: "usNFLX", 奈飞: "usNFLX",
  amd: "usAMD", broadcom: "usAVGO", 博通: "usAVGO", micron: "usMU", 美光: "usMU", circle: "usCRCL",
  coinbase: "usCOIN", palantir: "usPLTR", nebius: "usNBIS",
  // HK
  腾讯: "hk00700", tencent: "hk00700", 阿里巴巴: "hk09988", 阿里: "hk09988", alibaba: "hk09988",
  美团: "hk03690", meituan: "hk03690", 小米: "hk01810", xiaomi: "hk01810", 京东: "hk09618",
  // A-share
  茅台: "sh600519", 贵州茅台: "sh600519", maotai: "sh600519", 宁德时代: "sz300750", 宁德: "sz300750",
  五粮液: "sz000858", 比亚迪: "sz002594", 隆基绿能: "sh601012", 招商银行: "sh600036",
  中国平安: "sh601318", 平安: "sh601318",
};

function dictLookup(token: string): string | null {
  return BASE_DICT[token] || BASE_DICT[token.toLowerCase()] || null;
}

export interface DetectOptions {
  kolUniverse?: Set<string>; // internal codes the active KOL talks about, to bias disambiguation
  max?: number;
}

type Cand = { token: string; kind: "cash" | "cjk" | "phrase" | "upper" };

// Pull ranked candidate spans out of the message (highest-confidence kinds first).
function candidates(message: string): Cand[] {
  const out: Cand[] = [];
  const push = (token: string, kind: Cand["kind"]) => out.push({ token, kind });

  // L1 $cashtags (strongest signal).
  for (const m of message.matchAll(/\$([A-Za-z]{1,6})\b/g)) push(m[1].toUpperCase(), "cash");
  // L3a Chinese name spans — split each run on stopwords to isolate the name from filler words.
  for (const m of message.matchAll(/[一-龥]{2,}/g)) {
    for (const piece of m[0].replace(CJK_STOP_RE, " ").split(/\s+/)) {
      if (piece.length >= 2 && piece.length <= 6) push(piece, "cjk");
    }
  }
  // L3b Capitalized English name phrases (1-3 words, e.g. "Apple", "Eli Lilly").
  for (const m of message.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/g)) {
    if (!COMMON_CAP_WORDS.has(m[1])) push(m[1], "phrase");
  }
  // L2/L4 bare UPPER tickers (weak; filtered by stopword list).
  for (const m of message.matchAll(/\b([A-Z]{2,5})\b/g)) {
    if (!COMMON_WORDS.has(m[1])) push(m[1], "upper");
  }
  return out;
}

async function resolveOne(
  env: Env,
  token: string,
  kind: Cand["kind"],
  universe?: Set<string>
): Promise<Quote | null> {
  // L2 dictionary: instant code for common names, no network search needed.
  const dictCode = dictLookup(token);
  if (dictCode) {
    const qs = await getQuotesCached(env.CACHE, [dictCode]);
    if (qs[0] && qs[0].price > 0 && qs[0].name) return qs[0];
  }

  if (kind === "cash" || kind === "upper") {
    // resolveSymbolCached tries US-shape first, then smartbox fallback.
    return resolveSymbolCached(env.CACHE, token);
  }
  // cjk / phrase: search candidates and bias toward the KOL's known universe.
  let hits = await searchSymbolHits(token, 5);
  if (kind === "cjk") {
    // Reject fuzzy mismatches whose name doesn't actually overlap the query.
    hits = hits.filter((h) => cjkNameMatches(token, h.name));
  }
  if (!hits.length) return null;
  let pick = hits[0].code;
  if (universe) {
    const u = hits.find((h) => universe.has(h.code));
    if (u) pick = u.code;
  }
  const qs = await getQuotesCached(env.CACHE, [pick]);
  const q = qs[0];
  return q && q.price > 0 && q.name ? q : null;
}

// Build the active KOL's "universe" of instruments from their tweet $cashtags (assumed US-listed,
// which dominates KOL chatter), to bias disambiguation. Cached in KV for a day.
export async function getKolUniverse(env: Env, kolId: string): Promise<Set<string>> {
  const cacheKey = `kuniv:${kolId}`;
  if (env.CACHE) {
    const hit = await env.CACHE.get(cacheKey, "json");
    if (hit) return new Set(hit as string[]);
  }
  const r = await env.DB.prepare(
    `SELECT text FROM tweets WHERE kol_id=? AND is_retweet=0 ORDER BY created_at_ts DESC LIMIT 500`
  )
    .bind(kolId)
    .all();
  const tally = new Map<string, number>();
  for (const row of (r.results || []) as any[]) {
    for (const m of String(row.text || "").matchAll(/\$([A-Za-z]{1,6})\b/g)) {
      const t = m[1].toUpperCase();
      tally.set(t, (tally.get(t) || 0) + 1);
    }
  }
  const top = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 100).map(([t]) => `us${t}`);
  if (env.CACHE) await env.CACHE.put(cacheKey, JSON.stringify(top), { expirationTtl: 86400 });
  return new Set(top);
}

export async function detectInstruments(
  env: Env,
  message: string,
  opts: DetectOptions = {}
): Promise<Quote[]> {
  const max = opts.max ?? 4;
  const universe = opts.kolUniverse;
  const results: Quote[] = [];
  const seenCode = new Set<string>();
  const triedToken = new Set<string>();
  let attempts = 0;

  for (const { token, kind } of candidates(message)) {
    if (results.length >= max) break;
    if (attempts >= 8) break; // bound network fan-out per message
    const key = `${kind}:${token.toUpperCase()}`;
    if (triedToken.has(key)) continue;
    triedToken.add(key);
    attempts++;
    let q: Quote | null = null;
    try {
      q = await resolveOne(env, token, kind, universe);
    } catch {
      q = null;
    }
    if (q && !seenCode.has(q.code)) {
      seenCode.add(q.code);
      results.push(q);
    }
  }
  return results;
}
