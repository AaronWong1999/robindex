import { Hono } from "hono";
import type { Env, KolRow } from "./env";
import { getQuotesCached, getKlineCached, resolveSymbolCached } from "./finance";
import { retrieve, embedBatch } from "./rag";
import { gatherMarketData, buildMessages, streamChat } from "./chat";
import { runDailyIngest, runWeeklyPersonaRefresh } from "./ingest";

const app = new Hono<{ Bindings: Env }>();

const DEFAULT_PERSONA = (k: KolRow) =>
  `Identity: ${k.display_name} (@${k.handle}).\nTone: direct, data-driven finance commentator.\n` +
  `Methodology: reason from price action, fundamentals, and macro context.\nTaboos: no fabricated numbers; no guarantees.`;

app.get("/api/kols", async (c) => {
  const r = await c.env.DB.prepare(
    `SELECT id,display_name,handle,avatar_url,tagline FROM kols ORDER BY display_name`
  ).all();
  return c.json({ kols: r.results || [] });
});

app.get("/api/quote", async (c) => {
  const q = c.req.query("q");
  const codes = c.req.query("codes");
  if (codes) return c.json({ quotes: await getQuotesCached(c.env.CACHE, codes.split(",")) });
  if (q) {
    const hit = await resolveSymbolCached(c.env.CACHE, q);
    return c.json({ quotes: hit ? [hit] : [] });
  }
  return c.json({ error: "provide ?q= or ?codes=" }, 400);
});

// Public: recent tweets for a KOL — powers the 全量库/内容库 corpus views and the KOL 日报.
app.get("/api/tweets", async (c) => {
  const kolId = c.req.query("kol_id");
  if (!kolId) return c.json({ error: "provide ?kol_id=" }, 400);
  const limit = Math.min(parseInt(c.req.query("limit") || "30", 10), 100);
  const offset = Math.max(parseInt(c.req.query("offset") || "0", 10), 0);
  const k = await c.env.DB.prepare(`SELECT handle FROM kols WHERE id=?`).bind(kolId).first<{ handle: string }>();
  const total = await c.env.DB.prepare(
    `SELECT COUNT(*) c FROM tweets WHERE kol_id=? AND is_retweet=0`
  ).bind(kolId).first<{ c: number }>();
  const r = await c.env.DB.prepare(
    `SELECT id,text,created_at_iso,likes,retweets,replies,quotes,views,urls
     FROM tweets WHERE kol_id=? AND is_retweet=0 ORDER BY created_at_ts DESC LIMIT ? OFFSET ?`
  ).bind(kolId, limit, offset).all();
  return c.json({
    handle: k?.handle || kolId,
    total: total?.c ?? 0,
    tweets: (r.results || []).map((t: any) => ({ ...t, urls: t.urls ? JSON.parse(t.urls) : [] })),
  });
});

app.get("/api/kline", async (c) => {
  const code = c.req.query("code");
  if (!code) return c.json({ error: "provide ?code=" }, 400);
  const period = c.req.query("period") || "day";
  const limit = parseInt(c.req.query("limit") || "60", 10);
  try {
    return c.json(await getKlineCached(c.env.CACHE, code, period, limit));
  } catch (e) {
    return c.json({ code, period, candles: [], error: "kline_unavailable" }, 200);
  }
});

app.post("/api/chat", async (c) => {
  const body = await c.req.json<{
    kol_id: string;
    model?: string;
    conversation_id?: string;
    message: string;
  }>();
  if (!body.kol_id || !body.message) return c.json({ error: "kol_id and message required" }, 400);

  const kol = await c.env.DB.prepare(`SELECT * FROM kols WHERE id=?`).bind(body.kol_id).first<KolRow>();
  if (!kol) return c.json({ error: "unknown kol_id" }, 404);

  const model = body.model === "pro" ? c.env.MODEL_PRO : c.env.MODEL_FLASH;

  // Conversation (bound to one KOL).
  let convId = body.conversation_id;
  if (!convId) {
    convId = crypto.randomUUID();
    await c.env.DB.prepare(
      `INSERT INTO conversations (id,kol_id,model,title) VALUES (?,?,?,?)`
    )
      .bind(convId, kol.id, model, body.message.slice(0, 60))
      .run();
  }

  // History (bounded).
  const hist = await c.env.DB.prepare(
    `SELECT role,content FROM messages WHERE conversation_id=? ORDER BY created_at LIMIT 20`
  )
    .bind(convId)
    .all();
  const history = (hist.results || []) as { role: string; content: string }[];

  // Save user message.
  await c.env.DB.prepare(
    `INSERT INTO messages (id,conversation_id,role,content) VALUES (?,?,?,?)`
  )
    .bind(crypto.randomUUID(), convId, "user", body.message)
    .run();

  // Live market data + retrieval (hard-scoped to this KOL).
  const market = await gatherMarketData(c.env, body.message);
  const tickers = market.quotes.map((q) => q.symbol);
  const { citations, knowledge } = await retrieve(c.env, kol.id, kol.handle, body.message, tickers);

  const messages = buildMessages({
    kol,
    persona: kol.persona_pack || DEFAULT_PERSONA(kol),
    knowledge,
    citations,
    market,
    history,
    userMessage: body.message,
  });

  const res = await streamChat(c.env, model, messages, citations, market.primary, async (full) => {
    await c.env.DB.prepare(
      `INSERT INTO messages (id,conversation_id,role,content,citations) VALUES (?,?,?,?,?)`
    )
      .bind(crypto.randomUUID(), convId!, "assistant", full, JSON.stringify(citations))
      .run();
    await c.env.DB.prepare(`UPDATE conversations SET updated_at=datetime('now') WHERE id=?`)
      .bind(convId!)
      .run();
  });
  // Surface the conversation id to the client.
  res.headers.set("X-Conversation-Id", convId!);
  return res;
});

