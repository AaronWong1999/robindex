import type { Env } from "./env";
import { archiveRawToR2, insertTweets, mapApifyTweet, mapGetxTweet } from "./ingest";
import { indexRawTweets } from "./tagger";
import { completeSystemChat as completeChat } from "./system-llm";
import type { PersonaJson } from "./persona-gen";

const GETX_BASE = "https://api.getxapi.com";

export interface PublicKolProfile {
  accent: string;
  role: { zh: string; en: string };
  bio: { zh: string; en: string };
  tagline: { zh: string; en: string };
  thesis: { zh: string; en: string };
  style: { zh: string[]; en: string[] };
  suggested: { zh: string[]; en: string[] };
}

export interface OnboardingJob {
  kol_id: string;
  handle: string;
  phase: string;
  cursor: string | null;
  has_more: number;
  pages_fetched: number;
  tweets_fetched: number;
  tweets_inserted: number;
  retries: number;
  last_error: string | null;
  distill_phase: string | null;
  distill_group_index: number;
  distill_steps: number;
  distill_updated_at: string | null;
  lease_owner: string | null;
  lease_until: number | null;
  next_retry_at: string | null;
  phase_retries: number;
  no_progress_count: number;
  r2_batches: number;
  r2_rows: number;
  originals_count: number;
  indexed_count: number;
  reduce_level: number;
  candidate_attempts: number;
  coverage_attempts: number;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
}

function cleanHandle(handle: string): string {
  return String(handle || "").trim().replace(/^@/, "").toLowerCase();
}

function kolIdFor(handle: string): string {
  return cleanHandle(handle).replace(/[^a-z0-9_]/g, "");
}

function largerAvatar(url: string): string {
  return String(url || "").replace(/_normal(\.[a-z]+)(?:\?.*)?$/i, "_400x400$1");
}

function accentForHandle(handle: string): string {
  const palette = ["#3DDC97", "#5B9DFF", "#F59E0B", "#A78BFA", "#FB7185", "#22D3EE", "#84CC16", "#F97316"];
  let hash = 2166136261;
  for (const char of handle) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return palette[Math.abs(hash) % palette.length];
}

function stringList(value: unknown, fallback: string[], min = 2, max = 6): string[] {
  const list = Array.isArray(value) ? value.map((item) => String(item || "").trim()).filter(Boolean) : [];
  const out = list.length >= min ? list : [...list, ...fallback.filter((item) => !list.includes(item))];
  return out.slice(0, max);
}

function deterministicPublicProfile(handle: string, displayName: string, persona: PersonaJson): PublicKolProfile {
  const identity = String(persona.identity_summary || `${displayName} 的公开内容与判断框架`).trim();
  const focus = (persona.sector_focus || []).map(String).filter(Boolean).slice(0, 5);
  const models = (persona.mental_models || []).map((item: any) => String(item?.name || item?.description || "")).filter(Boolean);
  const heuristics = (persona.decision_heuristics || []).map((item: any) => String(item?.rule || item?.example || "")).filter(Boolean);
  const topics = focus.length ? focus : (persona.topic_coverage || []).map((item) => item.topic).filter(Boolean).slice(0, 5);
  const thesis = models.slice(0, 3).join("；") || identity;
  const suggestedZh = topics.slice(0, 4).map((topic) => `你现在怎么看${topic}？`);
  const suggestedEn = topics.slice(0, 4).map((topic) => `What is your current view on ${topic}?`);
  const genericZh = ["你最近最关注什么？", "你会如何判断机会与风险？", "什么信号会让你改变观点？", "你现在会如何配置仓位？"];
  const genericEn = ["What are you focused on now?", "How do you judge opportunity versus risk?", "What would change your view?", "How would you size a position now?"];
  return {
    accent: accentForHandle(handle),
    role: { zh: identity, en: identity },
    bio: { zh: identity, en: identity },
    tagline: { zh: topics.join(" · ") || identity, en: topics.join(" · ") || identity },
    thesis: { zh: thesis, en: thesis },
    style: {
      zh: stringList(persona.expression_dna?.vocabulary, ["直接", "证据驱动"], 1, 5),
      en: stringList(persona.expression_dna?.vocabulary, ["Direct", "Evidence-driven"], 1, 5),
    },
    suggested: {
      zh: stringList(suggestedZh, heuristics.length ? [...heuristics.slice(0, 4).map((item) => `你会如何应用“${item}”？`), ...genericZh] : genericZh, 4, 4),
      en: stringList(suggestedEn, genericEn, 4, 4),
    },
  };
}

