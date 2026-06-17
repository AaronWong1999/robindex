// Tool definitions + dispatcher for the hybrid chat path. The model may call these to fetch data the
// pre-fetch didn't already inject (e.g. a symbol not already quoted, intraday K-line, fresh news,
// fundamentals). Kept deliberately lean (9 tools) — flash-tier function-calling degrades when the
// menu is long, and the query planner already pre-detects + validates instruments before this phase.
import type { Env } from "./env";
import { resolveSymbolCached, getKlineCached, searchSymbolHits, getQuotesCached, type Quote } from "./finance";
import { getStockNews, getMarketNews } from "./marketdata";
import { getSectorBlocks, getFundFlowMinute, getDragonTiger } from "./eastmoney-astock";
import {
  getFinancialStatements, getKeyIndicators, getAnalystData,
  getMarketRanking, getSecFilings,
} from "./eastmoney-global";

export const TOOLS = [
  // ---- Core: quotes / candles / news (cover the common case) ----
  {
    type: "function",
    function: {
      name: "get_quote",
      description:
        "Live quote(s) for one or more stocks/ETFs/indices/crypto by ticker or name (English, $TICKER, " +
        "or Chinese name). Also use this to RESOLVE a name you're unsure about — it validates against the " +
        "live feed and reports anything it couldn't resolve. Quotes for instruments already shown in " +
        "LIVE MARKET DATA do not need re-fetching.",
      parameters: {
        type: "object",
        properties: {
          symbols: {
            type: "array",
            items: { type: "string" },
            description: "One or more instruments, e.g. [\"AAPL\"], [\"SOXL\",\"英伟达\",\"00700.HK\",\"BTC\"].",
          },
        },
        required: ["symbols"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_kline",
      description:
        "Historical or intraday candles. period: m1/m5/m15/m30/m60 for minute bars, or day/week/month. Use minute periods for intraday/1-minute questions.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string" },
          period: { type: "string", enum: ["m1", "m5", "m15", "m30", "m60", "day", "week", "month"] },
          limit: { type: "number" },
        },
        required: ["symbol"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_news",
      description:
        "Recent news. Pass a symbol for stock-specific news (US); omit the symbol for market/macro 7x24 " +
        "fast-news (policy, rates, economic events).",
      parameters: { type: "object", properties: { symbol: { type: "string" } } },
    },
  },
  // ---- US / HK fundamentals ----
  {
    type: "function",
    function: {
      name: "get_financials",
      description: "Financial statements (balance sheet / income / cash flow) for US and HK stocks. Returns line-item data with Chinese field names and YoY ratios.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string" },
          statement: { type: "string", enum: ["balance", "income", "cashflow"] },
          periods: { type: "number", description: "Number of recent periods, default 4" },
        },
        required: ["symbol", "statement"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_key_indicators",
      description: "Key financial indicators: ROE, ROA, EPS, margins, debt ratio, revenue/profit growth for US and HK stocks.",
      parameters: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_analyst_data",
      description: "Analyst estimates, ratings, target price, upgrade/downgrade history, and institutional holders (US and HK stocks).",
      parameters: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_sec_filings",
      description: "SEC EDGAR filings for US stocks: 10-K, 10-Q, 8-K. Returns filing list with document URLs.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "US stock ticker, e.g. AAPL" },
          form_type: { type: "string", enum: ["10-K", "10-Q", "8-K"], description: "Filter by form type" },
        },
        required: ["symbol"],
      },
    },
  },
  // ---- Market-wide ----
  {
    type: "function",
    function: {
      name: "get_market_ranking",
      description: "Full market stock ranking by change%, volume, or amount. Covers US (NASDAQ/NYSE), HK, and CN industry boards. Returns top gainers/losers.",
      parameters: {
        type: "object",
        properties: {
          market: { type: "string", enum: ["us_nasdaq", "us_nyse", "hk", "cn_industry"] },
          sort: { type: "string", enum: ["change_pct", "volume", "amount"], default: "change_pct" },
          limit: { type: "number", default: 20 },
        },
        required: ["market"],
      },
    },
  },
  // ---- A-share-only deep microstructure (one grouped tool) ----
  {
    type: "function",
    function: {
      name: "get_ashare_detail",
      description:
        "A-share-only deep data. kind='sectors': all sector/concept/industry boards a stock belongs to + " +
        "leaders. kind='fund_flow': intraday main/large/mid/small order net inflow (institutional vs retail). " +
        "kind='dragon_tiger': 龙虎榜 brokerage seat activity + institutional participation. Code like sh600519 or 600519.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string" },
          kind: { type: "string", enum: ["sectors", "fund_flow", "dragon_tiger"] },
          date: { type: "string", description: "dragon_tiger only: trade date YYYY-MM-DD, defaults to today" },
        },
        required: ["symbol", "kind"],
      },
    },
  },
];