// ---------------- Admin bulk import (protected) ----------------
function adminOk(c: any): boolean {
  return !!c.env.ADMIN_KEY && c.req.header("x-admin-key") === c.env.ADMIN_KEY;
}

app.post("/api/admin/kol", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const k = await c.req.json<any>();
  await c.env.DB.prepare(
    `INSERT INTO kols (id,display_name,handle,twitter_uid,avatar_url,tagline,persona_pack,persona_version,updated_at)
     VALUES (?,?,?,?,?,?,?,?,datetime('now'))
     ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name, handle=excluded.handle,
       twitter_uid=excluded.twitter_uid, avatar_url=excluded.avatar_url, tagline=excluded.tagline,
       persona_pack=excluded.persona_pack, persona_version=excluded.persona_version, updated_at=datetime('now')`
  )
    .bind(k.id, k.display_name, k.handle, k.twitter_uid || null, k.avatar_url || null, k.tagline || null, k.persona_pack || null, k.persona_version || null)
    .run();
  if (k.last_tweet_id) {
    await c.env.DB.prepare(
      `INSERT INTO sync_state (kol_id,last_tweet_id,last_run_at,note) VALUES (?,?,datetime('now'),?)
       ON CONFLICT(kol_id) DO UPDATE SET last_tweet_id=excluded.last_tweet_id`
    )
      .bind(k.id, k.last_tweet_id, "seed")
      .run();
  }
  return c.json({ ok: true });
});

