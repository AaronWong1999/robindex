import type { Env } from "./env";
import { embed, indexVectors } from "./rag";
import { completeChat } from "./chat";

const APIFY_ACTOR = "apidojo~tweet-scraper";
const GETXAPI_BASE = "https://api.getxapi.com/twitter/user/tweets";

type TweetRow = ReturnType<typeof mapApifyTweet>;

function tweetIdGt(a: string, b: string): boolean {
  try {
    return BigInt(a) > BigInt(b);
  } catch {
    return a > b;
  }
}

// Map an Apify apidojo/tweet-scraper item into our tweet row shape (defensive about field names).
function mapApifyTweet(it: any, kolId: string) {
  const id = String(it.id || it.id_str || it.tweetId || "");
  const text = it.text || it.full_text || it.fullText || "";
  const created = it.createdAt || it.created_at || it.date || "";
  const ts = created ? Math.floor(new Date(created).getTime() / 1000) : 0;
  const m = it.metrics || {};
  return {
    id,
    kol_id: kolId,
    text,
    created_at_iso: created ? new Date(created).toISOString() : "",
    created_at_ts: ts,
    is_retweet: it.isRetweet ? 1 : 0,
    lang: it.lang || "",
    likes: it.likeCount ?? m.likes ?? 0,
    retweets: it.retweetCount ?? m.retweets ?? 0,
    replies: it.replyCount ?? m.replies ?? 0,
    quotes: it.quoteCount ?? m.quotes ?? 0,
    views: it.viewCount ?? m.views ?? 0,
    urls: JSON.stringify(it.urls || it.entities?.urls || []),
    media: JSON.stringify(it.media || []),
  };
}

function mapGetxTweet(it: any, kolId: string) {
  const id = String(it.id || "");
  const created = it.createdAt || it.created_at || "";
  const ts = created ? Math.floor(new Date(created).getTime() / 1000) : 0;
  const urls: string[] = [];
  const ent = it.entities || {};
  for (const u of ent.urls || []) {
    const expanded = u.expanded_url || u.url;
    if (expanded) urls.push(expanded);
  }
  return {
    id,
    kol_id: kolId,
    text: it.text || it.full_text || "",
    created_at_iso: created ? new Date(created).toISOString() : "",
    created_at_ts: ts,
    is_retweet: it.retweeted_tweet ? 1 : 0,
    lang: it.lang || "",
    likes: it.likeCount || 0,
    retweets: it.retweetCount || 0,
    replies: it.replyCount || 0,
    quotes: it.quoteCount || 0,
    views: it.viewCount || 0,
    urls: JSON.stringify(urls),
    media: JSON.stringify(it.media || []),
  };
}

async function apifyFetch(env: Env, handle: string, sinceId: string | null): Promise<any[]> {
  const url = `https://api.apify.com/v2/acts/${APIFY_ACTOR}/run-sync-get-dataset-items?token=${env.APIFY_TOKEN}`;
  const input: any = {
    twitterHandles: [handle],
    maxItems: 60,
    sort: "Latest",
    includeSearchTerms: false,
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) return [];
  const items = (await res.json()) as any[];
  if (!sinceId) return items;
  return items.filter((it) => String(it.id || it.id_str || "") > sinceId);
}

