import type { Env } from "./env";

export interface EtfHolding {
  rank: number;
  symbol: string;
  name: string;
  weight: number;
}

export interface EtfHoldings {
  symbol: string;
  count: number | null;
  top10Weight: number | null;
  aum: number | null;
  peRatio: number | null;
  asOf: string;
  sourceUrl: string;
  holdings: EtfHolding[];
}

function decodeJsString(value: string): string {
  try {
    return JSON.parse(`"${value.replace(/"/g, '\\"')}"`);
  } catch {
    return value.replace(/\\"/g, '"').replace(/\\u0026/g, "&");
  }
}

export async function getEtfHoldings(env: Env, rawSymbol: string): Promise<EtfHoldings | null> {
  const symbol = String(rawSymbol || "").replace(/^\$/, "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) return null;
  const cacheKey = `etf_holdings:v2:${symbol}`;
  const cached = await env.CACHE.get(cacheKey, "json").catch(() => null) as EtfHoldings | null;
  if (cached?.holdings?.length) return cached;

  const sourceUrl = `https://stockanalysis.com/etf/${symbol.toLowerCase()}/holdings/`;
  const res = await fetch(sourceUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; Robindex/1.0; +https://robindex.ai)",
      Accept: "text/html,application/xhtml+xml",
    },
  }).catch(() => null);
  if (!res?.ok) return null;
  const html = await res.text();
  const block = html.match(/data:\{holdings:\[([\s\S]*?)\],infoBox:/)?.[1] || "";
  if (!block) return null;

  const holdings: EtfHolding[] = [];
  const rowRe = /\{no:(\d+),n:"((?:\\.|[^"])*)"(?:,s:"\$?((?:\\.|[^"])*)")?,as:"([0-9.]+)%"/g;
  for (const match of block.matchAll(rowRe)) {
    holdings.push({
      rank: Number(match[1]),
      name: decodeJsString(match[2]),
      symbol: decodeJsString(match[3] || "").replace(/^!.*\//, ""),
      weight: Number(match[4]),
    });
    if (holdings.length >= 25) break;
  }
  if (!holdings.length) return null;

  const meta = html.match(/infoTable:\{count:(\d+),top10:([0-9.]+),assetClass:"[^"]*",category:[^,]+,categoryLabel:"[^"]*",aum:([0-9.]+),peRatio:([0-9.]+)/);
  const asOf = html.match(/As of ([A-Z][a-z]{2} \d{1,2}, \d{4})/)?.[1] || "";
  const result: EtfHoldings = {
    symbol,
    count: meta ? Number(meta[1]) : null,
    top10Weight: meta ? Number(meta[2]) : null,
    aum: meta ? Number(meta[3]) : null,
    peRatio: meta ? Number(meta[4]) : null,
    asOf,
    sourceUrl,
    holdings,
  };
  await env.CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 6 * 60 * 60 }).catch(() => {});
  return result;
}

export function formatEtfHoldings(data: EtfHoldings): string {
  const lines = [
    `ETF HOLDINGS (${data.symbol}${data.asOf ? `, as of ${data.asOf}` : ""}; source: ${data.sourceUrl}):`,
    `${data.count || data.holdings.length} holdings${data.top10Weight != null ? ` | top-10 weight ${data.top10Weight.toFixed(2)}%` : ""}${data.aum ? ` | AUM $${(data.aum / 1e6).toFixed(1)}M` : ""}`,
    ...data.holdings.slice(0, 15).map((h) => `${h.rank}. ${h.symbol || "N/A"} ${h.name}: ${h.weight.toFixed(2)}%`),
  ];
  if (data.peRatio != null) {
    lines.push(`Fund-level weighted PE (provider): ${data.peRatio.toFixed(2)}; this is not a company PE.`);
  }
  return lines.join("\n");
}
