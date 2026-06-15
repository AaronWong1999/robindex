// News & macro/market fast-news, ported from the data skills' underlying free endpoints so the Worker
// can serve them directly. US per-stock news via Yahoo Finance search; market/macro 7x24 fast-news via
// Eastmoney 快讯 (Chinese, covers policy/macro/global events for everyone).
import type { Env } from "./env";
import type { Quote } from "./finance";

export interface NewsItem {
  title: string;
  digest?: string;
  source: string;
  time: string; // ISO or "YYYY-MM-DD HH:mm:ss"
  url: string;
}

async function cached<T>(
  kv: KVNamespace | undefined,
  key: string,
  ttl: number,
  miss: () => Promise<T>
): Promise<T> {
  if (!kv) return miss();
  const hit = await kv.get(key, "json");
  if (hit) return hit as T;
  const val = await miss();
  try {
    await kv.put(key, JSON.stringify(val), { expirationTtl: ttl });
  } catch {}
  return val;
}

// US-stock news via Yahoo Finance search (title/publisher/time/link). Non-US returns [] (use market news).
export async function getStockNews(env: Env, quote: Quote, n = 5): Promise<NewsItem[]> {
  if (quote.market !== "us") return [];
  return cached(env.CACHE, `news:${quote.code}:${n}`, 300, async () => {
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(
      quote.symbol
    )}&newsCount=${n}&quotesCount=0`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const json: any = await res.json().catch(() => null);
    const news: any[] = json?.news || [];
    return news.slice(0, n).map((it) => ({
      title: it.title || "",
      source: it.publisher || "",
      time: it.providerPublishTime ? new Date(it.providerPublishTime * 1000).toISOString() : "",
      url: it.link || "",
    }));
  });
}

// Market / macro 7x24 fast-news via Eastmoney 快讯. Response is `var ajaxResult={...,"LivesList":[...]}`.
export async function getMarketNews(env: Env, n = 10): Promise<NewsItem[]> {
  return cached(env.CACHE, `marketnews:${n}`, 300, async () => {
    const url = `https://newsapi.eastmoney.com/kuaixun/v1/getlist_102_ajaxResult_50_1_.html`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", Referer: "https://kuaixun.eastmoney.com/" },
    });
    const text = await res.text();
    const jsonText = text.replace(/^[^{]*?(\{)/, "$1"); // strip `var ajaxResult=`
    let json: any = null;
    try {
      json = JSON.parse(jsonText);
    } catch {
      return [];
    }
    const list: any[] = json?.LivesList || [];
    return list.slice(0, n).map((it) => ({
      title: it.title || "",
      digest: it.digest || "",
      source: "东方财富",
      time: it.showtime || "",
      url: it.url_w || it.url_m || "",
    }));
  });
}
