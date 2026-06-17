// US & HK stock data via Eastmoney HTTP APIs + Yahoo Finance + SEC EDGAR (from global-stock-data SKILL).
// All endpoints are KV-cached. Covers: financial statements, key indicators, analyst data,
// market ranking, SEC filings, Sina US K-line.

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const DATACENTER_URL = "https://datacenter-web.eastmoney.com/api/data/v1/get";
const SEC_UA = "Robindex/1.0 (contact@robindex.ai)";

// ---- helpers ----

async function cached<T>(kv: KVNamespace | undefined, key: string, ttl: number, miss: () => Promise<T>): Promise<T> {
  if (!kv) return miss();
  const hit = await kv.get(key, "json");
  if (hit) return hit as T;
  const val = await miss();
  try { await kv.put(key, JSON.stringify(val), { expirationTtl: ttl }); } catch {}
  return val;
}

async function emFetch(url: string, params: Record<string, string>, headers?: Record<string, string>): Promise<any> {
  const qs = new URLSearchParams(params).toString();
  const fullUrl = url.includes("?") ? `${url}&${qs}` : `${url}?${qs}`;
  const res = await fetch(fullUrl, {
    headers: { "User-Agent": UA, Referer: "https://quote.eastmoney.com/", ...(headers || {}) },
  });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

async function emDatacenter(reportName: string, filter: string, opts?: { pageSize?: number; sortColumns?: string; sortTypes?: string }): Promise<any[]> {
  const params: Record<string, string> = {
    reportName, columns: "ALL", filter,
    pageNumber: "1", pageSize: String(opts?.pageSize ?? 50),
    sortColumns: opts?.sortColumns || "", sortTypes: opts?.sortTypes || "-1",
    source: "WEB", client: "WEB",
  };
  const d = await emFetch(DATACENTER_URL, params);
  return d?.result?.data || [];
}

// ---- Secucode mapping: usAAPL → AAPL.O, hk00700 → 00700.HK ----

async function resolveSecucode(kv: KVNamespace | undefined, code: string): Promise<string> {
  // HK: always CODE.HK (5-digit padded)
  if (code.startsWith("hk")) {
    let digits = code.replace(/^hk/, "");
    while (digits.length < 5) digits = "0" + digits;
    return `${digits}.HK`;
  }
  // US: need to determine .O (NASDAQ) vs .N (NYSE) vs .A (AMEX)
  const ticker = code.replace(/^us/, "").toUpperCase();
  // Try KV cache first
  if (kv) {
    const hit = await kv.get(`secucode:${ticker}`);
    if (hit) return hit;
  }
  // Query Eastmoney search API for MktNum
  const d = await emFetch("https://searchapi.eastmoney.com/api/suggest/get", {
    input: ticker, type: "14", token: "D43BF722C8E33BDC906FB84D85E326E8", count: "5",
  });
  const suggestions: any[] = d?.QuotationCodeTable?.Data || [];
  let suffix = ".O"; // default NASDAQ
  for (const s of suggestions) {
    if (String(s.Code).toUpperCase() === ticker) {
      const mkt = String(s.MktNum || "");
      if (mkt === "106") suffix = ".N";
      else if (mkt === "107") suffix = ".A";
      break;
    }
  }
  const result = `${ticker}${suffix}`;
  if (kv) { try { await kv.put(`secucode:${ticker}`, result, { expirationTtl: 86400 }); } catch {} }
  return result;
}

// ---- Yahoo Finance session (cookie + crumb) ----

interface YahooSession { cookie: string; crumb: string }

async function getYahooSession(kv: KVNamespace | undefined): Promise<YahooSession | null> {
  if (kv) {
    const hit = await kv.get("yhcrumb", "json");
    if (hit) return hit as YahooSession;
  }
  try {
    // Step 1: get cookie from fc.yahoo.com
    const r1 = await fetch("https://fc.yahoo.com", {
      headers: { "User-Agent": UA }, redirect: "manual",
    });
    const setCookie = r1.headers.get("set-cookie") || "";
    const cookie = setCookie.split(";")[0] || "";

    // Step 2: get crumb
    const r2 = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
      headers: { "User-Agent": UA, Cookie: cookie },
    });
    if (!r2.ok) return null;
    const crumb = await r2.text();
    const session: YahooSession = { cookie, crumb };
    if (kv) { try { await kv.put("yhcrumb", JSON.stringify(session), { expirationTtl: 3600 }); } catch {} }
    return session;
  } catch {
    return null;
  }
}

// ---- Types ----