app.post("/api/admin/tweets", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.json<{ kol_id: string; embed?: boolean; tweets: any[] }>();
  const tweets = body.tweets || [];
  const vecs = body.embed ? await embedBatch(c.env, tweets.map((t) => t.text || "")) : [];
  const stmt = c.env.DB.prepare(
    `INSERT OR IGNORE INTO tweets
     (id,kol_id,text,created_at_iso,created_at_ts,is_retweet,lang,likes,retweets,replies,quotes,views,urls,media,embedding,embedded)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const batch: D1PreparedStatement[] = [];
  tweets.forEach((t, i) => {
    const v = vecs[i] || null;
    batch.push(
      stmt.bind(
        String(t.id),
        body.kol_id,
        t.text || "",
        t.created_at_iso || "",
        t.created_at_ts || 0,
        t.is_retweet ? 1 : 0,
        t.lang || "",
        t.likes || 0,
        t.retweets || 0,
        t.replies || 0,
        t.quotes || 0,
        t.views || 0,
        JSON.stringify(t.urls || []),
        JSON.stringify(t.media || []),
        v ? JSON.stringify(v) : null,
        v ? 1 : 0
      )
    );
  });
  if (batch.length) await c.env.DB.batch(batch);
  return c.json({ ok: true, inserted: batch.length, embedded: vecs.filter(Boolean).length });
});

app.post("/api/admin/knowledge", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.json<{ kol_id: string; embed?: boolean; chunks: any[] }>();
  const chunks = body.chunks || [];
  const vecs = body.embed ? await embedBatch(c.env, chunks.map((k) => k.text || "")) : [];
  const stmt = c.env.DB.prepare(
    `INSERT OR REPLACE INTO knowledge_chunks (id,kol_id,source,title,text,embedding,embedded)
     VALUES (?,?,?,?,?,?,?)`
  );
  const batch: D1PreparedStatement[] = [];
  chunks.forEach((k, i) => {
    const v = vecs[i] || null;
    batch.push(stmt.bind(k.id, body.kol_id, k.source, k.title || null, k.text || "", v ? JSON.stringify(v) : null, v ? 1 : 0));
  });
  if (batch.length) await c.env.DB.batch(batch);
  return c.json({ ok: true, inserted: batch.length, embedded: vecs.filter(Boolean).length });
});

app.post("/api/admin/embed", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const kolId = c.req.query("kol_id");
  const limit = Math.min(parseInt(c.req.query("limit") || "150", 10), 300);
  if (!kolId) return c.json({ error: "kol_id required" }, 400);
  const r = await c.env.DB.prepare(
    `SELECT id,text FROM tweets WHERE kol_id=? AND embedded=0 AND is_retweet=0 ORDER BY created_at_ts DESC LIMIT ?`
  )
    .bind(kolId, limit)
    .all();
  const rows = (r.results || []) as any[];
  if (!rows.length) return c.json({ ok: true, embedded: 0, remaining: 0 });
  const vecs = await embedBatch(c.env, rows.map((x) => x.text));
  const stmt = c.env.DB.prepare(`UPDATE tweets SET embedding=?, embedded=1 WHERE id=?`);
  const batch: D1PreparedStatement[] = [];
  let n = 0;
  rows.forEach((row, i) => {
    if (vecs[i]) {
      batch.push(stmt.bind(JSON.stringify(vecs[i]), row.id));
      n++;
    }
  });
  if (batch.length) await c.env.DB.batch(batch);
  const rem = await c.env.DB.prepare(
    `SELECT COUNT(*) c FROM tweets WHERE kol_id=? AND embedded=0 AND is_retweet=0`
  )
    .bind(kolId)
    .first<{ c: number }>();
  return c.json({ ok: true, embedded: n, remaining: rem?.c ?? 0 });
});

app.get("/api/admin/stats", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const t = await c.env.DB.prepare(`SELECT kol_id, COUNT(*) n, SUM(embedded) emb FROM tweets GROUP BY kol_id`).all();
  const k = await c.env.DB.prepare(`SELECT kol_id, COUNT(*) n FROM knowledge_chunks GROUP BY kol_id`).all();
  const s = await c.env.DB.prepare(`SELECT * FROM sync_state`).all();
  return c.json({ tweets: t.results, knowledge: k.results, sync_state: s.results });
});

app.get("/research", (c) => {
  const url = new URL(c.req.url);
  url.pathname = "/research.html";
  return c.env.ASSETS.fetch(new Request(url, c.req.raw));
});

app.post("/api/admin/ingest", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const embedLimit = Math.min(parseInt(c.req.query("embed_limit") || "0", 10), 50);
  c.executionCtx.waitUntil(runDailyIngest(c.env, { embedLimit }));
  return c.json({ ok: true, scheduled: true, embedLimit });
});

app.post("/api/admin/persona-refresh", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const updated = await runWeeklyPersonaRefresh(c.env);
  return c.json({ ok: true, updated });
});

// Human-facing KOL research-room routes. Static Assets' SPA fallback would otherwise
// return the landing page for these deep links.
app.get("/kol/:persona", (c) => {
  const url = new URL(c.req.url);
  url.pathname = "/index.html";
  return c.env.ASSETS.fetch(new Request(url, c.req.raw));
});

app.get("/kol/:persona/:section", (c) => {
  const url = new URL(c.req.url);
  url.pathname = "/index.html";
  return c.env.ASSETS.fetch(new Request(url, c.req.raw));
});

// Human-facing top-nav pages. Each maps to a static HTML file under public/.
const PAGE_ROUTES: Record<string, string> = {
  "/pricing": "/pricing.html",
  "/stock": "/stock.html",
  "/macro": "/macro.html",
  "/briefings": "/briefings.html",
  "/today": "/briefings.html",
  "/morning": "/briefings.html",
  "/for-you": "/for-you.html",
  "/watchlist": "/for-you.html",
};
for (const [route, file] of Object.entries(PAGE_ROUTES)) {
  app.get(route, (c) => {
    const url = new URL(c.req.url);
    url.pathname = file;
    return c.env.ASSETS.fetch(new Request(url, c.req.raw));
  });
}

// Static assets fallback (SPA).
app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/kol/")) {
      url.pathname = "/index.html";
      return env.ASSETS.fetch(new Request(url, req));
    }
    return app.fetch(req, env, ctx);
  },
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (event.cron === "30 9 * * 1") {
      ctx.waitUntil(runWeeklyPersonaRefresh(env));
      return;
    }
    ctx.waitUntil(runDailyIngest(env));
  },
};
