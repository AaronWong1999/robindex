// Tool definitions + dispatcher for the hybrid chat path. The model may call these to fetch data the
// pre-fetch didn't already inject (e.g. 1-minute K-line, fresh news, a symbol it couldn't resolve).
import type { Env } from "./env";
import { resolveSymbolCached, getKlineCached, searchSymbolHits, type Quote } from "./finance";
import { getStockNews, getMarketNews } from "./marketdata";

export const TOOLS = [
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
    return `Unknown tool ${name}.`;
  } catch (e) {
    return `Tool ${name} error: ${e}`;
  }
}