export interface FinancialRow { itemName: string; amount: number; yoyRatio: number; report: string; reportDate: string }
export interface KeyIndicatorRow { reportDate: string; operateIncome: number; basicEps: number; roe: number; roa: number; grossProfitRatio: number; netProfitRatio: number; debtAssetRatio: number; incomeYoy: number; epsYoy: number; [key: string]: any }
export interface AnalystData { recommendation: string; targetMean: number; targetHigh: number; targetLow: number; trailingPe: number; forwardPe: number; pegRatio: number; priceToBook: number; profitMargin: number; returnOnEquity: number; beta: number; epsTrend: any[]; ratingTrend: any[]; topHolders: any[] }
export interface MarketStock { code: string; name: string; price: number; changePct: number; volume: number; amount: number }
export interface SecFiling { form: string; date: string; accessionNumber: string; url: string; description: string }
export interface SinaKline { date: string; open: number; high: number; low: number; close: number; volume: number }

// ---- 1. Financial statements (balance / income / cashflow) ----

export async function getFinancialStatements(
  kv: KVNamespace | undefined, code: string, statement: "balance" | "income" | "cashflow", periods = 4
): Promise<FinancialRow[]> {
  const secucode = await resolveSecucode(kv, code);
  return cached(kv, `emfin:${secucode}:${statement}:${periods}`, 86400, async () => {
    const isHK = secucode.endsWith(".HK");
    const reportMap: Record<string, { us: string; hk: string }> = {
      balance: { us: "RPT_USF10_FN_BALANCE", hk: "RPT_HKF10_FN_BALANCE" },
      income:  { us: "RPT_USF10_FN_INCOME", hk: "RPT_HKF10_FN_INCOME" },
      cashflow: { us: "RPT_USSK_FN_CASHFLOW", hk: "RPT_HKSK_FN_CASHFLOW" },
    };
    const reportName = reportMap[statement][isHK ? "hk" : "us"];
    const data = await emDatacenter(reportName, `(SECUCODE="${secucode}")`,
      { pageSize: periods * 30, sortColumns: "REPORT_DATE", sortTypes: "-1" }); // ~30 items per period
    return data.slice(0, periods * 30).map((row: any) => ({
      itemName: row.ITEM_NAME || "", amount: row.AMOUNT || 0,
      yoyRatio: row.YOY_RATIO || 0, report: row.REPORT || "",
      reportDate: String(row.REPORT_DATE || "").slice(0, 10),
    }));
  });
}

// ---- 2. Key financial indicators (GMAININDICATOR) ----

export async function getKeyIndicators(kv: KVNamespace | undefined, code: string, periods = 4): Promise<KeyIndicatorRow[]> {
  const secucode = await resolveSecucode(kv, code);
  return cached(kv, `emki:${secucode}:${periods}`, 86400, async () => {
    const isHK = secucode.endsWith(".HK");
    const reportName = isHK ? "RPT_HKF10_FN_GMAININDICATOR" : "RPT_USF10_FN_GMAININDICATOR";
    const data = await emDatacenter(reportName, `(SECUCODE="${secucode}")`,
      { pageSize: periods, sortColumns: "REPORT_DATE", sortTypes: "-1" });
    return data.map((row: any) => ({
      reportDate: String(row.REPORT_DATE || "").slice(0, 10),
      operateIncome: row.OPERATE_INCOME || 0,
      basicEps: row.BASIC_EPS || 0,
      roe: row.ROE_AVG || 0,
      roa: row.ROA || 0,
      grossProfitRatio: row.GROSS_PROFIT_RATIO || 0,
      netProfitRatio: row.NET_PROFIT_RATIO || 0,
      debtAssetRatio: row.DEBT_ASSET_RATIO || 0,
      incomeYoy: row.OPERATE_INCOME_YOY || 0,
      epsYoy: row.BASIC_EPS_YOY || 0,
    }));
  });
}

// ---- 3. Analyst data (Yahoo quoteSummary) ----

