// A-share data via Eastmoney HTTP APIs (from a-stock-data SKILL). All endpoints are KV-cached.
// Covers: sector/concept blocks, fund flow, dragon-tiger, lockup, industry ranking,
//         margin trading, stock info, research reports.
// Note: mootdx (TCP) is unavailable in Workers; we use Eastmoney push2/datacenter/reportapi only.

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const DATACENTER_URL = "https://datacenter-web.eastmoney.com/api/data/v1/get";
const PUSH2_URL = "https://push2.eastmoney.com/api/qt";

// ---- helpers ----

async function cached<T>(kv: KVNamespace | undefined, key: string, ttl: number, miss: () => Promise<T>): Promise<T> {
  if (!kv) return miss();
  const hit = await kv.get(key, "json");
  if (hit) return hit as T;
  const val = await miss();
  try { await kv.put(key, JSON.stringify(val), { expirationTtl: ttl }); } catch {}
  return val;
}

/** sh600519 → 1.600519, sz000858 → 0.000858, bj832000 → 0.832000 */
function toSecid(code: string): string {
  const c = code.replace(/^(sh|sz|bj)/i, "");
  if (code.startsWith("sh")) return `1.${c}`;
  return `0.${c}`;
}

/** Strip sh/sz/bj prefix to get raw 6-digit code. */
function rawCode(code: string): string {
  return code.replace(/^(sh|sz|bj)/i, "");
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

async function emDatacenter(
  reportName: string, filter: string, opts?: { pageSize?: number; sortColumns?: string; sortTypes?: string }
): Promise<any[]> {
  const params: Record<string, string> = {
    reportName, columns: "ALL", filter,
    pageNumber: "1", pageSize: String(opts?.pageSize ?? 50),
    sortColumns: opts?.sortColumns || "", sortTypes: opts?.sortTypes || "-1",
    source: "WEB", client: "WEB",
  };
  const d = await emFetch(DATACENTER_URL, params);
  return d?.result?.data || [];
}

// ---- Types ----

export interface SectorBlock { name: string; code: string; changePct: number; leader: string }
export interface FundFlowMinute { time: string; mainNet: number; smallNet: number; midNet: number; largeNet: number; superNet: number }
export interface DragonTigerSeat { name: string; buyAmt: number; sellAmt: number; net: number }
export interface DragonTigerRecord { date: string; reason: string; netBuy: number; turnover: number }
export interface DragonTigerResult { records: DragonTigerRecord[]; seats: { buy: DragonTigerSeat[]; sell: DragonTigerSeat[] }; institution: { buyAmt: number; sellAmt: number; netAmt: number } }
export interface LockupEntry { date: string; type: string; shares: number; ratio: number }
export interface IndustryRow { rank: number; name: string; code: string; changePct: number; upCount: number; downCount: number; leader: string; leaderChange: number }
export interface MarginRow { date: string; rzye: number; rzmre: number; rzche: number; rqye: number; rqmcl: number; rqchl: number; rzrqye: number }
export interface StockInfo { code: string; name: string; industry: string; totalShares: number; floatShares: number; mcap: number; floatMcap: number; listDate: string; price: number }
export interface ReportRow { title: string; publishDate: string; orgName: string; infoCode: string; predictThisYearEps: number; predictNextYearEps: number; rating: string; industry: string }

// ---- 1. Sector / concept blocks ----

export async function getSectorBlocks(kv: KVNamespace | undefined, code: string): Promise<{ total: number; boards: SectorBlock[]; tags: string[] }> {
  const c = rawCode(code);
  return cached(kv, `emblk:${c}`, 3600, async () => {
    const secid = c.startsWith("6") ? `1.${c}` : `0.${c}`;
    const d = await emFetch(`${PUSH2_URL}/slist/get`, {
      fltt: "2", invt: "2", secid, spt: "3", pi: "0", pz: "200", po: "1",
      fields: "f12,f14,f3,f128",
    });
    if (!d) return { total: 0, boards: [], tags: [] };
    const diff = d?.data?.diff || {};
    const items = typeof diff === "object" && !Array.isArray(diff) ? Object.values(diff) : (Array.isArray(diff) ? diff : []);
    const boards: SectorBlock[] = [];
    for (const it of items as any[]) {
      boards.push({
        name: it.f14 || "", code: it.f12 || "",
        changePct: typeof it.f3 === "number" ? it.f3 : 0,
        leader: it.f128 || "",
      });
    }
    return { total: boards.length, boards, tags: boards.map((b) => b.name) };
  });
}

// ---- 2. Fund flow (minute-level) ----

export async function getFundFlowMinute(kv: KVNamespace | undefined, code: string): Promise<FundFlowMinute[]> {
  const c = rawCode(code);
  return cached(kv, `emffm:${c}`, 120, async () => {
    const secid = c.startsWith("6") ? `1.${c}` : `0.${c}`;
    const d = await emFetch(`${PUSH2_URL}/stock/fflow/kline/get`, {
      secid, klt: "1", fields1: "f1,f2,f3,f7", fields2: "f51,f52,f53,f54,f55,f56,f57",
    });
    const klines: string[] = d?.data?.klines || [];
    return klines.map((line: string) => {
      const p = line.split(",");
      return { time: p[0] || "", mainNet: +p[1] || 0, smallNet: +p[2] || 0, midNet: +p[3] || 0, largeNet: +p[4] || 0, superNet: +p[5] || 0 };
    });
  });
}

// ---- 3. Dragon-tiger board ----

export async function getDragonTiger(kv: KVNamespace | undefined, code: string, tradeDate?: string): Promise<DragonTigerResult> {
  const c = rawCode(code);
  const today = tradeDate || new Date().toISOString().slice(0, 10);
  return cached(kv, `emlhb:${c}:${today}`, 3600, async () => {
    // Look back 30 days
    const start = new Date(today);
    start.setDate(start.getDate() - 30);
    const startStr = start.toISOString().slice(0, 10);

    // 1. Records
    const records_data = await emDatacenter("RPT_DAILYBILLBOARD_DETAILSNEW",
      `(TRADE_DATE>='${startStr}')(TRADE_DATE<='${today}')(SECURITY_CODE="${c}")`,
      { pageSize: 50, sortColumns: "TRADE_DATE", sortTypes: "-1" });
    const records: DragonTigerRecord[] = records_data.map((row: any) => ({
      date: String(row.TRADE_DATE || "").slice(0, 10),
      reason: row.EXPLANATION || "",
      netBuy: Math.round(((row.BILLBOARD_NET_AMT || 0) / 10000) * 10) / 10,
      turnover: Math.round((parseFloat(row.TURNOVERRATE || 0)) * 100) / 100,
    }));

    // 2. Seats (buy + sell in parallel)
    const seats: { buy: DragonTigerSeat[]; sell: DragonTigerSeat[] } = { buy: [], sell: [] };
    const institution = { buyAmt: 0, sellAmt: 0, netAmt: 0 };

    if (records.length) {
      const latestDate = records[0].date;
      const [buyData, sellData] = await Promise.all([
        emDatacenter("RPT_BILLBOARD_DAILYDETAILSBUY",
          `(TRADE_DATE='${latestDate}')(SECURITY_CODE="${c}")`,
          { pageSize: 10, sortColumns: "BUY", sortTypes: "-1" }),
        emDatacenter("RPT_BILLBOARD_DAILYDETAILSSELL",
          `(TRADE_DATE='${latestDate}')(SECURITY_CODE="${c}")`,
          { pageSize: 10, sortColumns: "SELL", sortTypes: "-1" }),
      ]);

      for (const row of buyData.slice(0, 5)) {
        seats.buy.push({ name: row.OPERATEDEPT_NAME || "", buyAmt: Math.round(((row.BUY || 0) / 10000) * 10) / 10, sellAmt: Math.round(((row.SELL || 0) / 10000) * 10) / 10, net: Math.round(((row.NET || 0) / 10000) * 10) / 10 });
      }
      for (const row of sellData.slice(0, 5)) {
        seats.sell.push({ name: row.OPERATEDEPT_NAME || "", buyAmt: Math.round(((row.BUY || 0) / 10000) * 10) / 10, sellAmt: Math.round(((row.SELL || 0) / 10000) * 10) / 10, net: Math.round(((row.NET || 0) / 10000) * 10) / 10 });
      }

      // Institution (OPERATEDEPT_CODE="0" = institution seat)
      for (const row of buyData) {
        if (String(row.OPERATEDEPT_CODE || "") === "0") institution.buyAmt += (row.BUY || 0);
      }
      for (const row of sellData) {
        if (String(row.OPERATEDEPT_CODE || "") === "0") institution.sellAmt += (row.SELL || 0);
      }
      institution.buyAmt = Math.round((institution.buyAmt / 10000) * 10) / 10;
      institution.sellAmt = Math.round((institution.sellAmt / 10000) * 10) / 10;
      institution.netAmt = Math.round((institution.buyAmt - institution.sellAmt) * 10) / 10;
    }

    return { records, seats, institution };
  });
}

// ---- 4. Lockup expiry ----

export async function getLockupExpiry(kv: KVNamespace | undefined, code: string): Promise<{ history: LockupEntry[]; upcoming: LockupEntry[] }> {
  const c = rawCode(code);
  return cached(kv, `emlock:${c}`, 86400, async () => {
    const today = new Date().toISOString().slice(0, 10);
    const future = new Date(); future.setDate(future.getDate() + 90);
    const endStr = future.toISOString().slice(0, 10);

    const [histData, upData] = await Promise.all([
      emDatacenter("RPT_LIFT_STAGE", `(SECURITY_CODE="${c}")`, { pageSize: 15, sortColumns: "FREE_DATE", sortTypes: "-1" }),
      emDatacenter("RPT_LIFT_STAGE", `(SECURITY_CODE="${c}")(FREE_DATE>='${today}')(FREE_DATE<='${endStr}')`, { pageSize: 20, sortColumns: "FREE_DATE", sortTypes: "1" }),
    ]);

    const toEntry = (row: any): LockupEntry => ({
      date: String(row.FREE_DATE || "").slice(0, 10),
      type: row.LIMITED_STOCK_TYPE || "",
      shares: row.FREE_SHARES_NUM || 0,
      ratio: row.FREE_RATIO || 0,
    });
    return { history: histData.map(toEntry), upcoming: upData.map(toEntry) };
  });
}

// ---- 5. Industry ranking ----

export async function getIndustryRanking(kv: KVNamespace | undefined, top = 20): Promise<{ top: IndustryRow[]; bottom: IndustryRow[]; total: number }> {
  return cached(kv, `emind:${top}`, 300, async () => {
    const d = await emFetch(`${PUSH2_URL}/clist/get`, {
      pn: "1", pz: "100", po: "1", np: "1", fltt: "2", invt: "2",
      fs: "m:90+t:2",
      fields: "f2,f3,f4,f12,f13,f14,f104,f105,f128,f136,f140,f141,f207",
    });
    const items: any[] = d?.data?.diff || [];
    if (!items.length) return { top: [], bottom: [], total: 0 };
    const rows: IndustryRow[] = items.map((it: any, i: number) => ({
      rank: i + 1, name: it.f14 || "", code: it.f12 || "",
      changePct: typeof it.f3 === "number" ? it.f3 : 0,
      upCount: it.f104 || 0, downCount: it.f105 || 0,
      leader: it.f140 || "", leaderChange: typeof it.f136 === "number" ? it.f136 : 0,
    }));
    return { top: rows.slice(0, top), bottom: rows.slice(-top), total: rows.length };
  });
}

// ---- 6. Margin trading ----

export async function getMarginTrading(kv: KVNamespace | undefined, code: string, limit = 30): Promise<MarginRow[]> {
  const c = rawCode(code);
  return cached(kv, `emmargin:${c}:${limit}`, 3600, async () => {
    const data = await emDatacenter("RPTA_WEB_RZRQ_GGMX", `(SCODE="${c}")`,
      { pageSize: limit, sortColumns: "DATE", sortTypes: "-1" });
    return data.map((row: any) => ({
      date: String(row.DATE || "").slice(0, 10),
      rzye: row.RZYE || 0, rzmre: row.RZMRE || 0, rzche: row.RZCHE || 0,
      rqye: row.RQYE || 0, rqmcl: row.RQMCL || 0, rqchl: row.RQCHL || 0,
      rzrqye: row.RZRQYE || 0,
    }));
  });
}

// ---- 7. Stock info ----

export async function getStockInfo(kv: KVNamespace | undefined, code: string): Promise<StockInfo | null> {
  const c = rawCode(code);
  return cached(kv, `eminfo:${c}`, 86400, async () => {
    const secid = c.startsWith("6") ? `1.${c}` : `0.${c}`;
    const d = await emFetch(`${PUSH2_URL}/stock/get`, {
      fltt: "2", invt: "2", fields: "f57,f58,f84,f85,f127,f116,f117,f189,f43", secid,
    });
    const data = d?.data;
    if (!data) return null;
    return {
      code: data.f57 || "", name: data.f58 || "", industry: data.f127 || "",
      totalShares: data.f84 || 0, floatShares: data.f85 || 0,
      mcap: data.f116 || 0, floatMcap: data.f117 || 0,
      listDate: String(data.f189 || ""), price: data.f43 || 0,
    };
  });
}

// ---- 8. Research reports ----

export async function getResearchReports(kv: KVNamespace | undefined, code: string, limit = 20): Promise<ReportRow[]> {
  const c = rawCode(code);
  return cached(kv, `emrpt:${c}:${limit}`, 3600, async () => {
    const params: Record<string, string> = {
      industryCode: "*", pageSize: String(limit), industry: "*", rating: "*", ratingChange: "*",
      beginTime: "2000-01-01", endTime: "2030-01-01", pageNo: "1", fields: "", qType: "0",
      orgCode: "", code: c, rcode: "",
    };
    const d = await emFetch("https://reportapi.eastmoney.com/report/list", params,
      { Referer: "https://data.eastmoney.com/" });
    const rows: any[] = d?.data || [];
    return rows.slice(0, limit).map((r: any) => ({
      title: r.title || "", publishDate: (r.publishDate || "").slice(0, 10),
      orgName: r.orgSName || "", infoCode: r.infoCode || "",
      predictThisYearEps: r.predictThisYearEps || 0, predictNextYearEps: r.predictNextYearEps || 0,
      rating: r.emRatingName || "", industry: r.indvInduName || "",
    }));
  });
}

// ---- 9. A-share valuation & key financials ----

export interface AshareValuation {
  code: string;
  name: string;
  peTTM: number;
  peStatic: number;
  pb: number;
  totalMcap: number;
  floatMcap: number;
  roe: number;
  grossMargin: number;
  netMargin: number;
  revenueYoY: number;
  profitYoY: number;
  epsTTM: number;
  revenue: number;
  netProfit: number;
  prevRevenue: number;
  prevNetProfit: number;
  reportDate: string;
  debtRatio: number;
  bps: number;
}

export async function getAshareValuation(kv: KVNamespace | undefined, code: string): Promise<AshareValuation | null> {
  const c = rawCode(code);
  return cached(kv, `emval:${c}`, 3600, async () => {
    const secid = toSecid(code);
    const d = await emFetch(`${PUSH2_URL}/stock/get`, {
      fltt: "2", invt: "2",
      fields: "f57,f58,f9,f23,f115,f116,f117,f162,f167",
      secid,
    });
    const data = d?.data;
    if (!data) return null;

    const fin = await emDatacenter("RPT_LICO_FN_CPD", `(SECUCODE="${c}.SZ")`, {
      pageSize: 4, sortColumns: "REPORT_DATE", sortTypes: "-1",
    }).catch(() => [] as any[]);
    const sh_fin = fin.length ? fin : await emDatacenter("RPT_LICO_FN_CPD", `(SECUCODE="${c}.SH")`, {
      pageSize: 4, sortColumns: "REPORT_DATE", sortTypes: "-1",
    }).catch(() => [] as any[]);

    const latest = sh_fin[0] || {};
    const prev = sh_fin[1] || {};
    return {
      code: data.f57 || c,
      name: data.f58 || "",
      peTTM: typeof data.f115 === "number" ? data.f115 : (typeof data.f9 === "number" ? data.f9 : 0),
      peStatic: typeof data.f162 === "number" ? data.f162 : 0,
      pb: typeof data.f23 === "number" ? data.f23 : 0,
      totalMcap: data.f116 || 0,
      floatMcap: data.f117 || 0,
      roe: latest.WEIGHTAVG_ROE || 0,
      grossMargin: latest.XSMLL || 0,
      netMargin: latest.XSJLL || 0,
      revenueYoY: latest.YSTZ || 0,
      profitYoY: latest.SJLTZ || 0,
      epsTTM: latest.BASIC_EPS || 0,
      revenue: latest.TOTAL_OPERATE_INCOME || 0,
      netProfit: latest.PARENT_NETPROFIT || 0,
      prevRevenue: prev.TOTAL_OPERATE_INCOME || 0,
      prevNetProfit: prev.PARENT_NETPROFIT || 0,
      reportDate: String(latest.REPORT_DATE || "").slice(0, 10),
      debtRatio: latest.DEBT_ASSET_RATIO || 0,
      bps: latest.BPS || 0,
    };
  });
}

// ---- 10. A-share analyst consensus estimates ----

export interface AshareEstimates {
  thisYearEps: number;
  nextYearEps: number;
  thisYearPe: number;
  nextYearPe: number;
  thisYearNetProfit: number;
  nextYearNetProfit: number;
  analystCount: number;
  buyCount: number;
  avgRating: string;
}

export async function getAshareEstimates(
  kv: KVNamespace | undefined, code: string, price: number, totalShares: number
): Promise<AshareEstimates | null> {
  const c = rawCode(code);
  return cached(kv, `emest:${c}`, 3600, async () => {
    const reports = await getResearchReports(kv, c, 30);
    if (!reports.length || price <= 0) return null;
    const thisYear = reports.filter((r) => r.predictThisYearEps > 0);
    const nextYear = reports.filter((r) => r.predictNextYearEps > 0);
    if (!thisYear.length) return null;
    const avgThisEps = thisYear.reduce((s, r) => s + r.predictThisYearEps, 0) / thisYear.length;
    const avgNextEps = nextYear.length
      ? nextYear.reduce((s, r) => s + r.predictNextYearEps, 0) / nextYear.length : 0;
    const shares = totalShares || 1;
    const thisYearProfit = avgThisEps * shares;
    const nextYearProfit = avgNextEps ? avgNextEps * shares : 0;
    const buyRatings = reports.filter((r) => ["买入", "强烈推荐", "推荐", "buy", "strong_buy"].includes(r.rating.toLowerCase())).length;
    return {
      thisYearEps: Math.round(avgThisEps * 100) / 100,
      nextYearEps: Math.round(avgNextEps * 100) / 100,
      thisYearPe: avgThisEps > 0 ? Math.round(price / avgThisEps * 100) / 100 : 0,
      nextYearPe: avgNextEps > 0 ? Math.round(price / avgNextEps * 100) / 100 : 0,
      thisYearNetProfit: thisYearProfit,
      nextYearNetProfit: nextYearProfit,
      analystCount: reports.length,
      buyCount: buyRatings,
      avgRating: buyRatings > reports.length * 0.6 ? "偏多" : buyRatings > reports.length * 0.3 ? "中性" : "偏空",
    };
  });
}