export async function buildPublicKolProfile(
  env: Env,
  kolId: string,
  persona: PersonaJson,
): Promise<PublicKolProfile> {
  const kol = await env.DB.prepare(`SELECT display_name,handle FROM kols WHERE id=?`).bind(kolId).first<any>();
  if (!kol) throw new Error(`KOL not found: ${kolId}`);
  const fallback = deterministicPublicProfile(kol.handle, kol.display_name, persona);
  const raw = await completeChat(env, env.MODEL_FLASH, [
    {
      role: "system",
      content:
        "Turn a distilled creator persona into concise public UI metadata. Return ONLY JSON with " +
        "role,bio,tagline,thesis as {zh,en}; style and suggested as {zh:string[],en:string[]}. " +
        "Use supported facts only. 2-5 style tags and exactly 4 useful follower questions per language.",
    },
    {
      role: "user",
      content: `Creator: ${kol.display_name} (@${kol.handle})\nPersona JSON:\n${JSON.stringify(persona).slice(0, 18000)}`,
    },
  ], { maxTokens: 1400, temperature: 0.25 });
  let parsed: any = null;
  try { parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || ""); } catch {}
  const pair = (field: string, base: { zh: string; en: string }) => ({
    zh: String(parsed?.[field]?.zh || base.zh || "").trim(),
    en: String(parsed?.[field]?.en || base.en || "").trim(),
  });
  const profile: PublicKolProfile = {
    accent: accentForHandle(kol.handle),
    role: pair("role", fallback.role),
    bio: pair("bio", fallback.bio),
    tagline: pair("tagline", fallback.tagline),
    thesis: pair("thesis", fallback.thesis),
    style: {
      zh: stringList(parsed?.style?.zh, fallback.style.zh),
      en: stringList(parsed?.style?.en, fallback.style.en),
    },
    suggested: {
      zh: stringList(parsed?.suggested?.zh, fallback.suggested.zh, 4, 4),
      en: stringList(parsed?.suggested?.en, fallback.suggested.en, 4, 4),
    },
  };
  if (!profile.role.zh || !profile.role.en || !profile.bio.zh || !profile.bio.en) return fallback;
  return profile;
}

async function getx(env: Env, path: string, params: Record<string, string>): Promise<any> {
  if (!env.GETXAPI_KEY) throw new Error("GETXAPI_KEY not set");
  const url = new URL(`${GETX_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, value);
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${env.GETXAPI_KEY}` } });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`getxapi ${res.status}: ${json?.error || json?.message || "request failed"}`);
  return json;
}