function fmtQuote(q: Quote): string {
  const s = q.change >= 0 ? "+" : "";
  return `${q.name} (${q.symbol}/${q.market.toUpperCase()}): ${q.price} ${q.currency} ${s}${q.change.toFixed(2)} (${s}${q.changePct.toFixed(2)}%) | O ${q.open} H ${q.high} L ${q.low} prevC ${q.prevClose} | vol ${q.volume} @ ${q.time}`;
}

function fmtNews(items: { time: string; title: string; digest?: string; source: string }[]): string {
  return items.map((n) => `- (${n.time}) ${n.title}${n.digest ? ` — ${n.digest}` : ""} [${n.source}]`).join("\n");
}

// Resolve one free-text symbol/name to a validated quote (direct resolve, then fuzzy search fallback).
async function resolveQuote(env: Env, raw: string, seen: Set<string>): Promise<Quote | null> {
  const sym = String(raw).trim();
  if (!sym) return null;
  const q = await resolveSymbolCached(env.CACHE, sym);
  if (q && q.price > 0 && !seen.has(q.code)) return q;
  const hits = await searchSymbolHits(sym, 3);
  if (hits.length) {
    const qs = await getQuotesCached(env.CACHE, [hits[0].code]);
    if (qs[0] && qs[0].price > 0 && !seen.has(qs[0].code)) return qs[0];
  }
  return null;
}

