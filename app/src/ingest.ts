import type { Env } from "./env";
import { completeChat } from "./chat";
import { evolvePersona, logPersonaExperiment } from "./persona-gen";
import { evalAndMaybeRollback } from "./eval";
import { distillPersonaIncremental, loadMergedFacts, personaCoverageGate } from "./persona-distill";
import { indexRawTweets } from "./tagger";

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
export function mapApifyTweet(it: any, kolId: string) {
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
    quoted: mapQuoted(it),
  };
}

// Extract the quoted tweet (GetXAPI `quoted_tweet`: {id, text, user:{name, screen_name}}) into our
// compact JSON shape, so the UI can render the nested original. Returns "" when not a quote-tweet.
function mapQuoted(it: any): string {
  const q = it.quoted_tweet || it.quotedTweet || it.quoted_status || null;
  if (!q || !(q.text || q.full_text)) return "";
  const u = q.user || q.author || {};
  const handle = u.screen_name || u.userName || u.username || "";
  const qid = String(q.id || q.id_str || "");
  return JSON.stringify({
    id: qid,
    text: q.text || q.full_text || "",
    handle,
    name: u.name || u.display_name || "",
    url: handle && qid ? `https://x.com/${handle}/status/${qid}` : "",
  });
}

export function mapGetxTweet(it: any, kolId: string) {
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
    quoted: mapQuoted(it),
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
export async function archiveRawToR2(env: Env, kolId: string, rows: TweetRow[]): Promise<string | null> {
  if (!env.RAW || !rows.length) return null;
  const key = `raw/${kolId}/incr-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  try {
    await env.RAW.put(key, JSON.stringify(rows), { httpMetadata: { contentType: "application/json" } });
    console.log(`r2 archive ${kolId}: wrote ${rows.length} raw tweets -> ${key}`);
    return key;
  } catch (e) {
    console.log(`r2 archive ${kolId} error: ${e}`);
    return null;
  }
}

export async function insertTweets(env: Env, rows: TweetRow[]): Promise<number> {
  let n = 0;
  for (const t of rows) {
    if (!t.id || !t.text) continue;
    const r = await env.DB.prepare(
      `INSERT OR IGNORE INTO tweets
       (id,kol_id,text,created_at_iso,created_at_ts,is_retweet,lang,likes,retweets,replies,quotes,views,urls,media,quoted)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
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
        t.media,
        (t as any).quoted || ""
      )
      .run();
    if (r.meta.changes) n++;
  }
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

export async function runDailyIngest(env: Env): Promise<void> {
  if (!env.GETXAPI_KEY && !env.APIFY_TOKEN) {
    console.log("ingest: no X/Twitter token set, skipping pull");
  }
  // Only fetch canonical corpora. Control/persona variants with corpus_id reuse another KOL's tweets,
  // so pulling their timelines would spend GetXAPI quota and then insert zero duplicate tweet IDs.
  const kols = await env.DB.prepare(
    `SELECT id,handle,twitter_uid FROM kols WHERE corpus_id IS NULL OR corpus_id=''`
  ).all();
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
        // Query-side-only is the default scheme: raw-index new tweets (original text → FTS, NO LLM) so
        // they are instantly searchable/citable. Cross-lingual recall comes from the planner's bilingual
        // expansion at query time, not per-tweet tagging — so daily updates cost zero tagging tokens.
        try {
          const fresh = rows
            .filter((r) => !r.is_retweet && r.id && r.text)
            .map((r) => ({ id: r.id, text: r.text }));
          if (fresh.length) {
            const n = await indexRawTweets(env, k.id, fresh);
            console.log(`ingest ${k.id}: raw search-indexed ${n} new tweets (query-side default)`);
          }
        } catch (e) {
          console.log(`ingest ${k.id} search-index error: ${e}`);
        }
        maxId = rows
          .map((r) => r.id)
          .filter(Boolean)
          .sort((a, b) => (tweetIdGt(a, b) ? 1 : tweetIdGt(b, a) ? -1 : 0))
          .pop() || null;
        console.log(`ingest ${k.id}: +${inserted} tweets`);
      }
      await touchSyncState(
        env,
        k.id,
        maxId,
        `source=${source}; fetched=${rows.length}; inserted=${inserted}`
      );
    } catch (e) {
      console.log(`ingest ${k.id} error: ${e}`);
    }
  }
}