export async function startOnboarding(
  env: Env,
  input: { handle: string; display_name?: string; twitter_uid?: string; profile?: PublicKolProfile; reset?: boolean },
): Promise<{ kol_id: string; job: OnboardingJob }> {
  const handle = cleanHandle(input.handle);
  if (!/^[a-z0-9_]{1,30}$/.test(handle)) throw new Error("invalid handle");
  const kolId = kolIdFor(handle);
  const existingJob = await getOnboardingJob(env, kolId);
  if (existingJob?.phase === "ready" && !input.reset) return { kol_id: kolId, job: existingJob };
  const infoJson = await getx(env, "/twitter/user/info", { userName: handle });
  const info = infoJson?.data || infoJson?.user || infoJson;
  const twitterUid = String(input.twitter_uid || info?.id || info?.rest_id || "");
  if (!twitterUid) throw new Error("twitter uid not found");
  const displayName = String(input.display_name || info?.name || handle).trim();
  const avatar = largerAvatar(info?.profilePicture || info?.profile_image_url_https || info?.avatar || "");
  const followers = Number(info?.followers || info?.followersCount || 0);
  const statuses = Number(info?.statusesCount || info?.tweetsCount || info?.statuses_count || 0);
  const xCreatedAt = String(info?.createdAt || info?.created_at || "");
  const profileJson = input.profile ? JSON.stringify(input.profile) : null;

  await env.DB.prepare(
    `INSERT INTO kols
       (id,display_name,handle,twitter_uid,avatar_url,tagline,profile_json,onboarding_status,is_public,
        followers_count,statuses_count,x_created_at,subscription_enabled,subscription_price_cents,
        subscription_promo_cents,subscription_gift,retrieval_mode,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       display_name=excluded.display_name, handle=excluded.handle, twitter_uid=excluded.twitter_uid,
       avatar_url=COALESCE(excluded.avatar_url,kols.avatar_url),
       profile_json=COALESCE(excluded.profile_json,kols.profile_json),
       onboarding_status=CASE WHEN ? THEN 'draft' ELSE kols.onboarding_status END,
       is_public=CASE WHEN ? THEN 0 ELSE kols.is_public END,
       followers_count=excluded.followers_count,statuses_count=excluded.statuses_count,
       x_created_at=COALESCE(excluded.x_created_at,kols.x_created_at),
       updated_at=datetime('now')`
  ).bind(
    kolId, displayName, handle, twitterUid, avatar || null, info?.description || null, profileJson,
    "draft", 0, followers, statuses, xCreatedAt || null, 1, 3990, 1990, 2000, "query_side",
    input.reset ? 1 : 0, input.reset ? 1 : 0,
  ).run();

  if (input.reset) {
    await env.DB.prepare(`DELETE FROM kol_onboarding_jobs WHERE kol_id=?`).bind(kolId).run();
  }
  await env.DB.prepare(
    `INSERT INTO kol_onboarding_jobs (kol_id,handle,phase,cursor,has_more,updated_at)
     VALUES (?,?,'ingesting',NULL,1,datetime('now'))
     ON CONFLICT(kol_id) DO UPDATE SET
       phase=CASE WHEN ? OR kol_onboarding_jobs.phase='failed' THEN 'ingesting' ELSE kol_onboarding_jobs.phase END,
       cursor=CASE WHEN ? THEN NULL ELSE kol_onboarding_jobs.cursor END,
       has_more=CASE WHEN ? THEN 1 ELSE kol_onboarding_jobs.has_more END,
       distill_phase=CASE WHEN ? THEN NULL ELSE kol_onboarding_jobs.distill_phase END,
       distill_group_index=CASE WHEN ? THEN 0 ELSE kol_onboarding_jobs.distill_group_index END,
       distill_steps=CASE WHEN ? THEN 0 ELSE kol_onboarding_jobs.distill_steps END,
       retries=CASE WHEN ? OR kol_onboarding_jobs.phase='failed' THEN 0 ELSE kol_onboarding_jobs.retries END,
       phase_retries=CASE WHEN ? OR kol_onboarding_jobs.phase='failed' THEN 0 ELSE kol_onboarding_jobs.phase_retries END,
       candidate_attempts=CASE WHEN ? THEN 0 ELSE kol_onboarding_jobs.candidate_attempts END,
       coverage_attempts=CASE WHEN ? THEN 0 ELSE kol_onboarding_jobs.coverage_attempts END,
       next_retry_at=NULL,last_error=NULL,updated_at=datetime('now')`
  ).bind(
    kolId, handle,
    input.reset ? 1 : 0, input.reset ? 1 : 0, input.reset ? 1 : 0, input.reset ? 1 : 0,
    input.reset ? 1 : 0, input.reset ? 1 : 0, input.reset ? 1 : 0,
    input.reset ? 1 : 0, input.reset ? 1 : 0, input.reset ? 1 : 0,
  ).run();
  await env.DB.prepare(`UPDATE kols SET onboarding_status='ingesting',is_public=0 WHERE id=? AND onboarding_status<>'ready'`)
    .bind(kolId).run();
  const job = await getOnboardingJob(env, kolId);
  if (!job) throw new Error("failed to create onboarding job");
  return { kol_id: kolId, job };
}

