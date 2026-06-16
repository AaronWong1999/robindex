import { Hono } from "hono";
import type { Env, KolRow } from "./env";
import { getQuotesCached, getKlineCached, resolveSymbolCached } from "./finance";
import { retrieve, expandQuery } from "./rag";
import { gatherMarketData, buildMessages, maybeUpdateSummary, resolveToolPhase } from "./chat";
import { getKolUniverse } from "./entities";
import { getStockNews, getMarketNews } from "./marketdata";
import { runDailyIngest, runWeeklyPersonaRefresh } from "./ingest";
import { generatePersonaPack, evolvePersona } from "./persona-gen";
import {
  getSectorBlocks, getFundFlowMinute, getDragonTiger, getLockupExpiry,
  getIndustryRanking, getMarginTrading, getStockInfo, getResearchReports,
} from "./eastmoney-astock";
import {
  getFinancialStatements, getKeyIndicators, getAnalystData,
  getMarketRanking, getSecFilings, getSinaKline,
} from "./eastmoney-global";

const app = new Hono<{ Bindings: Env }>();

const DEFAULT_PERSONA = (k: KolRow) =>
  `Identity: ${k.display_name} (@${k.handle}).\nTone: direct, data-driven finance commentator.\n` +
  `Methodology: reason from price action, fundamentals, and macro context.\nTaboos: no fabricated numbers; no guarantees.`;

function stripToolCallDSL(text: string): string {
  return text
    .replace(/<\s*[｜|]?\s*DSML\s*[｜|]?\s*tool_calls\s*>\s*[\s\S]*?<\s*\/\s*[｜|]?\s*DSML\s*[｜|]?\s*tool_calls\s*>/gi, "")
    .replace(/<\s*[｜|]?\s*DSML\s*[｜|]?\s*\/?\s*tool_calls?\s*>\s*/gi, "")
    .replace(/<\s*\/?\s*(?:invoke|function|parameter|tool_calls?)\b[^>]*>\s*/gi, "")
    .replace(/^\s*[<＜]\s*[｜|]?\s*DSML\s*[｜|]?\s*(?:tool_calls?|invoke|parameter|function).*$/gim, "")
    .replace(/^\s*[<＜]\s*\/\s*[｜|]?\s*DSML\s*[｜|]?.*$/gim, "");
}

function normalizeCitationBrackets(text: string): string {
  return text.replace(/【\s*(T\d+)\s*】/g, "[$1]");
}

function createDSLStreamCleaner() {
  let pending = "";
  let inDslBlock = false;
  const MAX_PENDING = 512;

  const cleanComplete = (input: string): string => {
    let text = input;
    let out = "";
    while (text) {
      if (inDslBlock) {
        const close = text.search(/<\s*\/\s*[｜|]?\s*DSML\s*[｜|]?\s*tool_calls\s*>/i);
        if (close < 0) return out;
        const rest = text.slice(close);
        const closeMatch = rest.match(/^<\s*\/\s*[｜|]?\s*DSML\s*[｜|]?\s*tool_calls\s*>/i);
        text = rest.slice(closeMatch?.[0].length || 0);
        inDslBlock = false;
        continue;
      }

      const open = text.search(/<\s*[｜|]?\s*DSML\s*[｜|]?\s*tool_calls\s*>/i);
      if (open < 0) {
        out += stripToolCallDSL(text);
        break;
      }
      out += stripToolCallDSL(text.slice(0, open));
      const rest = text.slice(open);
      const openMatch = rest.match(/^<\s*[｜|]?\s*DSML\s*[｜|]?\s*tool_calls\s*>/i);
      text = rest.slice(openMatch?.[0].length || 0);
      inDslBlock = true;
    }
    return out;
  };

  return {
    push(chunk: string): string {
      pending += chunk;
      const keepFrom = Math.max(
        pending.lastIndexOf("<"),
        pending.lastIndexOf("＜"),
        pending.lastIndexOf("<｜DSML"),
        pending.lastIndexOf("<|DSML")
      );
      const keep = keepFrom >= 0 && pending.length - keepFrom < MAX_PENDING ? pending.slice(keepFrom) : "";
      const complete = keep ? pending.slice(0, -keep.length) : pending;
      pending = keep;
      return cleanComplete(complete);
    },
    flush(): string {
      const out = cleanComplete(pending);
      pending = "";
      return out;
    },
    cleanAll(text: string): string {
      pending = "";
      inDslBlock = false;
      return cleanComplete(text);
    },
  };
}

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