// Weekly refresh: distill each KOL's *new* tweets from the past week into a dated "current stance"
// knowledge chunk. For KOLs with an existing persona_pack, also run incremental evolution
// (colleague-skill pattern): new models/heuristics are appended, contradictions flagged for review.
export async function runWeeklyPersonaRefresh(env: Env): Promise<number> {
  const week = new Date().toISOString().slice(0, 10);
  const version = `weekly-${week}`;
  const since = Math.floor(Date.now() / 1000) - 7 * 86400;
  const kols = await env.DB.prepare(
    `SELECT id,display_name,handle,persona_pack,persona_version FROM kols`
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

      // --- Dated stance chunk (always, for KOLs with persona_pack) ---
      if (k.persona_pack && tweets.length >= 5) {
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
          await env.DB.prepare(
            `INSERT OR REPLACE INTO knowledge_chunks (id,kol_id,source,title,text)
             VALUES (?,?,?,?,?)`
          )
            .bind(chunkId, k.id, `weekly_stance:${week}`, `Weekly stance ${week}`, note)
            .run();
          updated++;
        }

        // --- Weekly persona update ---
        // If this KOL has been migrated to the map-reduce fact store, do an INCREMENTAL distill (map the
        // new week's tweets, reduce into the stored facts). Otherwise fall back to the legacy text-append
        // evolution. Either way, score + auto-rollback afterward (no-op without a golden eval set).
        try {
          const hasFacts = await loadMergedFacts(env, k.id);
          if (hasFacts) {
            const inc = await distillPersonaIncremental(env, k.id, since);
            if (inc.changed && inc.result && inc.result.persona_pack.length >= 500) {
              if (!inc.result.persona_json) throw new Error("weekly candidate persona JSON missing");
              const gate = personaCoverageGate(inc.result.persona_json, inc.result.persona_pack);
              if (!gate.ok) throw new Error(`weekly coverage gate failed: ${gate.missing.join(",") || "identity"}`);
              const candidateVersion = `v2-mapreduce-inc-${week}-candidate-${Date.now()}`;
              await env.DB.prepare(
                `INSERT INTO persona_candidates
                   (kol_id,version,persona_pack,persona_json,coverage_json,status,last_error,updated_at)
                 VALUES (?,?,?,?,?,'evaluating',NULL,datetime('now'))
                 ON CONFLICT(kol_id) DO UPDATE SET
                   version=excluded.version,persona_pack=excluded.persona_pack,persona_json=excluded.persona_json,
                   coverage_json=excluded.coverage_json,status='evaluating',last_error=NULL,updated_at=datetime('now')`
              ).bind(k.id, candidateVersion, inc.result.persona_pack, JSON.stringify(inc.result.persona_json), JSON.stringify(gate)).run();
              await env.DB.prepare(
                `INSERT INTO persona_update_jobs
                   (kol_id,kind,phase,distill_phase,distill_group_index,distill_steps,last_error,updated_at)
                 VALUES (?,'weekly','evaluating','build_eval',0,0,NULL,datetime('now'))
                 ON CONFLICT(kol_id) DO UPDATE SET
                   kind='weekly',
                   phase='evaluating',distill_phase='build_eval',distill_group_index=0,
                   distill_steps=0,last_error=NULL,completed_at=NULL,updated_at=datetime('now')`
              ).bind(k.id).run();
              console.log(`persona distill-inc ${k.id}: staged +${inc.result.stats.tweets} tweets, models=${inc.result.stats.models}`);
            } else {
              console.log(`persona distill-inc ${k.id}: ${inc.note}`);
            }
          } else {
            const evo = await evolvePersona(env, k.id);
            console.log(`persona evolve ${k.id}: evolved=${evo.evolved} v=${evo.version} notes=${evo.notes.join("; ")} review=${evo.needs_review}`);
            if (evo.evolved) {
              const er = await evalAndMaybeRollback(env, k.id, { limit: 12, smoke: true });
              if (er.smoke_suspicious) {
                await env.CACHE.put(`distill_job:${k.id}`, JSON.stringify({ phase: "eval", i: 0 }), { expirationTtl: 7200 });
                await env.CACHE.put(`distill_steps:${k.id}`, "0", { expirationTtl: 7200 });
                console.log(`eval ${k.id}: smoke suspicious; scheduled full eval via distill_job`);
              }
              if (!er.skipped) console.log(`eval ${k.id}: composite=${er.summary?.composite?.toFixed(3)} regressed=${er.summary?.regressed} rolled_back=${er.rolled_back}`);
            }
          }
        } catch (e: any) {
          console.log(`persona evolve ${k.id} error: ${e}`);
          // Persist to D1 so weekly evolve failures survive Worker log rotation. A KOL with no
          // persona_pack yet legitimately throws here — tag it so post-mortems can tell that
          // apart from a real evolution failure.
          const noPersona = /No existing persona_pack/.test(String(e?.message || e));
          await logPersonaExperiment(env, k.id, {
            content: "", finish_reason: noPersona ? "no_persona" : "error",
            content_len: 0, duration_ms: 0, parse_ok: false,
            error_type: null, note: String(e?.message || e).slice(0, 400),
          }, 0, "evolve");
        }
      }

      // persona_version changes only after the candidate completes full evaluation and is published.
    } catch (e: any) {
      console.log(`weekly refresh ${k.id} error: ${e}`);
      // Outer failure (DB query, stance chunk, version update). Record as a cron-level row.
      await logPersonaExperiment(env, k.id, {
        content: "", finish_reason: "error",
        content_len: 0, duration_ms: 0, parse_ok: false,
        error_type: null, note: `weekly refresh: ${String(e?.message || e).slice(0, 400)}`,
      }, 0, "cron");
    }
  }
  console.log(`weekly persona refresh: ${updated} dated stance chunks @ ${version}`);
  return updated;
}