export async function getAnalystData(kv: KVNamespace | undefined, code: string): Promise<AnalystData | null> {
  const ticker = code.replace(/^us/, "").replace(/^hk/, "");
  const symbol = code.startsWith("hk")
    ? `${ticker.replace(/^0+/, "") || "0"}.HK`
    : ticker.toUpperCase();
  return cached(kv, `yhsum:${symbol}`, 3600, async () => {
    const session = await getYahooSession(kv);
    const modules = "financialData,defaultKeyStatistics,summaryDetail,earningsTrend,recommendationTrend,institutionOwnership,majorHoldersBreakdown";
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}${session ? `&crumb=${encodeURIComponent(session.crumb)}` : ""}`;
    const res = await fetch(url, {
      headers: { "User-Agent": UA, ...(session ? { Cookie: session.cookie } : {}) },
    });
    if (!res.ok) return null;
    const json: any = await res.json().catch(() => null);
    const result = json?.quoteSummary?.result?.[0];
    if (!result) return null;

    const fd = result.financialData || {};
    const ks = result.defaultKeyStatistics || {};
    const sd = result.summaryDetail || {};

    const _v = (d: any, key: string) => {
      const v = d?.[key];
      return typeof v === "object" && v?.raw !== undefined ? v.raw : v;
    };

    // EPS trend
    const et = result.earningsTrend?.trend || [];
    const epsTrend = et.map((t: any) => ({
      period: t.period, endDate: t.endDate,
      epsEstimate: t.earningsEstimate?.avg?.raw,
      revenueEstimate: t.revenueEstimate?.avg?.raw,
      numAnalysts: t.earningsEstimate?.numberOfAnalysts?.raw,
    }));

    // Rating trend
    const rt = result.recommendationTrend?.trend || [];
    const ratingTrend = rt.map((r: any) => ({
      period: r.period, strongBuy: r.strongBuy, buy: r.buy, hold: r.hold, sell: r.sell, strongSell: r.strongSell,
    }));

    // Top holders
    const io = result.institutionOwnership?.ownershipList || [];
    const topHolders = io.slice(0, 10).map((h: any) => ({
      name: h.organization, shares: _v(h, "position"), pctHeld: _v(h, "pctHeld"),
    }));

    return {
      recommendation: fd.recommendationKey || "",
      targetMean: _v(fd, "targetMeanPrice") ?? 0,
      targetHigh: _v(fd, "targetHighPrice") ?? 0,
      targetLow: _v(fd, "targetLowPrice") ?? 0,
      trailingPe: _v(sd, "trailingPE") ?? 0,
      forwardPe: _v(ks, "forwardPE") ?? 0,
      pegRatio: _v(ks, "pegRatio") ?? 0,
      priceToBook: _v(ks, "priceToBook") ?? 0,
      profitMargin: _v(ks, "profitMargins") ?? 0,
      returnOnEquity: _v(fd, "returnOnEquity") ?? 0,
      beta: _v(ks, "beta") ?? 0,
      epsTrend, ratingTrend, topHolders,
    };
  });
}

// ---- 4. Market ranking (push2 clist) ----

export async function getMarketRanking(
  kv: KVNamespace | undefined, market: string, sort = "f3", limit = 20
): Promise<{ total: number; stocks: MarketStock[] }> {
  return cached(kv, `emmkt:${market}:${sort}:${limit}`, 300, async () => {
    const marketMap: Record<string, string> = {
      us_nasdaq: "m:105", us_nyse: "m:106", us_etf: "m:107", hk: "m:116", cn_industry: "m:90+t:2",
    };
    const fs = marketMap[market] || market;
    const d = await emFetch("https://push2.eastmoney.com/api/qt/clist/get", {
      fs, fields: "f2,f3,f4,f5,f6,f7,f12,f14,f15,f16,f17,f18",
      pn: "1", pz: String(limit), fid: sort, po: "1",
    });
    const data = d?.data || {};
    const diff: any[] = data.diff || [];
    return {
      total: data.total || 0,
      stocks: diff.map((it: any) => ({
        code: it.f12 || "", name: it.f14 || "",
        price: typeof it.f2 === "number" ? it.f2 / 100 : 0,
        changePct: typeof it.f3 === "number" ? it.f3 / 100 : 0,
        volume: it.f5 || 0, amount: it.f6 || 0,
      })),
    };
  });
}

// ---- 5. SEC EDGAR filings ----

export async function getSecFilings(kv: KVNamespace | undefined, symbol: string, formType?: string): Promise<{ companyName: string; cik: string; filings: SecFiling[] }> {
  const ticker = symbol.replace(/^us/, "").toUpperCase();
  return cached(kv, `secfil:${ticker}:${formType || "all"}`, 86400, async () => {
    // Step 1: ticker → CIK
    const cikRes = await fetch("https://www.sec.gov/files/company_tickers.json", { headers: { "User-Agent": SEC_UA } });
    const cikMap: any = await cikRes.json().catch(() => ({}));
    let cik = "";
    let companyName = ticker;
    for (const v of Object.values(cikMap) as any[]) {
      if (v.ticker === ticker) {
        cik = String(v.cik_str).padStart(10, "0");
        companyName = v.title;
        break;
      }
    }
    if (!cik) return { companyName: ticker, cik: "", filings: [] };

    // Step 2: fetch filings
    const res = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, { headers: { "User-Agent": SEC_UA } });
    if (!res.ok) return { companyName, cik, filings: [] };
    const data: any = await res.json().catch(() => ({}));
    const recent = data?.filings?.recent || {};
    const forms: string[] = recent.form || [];
    const dates: string[] = recent.filingDate || [];
    const accessions: string[] = recent.accessionNumber || [];
    const docs: string[] = recent.primaryDocument || [];
    const descs: string[] = recent.primaryDocDescription || [];

    const filings: SecFiling[] = [];
    for (let i = 0; i < forms.length; i++) {
      if (formType && forms[i] !== formType) continue;
      if (filings.length >= 50) break;
      const acc = accessions[i] || "";
      filings.push({
        form: forms[i], date: dates[i] || "", accessionNumber: acc,
        description: descs[i] || "",
        url: docs[i] ? `https://www.sec.gov/Archives/edgar/data/${parseInt(cik)}/${acc.replace(/-/g, "")}/${docs[i]}` : "",
      });
    }
    return { companyName, cik, filings };
  });
}