// News for a symbol (?q=/?code=) and/or market/macro fast-news (?market=1).
app.get("/api/news", async (c) => {
  const q = c.req.query("q") || c.req.query("code");
  const n = Math.min(parseInt(c.req.query("limit") || "8", 10), 20);
  const out: any = { stock: [], market: [] };
  if (q) {
    const hit = await resolveSymbolCached(c.env.CACHE, q);
    if (hit) out.stock = await getStockNews(c.env, hit, n);
  }
  if (!q || c.req.query("market")) out.market = await getMarketNews(c.env, n);
  return c.json(out);
});

app.get("/api/macro", async (c) => {
  const n = Math.min(parseInt(c.req.query("limit") || "12", 10), 30);
  return c.json({ news: await getMarketNews(c.env, n) });
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

// ---- Extended data endpoints (from a-stock-data + global-stock-data) ----

app.get("/api/sectors", async (c) => {
  const code = c.req.query("code");
  if (!code) return c.json({ error: "provide ?code= (e.g. sh600519)" }, 400);
  return c.json(await getSectorBlocks(c.env.CACHE, code));
});

app.get("/api/fund-flow", async (c) => {
  const code = c.req.query("code");
  if (!code) return c.json({ error: "provide ?code= (e.g. sh600519)" }, 400);
  return c.json({ code, flow: await getFundFlowMinute(c.env.CACHE, code) });
});

app.get("/api/dragon-tiger", async (c) => {
  const code = c.req.query("code");
  if (!code) return c.json({ error: "provide ?code= (e.g. sz002475)" }, 400);
  return c.json(await getDragonTiger(c.env.CACHE, code, c.req.query("date") || undefined));
});

app.get("/api/lockup", async (c) => {
  const code = c.req.query("code");
  if (!code) return c.json({ error: "provide ?code=" }, 400);
  return c.json(await getLockupExpiry(c.env.CACHE, code));
});

app.get("/api/industry", async (c) => {
  const top = Math.min(parseInt(c.req.query("top") || "20", 10), 50);
  return c.json(await getIndustryRanking(c.env.CACHE, top));
});

app.get("/api/margin", async (c) => {
  const code = c.req.query("code");
  if (!code) return c.json({ error: "provide ?code=" }, 400);
  const limit = Math.min(parseInt(c.req.query("limit") || "30", 10), 100);
  return c.json({ code, margin: await getMarginTrading(c.env.CACHE, code, limit) });
});

app.get("/api/stock-info", async (c) => {
  const code = c.req.query("code");
  if (!code) return c.json({ error: "provide ?code=" }, 400);
  return c.json(await getStockInfo(c.env.CACHE, code));
});

app.get("/api/reports", async (c) => {
  const code = c.req.query("code");
  if (!code) return c.json({ error: "provide ?code=" }, 400);
  const limit = Math.min(parseInt(c.req.query("limit") || "20", 10), 100);
  return c.json({ code, reports: await getResearchReports(c.env.CACHE, code, limit) });
});

app.get("/api/financials", async (c) => {
  const code = c.req.query("code");
  if (!code) return c.json({ error: "provide ?code= (e.g. usAAPL)" }, 400);
  const stmt = (c.req.query("type") || "income") as "balance" | "income" | "cashflow";
  const periods = Math.min(parseInt(c.req.query("periods") || "4", 10), 12);
  return c.json({ code, statement: stmt, data: await getFinancialStatements(c.env.CACHE, code, stmt, periods) });
});

app.get("/api/key-indicators", async (c) => {
  const code = c.req.query("code");
  if (!code) return c.json({ error: "provide ?code= (e.g. usAAPL)" }, 400);
  return c.json({ code, indicators: await getKeyIndicators(c.env.CACHE, code) });
});

app.get("/api/analyst", async (c) => {
  const code = c.req.query("code");
  if (!code) return c.json({ error: "provide ?code= (e.g. usAAPL)" }, 400);
  return c.json(await getAnalystData(c.env.CACHE, code));
});

app.get("/api/market-ranking", async (c) => {
  const market = c.req.query("market") || "us_nasdaq";
  const sortMap: Record<string, string> = { change_pct: "f3", volume: "f5", amount: "f6" };
  const sort = sortMap[c.req.query("sort") || "change_pct"] || "f3";
  const limit = Math.min(parseInt(c.req.query("limit") || "20", 10), 50);
  return c.json(await getMarketRanking(c.env.CACHE, market, sort, limit));
});

app.get("/api/sec-filings", async (c) => {
  const symbol = c.req.query("symbol");
  if (!symbol) return c.json({ error: "provide ?symbol= (e.g. AAPL)" }, 400);
  return c.json(await getSecFilings(c.env.CACHE, symbol, c.req.query("form") || undefined));
});

app.get("/api/kline-sina", async (c) => {
  const symbol = c.req.query("symbol");
  if (!symbol) return c.json({ error: "provide ?symbol= (e.g. AAPL)" }, 400);
  const num = Math.min(parseInt(c.req.query("num") || "120", 10), 500);
  return c.json({ symbol, kline: await getSinaKline(c.env.CACHE, symbol, num) });
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

  // History (bounded) — take last 6 raw + check for tool call memory.
  const hist = await c.env.DB.prepare(
    `SELECT role,content,tool_calls FROM messages WHERE conversation_id=? ORDER BY created_at DESC LIMIT 20`
  )
    .bind(convId)
    .all();
  const allMsgs = ((hist.results || []) as any[]).reverse();
  const history = allMsgs.map((m) => ({ role: m.role as string, content: m.content as string }));

  // Tool call memory: collect recent tool call summaries for context injection
  const prevToolCalls: string[] = [];
  for (const m of allMsgs) {
    if (m.tool_calls) {
      try {
        const tc = JSON.parse(m.tool_calls);
        if (Array.isArray(tc)) {
          for (const call of tc) {
            if (call.result_summary) prevToolCalls.push(`[${call.tool}] ${call.result_summary.slice(0, 100)}`);
          }
        }
      } catch {}
    }
  }

  // Rolling long-term memory: inject the summary of earlier (truncated) turns, if any.
  const conv = await c.env.DB.prepare(`SELECT summary FROM conversations WHERE id=?`)
    .bind(convId)
    .first<{ summary: string | null }>();

  // Save user message.
  await c.env.DB.prepare(
    `INSERT INTO messages (id,conversation_id,role,content) VALUES (?,?,?,?)`
  )
    .bind(crypto.randomUUID(), convId, "user", body.message)
    .run();

  // ---- True streaming: start SSE immediately, do preprocessing inside the stream ----
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (evt: string, data: any) =>
        controller.enqueue(encoder.encode(`event: ${evt}\ndata: ${JSON.stringify(data)}\n\n`));

      try {
        // Step 1: Market data gathering
        send("progress", { phase: "market", text: "正在识别标的、获取实时行情…" });
        const kolUniverse = await getKolUniverse(c.env, kol.id);
        const market = await gatherMarketData(c.env, body.message, { kolUniverse });
        const tickers = market.quotes.map((q) => q.symbol);

        // Step 2: LLM query expansion (bridges semantic gap between user language and KOL vocabulary)
        send("progress", { phase: "rag", text: "正在理解问题并扩展搜索关键词…" });
        const expandedTerms = await expandQuery(c.env, model, body.message, tickers);

        // Step 3: RAG retrieval
        send("progress", { phase: "rag", text: "正在检索相关历史原文…" });
        const { citations, knowledge } = await retrieve(c.env, kol.id, kol.handle, body.message, tickers, expandedTerms);

        const messages = buildMessages({
          kol,
          persona: kol.persona_pack || DEFAULT_PERSONA(kol),
          knowledge,
          citations,
          market,
          history,
          userMessage: body.message,
          summary: conv?.summary || undefined,
          toolMemory: prevToolCalls.length ? prevToolCalls.slice(0, 8).join("\n") : undefined,
        });

        // Step 4: Tool phase (shared helper, best effort)
        send("progress", { phase: "tools", text: "正在调用工具获取深度数据…" });
        const toolPhase = await resolveToolPhase(c.env, model, messages, (evt) => {
          if (evt.type === "progress") send("progress", { phase: "tools", text: evt.text || "正在分析数据…" });
          if (evt.type === "tool_call") {
            send("progress", { phase: "tools", text: `工具: ${evt.name || "unknown"}` });
            send("tool_call", { name: evt.name || "unknown", args: evt.args || "" });
          }
        });
        const toolMsgs: any[] = toolPhase.messages;
        const toolCalls = toolPhase.toolCalls;

        const finalMessages = [
          ...toolMsgs,
          {
            role: "user",
            content:
              "现在直接输出给用户看的最终分析。严禁输出任何工具调用、DSML、XML/HTML-like invoke/parameter/tool_calls 标签；" +
              "不要说你要调用工具。请用中文，按“主矛盾 / 四个维度 / 打脸指标 / 风险边界”的结构回答。" +
              "所有原文引用必须写成方括号格式，例如 [T1]、[T4]，不要写成 T1 或 #1。" +
              "如果问题涉及流动性、利率、美债、风险资产，优先围绕 SOURCE TWEETS 里的 RRP、TGA、SOFR、SRF、商业银行准备金、回购钱荒、联储购债扩表框架展开；" +
              "除非用户明确问油价或地缘冲突，否则油价、地缘新闻和单个当日行情只能作为次要背景，不要抢走主线。",
          },
        ];

        // Step 4: Stream final LLM response
        send("progress", { phase: "thinking", text: "正在生成回复…" });
        const upstream = await fetch(c.env.GATEWAY_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "cf-aig-authorization": `Bearer ${c.env.CFGATEWAYKEY}`,
            ...(c.env.OPENROUTER_KEY ? { Authorization: `Bearer ${c.env.OPENROUTER_KEY}` } : {}),
            "HTTP-Referer": "https://robindex.ai",
            "X-Title": "Robindex",
          },
          body: JSON.stringify({ model, messages: finalMessages, stream: true, temperature: 0.6 }),
        });

        if (!upstream.ok || !upstream.body) {
          send("error", { status: upstream.status });
          controller.close();
          return;
        }

        // Send meta (citations + chart info) before streaming text
        send("meta", {
          citations,
          chart: market.primary ? { code: market.primary.code, symbol: market.primary.symbol, market: market.primary.market } : null,
        });

        const reader = upstream.body!.getReader();
        let buf = "";
        let full = "";
        const dslCleaner = createDSLStreamCleaner();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop() || "";
            for (const line of lines) {
              const s = line.trim();
              if (!s.startsWith("data:")) continue;
              const payload = s.slice(5).trim();
              if (payload === "[DONE]") continue;
              try {
                const pj = JSON.parse(payload);
                const delta = pj.choices?.[0]?.delta?.content || "";
                if (delta) {
                  const clean = normalizeCitationBrackets(dslCleaner.push(delta));
                  if (clean) {
                    full += clean;
                    controller.enqueue(encoder.encode(`event: delta\ndata: ${JSON.stringify(clean)}\n\n`));
                  }
                }
              } catch {}
            }
          }
          const tail = dslCleaner.flush();
          if (tail) {
            full += tail;
            controller.enqueue(encoder.encode(`event: delta\ndata: ${JSON.stringify(tail)}\n\n`));
          }
        } catch (e) {
          send("error", { message: String(e) });
        }

        full = normalizeCitationBrackets(stripToolCallDSL(full)).trim();
        send("done", {});
        controller.close();

        // Persist (runs after stream is closed)
        const usedRefs = new Set(Array.from(full.matchAll(/(?:\[|【)\s*(T\d+)\s*(?:\]|】)/g)).map((m) => m[1]));
        const usedCitations = usedRefs.size ? citations.filter((cc) => usedRefs.has(cc.ref)) : [];
        await c.env.DB.prepare(
          `INSERT INTO messages (id,conversation_id,role,content,citations,tool_calls) VALUES (?,?,?,?,?,?)`
        )
          .bind(crypto.randomUUID(), convId!, "assistant", full, JSON.stringify(usedCitations), toolCalls.length ? JSON.stringify(toolCalls) : null)
          .run();
        await c.env.DB.prepare(`UPDATE conversations SET updated_at=datetime('now') WHERE id=?`)
          .bind(convId!)
          .run();
        await maybeUpdateSummary(c.env, convId!, model);
      } catch (e) {
        send("error", { message: String(e) });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Conversation-Id": convId!,
    },
  });
});

