// Live market data via public Tencent (自选股) endpoints. No API key required.
// Code formats: A-share sh######/sz######/bj######, HK hk#####, US us<SYM>.

export interface Quote {
  code: string;       // normalized internal code, e.g. usSOXL
  symbol: string;     // display symbol, e.g. SOXL
  name: string;
  market: "us" | "hk" | "cn";
  currency: string;
  price: number;
  prevClose: number;
  open: number;
  high: number;
  low: number;
  change: number;
  changePct: number;
  volume: number;
  time: string;
  raw?: string;
}

export interface Kline {
  code: string;
  period: string;
  candles: { date: string; open: number; close: number; high: number; low: number; volume: number }[];
}

function marketOf(code: string): "us" | "hk" | "cn" {
  if (code.startsWith("us")) return "us";
  if (code.startsWith("hk")) return "hk";
  return "cn";
}
function currencyOf(m: string): string {
  return m === "us" ? "USD" : m === "hk" ? "HKD" : "CNY";
}

async function fetchGbkText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", Referer: "https://gu.qq.com/" } });
  const buf = await res.arrayBuffer();
  try {
    return new TextDecoder("gbk").decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}

const num = (s: string | undefined) => {
  const n = parseFloat((s ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};

// Parse one `v_<code>="a~b~c~..."` line from qt.gtimg.cn.
export function parseQuoteLine(code: string, line: string): Quote | null {
  const m = line.match(/="([^"]*)"/);
  if (!m) return null;
  const f = m[1].split("~");
  if (f.length < 7 || !f[1]) return null;
  const market = marketOf(code);
  const price = num(f[3]);
  const prevClose = num(f[4]);
  const open = num(f[5]);
  const change = prevClose ? price - prevClose : num(f[31]);
  const changePct = prevClose ? (change / prevClose) * 100 : num(f[32]);
  // high/low live at 33/34 for US; for A/HK they are also 33/34 in the long form.
  const high = num(f[33]) || Math.max(price, open);
  const low = num(f[34]) || Math.min(price || open, open || price);
  return {
    code,
    symbol: code.replace(/^us|^hk/, "").replace(/\.\w+$/, ""),
    name: f[1],
    market,
    currency: currencyOf(market),
    price,
    prevClose,
    open,
    high,
    low,
    change,
    changePct,
    volume: num(f[6]),
    time: f[30] || "",
    raw: m[1],
  };
}

// ---- KV-cached wrappers (short TTL) ----
export async function getQuotesCached(kv: KVNamespace | undefined, codes: string[]): Promise<Quote[]> {
  if (!kv || !codes.length) return getQuotes(codes);
  const key = `q:${codes.slice().sort().join(",")}`;
  const hit = await kv.get(key, "json");
  if (hit) return hit as Quote[];
  const q = await getQuotes(codes);
  if (q.length) await kv.put(key, JSON.stringify(q), { expirationTtl: 60 }); // KV min TTL is 60s
  return q;
}

export async function getKlineCached(
  kv: KVNamespace | undefined,
  code: string,
  period = "day",
  limit = 60
): Promise<Kline> {
  if (!kv) return getKline(code, period, limit);
  const key = `k:${code}:${period}:${limit}`;
  const hit = await kv.get(key, "json");
  if (hit) return hit as Kline;
  const k = await getKline(code, period, limit);
  if (k.candles.length) await kv.put(key, JSON.stringify(k), { expirationTtl: 600 });
  return k;
}

export async function resolveSymbolCached(kv: KVNamespace | undefined, token: string): Promise<Quote | null> {
  // resolve mapping is stable-ish; cache the resolved code, but always fetch a fresh quote.
  if (!kv) return resolveSymbol(token);
  const mapKey = `r:${token.trim().toUpperCase()}`;
  const code = await kv.get(mapKey);
  if (code) {
    const qs = await getQuotesCached(kv, [code]);
    if (qs[0]) return qs[0];
  }
  const q = await resolveSymbol(token);
  if (q) await kv.put(mapKey, q.code, { expirationTtl: 86400 });
  return q;
}

export async function getQuotes(codes: string[]): Promise<Quote[]> {
  if (!codes.length) return [];
  const url = `https://qt.gtimg.cn/q=${codes.join(",")}`;
  const text = await fetchGbkText(url);
  const out: Quote[] = [];
  for (const raw of text.split(";")) {
    const idm = raw.match(/v_([a-zA-Z0-9.]+)=/);
    if (!idm) continue;
    const q = parseQuoteLine(idm[1], raw);
    if (q) out.push(q);
  }
  return out;
}

export async function getKline(code: string, period = "day", limit = 60): Promise<Kline> {
  const market = marketOf(code);
  // US daily/weekly/monthly history: Tencent only returns the latest candle, so use Yahoo.
  if (market === "us") return getKlineYahoo(code, period, limit);

  const base = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get";
  const url = `${base}?param=${code},${period},,,${limit},qfq`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", Referer: "https://gu.qq.com/" } });
  const json: any = await res.json();
  const node = json?.data?.[code] || {};
  const rows: any[] = node[period] || node[`qfq${period}`] || [];
  const candles = rows.map((r) => ({
    date: r[0],
    open: num(r[1]),
    close: num(r[2]),
    high: num(r[3]),
    low: num(r[4]),
    volume: num(r[5]),
  }));
  return { code, period, candles };
}

async function getKlineYahoo(code: string, period: string, limit: number): Promise<Kline> {
  const symbol = code.replace(/^us/, "").replace(/\.\w+$/, "");
  const interval = period === "week" ? "1wk" : period === "month" ? "1mo" : "1d";
  let range = "3mo";
  if (interval === "1d") range = limit <= 25 ? "1mo" : limit <= 70 ? "3mo" : limit <= 130 ? "6mo" : limit <= 260 ? "1y" : "2y";
  else range = period === "month" ? "10y" : "5y";
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  const json: any = await res.json();
  const r = json?.chart?.result?.[0];
  const candles: Kline["candles"] = [];
  if (r?.timestamp && r.indicators?.quote?.[0]) {
    const q = r.indicators.quote[0];
    for (let i = 0; i < r.timestamp.length; i++) {
      if (q.close[i] == null) continue;
      candles.push({
        date: new Date(r.timestamp[i] * 1000).toISOString().slice(0, 10),
        open: q.open[i] ?? q.close[i],
        high: q.high[i] ?? q.close[i],
        low: q.low[i] ?? q.close[i],
        close: q.close[i],
        volume: q.volume[i] ?? 0,
      });
    }
  }
  return { code, period, candles: candles.slice(-limit) };
}

// Resolve a free-form symbol/name to a concrete tradable code + quote.
// Strategy: try US first (most KOL chatter is US tickers), then HK/A by shape, then keyword search.
export async function resolveSymbol(token: string): Promise<Quote | null> {
  const t = token.trim().replace(/^\$/, "");
  if (!t) return null;
  const candidates: string[] = [];
  if (/^[A-Za-z][A-Za-z.\-]{0,6}$/.test(t)) candidates.push(`us${t.toUpperCase()}`);
  if (/^\d{5}$/.test(t)) candidates.push(`hk${t}`);
  if (/^(6|9)\d{5}$/.test(t)) candidates.push(`sh${t}`);
  if (/^(0|3|2)\d{5}$/.test(t)) candidates.push(`sz${t}`);
  if (/^(8|4)\d{5}$/.test(t)) candidates.push(`bj${t}`);
  for (const c of candidates) {
    const qs = await getQuotes([c]);
    if (qs[0] && qs[0].price > 0 && qs[0].name) return qs[0];
  }
  // Fallback: keyword search (handles Chinese names / ambiguous symbols).
  const hit = await searchSymbol(t);
  if (hit) {
    const qs = await getQuotes([hit]);
    if (qs[0]) return qs[0];
  }
  return null;
}

export async function searchSymbol(keyword: string): Promise<string | null> {
  try {
    const url = `https://proxy.finance.qq.com/ifzqgtimg/appstock/smartbox/search/get?app=search&q=${encodeURIComponent(
      keyword
    )}&t=all`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", Referer: "https://gu.qq.com/" } });
    const text = await fetchGbkTextFromRes(res);
    // Response is `v_hint="us~SOXL~...^..."` style; pull the first code-ish token.
    const m = text.match(/="([^"]*)"/);
    if (!m) return null;
    const first = m[1].split("^")[0]?.split("~") || [];
    const mkt = (first[0] || "").toLowerCase();
    const sym = first[1] || "";
    if (!sym) return null;
    if (mkt.includes("us")) return `us${sym.toUpperCase()}`;
    if (mkt === "hk") return `hk${sym}`;
    if (mkt === "sh" || mkt === "sz" || mkt === "bj") return `${mkt}${sym}`;
    return null;
  } catch {
    return null;
  }
}

async function fetchGbkTextFromRes(res: Response): Promise<string> {
  const buf = await res.arrayBuffer();
  try {
    return new TextDecoder("gbk").decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}