export async function getOnboardingJob(env: Env, kolId: string): Promise<OnboardingJob | null> {
  return env.DB.prepare(`SELECT * FROM kol_onboarding_jobs WHERE kol_id=?`).bind(kolId).first<OnboardingJob>();
}

export async function processOnboardingBatch(
  env: Env,
  kolId: string,
  pages = 5,
): Promise<{ job: OnboardingJob; start_distill: boolean }> {
  const job = await getOnboardingJob(env, kolId);
  if (!job) throw new Error(`onboarding job not found: ${kolId}`);
  if (job.phase !== "ingesting") return { job, start_distill: job.phase === "distilling" };
  // Owner lease + heartbeat prevents a self-chain and cron tick from consuming the same cursor.
  const leaseOwner = crypto.randomUUID();
  const lease = await env.DB.prepare(
    `UPDATE kol_onboarding_jobs
     SET phase='ingesting_running',lease_owner=?,lease_until=?,updated_at=datetime('now')
     WHERE kol_id=? AND phase='ingesting'
       AND (next_retry_at IS NULL OR next_retry_at<=datetime('now'))`
  ).bind(leaseOwner, Date.now() + 5 * 60 * 1000, kolId).run();
  if (!lease.meta.changes) {
    const current = await getOnboardingJob(env, kolId);
    if (!current) throw new Error("onboarding job disappeared");
    return { job: current, start_distill: current.phase === "distilling" };
  }
  const kol = await env.DB.prepare(
    `SELECT handle,twitter_uid,statuses_count,x_created_at FROM kols WHERE id=?`
  ).bind(kolId).first<any>();
  if (!kol?.twitter_uid) throw new Error(`twitter uid missing: ${kolId}`);

  let cursor = job.cursor || "";
  let fetched = 0;
  let inserted = 0;
  let pageCount = 0;
  let hasMore = true;
  let archivedBatches = 0;
  let archivedRows = 0;
  try {
    for (let page = 0; page < Math.max(1, Math.min(pages, 10)); page++) {
      // The profile "Posts" endpoint is capped to a recent timeline for many accounts. Advanced
      // search with an author operator can paginate the full public history, including older posts.
      const json = await getx(env, "/twitter/tweet/advanced_search", {
        q: `from:${kol.handle} since:2010-01-01`,
        product: "Latest",
        cursor,
      });
      const tweets: any[] = Array.isArray(json?.tweets) ? json.tweets : [];
      const rows = tweets
        .filter((tweet) => String(tweet?.author?.userName || json?.userName || kol.handle).toLowerCase() === String(kol.handle).toLowerCase())
        .map((tweet) => mapGetxTweet(tweet, kolId))
        .filter((row) => row.id && row.text);
      if (rows.length) {
        if (await archiveRawToR2(env, kolId, rows)) {
          archivedBatches++;
          archivedRows += rows.length;
        }
        const existing = await env.DB.prepare(
          `SELECT id FROM tweets WHERE id IN (${rows.map(() => "?").join(",")})`
        ).bind(...rows.map((row) => row.id)).all();
        const known = new Set(((existing.results || []) as any[]).map((row) => String(row.id)));
        const freshRows = rows.filter((row) => !known.has(String(row.id)));
        inserted += await insertTweets(env, rows);
        const originals = freshRows.filter((row) => !row.is_retweet).map((row) => ({ id: row.id, text: row.text }));
        if (originals.length) await indexRawTweets(env, kolId, originals);
      }
      fetched += rows.length;
      pageCount++;
      await env.DB.prepare(
        `UPDATE kol_onboarding_jobs SET lease_until=?,updated_at=datetime('now')
         WHERE kol_id=? AND lease_owner=?`
      ).bind(Date.now() + 5 * 60 * 1000, kolId, leaseOwner).run();
      hasMore = !!json?.has_more && !!json?.next_cursor && tweets.length > 0;
      cursor = hasMore ? String(json.next_cursor) : "";
      if (!hasMore) break;
    }
    if (!hasMore) {
      // FTS5 has no uniqueness constraint. Rebuild once from canonical D1 rows so retries/races can
      // never leave duplicate search hits.
      await rebuildRawSearchIndex(env, kolId);
    }
    const stats = await env.DB.prepare(
      `SELECT SUM(CASE WHEN is_retweet=0 THEN 1 ELSE 0 END) originals,
              MIN(created_at_iso) oldest FROM tweets WHERE kol_id=?`
    ).bind(kolId).first<{ originals: number; oldest: string | null }>();
    const indexed = await env.DB.prepare(
      `SELECT COUNT(*) n FROM tweet_search WHERE kol_id=?`
    ).bind(kolId).first<{ n: number }>();
    const oldestMs = Date.parse(String(stats?.oldest || ""));
    const createdMs = Date.parse(String(kol.x_created_at || ""));
    const shouldReconcile = !hasMore && !!env.APIFY_TOKEN && Number.isFinite(oldestMs) && Number.isFinite(createdMs) &&
      oldestMs - createdMs > 45 * 86400_000 && Number(kol.statuses_count || 0) > Number(stats?.originals || 0);
    const nextPhase = hasMore ? "ingesting" : shouldReconcile ? "reconciling" : "distilling";
    const startDistill = nextPhase === "distilling";
    const nextCursor = shouldReconcile ? `apify:${new Date(oldestMs).getUTCFullYear()}` : (cursor || null);
    await env.DB.prepare(
      `UPDATE kol_onboarding_jobs SET phase=?,cursor=?,has_more=?,pages_fetched=pages_fetched+?,
       tweets_fetched=tweets_fetched+?,tweets_inserted=tweets_inserted+?,last_error=NULL,updated_at=datetime('now')
       ,distill_phase=CASE WHEN ?=0 THEN 'map' ELSE distill_phase END
       ,distill_group_index=CASE WHEN ?=0 THEN 0 ELSE distill_group_index END
       ,distill_steps=CASE WHEN ?=0 THEN 0 ELSE distill_steps END
       ,distill_updated_at=CASE WHEN ?=0 THEN datetime('now') ELSE distill_updated_at END
       ,r2_batches=r2_batches+?,r2_rows=r2_rows+?,originals_count=?,indexed_count=?
       ,lease_owner=NULL,lease_until=NULL,phase_retries=0,next_retry_at=NULL
       WHERE kol_id=?`
    ).bind(
      nextPhase, nextCursor, hasMore ? 1 : 0, pageCount, fetched, inserted,
      startDistill ? 0 : 1, startDistill ? 0 : 1, startDistill ? 0 : 1, startDistill ? 0 : 1,
      archivedBatches, archivedRows, Number(stats?.originals || 0), Number(indexed?.n || 0), kolId,
    ).run();
    if (startDistill && env.RAW) {
      await env.RAW.put(
        `raw/${kolId}/manifest.json`,
        JSON.stringify({
          kol_id: kolId,
          pages_fetched: job.pages_fetched + pageCount,
          rows_archived: job.r2_rows + archivedRows,
          originals: Number(stats?.originals || 0),
          indexed: Number(indexed?.n || 0),
          completed_at: new Date().toISOString(),
        }),
        { httpMetadata: { contentType: "application/json" } },
      );
    }
    if (!hasMore) {
      await env.DB.prepare(`UPDATE kols SET onboarding_status=?,updated_at=datetime('now') WHERE id=?`)
        .bind(nextPhase, kolId).run();
    }
  } catch (error) {
    const message = String(error).slice(0, 500);
    const attempts = Number(job.phase_retries || 0) + 1;
    const delayMinutes = Math.min(60, 2 ** Math.min(attempts - 1, 6));
    await env.DB.prepare(
      `UPDATE kol_onboarding_jobs SET phase='ingesting',retries=retries+1,phase_retries=?,
       next_retry_at=datetime('now',?),last_error=?,lease_owner=NULL,lease_until=NULL,updated_at=datetime('now')
       WHERE kol_id=? AND lease_owner=?`
    ).bind(attempts, `+${delayMinutes} minutes`, message, kolId, leaseOwner).run();
    if (attempts >= 8) {
      if (env.APIFY_TOKEN) {
        await env.DB.prepare(
          `UPDATE kol_onboarding_jobs SET phase='reconciling',cursor=?,phase_retries=0,next_retry_at=NULL,
             lease_owner=NULL,lease_until=NULL,last_error='GetXAPI exhausted; switching to Apify reconciliation'
           WHERE kol_id=?`
        ).bind(`apify:${new Date().getUTCFullYear()}`, kolId).run();
        await env.DB.prepare(`UPDATE kols SET onboarding_status='reconciling',is_public=0 WHERE id=?`).bind(kolId).run();
      } else {
        await env.DB.prepare(
          `UPDATE kol_onboarding_jobs SET phase='failed',lease_owner=NULL,lease_until=NULL WHERE kol_id=?`
        ).bind(kolId).run();
        await env.DB.prepare(`UPDATE kols SET onboarding_status='failed',is_public=0 WHERE id=?`).bind(kolId).run();
      }
    }
  }
  const updated = await getOnboardingJob(env, kolId);
  if (!updated) throw new Error("onboarding job disappeared");
  return { job: updated, start_distill: updated.phase === "distilling" };
}

