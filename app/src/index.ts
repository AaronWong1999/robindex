import { Hono } from "hono";
import type { Env, KolRow } from "./env";
import { getQuotesCached, getKlineCached, resolveSymbolCached } from "./finance";
import { retrieve } from "./rag";
import { planQuery, type QueryPlan } from "./query-plan";
import { indexTweets, indexRawTweets } from "./tagger";
import { gatherMarketData, buildMessages, maybeUpdateSummary, resolveToolPhase, type MarketData } from "./chat";
import { getStockNews, getMarketNews } from "./marketdata";
import { runDailyIngest, runWeeklyPersonaRefresh } from "./ingest";
import { generatePersonaPack, evolvePersona, diagnosePersonaGeneration, logPersonaExperiment } from "./persona-gen";
import { buildEvalSet, runEval, autoRollback, evalAndMaybeRollback } from "./eval";
import { distillPersonaFull, distillPersonaIncremental, mapStage, reduceStage, reduceGroup, reduceFinal, reduceFinalDraft, finalizeMerged, renderMergedPack, refineVoice } from "./persona-distill";
import {
  getSectorBlocks, getFundFlowMinute, getDragonTiger, getLockupExpiry,
  getIndustryRanking, getMarginTrading, getStockInfo, getResearchReports,
} from "./eastmoney-astock";
import {
  getFinancialStatements, getKeyIndicators, getAnalystData,
  getMarketRanking, getSecFilings, getSinaKline,
} from "./eastmoney-global";

const app = new Hono<{ Bindings: Env }>();

const APP_HOST = "app.robindex.ai";

const NEWS_OR_EVENT_INTENT = /(news|headline|happening|新闻|消息|资讯|事件|最近|发生|利好|利空|政策|财报)/i;
const PROFILE_INTENT = /(估值|财务|基本面|pe|pb|peg|roe|margin|revenue|profit|earnings|valuation|fundamental|financial)/i;
const INTRADAY_OR_TECH_INTENT = /(盘中|分钟|分时|日内|技术位|支撑|压力|k线|k-line|intraday|minute|technical|support|resistance)/i;
const CURRENT_MARKET_INTENT = /(现在|今天|今日|当前|能不能买|可以买|该不该买|要不要买|买入|卖出|加仓|减仓|仓位|now|today|buy|sell|position)/i;

export function shouldRunToolPhase(plan: QueryPlan, market: MarketData, message: string, plannedInstruments: string[]): boolean {
  if (!plan.needs_tools) return false;

  const hasPlannedInstrument = plannedInstruments.some(Boolean) || plan.instruments.length > 0;
  const hasQuote = market.quotes.length > 0 && !!market.primary;
  const hasDailyKline = !!market.klineText.trim();
  const hasProfile = !!market.extraContext.trim();
  const asksNews = NEWS_OR_EVENT_INTENT.test(message);
  const asksProfile = PROFILE_INTENT.test(message);
  const asksIntradayOrTech = INTRADAY_OR_TECH_INTENT.test(message);
  const asksCurrentMarket = CURRENT_MARKET_INTENT.test(message);

  if (hasPlannedInstrument && !hasQuote) return true;
  if (asksNews && market.news.length === 0) return true;
  if (asksProfile && !hasProfile) return true;
  if (asksIntradayOrTech && !hasDailyKline) return true;
  if (!market.primary && asksCurrentMarket) return true;

  const prefetchCoversDeepStockQuestion =
    hasQuote &&
    hasDailyKline &&
    hasProfile &&
    (!asksNews || market.news.length > 0);
  if (prefetchCoversDeepStockQuestion) return false;

  return !market.primary;
}

function requestHost(req: Request): string {
  return new URL(req.url).hostname.toLowerCase();
}

function isAppHost(host: string): boolean {
  return host === APP_HOST;
}

function isMarketingHost(host: string): boolean {
  return host === "robindex.ai" || host === "www.robindex.ai";
}

function serveDesk(c: { req: { url: string; raw: Request }; env: Env }): Response | Promise<Response> {
  const url = new URL(c.req.url);
  url.pathname = "/desk.html";
  return c.env.ASSETS.fetch(new Request(url, c.req.raw));
}

function redirectToApp(req: Request): Response {
  const src = new URL(req.url);
  const dest = new URL(req.url);
  dest.hostname = APP_HOST;
  if (src.pathname === "/desk") dest.pathname = "/";
  return Response.redirect(dest.toString(), 302);
}