async function getxFetch(
  env: Env,
  kolId: string,
  handle: string,
  twitterUid: string,
  sinceId: string | null
): Promise<TweetRow[]> {
  const rows: TweetRow[] = [];
  let cursor = "";

  // Daily cron should be cheap and incremental. Four pages is normally enough for a day,
  // while still covering bursty posting days without burning API balance.
  for (let page = 0; page < 4; page++) {
    const url = new URL(GETXAPI_BASE);
    url.searchParams.set("userId", twitterUid);
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${env.GETXAPI_KEY}` } });
    if (!res.ok) break;
    const json: any = await res.json();
    const tweets = json.tweets || [];
    let reachedKnownTweet = false;
    for (const tweet of tweets) {
      const author = String(tweet.author?.userName || "").toLowerCase();
      if (author !== handle.toLowerCase()) continue;
      const id = String(tweet.id || "");
      if (!id) continue;
      if (sinceId && !tweetIdGt(id, sinceId)) {
        reachedKnownTweet = true;
        continue;
      }
      rows.push(mapGetxTweet(tweet, kolId));
    }
    if (reachedKnownTweet || !json.has_more || !json.next_cursor || !tweets.length) break;
    cursor = json.next_cursor;
  }
  return rows;
}

// Append-only raw archive to R2. Twitter data is paid, so every fetched batch is
// preserved verbatim as its own object (never overwritten) under raw/<kol>/<ISO>.json.
async function archiveRawToR2(env: Env, kolId: string, rows: TweetRow[]): Promise<void> {
  if (!env.RAW || !rows.length) return;
  const key = `raw/${kolId}/incr-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  try {
    await env.RAW.put(key, JSON.stringify(rows), { httpMetadata: { contentType: "application/json" } });
    console.log(`r2 archive ${kolId}: wrote ${rows.length} raw tweets -> ${key}`);
  } catch (e) {
    console.log(`r2 archive ${kolId} error: ${e}`);
  }
}

export async function insertTweets(env: Env, rows: TweetRow[]): Promise<number> {
  let n = 0;
  for (const t of rows) {
    if (!t.id || !t.text) continue;
    const r = await env.DB.prepare(
      `INSERT OR IGNORE INTO tweets
       (id,kol_id,text,created_at_iso,created_at_ts,is_retweet,lang,likes,retweets,replies,quotes,views,urls,media)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
      .bind(
        t.id,
        t.kol_id,
        t.text,
        t.created_at_iso,
        t.created_at_ts,
        t.is_retweet,
        t.lang,
        t.likes,
        t.retweets,
        t.replies,
        t.quotes,
        t.views,
        t.urls,
        t.media
      )
      .run();
    if (r.meta.changes) n++;
  }
  return n;
}

// Embed up to `limit` not-yet-embedded tweets for a KOL.
export async function embedPending(env: Env, kolId: string, limit = 40): Promise<number> {
  const r = await env.DB.prepare(
    `SELECT id,text FROM tweets WHERE kol_id=? AND embedded=0 AND is_retweet=0 ORDER BY created_at_ts DESC LIMIT ?`
  )
    .bind(kolId, limit)
    .all();
  let n = 0;
  const vecs: { id: string; kolId: string; values: number[] }[] = [];
  for (const row of (r.results || []) as any[]) {
    const v = await embed(env, row.text);
    if (!v) continue;
    await env.DB.prepare(`UPDATE tweets SET embedding=?, embedded=1 WHERE id=?`)
      .bind(JSON.stringify(v), row.id)
      .run();
    vecs.push({ id: row.id, kolId, values: v });
    n++;
  }
  await indexVectors(env, "tweet", vecs);
  return n;
}

async function touchSyncState(
  env: Env,
  kolId: string,
  lastTweetId: string | null,
  note: string
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO sync_state (kol_id,last_tweet_id,last_run_at,note) VALUES (?,?,datetime('now'),?)
     ON CONFLICT(kol_id) DO UPDATE SET
       last_tweet_id=COALESCE(excluded.last_tweet_id, sync_state.last_tweet_id),
       last_run_at=excluded.last_run_at,
       note=excluded.note`
  )
    .bind(kolId, lastTweetId, note)
    .run();
}

export async function runDailyIngest(env: Env, opts: { embedLimit?: number } = {}): Promise<void> {
  const embedLimit = opts.embedLimit ?? 50;
  if (!env.GETXAPI_KEY && !env.APIFY_TOKEN) {
    console.log("ingest: no X/Twitter token set, skipping pull");
  }
  const kols = await env.DB.prepare(`SELECT id,handle,twitter_uid FROM kols`).all();
  for (const k of (kols.results || []) as any[]) {
    try {
      const st = await env.DB.prepare(`SELECT last_tweet_id FROM sync_state WHERE kol_id=?`)
        .bind(k.id)
        .first<{ last_tweet_id: string }>();
      let rows: TweetRow[] = [];
      let source = "none";
      if (env.GETXAPI_KEY && k.twitter_uid) {
        source = "getxapi";
        rows = await getxFetch(env, k.id, k.handle, k.twitter_uid, st?.last_tweet_id || null);
        console.log(`ingest ${k.id}: getxapi returned ${rows.length} new tweets`);
      } else if (env.APIFY_TOKEN) {
        source = "apify";
        const items = await apifyFetch(env, k.handle, st?.last_tweet_id || null);
        rows = items
          .filter((it) => {
            const author = String(it.author?.userName || it.author?.screenName || it.username || "").toLowerCase();
            return !author || author === String(k.handle).toLowerCase();
          })
          .map((it) => mapApifyTweet(it, k.id));
        console.log(`ingest ${k.id}: apify returned ${rows.length} new tweets`);
      }
      let inserted = 0;
      let maxId: string | null = null;
      if (rows.length) {
        await archiveRawToR2(env, k.id, rows);
        inserted = await insertTweets(env, rows);
        maxId = rows
          .map((r) => r.id)
          .filter(Boolean)
          .sort((a, b) => (tweetIdGt(a, b) ? 1 : tweetIdGt(b, a) ? -1 : 0))
          .pop() || null;
        console.log(`ingest ${k.id}: +${inserted} tweets`);
      }
      const emb = embedLimit > 0 ? await embedPending(env, k.id, embedLimit) : 0;
      await touchSyncState(
        env,
        k.id,
        maxId,
        `source=${source}; fetched=${rows.length}; inserted=${inserted}; embedded=${emb}`
      );
      console.log(`ingest ${k.id}: embedded ${emb}`);
    } catch (e) {
      console.log(`ingest ${k.id} error: ${e}`);
    }
  }
}

// Weekly refresh: distill each KOL's *new* tweets from the past week into a dated "current stance"
// knowledge chunk (embedded). The persona pack itself is NOT auto-mutated (anti-drift): identity/voice
// stay human-curated; only the dated knowledge layer grows so answers stay current.
export async function runWeeklyPersonaRefresh(env: Env): Promise<number> {
  const week = new Date().toISOString().slice(0, 10);
  const version = `weekly-${week}`;
  const since = Math.floor(Date.now() / 1000) - 7 * 86400;
  const kols = await env.DB.prepare(
    `SELECT id,display_name,handle FROM kols WHERE persona_pack IS NOT NULL`
  ).all();
  let updated = 0;
  for (const k of (kols.results || []) as any[]) {
    try {
      const r = await env.DB.prepare(
        `SELECT text,created_at_iso FROM tweets
         WHERE kol_id=? AND is_retweet=0 AND created_at_ts>=? ORDER BY created_at_ts DESC LIMIT 120`
      )
        .bind(k.id, since)
        .all();
      const tweets = (r.results || []) as any[];
      if (tweets.length >= 5) {
        const corpus = tweets
          .map((t) => `(${(t.created_at_iso || "").slice(0, 10)}) ${t.text}`)
          .join("\n")
          .slice(0, 12000);
        const sys =
          "You distill a finance KOL's recent posts into a dated 'current stance' note for a knowledge base. " +
          "Output a one-line summary, then 4-8 concise bullets: tickers/themes in focus this week, current calls and rationale, any change vs prior views, and risk flags. Third person, factual, no fabrication.";
        const note = await completeChat(
          env,
          env.MODEL_FLASH,
          [
            { role: "system", content: sys },
            { role: "user", content: `KOL: ${k.display_name} (@${k.handle})\nRecent posts:\n${corpus}` },
          ],
          { maxTokens: 600 }
        );
        if (note) {
          const chunkId = `${k.id}:analysis:${week}`;
          const vec = await embed(env, note);
          await env.DB.prepare(
            `INSERT OR REPLACE INTO knowledge_chunks (id,kol_id,source,title,text,embedding,embedded)
             VALUES (?,?,?,?,?,?,?)`
          )
            .bind(chunkId, k.id, `analysis:${week}`, `Weekly stance ${week}`, note, vec ? JSON.stringify(vec) : null, vec ? 1 : 0)
            .run();
          if (vec) await indexVectors(env, "knowledge", [{ id: chunkId, kolId: k.id, values: vec }]);
          updated++;
        }
      }
      await env.DB.prepare(`UPDATE kols SET persona_version=?, updated_at=datetime('now') WHERE id=?`)
        .bind(version, k.id)
        .run();
    } catch (e) {
      console.log(`weekly refresh ${k.id} error: ${e}`);
    }
  }
  console.log(`weekly persona refresh: ${updated} dated stance chunks @ ${version}`);
  return updated;
}