export async function executeTool(env: Env, name: string, args: any): Promise<string> {
  try {
    if (name === "get_quote") {
      // Accept the new array form, plus the legacy single `symbol` for resilience.
      const list: string[] = Array.isArray(args.symbols)
        ? args.symbols
        : args.symbol
          ? [args.symbol]
          : [];
      if (!list.length) return "No symbols provided.";
      const resolved: Quote[] = [];
      const unresolved: string[] = [];
      const seen = new Set<string>();
      for (const raw of list.slice(0, 10)) {
        const q = await resolveQuote(env, raw, seen);
        if (q) {
          seen.add(q.code);
          resolved.push(q);
        } else if (String(raw).trim()) {
          unresolved.push(String(raw).trim());
        }
      }
      let out = resolved.length ? resolved.map(fmtQuote).join("\n") : "";
      if (unresolved.length) out += (out ? "\n" : "") + `Could not resolve: ${unresolved.join(", ")}`;
      return out || "No instruments identified.";
    }
    if (name === "get_kline") {
      const q = await resolveSymbolCached(env.CACHE, String(args.symbol || ""));
      if (!q) return `Unknown symbol "${args.symbol}".`;
      const period = String(args.period || "day");
      const limit = Math.min(Number(args.limit) || 30, 60);
      const k = await getKlineCached(env.CACHE, q.code, period, limit);
      const rows = k.candles.slice(-limit);
      if (!rows.length) return `No ${period} candles for ${q.symbol}.`;
      return `${q.symbol} ${period} (last ${rows.length}):\n` +
        rows.map((c) => `${c.date} O:${c.open} H:${c.high} L:${c.low} C:${c.close} V:${c.volume}`).join("\n");
    }
    if (name === "get_news") {
      if (args.symbol) {
        const q = await resolveSymbolCached(env.CACHE, String(args.symbol));
        if (q) {
          const n = await getStockNews(env, q, 5);
          if (n.length) return `News for ${q.symbol}:\n` + fmtNews(n);
        }
      }
      return `Market / macro news:\n` + fmtNews(await getMarketNews(env, 8));
    }
    if (name === "get_financials") {
      const stmt = String(args.statement || "income") as "balance" | "income" | "cashflow";
      const periods = Math.min(Number(args.periods) || 4, 12);
      const rows = await getFinancialStatements(env.CACHE, String(args.symbol || ""), stmt, periods);
      if (!rows.length) return `No ${stmt} data for "${args.symbol}".`;
      const byDate = new Map<string, typeof rows>();
      for (const r of rows) {
        const list = byDate.get(r.reportDate) || [];
        list.push(r);
        byDate.set(r.reportDate, list);
      }
      let out = `Financials (${stmt}) for ${args.symbol}:\n`;
      for (const [date, items] of byDate) {
        out += `\n${date} (${items[0].report}):\n` + items.slice(0, 15).map((it) => `  ${it.itemName}: ${it.amount}${it.yoyRatio ? ` (YoY:${it.yoyRatio}%)` : ""}`).join("\n");
      }
      return out;
    }
    if (name === "get_key_indicators") {
      const rows = await getKeyIndicators(env.CACHE, String(args.symbol || ""));
      if (!rows.length) return `No key indicators for "${args.symbol}".`;
      return `Key indicators for ${args.symbol}:\n` + rows.map((r) =>
        `${r.reportDate}: EPS=${r.basicEps} ROE=${r.roe}% ROA=${r.roa}% grossMargin=${r.grossProfitRatio}% netMargin=${r.netProfitRatio}% debtRatio=${r.debtAssetRatio}% revYoY=${r.incomeYoy}% epsYoY=${r.epsYoy}%`
      ).join("\n");
    }
    if (name === "get_analyst_data") {
      const d = await getAnalystData(env.CACHE, String(args.symbol || ""));
      if (!d) return `No analyst data for "${args.symbol}".`;
      let out = `Analyst data for ${args.symbol}:\n`;
      out += `Recommendation: ${d.recommendation} | Target: ${d.targetLow}-${d.targetHigh} (mean ${d.targetMean})\n`;
      out += `PE: trailing=${d.trailingPe} forward=${d.forwardPe} | PEG=${d.pegRatio} | PB=${d.priceToBook}\n`;
      out += `Margin=${d.profitMargin} ROE=${d.returnOnEquity} Beta=${d.beta}\n`;
      if (d.epsTrend.length) {
        out += `EPS trend:\n` + d.epsTrend.map((t: any) => `  ${t.period} ${t.endDate}: est=${t.epsEstimate} analysts=${t.numAnalysts} rev=${t.revenueEstimate}`).join("\n") + "\n";
      }
      if (d.ratingTrend.length) {
        out += `Rating trend:\n` + d.ratingTrend.map((r: any) => `  ${r.period}: SB=${r.strongBuy} B=${r.buy} H=${r.hold} S=${r.sell} SS=${r.strongSell}`).join("\n") + "\n";
      }
      if (d.topHolders.length) {
        out += `Top holders:\n` + d.topHolders.map((h: any) => `  ${h.name}: ${h.shares} shares (${h.pctHeld}%)`).join("\n");
      }
      return out;
    }
    if (name === "get_sec_filings") {
      const r = await getSecFilings(env.CACHE, String(args.symbol || ""), args.form_type || undefined);
      if (!r.filings.length) return `No SEC filings for "${args.symbol}".`;
      return `SEC filings for ${r.companyName} (CIK:${r.cik}):\n` +
        r.filings.slice(0, 20).map((f) => `  ${f.date} ${f.form}: ${f.description} ${f.url}`).join("\n");
    }
    if (name === "get_market_ranking") {
      const sortMap: Record<string, string> = { change_pct: "f3", volume: "f5", amount: "f6" };
      const sortField = sortMap[String(args.sort || "change_pct")] || "f3";
      const limit = Math.min(Number(args.limit) || 20, 50);
      const r = await getMarketRanking(env.CACHE, String(args.market || "us_nasdaq"), sortField, limit);
      if (!r.stocks.length) return `No ranking data for "${args.market}".`;
      return `Market ranking (${args.market}, ${r.total} total, showing top ${r.stocks.length}):\n` +
        r.stocks.map((s, i) => `${i + 1}. ${s.name}(${s.code}): ${s.changePct}% vol=${s.volume} amt=${s.amount}`).join("\n");
    }
    if (name === "get_ashare_detail") {
      const code = String(args.symbol || "");
      const kind = String(args.kind || "");
      if (kind === "sectors") {
        const r = await getSectorBlocks(env.CACHE, code);
        if (!r.total) return `No sector/concept blocks found for "${code}".`;
        return `Blocks for ${code} (${r.total}):\n` + r.boards.map((b) => `- ${b.name} (${b.code}) ${b.changePct}% leader:${b.leader}`).join("\n");
      }
      if (kind === "fund_flow") {
        const rows = await getFundFlowMinute(env.CACHE, code);
        if (!rows.length) return `No fund flow data for "${code}".`;
        const last = rows[rows.length - 1];
        const total = rows.reduce((s, r) => s + r.mainNet, 0);
        return `Fund flow for ${code} (${rows.length} min bars, latest: ${last.time}):\nmain:${last.mainNet} large:${last.largeNet} mid:${last.midNet} small:${last.smallNet} super:${last.superNet}\nTotal main net (day): ${total}`;
      }
      if (kind === "dragon_tiger") {
        const r = await getDragonTiger(env.CACHE, code, args.date || undefined);
        if (!r.records.length) return `No dragon-tiger records for "${code}".`;
        let out = `Dragon-tiger for ${code} (${r.records.length} records):\n`;
        out += r.records.map((rc) => `  ${rc.date}: ${rc.reason} net=${rc.netBuy}万 turnover=${rc.turnover}%`).join("\n");
        if (r.seats.buy.length) out += `\nBuy seats:\n` + r.seats.buy.map((s) => `  ${s.name}: buy=${s.buyAmt}万 sell=${s.sellAmt}万 net=${s.net}万`).join("\n");
        if (r.seats.sell.length) out += `\nSell seats:\n` + r.seats.sell.map((s) => `  ${s.name}: buy=${s.buyAmt}万 sell=${s.sellAmt}万 net=${s.net}万`).join("\n");
        out += `\nInstitution: buy=${r.institution.buyAmt}万 sell=${r.institution.sellAmt}万 net=${r.institution.netAmt}万`;
        return out;
      }
      return `Unknown get_ashare_detail kind "${kind}".`;
    }
    return `Unknown tool ${name}.`;
  } catch (e) {
    return `Tool ${name} error: ${e}`;
  }
}