/** True when the path should be served as a static file, not the Desk SPA shell. */
function isStaticAssetPath(pathname: string): boolean {
  if (pathname.startsWith("/app/")) return true;
  if (pathname === "/landing-static.js") return true;
  if (/\.(html|css|js|jsx|mjs|json|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|txt|map)$/i.test(pathname)) return true;
  return false;
}

function isDeskSpaPath(pathname: string): boolean {
  if (pathname.startsWith("/api/")) return false;
  return !isStaticAssetPath(pathname);
}

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
    .replace(/【\s*T?(\d+)\s*】/gi, "[$1]")
    .replace(/\[\s*T(\d+)\s*\]/gi, "[$1]")
    .replace(/[（(]\s*T(\d+)\s*[）)]/gi, "[$1]")
    .replace(/(^|[^\[\w])\bT(\d+)\b(?!\s*[\]\w])/gi, "$1[$2]");
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

app.get("/api/config", async (c) => {
  return c.json({
    privyAppId: c.env.PRIVY_APP_ID || "client-clxxyzdummyappidforlocaldev"
  });
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

        // Observability: when persona_pack is NULL the KOL silently runs on the 3-line generic
        // DEFAULT_PERSONA. Record it (once per conversation, on the first turn) so we can see how
        // often and for which KOLs distillation never produced a usable pack. Non-blocking.
        if (!kol.persona_pack && history.length === 0) {
          c.executionCtx.waitUntil(
            logPersonaExperiment(c.env, kol.id, {
              content: "", finish_reason: "fallback",
              content_len: 0, duration_ms: 0, parse_ok: false,
              error_type: null, note: `chat used DEFAULT_PERSONA (no persona_pack); conv=${convId}`,
            }, 0, "chat_fallback"),
          );
        }

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

        // Step 4: Tool phase — run the LLM tool chooser only when the planner needs live data AND the
        // deterministic prefetch did not already cover the requested quote/news/profile/kline context.
        // The common stock case is answered from SOURCE TWEETS + LIVE MARKET DATA with no extra tool LLM.
        let toolMsgs: any[] = messages;
        let toolCalls: { tool: string; args: Record<string, any>; result_summary: string }[] = [];
        if (shouldRunToolPhase(plan, market, body.message, plannedInstruments)) {
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
              "引用写成 [1]、[2] 这种纯数字格式。自然地融入原文引用，不要刻意分段或加小标题。\n" +
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
        const usedRefs = new Set(Array.from(full.matchAll(/(?:\[|【)\s*T?(\d+)\s*(?:\]|】)/gi)).map((m) => `T${m[1]}`));
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

// ---- Chat history (Desk frontend cloud sync) ----
app.get("/api/chat/history", async (c) => {
  const userId = c.req.query("user_id");
  if (!userId) return c.json({ error: "user_id required" }, 400);
  const rows = await c.env.DB.prepare(
    `SELECT id, kol_id, title, messages_json, created_at, updated_at FROM chat_history WHERE user_id=? ORDER BY updated_at DESC LIMIT 100`
  ).bind(userId).all();
  return c.json({ chats: rows.results || [] });
});

app.get("/api/chat/history/:id", async (c) => {
  const userId = c.req.query("user_id");
  const id = c.req.param("id");
  if (!userId) return c.json({ error: "user_id required" }, 400);
  const row = await c.env.DB.prepare(
    `SELECT id, kol_id, title, messages_json, created_at, updated_at FROM chat_history WHERE id=? AND user_id=?`
  ).bind(id, userId).first();
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json(row);
});

app.post("/api/citations/hydrate", async (c) => {
  const body: { kol_id?: string; handle?: string; citations?: any[] } =
    await c.req.json<{ kol_id?: string; handle?: string; citations?: any[] }>().catch(() => ({}));
  const kolId = body.kol_id || "";
  const handle = body.handle || kolId;
  const citations = Array.isArray(body.citations) ? body.citations : [];
  if (!kolId || !citations.length) return c.json({ citations });

  const citationTweetId = (x: any) => {
    const direct = String(x.tweet_id || x.id || "");
    if (direct) return direct;
    const m = String(x.url || "").match(/\/status\/(\d+)/);
    return m ? m[1] : "";
  };
  const ids = Array.from(new Set(citations.map(citationTweetId).filter(Boolean))).slice(0, 80);
  if (!ids.length) return c.json({ citations });

  const rows = await c.env.DB.prepare(
    `SELECT id,text,created_at_iso,quoted FROM tweets WHERE kol_id=? AND id IN (${ids.map(() => "?").join(",")})`
  ).bind(kolId, ...ids).all().then((r) => (r.results || []) as any[]);
  const byId = new Map(rows.map((r) => [String(r.id), r]));

  const needLookup = new Map<string, any[]>();
  for (const cite of citations) {
    const cid = citationTweetId(cite);
    if (cid && !cite.tweet_id) cite.tweet_id = cid;
    const row = byId.get(cid);
    if (cite.quoted?.text) continue;
    if (row?.quoted) {
      try {
        const quoted = JSON.parse(row.quoted);
        if (quoted?.text) {
          cite.quoted = quoted;
          continue;
        }
      } catch {}
    }
    const text = String(cite.snippet || cite.text || row?.text || "");
    let match = text.match(/(?:x|twitter)\.com\/([A-Za-z0-9_]+)\/status\/(\d+)/i);
    if (!match) {
      const short = text.match(/https?:\/\/t\.co\/[A-Za-z0-9_%-]+/i)?.[0];
      if (short) {
        const res = await fetch(short, { redirect: "manual" }).catch(() => null);
        const dest = res?.headers.get("location") || "";
        match = dest.match(/(?:x|twitter)\.com\/([A-Za-z0-9_]+)\/status\/(\d+)/i);
      }
    }
    if (!match || match[1].toLowerCase() !== String(handle).toLowerCase()) continue;
    const arr = needLookup.get(match[2]) || [];
    arr.push(cite);
    needLookup.set(match[2], arr);
  }

  const qids = Array.from(needLookup.keys()).slice(0, 80);
  if (qids.length) {
    const qrows = await c.env.DB.prepare(
      `SELECT id,text,created_at_iso FROM tweets WHERE kol_id=? AND id IN (${qids.map(() => "?").join(",")})`
    ).bind(kolId, ...qids).all().then((r) => (r.results || []) as any[]).catch(() => []);
    for (const r of qrows) {
      const arr = needLookup.get(String(r.id)) || [];
      for (const cite of arr) {
        cite.quoted = {
          id: String(r.id),
          text: r.text || "",
          handle,
          name: handle === "qinbafrank" ? "Qinbafrank" : "",
          url: `https://x.com/${handle}/status/${r.id}`,
          date: (r.created_at_iso || "").slice(0, 10),
        };
      }
    }
  }

  return c.json({ citations });
});

app.put("/api/chat/history/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ user_id: string; kol_id: string; title: string; messages_json: string }>();
  if (!body.user_id || !body.kol_id) return c.json({ error: "user_id and kol_id required" }, 400);
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO chat_history (id, user_id, kol_id, title, messages_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET title=excluded.title, messages_json=excluded.messages_json, updated_at=excluded.updated_at`
  ).bind(id, body.user_id, body.kol_id, body.title || "", body.messages_json || "[]", now, now).run();
  return c.json({ ok: true, id });
});

app.delete("/api/chat/history/:id", async (c) => {
  const userId = c.req.query("user_id");
  const id = c.req.param("id");
  if (!userId) return c.json({ error: "user_id required" }, 400);
  await c.env.DB.prepare(`DELETE FROM chat_history WHERE id=? AND user_id=?`).bind(id, userId).run();
  return c.json({ ok: true });
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

app.get("/research", (c) => serveDesk(c));

app.get("/desk", (c) => serveDesk(c));

app.get("/", (c) => {
  if (isAppHost(requestHost(c.req.raw))) return serveDesk(c);
  return c.env.ASSETS.fetch(c.req.raw);
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
    if (persona_pack.length < 500) {
      return c.json({ ok: false, validation, pack_length: persona_pack.length, error: "Generated pack too short — existing pack preserved" });
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
    // Self-healing: if a golden eval set exists, score the fresh pack in the background and roll back
    // to the last good pack if it regressed vs the previous version. No-op when no eval set exists.
    c.executionCtx.waitUntil(
      evalAndMaybeRollback(c.env, kolId).catch((e) =>
        logPersonaExperiment(c.env, kolId, {
          content: "", finish_reason: "error", content_len: 0, duration_ms: 0,
          parse_ok: false, error_type: null, note: `post-generate eval failed: ${String(e).slice(0, 300)}`,
        }, 0, "eval"),
      ),
    );
    return c.json({ ok: true, validation, pack_length: persona_pack.length });
  } catch (e: any) {
    return c.json({ error: e.message || String(e) }, 500);
  }
});

// ---- Eval / auto-rollback (Phase 2) ----

// Build (or rebuild) the golden eval set for a KOL by mining Q&A from their own tweets + synthesizing
// follower questions. Idempotent. Query: ?kol_id=X
app.post("/api/admin/eval-build", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const kolId = c.req.query("kol_id");
  if (!kolId) return c.json({ error: "kol_id required" }, 400);
  try {
    const r = await buildEvalSet(c.env, kolId);
    return c.json({ ok: true, kol_id: kolId, ...r });
  } catch (e: any) {
    return c.json({ error: e.message || String(e) }, 500);
  }
});

// Run the golden eval set against the current persona, write per-case results, and auto-rollback if the
// run regressed vs the previous persona version. Query: ?kol_id=X&limit=12&rollback=1 (rollback on by
// default; pass rollback=0 to score only, no self-healing).
app.post("/api/admin/eval-run", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const kolId = c.req.query("kol_id");
  if (!kolId) return c.json({ error: "kol_id required" }, 400);
  const limit = parseInt(c.req.query("limit") || "12", 10);
  const rollback = c.req.query("rollback") !== "0";
  try {
    if (rollback) {
      const r = await evalAndMaybeRollback(c.env, kolId, { limit });
      return c.json({ ok: true, kol_id: kolId, ...r });
    }
    const summary = await runEval(c.env, kolId, { limit });
    return c.json({ ok: true, kol_id: kolId, summary, rolled_back: false });
  } catch (e: any) {
    return c.json({ error: e.message || String(e) }, 500);
  }
});

// Manually roll a KOL's persona back to its last backup/snapshot. Query: ?kol_id=X
app.post("/api/admin/eval-rollback", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const kolId = c.req.query("kol_id");
  if (!kolId) return c.json({ error: "kol_id required" }, 400);
  try {
    const r = await autoRollback(c.env, kolId, "manual rollback via admin endpoint");
    return c.json({ ok: r.rolled_back, kol_id: kolId, ...r });
  } catch (e: any) {
    return c.json({ error: e.message || String(e) }, 500);
  }
});

// Back up the current pack (so eval auto-rollback has a target), then write the new one. Shared by the
// synchronous and background distill paths.
async function publishDistilledPack(env: Env, kolId: string, pack: string, version: string): Promise<void> {
  const current = await env.DB.prepare(`SELECT persona_pack, persona_version FROM kols WHERE id=?`).bind(kolId).first<any>();
  if (current?.persona_pack && current.persona_pack.length > 100) {
    const backupId = `${kolId}:persona_backup:${new Date().toISOString().slice(0, 10)}:${Date.now()}`;
    await env.DB.prepare(
      `INSERT OR REPLACE INTO knowledge_chunks (id,kol_id,source,title,text) VALUES (?,?,?,?,?)`
    ).bind(backupId, kolId, `persona_backup:${current.persona_version || "unknown"}`, `Persona backup ${new Date().toISOString().slice(0, 10)}`, current.persona_pack).run();
  }
  await env.DB.prepare(`UPDATE kols SET persona_pack=?, persona_version=?, updated_at=datetime('now') WHERE id=?`)
    .bind(pack, version, kolId).run();
}

// Full-corpus map-reduce persona distillation. Reads 100% of the corpus (chunk → flash map → pro
// reduce), verifies quotes verbatim, and writes the resulting pack (backing up the current one).
// Query: ?kol_id=X&mode=full|incremental&days=7  (full = whole history; incremental = last `days`).
// This can take several minutes (many LLM calls) — call with a long client timeout.
app.post("/api/admin/persona-distill", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const kolId = c.req.query("kol_id");
  if (!kolId) return c.json({ error: "kol_id required" }, 400);
  const mode = c.req.query("mode") || "full";
  const days = Math.max(1, parseInt(c.req.query("days") || "7", 10));
  try {
    // Resumable map stage: call repeatedly until remaining===0 (stays under the edge timeout). Does not
    // touch the live pack — only fills the chunk fact store.
    if (mode === "map") {
      const batch = Math.max(1, parseInt(c.req.query("batch") || "8", 10));
      const prog = await mapStage(c.env, kolId, { batch });
      return c.json({ ok: true, mode, ...prog });
    }
    // Staged reduce (resumable, one pro call each) for large corpora — neither stage writes the pack:
    //   reduce_group?group=i  → merge chunk partials [i] into an intermediate (call 0..groups-1)
    //   reduce_final          → merge intermediates → final (falls through to the write block)
    if (mode === "reduce_group") {
      const group = parseInt(c.req.query("group") || "0", 10);
      // bg=1 runs the (one) pro merge detached so the client edge timeout can't kill it mid-call.
      if (c.req.query("bg") === "1") {
        c.executionCtx.waitUntil(
          reduceGroup(c.env, kolId, group).then((p) =>
            logPersonaExperiment(c.env, kolId, {
              content: "", finish_reason: p.ok ? "stop" : "empty", content_len: 0, duration_ms: 0,
              parse_ok: p.ok, error_type: null, note: `reduce_group_bg ${group}/${p.groups} ok=${p.ok}`,
            }, 0, "distill"),
          ).catch((e) =>
            logPersonaExperiment(c.env, kolId, {
              content: "", finish_reason: "error", content_len: 0, duration_ms: 0,
              parse_ok: false, error_type: null, note: `reduce_group_bg ${group} failed: ${String(e).slice(0, 200)}`,
            }, 0, "distill"),
          ),
        );
        return c.json({ ok: true, mode, group, bg: true, note: "group reduce running in background" });
      }
      const prog = await reduceGroup(c.env, kolId, group);
      return c.json({ mode, ...prog });
    }
    // Final reduce in the BACKGROUND: a single pro merge of the intermediates needs ~100-130s (a full
    // persona JSON), which exceeds the client edge timeout. waitUntil runs for minutes here, so we do it
    // detached, publish the pack, and log completion to persona_experiments (poll that to confirm).
    if (mode === "reduce_final_bg") {
      c.executionCtx.waitUntil((async () => {
        try {
          const result = await reduceFinal(c.env, kolId);
          if (result.persona_pack.length >= 500) {
            await publishDistilledPack(c.env, kolId, result.persona_pack, "v2-mapreduce");
            await logPersonaExperiment(c.env, kolId, {
              content: "", finish_reason: "stop", content_len: result.persona_pack.length, duration_ms: 0,
              parse_ok: true, error_type: null, note: `reduce_final_bg published: models=${result.stats.models} exemplars=${result.stats.exemplars} tweets=${result.stats.tweets}`,
            }, 0, "distill");
            await evalAndMaybeRollback(c.env, kolId).catch(() => {});
          } else {
            await logPersonaExperiment(c.env, kolId, {
              content: "", finish_reason: "empty", content_len: result.persona_pack.length, duration_ms: 0,
              parse_ok: false, error_type: null, note: "reduce_final_bg: pack too short, not published",
            }, 0, "distill");
          }
        } catch (e: any) {
          await logPersonaExperiment(c.env, kolId, {
            content: "", finish_reason: "error", content_len: 0, duration_ms: 0,
            parse_ok: false, error_type: null, note: `reduce_final_bg failed: ${String(e).slice(0, 300)}`,
          }, 0, "distill");
        }
      })());
      return c.json({ ok: true, mode, note: "final reduce running in background; poll persona-experiments (trigger=distill) + persona_version" });
    }
    // Reduce stage: merge stored chunks → write the pack (with backup) + trigger eval. Run after map
    // reports remaining===0. Falls through to the shared write block below.
    const out = mode === "incremental"
      ? await distillPersonaIncremental(c.env, kolId, Math.floor(Date.now() / 1000) - days * 86400)
      : mode === "voice_refine"
        ? { changed: true, result: await refineVoice(c.env, kolId), note: "voice_refine" }
        : mode === "publish_merged"
        ? { changed: true, result: await renderMergedPack(c.env, kolId), note: "publish_merged" }
        : mode === "reduce_final"
          ? { changed: true, result: await reduceFinal(c.env, kolId), note: "reduce_final" }
          : mode === "reduce"
            ? { changed: true, result: await reduceStage(c.env, kolId), note: "reduce" }
            : { changed: true, result: await distillPersonaFull(c.env, kolId), note: "full" };

    if (!out.changed || !out.result) {
      return c.json({ ok: false, mode, changed: false, note: out.note });
    }
    const { persona_pack, validation, stats } = out.result;
    if (persona_pack.length < 500) {
      return c.json({ ok: false, mode, validation, pack_length: persona_pack.length, error: "Generated pack too short — existing pack preserved" });
    }
    const version = mode === "incremental" ? `v2-mapreduce-inc-${new Date().toISOString().slice(0, 10)}`
      : mode === "voice_refine" ? "v3-voice"
      : "v2-mapreduce";
    await publishDistilledPack(c.env, kolId, persona_pack, version);
    // Score the fresh pack + self-heal in the background (no-op without an eval set).
    c.executionCtx.waitUntil(
      evalAndMaybeRollback(c.env, kolId).catch((e) =>
        logPersonaExperiment(c.env, kolId, {
          content: "", finish_reason: "error", content_len: 0, duration_ms: 0,
          parse_ok: false, error_type: null, note: `post-distill eval failed: ${String(e).slice(0, 300)}`,
        }, 0, "eval"),
      ),
    );
    return c.json({ ok: true, mode, version, validation, pack_length: persona_pack.length, stats });
  } catch (e: any) {
    return c.json({ error: e.message || String(e) }, 500);
  }
});

// Run ONE pipeline step (the work happens IN-REQUEST — the response is held until it finishes; deferring
// it to waitUntil does NOT keep the worker alive here, the work just never runs). Returns the next phase
// to chain to (or null when the pipeline is done / should stop), so the caller can advance it via whatever
// driver. Steps skip work already persisted (idempotent/resumable).
async function runDistillStep(
  env: Env, kolId: string, phase: string, groupIdx: number, steps: number, stepKey: string,
): Promise<{ next: string | null; extra: string }> {
  const log = (note: string) => logPersonaExperiment(env, kolId, {
    content: "", finish_reason: "step", content_len: 0, duration_ms: 0, parse_ok: true, error_type: null,
    note: `[${steps}] ${note}`,
  }, 0, "distill_auto");
  try {
    if (phase === "map") {
      const prog = await mapStage(env, kolId, { batch: 6 });
      await log(`map ${prog.cached}/${prog.total} (rem ${prog.remaining})`);
      return prog.remaining > 0 ? { next: "map", extra: "" } : { next: "group", extra: "&i=0" };
    }
    if (phase === "group") {
      const prog = await reduceGroup(env, kolId, groupIdx);
      await log(`reduce_group ${groupIdx + 1}/${prog.groups} ok=${prog.ok}`);
      return groupIdx + 1 < prog.groups ? { next: "group", extra: `&i=${groupIdx + 1}` } : { next: "final", extra: "" };
    }
    if (phase === "final") {
      // Final reduce, step 1/2: the pro merge ONLY (no full-corpus load) → 'merged_draft' fact. LLM-only
      // so this single pro call stays under the ~100s limit (the combined verify-too version got killed).
      const d = await reduceFinalDraft(env, kolId);
      await log(`final draft: groups=${d.groups} draft_len=${d.len}`);
      return { next: "finalize", extra: "" };
    }
    if (phase === "finalize") {
      // Final reduce, step 2/2: LLM-free verify + exemplars + publish (fast). Date-stamp the version so
      // eval scores THIS pack fresh — runEval keys results by persona_version and skips already-scored
      // cases, so reusing a bare "v2-mapreduce" would make eval a stale no-op and disable the regression
      // check; a unique version also makes the prior run the comparison baseline.
      const result = await finalizeMerged(env, kolId);
      if (result.persona_pack.length >= 500) {
        const version = `v2-mapreduce-${new Date().toISOString().slice(0, 10)}`;
        await publishDistilledPack(env, kolId, result.persona_pack, version);
        await log(`finalize published ${version}: models=${result.stats.models} exemplars=${result.stats.exemplars} len=${result.persona_pack.length}`);
        return { next: "eval", extra: "" };
      }
      await log(`finalize: pack too short (${result.persona_pack.length}), not published`);
      return { next: null, extra: "" };
    }
    if (phase === "eval") {
      const cnt = await env.DB.prepare(`SELECT COUNT(*) n FROM eval_cases WHERE kol_id=?`).bind(kolId).first<{ n: number }>();
      if (!cnt?.n) { await buildEvalSet(env, kolId); await log(`eval set built`); }
      // limit=2 per invocation: each case (retrieve + flash answer + 3 flash judges) runs ~25-30s, so a
      // batch of 2 (~55s) fits the ~100s worker budget; limit=4 (~110s) would be killed mid-step.
      const s = await runEval(env, kolId, { limit: 2 });
      await log(`eval rem=${s.remaining} composite=${s.composite.toFixed(3)} regressed=${s.regressed}`);
      if (s.remaining > 0) return { next: "eval", extra: "" };
      // Full set scored: self-heal if regressed, then finish.
      let rolled = false;
      if (s.regressed) { const rb = await autoRollback(env, kolId, "distill-auto eval regression"); rolled = rb.rolled_back; }
      await env.CACHE.delete(stepKey);
      await log(`DONE composite=${s.composite.toFixed(3)} regressed=${s.regressed} rolled_back=${rolled}`);
      return { next: null, extra: "" };
    }
    await log(`ERROR unknown phase ${phase}`);
    return { next: null, extra: "" };
  } catch (e: any) {
    await log(`ERROR phase=${phase}: ${String(e).slice(0, 200)}`);
    return { next: null, extra: "" };
  }
}

// Automated backfill orchestrator. Runs the current step IN-REQUEST, then self-triggers the next via a
// waitUntil(SELF.fetch). This reliably chains the fast + single-heavy steps (map → group* → final →
// finalize → first eval batch). A long *sequence* of slow steps (the many eval batches) can't fully
// self-chain on CF — each parent must waitUntil the child's response, and a ~55s parent has too little
// budget left to await a ~55s child — so it also records the in-progress job in KV (`distill_job:<kol>`)
// for an external/cron driver to resume. Start: POST /api/admin/distill-auto?kol_id=X&reset=1, then poll
// persona-experiments (trigger=distill_auto) for the DONE row.
app.post("/api/admin/distill-auto", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const kolId = c.req.query("kol_id");
  if (!kolId) return c.json({ error: "kol_id required" }, 400);
  const phase = c.req.query("phase") || "map";
  const groupIdx = parseInt(c.req.query("i") || "0", 10);
  const STEP_CAP = 80;

  // Runaway guard: a KV-backed step counter (TTL 2h), reset on a fresh start.
  const stepKey = `distill_steps:${kolId}`;
  let steps = c.req.query("reset") === "1" ? 0 : parseInt((await c.env.CACHE.get(stepKey)) || "0", 10);
  steps++;
  await c.env.CACHE.put(stepKey, String(steps), { expirationTtl: 7200 });

  if (steps > STEP_CAP) {
    await logPersonaExperiment(c.env, kolId, {
      content: "", finish_reason: "step", content_len: 0, duration_ms: 0, parse_ok: true, error_type: null,
      note: `[${steps}] STOP: step cap ${STEP_CAP} hit at phase=${phase}`,
    }, 0, "distill_auto");
    await c.env.CACHE.delete(`distill_job:${kolId}`);
    return c.json({ stopped: "step_cap", steps });
  }

  const result = await runDistillStep(c.env, kolId, phase, groupIdx, steps, stepKey);
  if (result.next) {
    const nextI = result.extra.includes("i=") ? parseInt(result.extra.split("i=")[1], 10) : 0;
    await c.env.CACHE.put(`distill_job:${kolId}`, JSON.stringify({ phase: result.next, i: nextI }), { expirationTtl: 7200 });
    const origin = new URL(c.req.url).origin;
    const url = `${origin}/api/admin/distill-auto?kol_id=${encodeURIComponent(kolId)}&phase=${result.next}${result.extra}`;
    const init = { method: "POST", headers: { "x-admin-key": c.env.ADMIN_KEY || "" } };
    const fire = c.env.SELF ? c.env.SELF.fetch(url, init) : fetch(url, init);
    c.executionCtx.waitUntil(Promise.resolve(fire).then(() => {}).catch(() => {}));
  } else {
    await c.env.CACHE.delete(`distill_job:${kolId}`); // pipeline finished/stopped
  }
  return c.json({ ok: true, phase, next: result.next, steps });
});

// Diagnose WHY persona generation fails for a KOL: probes several max_tokens budgets and reports
// finish_reason / content length / parse outcome for each, WITHOUT writing anything to kols. The
// outcome is logged to persona_experiments so it's auditable. Use this to pick the production
// budget instead of guessing. Query: ?kol_id=X&budgets=8192,16384,32768 (defaults to a small ladder).
app.post("/api/admin/persona-diagnose", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const kolId = c.req.query("kol_id");
  if (!kolId) return c.json({ error: "kol_id required" }, 400);
  const budgetsParam = c.req.query("budgets");
  const budgets = budgetsParam
    ? budgetsParam.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => n > 0)
    : [8192, 16384, 32768];
  try {
    const result = await diagnosePersonaGeneration(c.env, kolId, budgets);
    return c.json({ ok: true, kol_id: kolId, probes: result.probes, best_budget: result.best });
  } catch (e: any) {
    return c.json({ error: e.message || String(e) }, 500);
  }
});

// Cron-driven step driver. Advances every in-progress distill job (`distill_job:<kol>` in KV) by ONE step
// per tick, running entirely on the worker. This is what completes the parts of the pipeline the
// self-chain can't (the long sequence of slow eval batches): each cron tick is an independent invocation
// with a fresh ~100s budget, so it never hits the await-the-slow-child wall. One step/min → a full eval
// (~13 batches) finishes in ~13 min, hands-off. Idempotent steps mean overlap with the self-chain is safe.
async function driveDistillJobs(env: Env): Promise<void> {
  const list = await env.CACHE.list({ prefix: "distill_job:" });
  for (const key of list.keys) {
    const kolId = key.name.slice("distill_job:".length);
    const jobRaw = await env.CACHE.get(key.name);
    if (!jobRaw) continue;
    let job: { phase: string; i: number };
    try { job = JSON.parse(jobRaw); } catch { await env.CACHE.delete(key.name); continue; }
    const stepKey = `distill_steps:${kolId}`;
    const steps = parseInt((await env.CACHE.get(stepKey)) || "0", 10) + 1;
    await env.CACHE.put(stepKey, String(steps), { expirationTtl: 7200 });
    if (steps > 200) { await env.CACHE.delete(key.name); continue; } // runaway guard
    const result = await runDistillStep(env, kolId, job.phase, job.i || 0, steps, stepKey);
    if (result.next) {
      const nextI = result.extra.includes("i=") ? parseInt(result.extra.split("i=")[1], 10) : 0;
      await env.CACHE.put(key.name, JSON.stringify({ phase: result.next, i: nextI }), { expirationTtl: 7200 });
    } else {
      await env.CACHE.delete(key.name);
    }
  }
}

// Inspect persona generation history for a KOL (from persona_experiments) — shows the trail of
// attempts, their finish_reasons, and parse outcomes. Useful for post-mortems on failed onboarding.
app.get("/api/admin/persona-experiments", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const kolId = c.req.query("kol_id");
  const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 200);
  const stmt = kolId
    ? c.env.DB.prepare(`SELECT * FROM persona_experiments WHERE kol_id=? ORDER BY started_at DESC LIMIT ?`).bind(kolId, limit)
    : c.env.DB.prepare(`SELECT * FROM persona_experiments ORDER BY started_at DESC LIMIT ?`).bind(limit);
  const r = await stmt.all();
  return c.json({ experiments: r.results });
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
app.get("/kol/:persona", (c) => serveDesk(c));

app.get("/kol/:persona/:section", (c) => serveDesk(c));

// ---- Diagnostic: test pro model connectivity ----
app.get("/api/admin/model-test", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const kolId = c.req.query("kol_id") || "aleabitoreddit";
  const debug = await c.env.CACHE.get(`persona_debug:${kolId}`);
  const start = Date.now();
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
      body: JSON.stringify({
        model: c.env.MODEL_PRO,
        messages: [{ role: "user", content: "Say hello in exactly 3 words." }],
        temperature: 0.1,
        max_tokens: 20,
      }),
    });
    const elapsed = Date.now() - start;
    if (!res.ok) return c.json({ error: `HTTP ${res.status}`, elapsed });
    const j: any = await res.json();
    return c.json({ ok: true, elapsed, model: c.env.MODEL_PRO, response: j?.choices?.[0]?.message?.content || "", persona_debug: debug });
  } catch (e: any) {
    return c.json({ error: String(e), elapsed: Date.now() - start });
  }
});

// Static assets fallback — app subdomain uses desk.html only for client-side routes.
app.get("*", (c) => {
  const url = new URL(c.req.url);
  if (isAppHost(url.hostname) && isDeskSpaPath(url.pathname)) {
    url.pathname = "/desk.html";
    return c.env.ASSETS.fetch(new Request(url, c.req.raw));
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const host = requestHost(req);
    const url = new URL(req.url);
    if (isMarketingHost(host)) {
      if (
        url.pathname.startsWith("/kol/") ||
        url.pathname === "/research" ||
        url.pathname === "/desk" ||
        url.pathname.startsWith("/research/")
      ) {
        return redirectToApp(req);
      }
    }
    if (url.pathname.startsWith("/kol/")) {
      url.pathname = "/desk.html";
      return env.ASSETS.fetch(new Request(url, req));
    }
    return app.fetch(req, env, ctx);
  },
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (event.cron === "* * * * *") {
      // Every minute: advance any in-progress distill backfill by one step (no-op when none are running).
      ctx.waitUntil(driveDistillJobs(env));
      return;
    }
    if (event.cron === "30 9 * * 1") {
      ctx.waitUntil(runWeeklyPersonaRefresh(env));
      return;
    }
    ctx.waitUntil(runDailyIngest(env));
  },
};