// ---- 6. Sina US K-line (historical back to 1984) ----

export async function getSinaKline(kv: KVNamespace | undefined, symbol: string, num = 120): Promise<SinaKline[]> {
  const ticker = symbol.replace(/^us/, "").toUpperCase();
  return cached(kv, `sinakl:${ticker}:${num}`, 3600, async () => {
    const url = `https://stock.finance.sina.com.cn/usstock/api/jsonp.php/var/US_MinKService.getDailyK?symbol=${ticker}&num=${num}`;
    const res = await fetch(url, { headers: { "User-Agent": UA, Referer: "https://finance.sina.com.cn/" } });
    if (!res.ok) return [];
    const text = await res.text();
    const m = text.match(/\((\[.+\])\)/);
    if (!m) return [];
    try {
      const items: any[] = JSON.parse(m[1]);
      return items.map((it) => ({
        date: it.d || "", open: +it.o || 0, high: +it.h || 0,
        low: +it.l || 0, close: +it.c || 0, volume: +it.v || 0,
      }));
    } catch { return []; }
  });
}

// ---- 7. Unified financial profile for US/HK stocks ----

export interface GlobalFinancialProfile {
  pe: number;
  forwardPe: number;
  peg: number;
  pb: number;
  roe: number;
  roa: number;
  grossMargin: number;
  netMargin: number;
  debtRatio: number;
  revenueYoY: number;
  epsYoY: number;
  eps: number;
  revenue: number;
  beta: number;
  targetPrice: number;
  targetRange: string;
  recommendation: string;
  analystCount: number;
  topHolders: string[];
}

export async function getStockFinancialProfile(
  kv: KVNamespace | undefined, code: string
): Promise<GlobalFinancialProfile | null> {
  const isHK = code.startsWith("hk");
  const isUS = code.startsWith("us");
  if (!isHK && !isUS) return null;

  const [indicators, analyst] = await Promise.all([
    getKeyIndicators(kv, code, 2).catch(() => [] as KeyIndicatorRow[]),
    getAnalystData(kv, code).catch(() => null),
  ]);

  const latest = indicators[0] || ({} as KeyIndicatorRow);
  if (!latest.reportDate && !analyst) return null;

  return {
    pe: analyst?.trailingPe || 0,
    forwardPe: analyst?.forwardPe || 0,
    peg: analyst?.pegRatio || 0,
    pb: analyst?.priceToBook || 0,
    roe: latest.roe || analyst?.returnOnEquity || 0,
    roa: latest.roa || 0,
    grossMargin: latest.grossProfitRatio || 0,
    netMargin: latest.netProfitRatio || analyst?.profitMargin || 0,
    debtRatio: latest.debtAssetRatio || 0,
    revenueYoY: latest.incomeYoy || 0,
    epsYoY: latest.epsYoy || 0,
    eps: latest.basicEps || 0,
    revenue: latest.operateIncome || 0,
    beta: analyst?.beta || 0,
    targetPrice: analyst?.targetMean || 0,
    targetRange: analyst ? `${analyst.targetLow}-${analyst.targetHigh}` : "",
    recommendation: analyst?.recommendation || "",
    analystCount: analyst?.ratingTrend?.[0]
      ? Object.values(analyst.ratingTrend[0] as Record<string, number>).reduce((a: number, b: number) => a + (typeof b === "number" ? b : 0), 0)
      : 0,
    topHolders: analyst?.topHolders?.slice(0, 5).map((h) => `${h.name} ${h.pctHeld}%`) || [],
  };
}

