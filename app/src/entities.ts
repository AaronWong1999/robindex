// Tradeable-instrument detection: fast-path for common cashtags and dictionary hits.
// The LLM tool round (extract_financial_entities) handles everything the fast-path misses.
import type { Env } from "./env";
import { resolveSymbolCached, getQuotesCached, type Quote } from "./finance";

// Static alias dictionary: common CN/EN names -> internal code. Hit instantly (no network call).
// Kept intentionally small (~30 entries) — the LLM handles long-tail recognition.
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
  kolUniverse?: Set<string>;
  max?: number;
}

type Cand = { token: string; kind: "cash" | "dict" };

// Fast-path candidates: only $cashtags and dictionary matches. The LLM handles the rest.
function candidates(message: string): Cand[] {
  const out: Cand[] = [];
  // L1: $cashtags (strongest signal, zero-cost).
  for (const m of message.matchAll(/\$([A-Za-z]{1,6})\b/g)) out.push({ token: m[1].toUpperCase(), kind: "cash" });
  // L2: dictionary hits — scan CJK spans and English words against BASE_DICT.
  for (const m of message.matchAll(/[一-龥]{2,}|[A-Za-z]{2,}/g)) {
    const tok = m[0];
    if (dictLookup(tok)) out.push({ token: tok, kind: "dict" });
  }
  return out;
}

async function resolveOne(env: Env, token: string, kind: Cand["kind"], universe?: Set<string>): Promise<Quote | null> {
  // Dictionary: instant code, no network search needed.
  const dictCode = dictLookup(token);
  if (dictCode) {
    const qs = await getQuotesCached(env.CACHE, [dictCode]);
    if (qs[0] && qs[0].price > 0 && qs[0].name) return qs[0];
  }
  if (kind === "cash") {
    return resolveSymbolCached(env.CACHE, token);
  }
  return null;
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
  const results: Quote[] = [];
  const seenCode = new Set<string>();
  const triedToken = new Set<string>();
  let attempts = 0;

  for (const { token, kind } of candidates(message)) {
    if (results.length >= max) break;
    if (attempts >= 6) break;
    const key = `${kind}:${token.toUpperCase()}`;
    if (triedToken.has(key)) continue;
    triedToken.add(key);
    attempts++;
    let q: Quote | null = null;
    try {
      q = await resolveOne(env, token, kind);
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
