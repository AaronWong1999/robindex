// Tool definitions + dispatcher for the hybrid chat path. The model may call these to fetch data the
// pre-fetch didn't already inject (e.g. 1-minute K-line, fresh news, a symbol it couldn't resolve).
import type { Env } from "./env";
import { resolveSymbolCached, getKlineCached, searchSymbolHits, getQuotesCached, type Quote } from "./finance";
import { getStockNews, getMarketNews } from "./marketdata";
import {
  getSectorBlocks, getFundFlowMinute, getDragonTiger, getIndustryRanking,
  getMarginTrading, getStockInfo, getResearchReports, getLockupExpiry,
} from "./eastmoney-astock";
import {
  getFinancialStatements, getKeyIndicators, getAnalystData,
  getMarketRanking, getSecFilings, getSinaKline,
} from "./eastmoney-global";

export const TOOLS = [
  // ---- Round 1: Entity extraction + quotes ----
  {
    type: "function",
    function: {
      name: "extract_financial_entities",
      description:
        "Identify ALL tradeable financial instruments (stocks, ETFs, crypto) mentioned in the user message. " +
        "Returns validated quotes with live prices. Always call this FIRST when the user mentions any company name, " +
        "stock ticker, Chinese name, or alias. Outputs standardized symbols like AAPL, 00700.HK, 600519.SH.",
      parameters: {
        type: "object",
        properties: {
          symbols: {
            type: "array",
            items: { type: "string" },
            description: "All recognized financial instrument symbols from the user message. Use standard tickers: AAPL, TSLA, 00700.HK, 600519.SH, BTC, etc.",
          },
        },
        required: ["symbols"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_quote",
      description: "Live quote for a stock/ETF/index by ticker or name (English, $TICKER, or Chinese name).",
      parameters: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
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
      description: "Recent news. Pass a symbol for stock-specific news (US), or omit for market/macro fast-news.",
      parameters: { type: "object", properties: { symbol: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "get_macro",
      description: "Latest macro / market 7x24 fast-news (policy, rates, economic events).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "search_symbol",
      description: "Resolve a free-text name/ticker to candidate instrument codes when unsure.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
  },
  // ---- New tools from a-stock-data / global-stock-data ----
  {
    type: "function",
    function: {
      name: "get_sector_blocks",
      description: "Get all sector/concept/industry boards a stock belongs to (A-share only, code like sh600519 or 600519). Returns board names, codes, daily change%, and leader stocks.",
      parameters: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_fund_flow",
      description: "Intraday minute-level fund flow: main/large/mid/small order net inflow (A-share only). Use to analyze institutional vs retail money direction during trading hours.",
      parameters: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_dragon_tiger",
      description: "Dragon-tiger board (龙虎榜): brokerage seat activity, top 5 buy/sell seats, institutional participation (A-share only). Shows which brokerages are actively trading a stock.",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string" },
          date: { type: "string", description: "Trade date YYYY-MM-DD, defaults to today" },
        },
        required: ["symbol"],
      },
    },
  },
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
      description: "Key financial indicators: ROE, ROA, EPS, margins, debt ratio, revenue/profit growth for US and HK stocks. Chinese field names from Eastmoney GMAININDICATOR.",
      parameters: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_analyst_data",
      description: "Analyst estimates, ratings, target price, upgrade/downgrade history, and institutional holders via Yahoo Finance. Works for US and HK stocks.",
      parameters: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
    },
  },
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
  {
    type: "function",
    function: {
      name: "get_sec_filings",
      description: "SEC EDGAR filings for US stocks: 10-K, 10-Q, 8-K annual/quarterly reports. Returns filing list with document URLs.",
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
];

function fmtQuote(q: Quote): string {
  const s = q.change >= 0 ? "+" : "";
  return `${q.name} (${q.symbol}/${q.market.toUpperCase()}): ${q.price} ${q.currency} ${s}${q.change.toFixed(2)} (${s}${q.changePct.toFixed(2)}%) | O ${q.open} H ${q.high} L ${q.low} prevC ${q.prevClose} | vol ${q.volume} @ ${q.time}`;
}

function fmtNews(items: { time: string; title: string; digest?: string; source: string }[]): string {
  return items.map((n) => `- (${n.time}) ${n.title}${n.digest ? ` — ${n.digest}` : ""} [${n.source}]`).join("\n");
}

export async function executeTool(env: Env, name: string, args: any): Promise<string> {
  try {
    if (name === "get_quote") {
      const q = await resolveSymbolCached(env.CACHE, String(args.symbol || ""));
      return q ? fmtQuote(q) : `No quote found for "${args.symbol}".`;
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
      return `Market news:\n` + fmtNews(await getMarketNews(env, 8));
    }
    if (name === "get_macro") {
      return `Macro / market fast-news:\n` + fmtNews(await getMarketNews(env, 10));
    }
    if (name === "search_symbol") {
      const hits = await searchSymbolHits(String(args.query || ""), 5);
      return hits.length ? hits.map((h) => `${h.code} — ${h.name}${h.nameEn ? ` / ${h.nameEn}` : ""}`).join("\n") : "No match.";
    }
    if (name === "extract_financial_entities") {
      const rawSymbols: string[] = Array.isArray(args.symbols) ? args.symbols : [];
      if (!rawSymbols.length) return "No symbols provided.";
      const resolved: Quote[] = [];
      const unresolved: string[] = [];
      const seen = new Set<string>();
      for (const raw of rawSymbols.slice(0, 10)) {
        const sym = String(raw).trim();
        if (!sym) continue;
        try {
          const q = await resolveSymbolCached(env.CACHE, sym);
          if (q && q.price > 0 && !seen.has(q.code)) {
            seen.add(q.code);
            resolved.push(q);
          } else {
            // Try search API as fuzzy fallback
            const hits = await searchSymbolHits(sym, 3);
            if (hits.length) {
              const qs = await getQuotesCached(env.CACHE, [hits[0].code]);
              if (qs[0] && qs[0].price > 0 && !seen.has(qs[0].code)) {
                seen.add(qs[0].code);
                resolved.push(qs[0]);
                continue;
              }
            }
            unresolved.push(sym);
          }
        } catch {
          unresolved.push(sym);
        }
      }
      let out = "";
      if (resolved.length) {
        out += `Identified ${resolved.length} instrument(s):\n` + resolved.map(fmtQuote).join("\n");
      }
      if (unresolved.length) {
        out += (out ? "\n" : "") + `Could not resolve: ${unresolved.join(", ")}`;
      }
      return out || "No instruments identified.";
    }
    // ---- New tools ----
    if (name === "get_sector_blocks") {
      const code = String(args.symbol || "");
      const r = await getSectorBlocks(env.CACHE, code);
      if (!r.total) return `No sector/concept blocks found for "${code}".`;
      return `Blocks for ${code} (${r.total}):\n` + r.boards.map((b) => `- ${b.name} (${b.code}) ${b.changePct}% leader:${b.leader}`).join("\n");
    }
    if (name === "get_fund_flow") {
      const code = String(args.symbol || "");
      const rows = await getFundFlowMinute(env.CACHE, code);
      if (!rows.length) return `No fund flow data for "${code}".`;
      const last = rows[rows.length - 1];
      const total = rows.reduce((s, r) => s + r.mainNet, 0);
      return `Fund flow for ${code} (${rows.length} min bars, latest: ${last.time}):\nmain:${last.mainNet} large:${last.largeNet} mid:${last.midNet} small:${last.smallNet} super:${last.superNet}\nTotal main net (day): ${total}`;
    }
    if (name === "get_dragon_tiger") {
      const r = await getDragonTiger(env.CACHE, String(args.symbol || ""), args.date || undefined);
      if (!r.records.length) return `No dragon-tiger records for "${args.symbol}".`;
      let out = `Dragon-tiger for ${args.symbol} (${r.records.length} records):\n`;
      out += r.records.map((rc) => `  ${rc.date}: ${rc.reason} net=${rc.netBuy}万 turnover=${rc.turnover}%`).join("\n");
      if (r.seats.buy.length) {
        out += `\nBuy seats:\n` + r.seats.buy.map((s) => `  ${s.name}: buy=${s.buyAmt}万 sell=${s.sellAmt}万 net=${s.net}万`).join("\n");
      }
      if (r.seats.sell.length) {
        out += `\nSell seats:\n` + r.seats.sell.map((s) => `  ${s.name}: buy=${s.buyAmt}万 sell=${s.sellAmt}万 net=${s.net}万`).join("\n");
      }
      out += `\nInstitution: buy=${r.institution.buyAmt}万 sell=${r.institution.sellAmt}万 net=${r.institution.netAmt}万`;
      return out;
    }
    if (name === "get_financials") {
      const stmt = String(args.statement || "income") as "balance" | "income" | "cashflow";
      const periods = Math.min(Number(args.periods) || 4, 12);
      const rows = await getFinancialStatements(env.CACHE, String(args.symbol || ""), stmt, periods);
      if (!rows.length) return `No ${stmt} data for "${args.symbol}".`;
      // Group by report date
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
    if (name === "get_market_ranking") {
      const sortMap: Record<string, string> = { change_pct: "f3", volume: "f5", amount: "f6" };
      const sortField = sortMap[String(args.sort || "change_pct")] || "f3";
      const limit = Math.min(Number(args.limit) || 20, 50);
      const r = await getMarketRanking(env.CACHE, String(args.market || "us_nasdaq"), sortField, limit);
      if (!r.stocks.length) return `No ranking data for "${args.market}".`;
      return `Market ranking (${args.market}, ${r.total} total, showing top ${r.stocks.length}):\n` +
        r.stocks.map((s, i) => `${i + 1}. ${s.name}(${s.code}): ${s.changePct}% vol=${s.volume} amt=${s.amount}`).join("\n");
    }
    if (name === "get_sec_filings") {
      const r = await getSecFilings(env.CACHE, String(args.symbol || ""), args.form_type || undefined);
      if (!r.filings.length) return `No SEC filings for "${args.symbol}".`;
      return `SEC filings for ${r.companyName} (CIK:${r.cik}):\n` +
        r.filings.slice(0, 20).map((f) => `  ${f.date} ${f.form}: ${f.description} ${f.url}`).join("\n");
    }
    return `Unknown tool ${name}.`;
  } catch (e) {
    return `Tool ${name} error: ${e}`;
  }
}