export async function rebuildRawSearchIndex(env: Env, kolId: string): Promise<number> {
  await env.DB.prepare(`DELETE FROM tweet_search WHERE kol_id=?`).bind(kolId).run();
  let offset = 0;
  let indexed = 0;
  for (;;) {
    const canonical = await env.DB.prepare(
      `SELECT id,text FROM tweets WHERE kol_id=? AND is_retweet=0 ORDER BY created_at_ts DESC LIMIT 500 OFFSET ?`
    ).bind(kolId, offset).all();
    const rows = ((canonical.results || []) as any[]).map((row) => ({ id: String(row.id), text: String(row.text || "") }));
    if (rows.length) indexed += await indexRawTweets(env, kolId, rows);
    if (rows.length < 500) break;
    offset += rows.length;
  }
  return indexed;
}

async function fetchApifyWindow(
  env: Env,
  kolId: string,
  opts: { since: string; until: string },
): Promise<ReturnType<typeof mapApifyTweet>[]> {
  if (!env.APIFY_TOKEN) throw new Error("APIFY_TOKEN not set");
  const kol = await env.DB.prepare(`SELECT handle FROM kols WHERE id=?`).bind(kolId).first<any>();
  if (!kol?.handle) throw new Error(`KOL not found: ${kolId}`);
  const url = `https://api.apify.com/v2/acts/apidojo~tweet-scraper/run-sync-get-dataset-items?token=${env.APIFY_TOKEN}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      searchTerms: [`from:${kol.handle} since:${opts.since} until:${opts.until}`],
      maxItems: 5000,
      sort: "Latest",
      includeSearchTerms: false,
    }),
  });
  const items = await res.json<any[]>().catch(() => []);
  if (!res.ok || !Array.isArray(items)) throw new Error(`apify ${res.status}: backfill failed`);
  return items
    .filter((item) => {
      const author = String(item?.author?.userName || item?.author?.screenName || item?.username || "").toLowerCase();
      return !author || author === String(kol.handle).toLowerCase();
    })
    .map((item) => mapApifyTweet(item, kolId))
    .filter((row) => row.id && row.text);
}

/** Backfill an older date range through Apify when X's search endpoint reaches its history cap. */
export async function backfillOnboardingFromApify(
  env: Env,
  kolId: string,
  opts: { since: string; until: string },
): Promise<{ fetched: number; inserted: number; indexed: number }> {
  const rows = await fetchApifyWindow(env, kolId, opts);
  await archiveRawToR2(env, kolId, rows);
  const inserted = await insertTweets(env, rows);
  const indexed = await rebuildRawSearchIndex(env, kolId);
  await env.DB.prepare(
    `UPDATE kol_onboarding_jobs SET tweets_fetched=tweets_fetched+?,tweets_inserted=tweets_inserted+?,
     phase='distilling',distill_phase='map',distill_group_index=0,distill_steps=0,
     distill_updated_at=datetime('now'),last_error=NULL,updated_at=datetime('now') WHERE kol_id=?`
  ).bind(rows.length, inserted, kolId).run();
  await env.DB.prepare(`UPDATE kols SET onboarding_status='distilling',is_public=0,updated_at=datetime('now') WHERE id=?`)
    .bind(kolId).run();
  return { fetched: rows.length, inserted, indexed };
}

function apifyWindow(cursor: string): { since: string; until: string; next: string | null; year: number; month: number | null } {
  const monthMatch = cursor.match(/^apify:(\d{4}):(\d{1,2})$/);
  if (monthMatch) {
    const year = Number(monthMatch[1]);
    const month = Number(monthMatch[2]);
    const since = `${year}-${String(month).padStart(2, "0")}-01`;
    const nextDate = new Date(Date.UTC(year, month, 1));
    const until = nextDate.toISOString().slice(0, 10);
    const next = month > 1 ? `apify:${year}:${month - 1}` : `apify:${year - 1}`;
    return { since, until, next, year, month };
  }
  const year = Number(cursor.match(/^apify:(\d{4})$/)?.[1] || new Date().getUTCFullYear());
  return {
    since: `${year}-01-01`,
    until: `${year + 1}-01-01`,
    next: `apify:${year - 1}`,
    year,
    month: null,
  };
}

export async function processOnboardingReconciliation(
  env: Env,
  kolId: string,
): Promise<{ job: OnboardingJob; start_distill: boolean }> {
  const job = await getOnboardingJob(env, kolId);
  if (!job) throw new Error(`onboarding job not found: ${kolId}`);
  if (job.phase !== "reconciling") return { job, start_distill: job.phase === "distilling" };
  const owner = crypto.randomUUID();
  const lease = await env.DB.prepare(
    `UPDATE kol_onboarding_jobs SET phase='reconciling_running',lease_owner=?,lease_until=?,updated_at=datetime('now')
     WHERE kol_id=? AND phase='reconciling' AND (next_retry_at IS NULL OR next_retry_at<=datetime('now'))`
  ).bind(owner, Date.now() + 8 * 60 * 1000, kolId).run();
  if (!lease.meta.changes) return { job, start_distill: false };
  try {
    const kol = await env.DB.prepare(`SELECT x_created_at FROM kols WHERE id=?`).bind(kolId).first<any>();
    const createdYear = Math.max(2006, Number(String(kol?.x_created_at || "2010").slice(0, 4)) || 2010);
    const window = apifyWindow(job.cursor || `apify:${new Date().getUTCFullYear()}`);
    const rows = await fetchApifyWindow(env, kolId, window);
    const archiveKey = await archiveRawToR2(env, kolId, rows);
    const inserted = await insertTweets(env, rows);
    let next = window.next;
    // An annual result at the provider cap is re-read month-by-month. Inserts remain idempotent.
    if (window.month === null && rows.length >= 4900) next = `apify:${window.year}:12`;
    const done = window.month === null
      ? window.year <= createdYear && rows.length < 4900
      : window.year <= createdYear && window.month === 1;
    if (done) next = null;
    if (!next) {
      const indexed = await rebuildRawSearchIndex(env, kolId);
      const stats = await env.DB.prepare(
        `SELECT COUNT(*) total,SUM(CASE WHEN is_retweet=0 THEN 1 ELSE 0 END) originals FROM tweets WHERE kol_id=?`
      ).bind(kolId).first<any>();
      await env.DB.prepare(
        `UPDATE kol_onboarding_jobs SET phase='distilling',cursor=NULL,has_more=0,
           tweets_fetched=tweets_fetched+?,tweets_inserted=tweets_inserted+?,
           r2_batches=r2_batches+?,r2_rows=r2_rows+?,originals_count=?,indexed_count=?,
           distill_phase='map',distill_group_index=0,distill_steps=0,distill_updated_at=datetime('now'),
           lease_owner=NULL,lease_until=NULL,phase_retries=0,next_retry_at=NULL,last_error=NULL,updated_at=datetime('now')
         WHERE kol_id=? AND lease_owner=?`
      ).bind(
        rows.length, inserted, archiveKey ? 1 : 0, archiveKey ? rows.length : 0,
        Number(stats?.originals || 0), indexed, kolId, owner,
      ).run();
      await env.DB.prepare(`UPDATE kols SET onboarding_status='distilling',updated_at=datetime('now') WHERE id=?`)
        .bind(kolId).run();
      if (env.RAW) {
        await env.RAW.put(
          `raw/${kolId}/manifest.json`,
          JSON.stringify({
            kol_id: kolId,
            source: "getxapi+apify",
            total_rows: Number(stats?.total || 0),
            originals: Number(stats?.originals || 0),
            indexed,
            completed_at: new Date().toISOString(),
          }),
          { httpMetadata: { contentType: "application/json" } },
        );
      }
    } else {
      await env.DB.prepare(
        `UPDATE kol_onboarding_jobs SET phase='reconciling',cursor=?,
           tweets_fetched=tweets_fetched+?,tweets_inserted=tweets_inserted+?,
           r2_batches=r2_batches+?,r2_rows=r2_rows+?,lease_owner=NULL,lease_until=NULL,
           phase_retries=0,next_retry_at=NULL,last_error=NULL,updated_at=datetime('now')
         WHERE kol_id=? AND lease_owner=?`
      ).bind(next, rows.length, inserted, archiveKey ? 1 : 0, archiveKey ? rows.length : 0, kolId, owner).run();
    }
  } catch (error) {
    const attempts = Number(job.phase_retries || 0) + 1;
    const delay = Math.min(60, 2 ** Math.min(attempts - 1, 6));
    await env.DB.prepare(
      `UPDATE kol_onboarding_jobs SET phase=CASE WHEN ?>=8 THEN 'failed' ELSE 'reconciling' END,
         phase_retries=?,next_retry_at=datetime('now',?),last_error=?,lease_owner=NULL,lease_until=NULL,
         updated_at=datetime('now') WHERE kol_id=? AND lease_owner=?`
    ).bind(attempts, attempts, `+${delay} minutes`, String(error).slice(0, 500), kolId, owner).run();
    if (attempts >= 8) {
      await env.DB.prepare(`UPDATE kols SET onboarding_status='failed',is_public=0 WHERE id=?`).bind(kolId).run();
    }
  }
  const updated = await getOnboardingJob(env, kolId);
  if (!updated) throw new Error("onboarding job disappeared");
  return { job: updated, start_distill: updated.phase === "distilling" };
}

export async function listRunnableOnboardingJobs(env: Env, limit = 3): Promise<OnboardingJob[]> {
  // A Worker can be terminated mid-batch. Reclaim only expired owner leases.
  await env.DB.prepare(
    `UPDATE kol_onboarding_jobs
     SET phase=CASE WHEN phase='reconciling_running' THEN 'reconciling' ELSE 'ingesting' END,
       lease_owner=NULL,lease_until=NULL,
       last_error='recovered stale ingestion lease',updated_at=datetime('now')
     WHERE phase IN ('ingesting_running','reconciling_running') AND lease_until < ?`
  ).bind(Date.now()).run();
  const rows = await env.DB.prepare(
    `SELECT * FROM kol_onboarding_jobs
     WHERE phase IN ('ingesting','reconciling') AND (next_retry_at IS NULL OR next_retry_at<=datetime('now'))
     ORDER BY updated_at ASC LIMIT ?`
  ).bind(Math.max(1, Math.min(3, limit))).all();
  return (rows.results || []) as unknown as OnboardingJob[];
}
