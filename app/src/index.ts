import { Hono } from "hono";
import type { Env, KolRow } from "./env";
import { getQuotesCached, getKlineCached, resolveSymbolCached } from "./finance";
import { retrieve } from "./rag";
import { planQuery } from "./query-plan";
import { indexTweets, indexRawTweets } from "./tagger";
import { gatherMarketData, buildMessages, maybeUpdateSummary, resolveToolPhase } from "./chat";
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
  return text
    .replace(/【\s*(T\d+)\s*】/g, "[$1]")
    .replace(/[（(]\s*(T\d+)\s*[）)]/g, "[$1]")
    .replace(/(^|[^\[\w])\b(T\d+)\b(?!\s*[\]\w])/g, "$1[$2]");
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
    `SELECT id,text,created_at_iso,likes,retweets,replies,quotes,views,urls,quoted
     FROM tweets WHERE kol_id=? AND is_retweet=0 ORDER BY created_at_ts DESC LIMIT ? OFFSET ?`
  ).bind(kolId, limit, offset).all();
  return c.json({
    handle: k?.handle || kolId,
    total: total?.c ?? 0,
    tweets: (r.results || []).map((t: any) => ({
      ...t,
      urls: t.urls ? JSON.parse(t.urls) : [],
      quoted: t.quoted ? (() => { try { return JSON.parse(t.quoted); } catch { return null; } })() : null,
    })),
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
        // Step 1: LLM query planning — one flash call that ALSO identifies tradable instruments
        // (name + ticker) AND classifies the route (quick = corpus-only, deep = needs live data/tools).
        send("progress", { phase: "plan", text: "正在理解问题、识别标的并规划检索…" });
        const plan = await planQuery(c.env, c.env.MODEL_FLASH, body.message, []);
        // Candidates to price-check: the planner's explicit instruments FIRST, then its exact_entities as
        // fallback. flash is often unsure whether a name is tradable (e.g. a just-IPO'd SpaceX→SPCX), so
        // we let the LIVE FEED decide — gatherMarketData keeps only those that return a real quote.
        const plannedInstruments = Array.from(new Set([
          ...plan.instruments.map((i) => i.ticker || i.name).filter(Boolean),
          ...plan.exact_entities,
        ]));

        // Step 2 + 3 run CONCURRENTLY: market-data fetch and tweet retrieval+rerank are independent once we
        // have the planner's instruments. (Previously serial, which cost ~15-20s.) They share no state.
        send("progress", { phase: "market", text: "正在并行获取行情与检索原文…" });
        const [market, retrieved] = await Promise.all([
          gatherMarketData(c.env, body.message, { extraInstruments: plannedInstruments }),
          (async () => {
            const mode = (kol.retrieval_mode === "tagged" ? "tagged" : "query_side") as "tagged" | "query_side";
            // Pass the planner's instrument guesses (validated tickers aren't resolved yet — market-data
            // runs concurrently); retrieve also tokenizes the raw query for ticker-ish terms. The planner's
            // exact_entities (which already contain these guesses) drive the FTS routes.
            return retrieve(
              c.env, kol.id, kol.handle, body.message, plannedInstruments, plan, c.env.MODEL_FLASH, mode, kol.corpus_id || kol.id
            );
          })(),
        ]);
        const tickers = market.quotes.map((q) => q.symbol);
        // Fold the validated tickers back into the plan so any downstream consumer matches them too.
        for (const t of tickers) if (t && !plan.exact_entities.includes(t)) plan.exact_entities.push(t);
        const { citations, knowledge } = retrieved;

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

        // Send meta (citations + chart info) EARLY — right after retrieval, before the (optional) tool
        // phase. This populates the right-side 原文支持 panel while the answer streams, dramatically
        // improving perceived latency. (Previously meta was sent after the ~35s tool phase.)
        send("meta", {
          citations,
          chart: market.primary ? { code: market.primary.code, symbol: market.primary.symbol, market: market.primary.market } : null,
        });

        // Step 4: Tool phase — ONLY when the planner flagged needs_tools (route=deep). The quick route
        // (viewpoint/framework/verify questions) is answered from the corpus + the pre-fetched quote/kline
        // already injected into LIVE MARKET DATA, so we skip the tool LLM rounds entirely (saves ~35s).
        let toolMsgs: any[] = messages;
        let toolCalls: { tool: string; args: Record<string, any>; result_summary: string }[] = [];
        if (plan.needs_tools) {
          send("progress", { phase: "tools", text: "正在调用工具获取深度数据…" });
          const toolRounds = plan.route === "quick" ? 1 : market.primary ? 1 : 2;
          const toolPhase = await resolveToolPhase(c.env, model, messages, (evt) => {
            if (evt.type === "progress") send("progress", { phase: "tools", text: evt.text || "正在分析数据…" });
            if (evt.type === "tool_call") {
              send("progress", { phase: "tools", text: `工具: ${evt.name || "unknown"}` });
              send("tool_call", { name: evt.name || "unknown", args: evt.args || "" });
            }
          }, toolRounds);
          toolMsgs = toolPhase.messages;
          toolCalls = toolPhase.toolCalls;
        }

        const finalMessages = [
          ...toolMsgs,
          {
            role: "user",
            content:
              "现在直接输出给用户看的最终分析。严禁输出任何工具调用或 DSL 标签；不要说你要调用工具。\n" +
              "请用中文回答。保持你（博主）一贯的语气、分析框架和表达风格，像在回复读者的提问一样自然地写。\n" +
              "引用写成 [T1] 格式。自然地融入原文引用，不要刻意分段或加小标题。\n" +
              "缺数据明说，不要编。",
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

// ---- FTS5 search index ----
// Two passes, both driven by scripts/build_search_index.mjs in a loop until remaining=0:
//   mode=raw  → write original text into tweet_search with empty tags (NO LLM). Fast; makes a KOL
//               searchable/citable in minutes. Selection key: not yet in tweet_search.
//   (default) → LLM-tag untagged tweets and fill the tag columns. Slow; the quality/recall layer.
//               Selection key: no tweet_tags row yet. ?full=1 wipes + rebuilds this KOL once.
app.post("/api/admin/reindex", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const kolId = c.req.query("kol_id");
  if (!kolId) return c.json({ error: "kol_id required" }, 400);
  const mode = c.req.query("mode") === "raw" ? "raw" : "tag";
  const batch = Math.min(parseInt(c.req.query("batch") || "60", 10), 200);
  const full = c.req.query("full") === "1";
  // Sharding: run N parallel drivers with shards=N & shard=0..N-1. Each shard owns a disjoint set of
  // tweet ids (id % N == shard), so parallel backfill never double-tags or races the FTS writes.
  const shards = Math.max(1, Math.min(parseInt(c.req.query("shards") || "1", 10), 16));
  const shard = Math.max(0, Math.min(parseInt(c.req.query("shard") || "0", 10), shards - 1));
  // full=1 clears this KOL once (only shard 0 clears, to avoid wiping peers' just-written rows).
  if (full && shard === 0 && mode === "tag") {
    await c.env.DB.prepare(`DELETE FROM tweet_search WHERE kol_id=?`).bind(kolId).run();
    await c.env.DB.prepare(`DELETE FROM tweet_tags WHERE kol_id=?`).bind(kolId).run();
  }
  const shardClause = shards > 1 ? `AND (abs(CAST(t.id AS INTEGER) % ?) = ?)` : "";
  // raw pass keys off tweet_search membership; tag pass keys off tweet_tags membership.
  // IMPORTANT: bind kol_id as a CONSTANT in the subquery (not correlated to t.kol_id). A correlated
  // subquery against the FTS5 virtual table re-scans it per outer row → D1 500s at scale.
  const missingClause =
    mode === "raw"
      ? `AND t.id NOT IN (SELECT tweet_id FROM tweet_search WHERE kol_id=?)`
      : `AND t.id NOT IN (SELECT tweet_id FROM tweet_tags WHERE kol_id=?)`;
  // bind order: t.kol_id, subquery kol_id, [shards, shard], LIMIT
  const sel: any[] = [kolId, kolId];
  if (shards > 1) sel.push(shards, shard);
  sel.push(batch);
  const rows = await c.env.DB.prepare(
    `SELECT t.id, t.text FROM tweets t
     WHERE t.kol_id=? AND t.is_retweet=0 ${missingClause} ${shardClause}
     ORDER BY t.created_at_ts DESC LIMIT ?`
  ).bind(...sel).all();
  const items = ((rows.results || []) as any[]).map((r) => ({ id: String(r.id), text: String(r.text || "") }));
  const indexed = items.length
    ? mode === "raw"
      ? await indexRawTweets(c.env, kolId, items)
      : await indexTweets(c.env, kolId, c.env.MODEL_FLASH, items)
    : 0;
  const rem: any[] = [kolId, kolId];
  if (shards > 1) rem.push(shards, shard);
  const remaining = await c.env.DB.prepare(
    `SELECT COUNT(*) c FROM tweets t
     WHERE t.kol_id=? AND t.is_retweet=0 ${missingClause} ${shardClause}`
  ).bind(...rem).first<{ c: number }>();
  return c.json({ ok: true, kol_id: kolId, mode, shard, shards, indexed, remaining: remaining?.c ?? 0 });
});

// ---- Paid re-fetch of quoted-tweet content (GetXAPI) for EXISTING history ----
// Budget-controlled: each call pages `pages` times from `cursor`, only UPDATEs rows we already have
// (never inserts), and returns next_cursor so a driver can paginate + stop. Drive from a script and
// watch the GetXAPI balance. New tweets already capture quoted natively via ingest.
app.post("/api/admin/refetch-quotes", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const kolId = c.req.query("kol_id");
  if (!kolId) return c.json({ error: "kol_id required" }, 400);
  if (!c.env.GETXAPI_KEY) return c.json({ error: "GETXAPI_KEY not set" }, 400);
  const kol = await c.env.DB.prepare(`SELECT twitter_uid, handle FROM kols WHERE id=?`).bind(kolId).first<any>();
  if (!kol?.twitter_uid) return c.json({ error: "kol has no twitter_uid" }, 400);
  const pages = Math.min(parseInt(c.req.query("pages") || "5", 10), 15);
  let cursor = c.req.query("cursor") || "";
  let scanned = 0, withQuote = 0, updated = 0, hasMore = false;
  for (let p = 0; p < pages; p++) {
    const url = new URL("https://api.getxapi.com/twitter/user/tweets");
    url.searchParams.set("userId", String(kol.twitter_uid));
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${c.env.GETXAPI_KEY}` } });
    if (!res.ok) return c.json({ ok: false, error: `getxapi ${res.status}`, updated, scanned, withQuote, next_cursor: cursor, has_more: false });
    const json: any = await res.json().catch(() => null);
    const tweets: any[] = json?.tweets || [];
    const stmts: D1PreparedStatement[] = [];
    for (const t of tweets) {
      if (String(t.author?.userName || "").toLowerCase() !== String(kol.handle).toLowerCase()) continue;
      scanned++;
      const q = t.quoted_tweet;
      if (!q || !(q.text || q.full_text)) continue;
      withQuote++;
      const u = q.user || {};
      const handle = u.screen_name || u.userName || "";
      const qid = String(q.id || "");
      const quoted = JSON.stringify({
        id: qid, text: q.text || q.full_text || "", handle, name: u.name || "",
        url: handle && qid ? `https://x.com/${handle}/status/${qid}` : "",
      });
      stmts.push(c.env.DB.prepare(`UPDATE tweets SET quoted=? WHERE id=? AND kol_id=?`).bind(quoted, String(t.id), kolId));
    }
    if (stmts.length) { await c.env.DB.batch(stmts); updated += stmts.length; }
    hasMore = !!json?.has_more;
    cursor = json?.next_cursor || "";
    if (!hasMore || !cursor || !tweets.length) break;
  }
  return c.json({ ok: true, kol_id: kolId, scanned, withQuote, updated, next_cursor: cursor, has_more: hasMore });
});