// ---- Follow-up question suggestions (lightweight, fast) ----
app.post("/api/suggest", async (c) => {
  const body = await c.req.json<{ kol_id: string; question: string; answer: string }>();
  if (!body.kol_id || !body.answer) return c.json({ suggestions: [] });
  const kol = await c.env.DB.prepare(`SELECT display_name,handle FROM kols WHERE id=?`).bind(body.kol_id).first<any>();
  const model = c.env.MODEL_FLASH;
  const sys = `You generate exactly 4 concise Chinese follow-up questions for a finance research assistant. Each question should dig deeper into a different angle of the analysis. Format: return ONLY a JSON array of 4 strings, no markdown. Example: ["如何量化判断毛利率出现结构性挤压？","在大厂CAPEX变动中看哪个财务指标？","怎么对比RubIn平台和之前的芯片逻辑？","为什么说H200交付是安全垫？"]`;
  const usr = `KOL: ${kol?.display_name || body.kol_id}\nUser question: ${body.question}\n\nAssistant answer (first 2000 chars):\n${body.answer.slice(0, 2000)}`;
  try {
    const res = await fetch(c.env.GATEWAY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "cf-aig-authorization": `Bearer ${c.env.CFGATEWAYKEY}`,
        ...(c.env.OPENROUTER_KEY ? { Authorization: `Bearer ${c.env.OPENROUTER_KEY}` } : {}),
        "HTTP-Referer": "https://robindex.ai",
        "X-Title": "Robindex",
      },
      body: JSON.stringify({ model, messages: [{ role: "system", content: sys }, { role: "user", content: usr }], temperature: 0.7, max_tokens: 300 }),
    });
    const j: any = await res.json();
    const text = j?.choices?.[0]?.message?.content || "";
    const arr = JSON.parse(text);
    return c.json({ suggestions: Array.isArray(arr) ? arr.slice(0, 4) : [] });
  } catch {
    return c.json({ suggestions: [] });
  }
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
  const body = await c.req.json<{ kol_id: string; tweets: any[] }>();
  const tweets = body.tweets || [];
  const stmt = c.env.DB.prepare(
    `INSERT OR IGNORE INTO tweets
     (id,kol_id,text,created_at_iso,created_at_ts,is_retweet,lang,likes,retweets,replies,quotes,views,urls,media)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const batch: D1PreparedStatement[] = [];
  tweets.forEach((t) => {
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
        JSON.stringify(t.media || [])
      )
    );
  });
  if (batch.length) await c.env.DB.batch(batch);
  return c.json({ ok: true, inserted: batch.length });
});

app.post("/api/admin/knowledge", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.json<{ kol_id: string; chunks: any[] }>();
  const chunks = body.chunks || [];
  const stmt = c.env.DB.prepare(
    `INSERT OR REPLACE INTO knowledge_chunks (id,kol_id,source,title,text)
     VALUES (?,?,?,?,?)`
  );
  const batch: D1PreparedStatement[] = [];
  chunks.forEach((k) => {
    batch.push(stmt.bind(k.id, body.kol_id, k.source, k.title || null, k.text || ""));
  });
  if (batch.length) await c.env.DB.batch(batch);
  return c.json({ ok: true, inserted: batch.length });
});

app.get("/api/admin/stats", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const t = await c.env.DB.prepare(
    `SELECT kol_id, COUNT(*) n,
            SUM(CASE WHEN is_retweet=0 THEN 1 ELSE 0 END) non_retweets,
            MIN(created_at_iso) oldest,
            MAX(created_at_iso) newest
     FROM tweets GROUP BY kol_id`
  ).all();
  const k = await c.env.DB.prepare(`SELECT kol_id, COUNT(*) n FROM knowledge_chunks GROUP BY kol_id`).all();
  const s = await c.env.DB.prepare(`SELECT * FROM sync_state`).all();
  return c.json({ tweets: t.results, knowledge: k.results, sync_state: s.results });
});

// ---- Auto-onboard: full KOL clone pipeline from just a Twitter handle ----
app.post("/api/admin/onboard", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.json<{ handle: string; display_name?: string; twitter_uid?: string }>();
  if (!body.handle) return c.json({ error: "handle required" }, 400);
  const { generatePersonaPack } = await import("./persona-gen");
  const { runDailyIngest } = await import("./ingest");
  const kolId = body.handle.toLowerCase().replace(/[^a-z0-9]/g, "");
  // Step 1: Create KOL record
  await c.env.DB.prepare(
    `INSERT OR IGNORE INTO kols (id,display_name,handle,twitter_uid,updated_at)
     VALUES (?,?,?,?,datetime('now'))`
  ).bind(kolId, body.display_name || body.handle, body.handle, body.twitter_uid || null).run();
  // Step 2: Run initial ingest. Tweets become searchable as soon as they land in D1.
  await runDailyIngest(c.env);
  // Step 3: Generate persona pack
  let personaInfo: { validation?: string[]; error?: string } = {};
  try {
    const result = await generatePersonaPack(c.env, kolId);
    await c.env.DB.prepare(
      `UPDATE kols SET persona_pack=?, persona_version='v1-auto', updated_at=datetime('now') WHERE id=?`
    ).bind(result.persona_pack, kolId).run();
    personaInfo = { validation: result.validation };
  } catch (e) {
    personaInfo = { error: String(e) };
  }
  const stats = await c.env.DB.prepare(
    `SELECT COUNT(*) total, SUM(CASE WHEN is_retweet=0 THEN 1 ELSE 0 END) non_retweets FROM tweets WHERE kol_id=?`
  ).bind(kolId).first<any>();
  return c.json({
    ok: true,
    kol_id: kolId,
    tweets: { total: stats?.total || 0, non_retweets: stats?.non_retweets || 0 },
    persona: personaInfo.validation || personaInfo.error,
  });
});

app.get("/research", (c) => {
  const url = new URL(c.req.url);
  url.pathname = "/research.html";
  return c.env.ASSETS.fetch(new Request(url, c.req.raw));
});

app.post("/api/admin/ingest", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  c.executionCtx.waitUntil(runDailyIngest(c.env));
  return c.json({ ok: true, scheduled: true });
});

app.post("/api/admin/persona-refresh", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const updated = await runWeeklyPersonaRefresh(c.env);
  return c.json({ ok: true, updated });
});

// ---- Persona Pack generation & evolution ----

app.post("/api/persona-generate", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const kolId = c.req.query("kol_id");
  if (!kolId) return c.json({ error: "kol_id required" }, 400);
  try {
    const { persona_pack, validation } = await generatePersonaPack(c.env, kolId);
    await c.env.DB.prepare(`UPDATE kols SET persona_pack=?, persona_version='v1-auto', updated_at=datetime('now') WHERE id=?`)
      .bind(persona_pack, kolId).run();
    return c.json({ ok: true, validation, pack_length: persona_pack.length });
  } catch (e: any) {
    return c.json({ error: e.message || String(e) }, 500);
  }
});

app.get("/api/persona/:kol_id", async (c) => {
  const kol = await c.env.DB.prepare(`SELECT id,display_name,handle,persona_pack,persona_version FROM kols WHERE id=?`)
    .bind(c.req.param("kol_id")).first<any>();
  if (!kol) return c.json({ error: "not found" }, 404);
  return c.json(kol);
});

app.post("/api/persona/:kol_id", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.json<{ persona_pack?: string; persona_version?: string }>();
  if (!body.persona_pack) return c.json({ error: "persona_pack required" }, 400);
  await c.env.DB.prepare(`UPDATE kols SET persona_pack=?, persona_version=?, updated_at=datetime('now') WHERE id=?`)
    .bind(body.persona_pack, body.persona_version || "manual", c.req.param("kol_id")).run();
  return c.json({ ok: true });
});

app.post("/api/persona-evolve", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const kolId = c.req.query("kol_id");
  if (!kolId) return c.json({ error: "kol_id required" }, 400);
  try {
    const result = await evolvePersona(c.env, kolId);
    return c.json(result);
  } catch (e: any) {
    return c.json({ error: e.message || String(e) }, 500);
  }
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
