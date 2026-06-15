// Scrape recent tweets for a user via ScrapeBadger, write to JSON in our schema.
// Usage: SB_KEY=xxx USERNAME=qinbafrank MAX_PAGES=40 OUT=/tmp/qf_tweets.json node scrape_qinbafrank.mjs
const KEY = process.env.SB_KEY;
const USERNAME = process.env.USERNAME || "qinbafrank";
const MAX_PAGES = parseInt(process.env.MAX_PAGES || "40", 10);
const OUT = process.env.OUT || "/tmp/qf_tweets.json";
import fs from "node:fs";
if (!KEY) throw new Error("SB_KEY required");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function page(cursor) {
  const url = new URL(`https://scrapebadger.com/v1/twitter/users/${USERNAME}/latest_tweets`);
  if (cursor) url.searchParams.set("cursor", cursor);
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url, { headers: { "x-api-key": KEY } });
    if (res.status === 429) {
      const reset = parseInt(res.headers.get("x-ratelimit-reset") || "0", 10);
      const waitMs = reset ? Math.max(1000, reset * 1000 - Date.now() + 500) : 15000;
      console.log(`  429, waiting ${Math.round(waitMs / 1000)}s`);
      await sleep(Math.min(waitMs, 70000));
      continue;
    }
    if (res.status === 402) throw new Error("402 out of credits");
    if (!res.ok) { console.log("  http", res.status, (await res.text()).slice(0, 120)); await sleep(3000); continue; }
    return await res.json();
  }
  throw new Error("too many retries");
}

const mapTweet = (t) => ({
  id: String(t.id),
  text: t.full_text || t.text || "",
  created_at_iso: t.created_at ? new Date(t.created_at).toISOString() : "",
  created_at_ts: t.created_at ? Math.floor(new Date(t.created_at).getTime() / 1000) : 0,
  is_retweet: t.is_retweet ? 1 : 0,
  lang: t.lang || "",
  likes: t.favorite_count || 0,
  retweets: t.retweet_count || 0,
  replies: t.reply_count || 0,
  quotes: t.quote_count || 0,
  views: t.view_count || 0,
  urls: (t.urls || []).map((u) => (typeof u === "string" ? u : u.expanded_url || u.url)).filter(Boolean),
  media: t.media || [],
});

const out = [];
const seen = new Set();
let cursor = null;
for (let p = 0; p < MAX_PAGES; p++) {
  const j = await page(cursor);
  const tw = j.data || j.tweets || [];
  let added = 0;
  for (const t of tw) {
    const id = String(t.id);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(mapTweet(t));
    added++;
  }
  cursor = j.next_cursor;
  console.log(`page ${p + 1}/${MAX_PAGES}: +${added} (total ${out.length})`);
  if (!cursor || !tw.length) { console.log("no more pages"); break; }
  await sleep(1500); // gentle pacing under the 5/window limit
}
fs.writeFileSync(OUT, JSON.stringify(out));
const nonRT = out.filter((t) => !t.is_retweet).length;
console.log(`DONE: ${out.length} tweets (${nonRT} non-retweet) -> ${OUT}`);
console.log("date range:", out[out.length - 1]?.created_at_iso, "..", out[0]?.created_at_iso);