// ---- Self-serve onboarding: cost estimate (step 1 of the KOL marketplace flow) ----
// Given a Twitter handle/uid, estimate tweet count and the one-time cost to clone the KOL, so we can
// quote the KOL a price before spending. Money figures use the RATES below — tune to real provider
// pricing. "go_live" = ingest + persona only (raw-index makes them searchable with NO LLM); the tag
// layer is async/optional, billed separately.
app.get("/api/admin/estimate", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const uid = c.req.query("uid") || "";
  const handle = c.req.query("handle") || "";
  let count = parseInt(c.req.query("count") || "0", 10);
  let countSource = count ? "param" : "unknown";
  // Best-effort: read the account's total tweet count cheaply (one GetXAPI page → author block).
  if (!count && uid && c.env.GETXAPI_KEY) {
    try {
      const url = new URL("https://api.getxapi.com/twitter/user/tweets");
      url.searchParams.set("userId", uid);
      const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${c.env.GETXAPI_KEY}` } });
      if (res.ok) {
        const j: any = await res.json();
        const a = j?.tweets?.[0]?.author || {};
        const cand = a.statusesCount ?? a.tweetsCount ?? a.statuses_count ?? a.tweet_count;
        if (cand) { count = Number(cand); countSource = "getxapi_author"; }
      }
    } catch {}
  }
  // USD rates — placeholders, tune to actual provider pricing (X scrape per 1k, DeepSeek per 1M tokens).
  const RATES = { X_PER_1K: 0.20, FLASH_IN_PER_M: 0.10, FLASH_OUT_PER_M: 0.30, PRO_IN_PER_M: 0.40, PRO_OUT_PER_M: 1.20 };
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const tagCalls = Math.ceil(count / 16);
  const ingest_usd = (count / 1000) * RATES.X_PER_1K;
  const persona_usd = (13000 / 1e6) * RATES.PRO_IN_PER_M + (4800 / 1e6) * RATES.PRO_OUT_PER_M;
  const tag_usd = (tagCalls * 1840 / 1e6) * RATES.FLASH_IN_PER_M + (tagCalls * 1600 / 1e6) * RATES.FLASH_OUT_PER_M;
  return c.json({
    handle, uid, estimated_tweets: count, count_source: countSource, rates: RATES,
    breakdown_usd: { ingest: r2(ingest_usd), persona: r2(persona_usd), tagging: r2(tag_usd) },
    go_live_usd: r2(ingest_usd + persona_usd),         // searchable + persona, NO tag LLM in the path
    full_index_usd: r2(ingest_usd + persona_usd + tag_usd),
    note: count ? "estimate" : "pass ?count=N or ?uid= (GetXAPI) to compute",
  });
});

app.get("/api/admin/search-stats", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const tweets = await c.env.DB.prepare(
    `SELECT kol_id, COUNT(*) n FROM tweets WHERE is_retweet=0 GROUP BY kol_id`
  ).all();
  const tagged = await c.env.DB.prepare(`SELECT kol_id, COUNT(*) n FROM tweet_tags GROUP BY kol_id`).all();
  const indexed = await c.env.DB.prepare(`SELECT kol_id, COUNT(*) n FROM tweet_search GROUP BY kol_id`).all();
  return c.json({ tweets: tweets.results, tagged: tagged.results, indexed: indexed.results });
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
  // Run generation in background (avoids Worker execution time limit)
  c.executionCtx.waitUntil(
    (async () => {
      try {
        const { persona_pack, validation } = await generatePersonaPack(c.env, kolId);
        if (persona_pack.length < 500) {
          console.log(`persona-gen ${kolId}: pack too short (${persona_pack.length}), keeping existing`);
          return;
        }
        const current = await c.env.DB.prepare(`SELECT persona_pack, persona_version FROM kols WHERE id=?`).bind(kolId).first<any>();
        if (current?.persona_pack && current.persona_pack.length > 100) {
          const backupId = `${kolId}:persona_backup:${new Date().toISOString().slice(0, 10)}:${Date.now()}`;
          await c.env.DB.prepare(
            `INSERT OR REPLACE INTO knowledge_chunks (id,kol_id,source,title,text) VALUES (?,?,?,?,?)`
          ).bind(backupId, kolId, `persona_backup:${current.persona_version || "unknown"}`, `Persona backup ${new Date().toISOString().slice(0, 10)}`, current.persona_pack).run();
        }
        await c.env.DB.prepare(`UPDATE kols SET persona_pack=?, persona_version='v1-auto', updated_at=datetime('now') WHERE id=?`)
          .bind(persona_pack, kolId).run();
        console.log(`persona-gen ${kolId}: success, ${persona_pack.length} chars`);
      } catch (e) {
        console.log(`persona-gen ${kolId} error: ${e}`);
      }
    })()
  );
  return c.json({ ok: true, message: "Generation started in background. Poll GET /api/persona/:kol_id to check." });
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
  // Backup current pack before overwriting
  const current = await c.env.DB.prepare(`SELECT persona_pack, persona_version FROM kols WHERE id=?`).bind(c.req.param("kol_id")).first<any>();
  if (current?.persona_pack && current.persona_pack.length > 100) {
    const backupId = `${c.req.param("kol_id")}:persona_backup:${new Date().toISOString().slice(0, 10)}:${Date.now()}`;
    await c.env.DB.prepare(
      `INSERT OR REPLACE INTO knowledge_chunks (id,kol_id,source,title,text) VALUES (?,?,?,?,?)`
    ).bind(backupId, c.req.param("kol_id"), `persona_backup:${current.persona_version || "unknown"}`, `Persona backup ${new Date().toISOString().slice(0, 10)}`, current.persona_pack).run();
  }
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
