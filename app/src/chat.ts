import type { Env, KolRow } from "./env";
import { retrieve, type Citation } from "./rag";
import { getKlineCached, resolveSymbolCached, getQuotesCached, type Quote } from "./finance";
import { getStockNews, getMarketNews, type NewsItem } from "./marketdata";
import { TOOLS, executeTool } from "./tools";
import { sourceTweetForPrompt } from "./source-format";

// User is asking about news / macro / what's happening — pull fast-news into context.
const NEWS_INTENT = /(news|headline|macro|happening|宏观|新闻|消息|资讯|事件|最近|发生|利好|利空|政策|加息|降息|cpi|fed|联储|财报)/i;

// Market-context intent: macro/market questions that name NO specific instrument (e.g. "最近宏观怎么看",
// "现在该不该买", "大盘怎么走") still need live context → we inject a benchmark INDEX basket + macro news.
const MACRO_INTENT =
  /(宏观|大盘|后市|该不该买|值不值得|要不要买|能不能买|可以买|抄底|加仓|减仓|仓位|配置|牛市|熊市|行情|指数|纳指|标普|道指|恒生|上证|创业板|经济|衰退|加息|降息|通胀|cpi|联储|fed|macro|recession|rally|index|market)/i;
// Reliable Tencent index codes (probed live): 纳指 / 标普 / 道指 / 恒生 / 上证.
const BENCH_INDEX_CODES = ["usIXIC", "usINX", "usDJI", "hkHSI", "sh000001"];

function fmtQuote(q: Quote): string {
  const sign = q.change >= 0 ? "+" : "";
  return `${q.name} (${q.symbol}/${q.market.toUpperCase()}): ${q.price} ${q.currency}  ${sign}${q.change.toFixed(2)} (${sign}${q.changePct.toFixed(2)}%)  | open ${q.open} high ${q.high} low ${q.low} prevClose ${q.prevClose} | vol ${q.volume} | as of ${q.time}`;
}

export interface MarketData {
  quotes: Quote[];          // real, user-named instruments (drive chart + per-stock kline/news)
  benchmarks: Quote[];      // macro index basket — TEXT context only, never charted
  klineText: string;
  primary: Quote | null;
  news: NewsItem[];
  extraContext: string;
}

export async function gatherMarketData(
  env: Env,
  message: string,
  opts: { extraInstruments?: string[] } = {}
): Promise<MarketData> {
  // Single source of instrument detection: the query planner (an LLM call we make anyway) identifies
  // the tradable names + tickers in the question. We resolve each through the quote feed, which
  // VALIDATES (price>0 + real name) before we trust the model's ticker guess. No static dictionary to
  // maintain — long-tail names (SOXL, CRCL, 茅台 …) are handled the same way as common ones.
  const quotes: Quote[] = [];
  const seen = new Set<string>();
  const rawInstruments = Array.from(new Set((opts.extraInstruments || []).map((raw) => String(raw || "").trim()).filter(Boolean))).slice(0, 8);
  const resolvedInstruments = await Promise.all(rawInstruments.map((name) => resolveSymbolCached(env.CACHE, name).catch(() => null)));
  for (const q of resolvedInstruments) {
    if (quotes.length >= 3) break;
    if (q && q.price > 0 && q.name && !seen.has(q.code)) {
      seen.add(q.code);
      quotes.push(q);
    }
  }
  // primary (→ chart + per-stock kline/news) is ONLY ever a real user-named instrument.
  let primary: Quote | null = quotes[0] || null;

  // No specific instrument but it's a macro / "should I buy" / 大盘 question → fetch a benchmark INDEX
  // basket for live context (纳指/标普/道指/恒生/上证). These are TEXT context only — NOT charted (index
  // K-line isn't reliably available, which is what produced the empty "IXIC · US" box).
  const wantMacro = NEWS_INTENT.test(message) || MACRO_INTENT.test(message);
  const benchmarks: Quote[] = [];
  if (!quotes.length && wantMacro) {
    try {
      const idx = await getQuotesCached(env.CACHE, BENCH_INDEX_CODES);
      benchmarks.push(...idx.filter((q) => q.price > 0).slice(0, 5));
    } catch {}
  }

  let klineText = "";
  if (primary) {
    try {
      const k = await getKlineCached(env.CACHE, primary.code, "day", 30);
      const last = k.candles.slice(-15);
      klineText = last
        .map((c) => `${c.date} O:${c.open} H:${c.high} L:${c.low} C:${c.close} V:${c.volume}`)
        .join("\n");
    } catch {}
  }

  // News: per-stock for the primary name, plus market/macro fast-news for news/macro/advice questions.
  const news: NewsItem[] = [];
  try {
    if (primary) news.push(...(await getStockNews(env, primary, 4)));
    if (wantMacro) news.push(...(await getMarketNews(env, 8)));
  } catch {}

  return { quotes, benchmarks, klineText, primary, news, extraContext: "" };
}

export function buildMessages(opts: {
  kol: KolRow;
  persona: string;
  knowledge: { source: string; title: string | null; text: string }[];
  citations: Citation[];
  market: MarketData;
  history: { role: string; content: string }[];
  userMessage: string;
  summary?: string;
  toolMemory?: string;
}) {
  const { kol, persona, knowledge, citations, market, history, userMessage, summary, toolMemory } = opts;

  // ---- STABLE PREFIX (cache-friendly): persona pack first, never changes per turn. ----
  const personaBlock =
    `You are a research assistant applying ${kol.display_name} (@${kol.handle})'s documented finance framework.\n` +
    `Always respond in the SAME language as the user's message, regardless of the KOL's corpus language.\n` +
    `Use the persona's cadence, vocabulary, priorities, and worldview, but do not claim to be the KOL or represent them.\n` +
    `Do not use first person on behalf of the KOL: avoid phrases like "我的框架", "我认为", "我多次说", or "我发过". Say "${kol.display_name}'s framework", "the source tweets say", or "this can be inferred from the framework" instead.\n` +
    `When naming the persona, use exactly "${kol.display_name}" or "@${kol.handle}"; never invent alternate spellings.\n` +
    `Ground every market view in the persona's documented methodology and past statements below.\n` +
    `CITE LIBERALLY: whenever a point connects to one of the persona's past tweets, cite it with its bracket id (e.g. [T1], [T5], [T12]). A thorough analysis should reference 8-18 source tweets across different dates or facets, not one cluster. Only cite ids from SOURCE TWEETS.\n` +
    `QUALITY BAR: first answer the user's concrete decision/question, then reconstruct the KOL's reasoning chain, separate direct source support from inference, judge whether the source view is still current or possibly stale, and name the evidence that would change the view. Avoid generic market commentary that is not tied to SOURCE TWEETS or LIVE MARKET DATA.\n` +
    `When a SOURCE TWEET includes Quoted context, treat it as context for what the KOL was reacting to; do not attribute the quoted account's words to the KOL unless the KOL tweet itself endorses or comments on it.\n` +
    `Use the LIVE MARKET DATA for current prices/levels — never invent numbers. If data is missing, say so.\n` +
    `This is not investment advice; it is a source-grounded reconstruction of the persona's likely framework.\n\n` +
    `=== PERSONA PACK (identity · methodology · tone · taboos · format) ===\n${persona}\n`;

  // Tool Usage SOP (works with the 3-round structured calling phase). Quotes for the user's instrument
  // are usually pre-fetched into LIVE MARKET DATA already — only call tools for what's missing.
  const toolSop =
    `\n=== TOOL USAGE GUIDE (only fetch what's missing; data may already be in LIVE MARKET DATA) ===\n` +
    `- 价格/标的确认 → get_quote (pass one or many names/tickers; also resolves names you're unsure of)\n` +
    `- 走势/K线 → get_kline (use minute periods for intraday)\n` +
    `- 新闻/宏观/事件 → get_news (with symbol = stock news; no symbol = market/macro fast-news)\n` +
    `- 基本面/估值/财务 → get_financials, get_key_indicators, get_analyst_data (US/HK)\n` +
    `- SEC 文件/年报 → get_sec_filings\n` +
    `- 全市场涨跌幅排名 → get_market_ranking\n` +
    `- A股资金流/龙虎榜/板块 → get_ashare_detail (kind = fund_flow | dragon_tiger | sectors)\n` +
    `Pattern: identify → fetch only missing details → compare/verify. Don't re-fetch data already shown.\n`;

  // NOTE: retrieved knowledge is query-dependent, so it must NOT live in the system message — that
  // would break the cacheable stable prefix. Only persona pack + tool SOP (both per-turn-invariant)
  // go in system; the knowledge block is emitted in the variable user suffix below.
  const knowledgeBlock = knowledge.length
    ? `=== PERSONA KNOWLEDGE (distilled theses / methodology / analysis) ===\n` +
      knowledge.map((k) => `# ${k.title || k.source}\n${k.text}`).join("\n\n") +
      "\n\n"
    : "";

  const system = personaBlock + toolSop;

  // ---- VARIABLE SUFFIX: retrieved tweets + live data + user turn. ----
  const tweetsBlock = citations.length
    ? `SOURCE TWEETS (cite by id):\n` +
      citations.map(sourceTweetForPrompt).join("\n")
    : `SOURCE TWEETS: (none retrieved)`;

  const benchmarkBlock = market.benchmarks?.length
    ? `大盘指数 (live benchmark levels):\n` + market.benchmarks.map(fmtQuote).join("\n")
    : "";
  const dataBlock = market.quotes.length
    ? `LIVE MARKET DATA (as of now):\n` +
      market.quotes.map(fmtQuote).join("\n") +
      (market.klineText ? `\n\nRecent daily candles for ${market.primary?.symbol}:\n${market.klineText}` : "") +
      (benchmarkBlock ? `\n\n${benchmarkBlock}` : "") +
      (market.extraContext ? `\n\nADDITIONAL DATA (pre-fetched by intent):\n${market.extraContext}` : "")
    : benchmarkBlock
      ? `LIVE MARKET DATA (no specific instrument named; market-wide context):\n${benchmarkBlock}`
      : `LIVE MARKET DATA: (no specific instrument detected in the question)`;

  const newsBlock = market.news.length
    ? `\n\nRECENT NEWS (use only if relevant; cite source/time, don't fabricate):\n` +
      market.news.map((n) => `- (${n.time}) ${n.title}${n.digest ? ` — ${n.digest}` : ""} [${n.source}]`).join("\n")
    : "";

  const summaryBlock = summary ? `=== CONVERSATION SO FAR (earlier turns, summarized) ===\n${summary}\n\n` : "";
  const toolMemoryBlock = toolMemory ? `=== PREVIOUS TOOL CALLS (avoid repeating same queries) ===\n${toolMemory}\n\n` : "";

  const messages: { role: string; content: string }[] = [{ role: "system", content: system }];
  for (const h of history.slice(-6)) messages.push({ role: h.role, content: h.content });
  messages.push({
    role: "user",
    content: `${summaryBlock}${toolMemoryBlock}${knowledgeBlock}${tweetsBlock}\n\n${dataBlock}${newsBlock}\n\n=== USER QUESTION ===\n${userMessage}`,
  });
  return messages;
}

// Rolling long-term memory: once a thread is long, summarize the older turns into conversations.summary
// (bounded memory that survives history truncation).
// Timing fix: if ≥4 new messages since last summary, run synchronously (not waitUntil)
// to avoid race condition on rapid-fire messages.
export async function maybeUpdateSummary(env: Env, convId: string, model: string): Promise<{ synced: boolean }> {
  const cnt = await env.DB.prepare(`SELECT COUNT(*) c FROM messages WHERE conversation_id=?`)
    .bind(convId)
    .first<{ c: number }>();
  if ((cnt?.c ?? 0) < 14) return { synced: false };

  // Check if we need synchronous update: count messages since last summary update
  const conv = await env.DB.prepare(`SELECT summary, updated_at FROM conversations WHERE id=?`)
    .bind(convId)
    .first<{ summary: string | null; updated_at: string }>();
  const newSinceLast = conv?.updated_at
    ? await env.DB.prepare(`SELECT COUNT(*) c FROM messages WHERE conversation_id=? AND created_at > ?`)
        .bind(convId, conv.updated_at).first<{ c: number }>()
    : null;
  const needsSync = (newSinceLast?.c ?? 0) >= 4;

  const rows = await env.DB.prepare(
    `SELECT role,content FROM messages WHERE conversation_id=? ORDER BY created_at`
  )
    .bind(convId)
    .all();
  const all = (rows.results || []) as { role: string; content: string }[];
  const older = all.slice(0, -6); // keep the last 6 raw; summarize the rest
  if (older.length < 6) return { synced: needsSync };

  const convo = older.map((m) => `${m.role}: ${m.content}`).join("\n").slice(0, 8000);
  const sys =
    "You compress a finance chat into a factual third-person memo (<=180 words). Capture: the user's situation, tickers/instruments discussed, the persona's stated views/calls and their rationale, and any open threads. No fluff.";
  const usr = (conv?.summary ? `Previous summary:\n${conv.summary}\n\n` : "") + `Conversation:\n${convo}`;
  const summary = await completeChat(env, model, [
    { role: "system", content: sys },
    { role: "user", content: usr },
  ], { maxTokens: 300 });
  if (summary) {
    await env.DB.prepare(`UPDATE conversations SET summary=?, updated_at=datetime('now') WHERE id=?`).bind(summary, convId).run();
  }
  return { synced: needsSync };
}

// Shared AI Gateway headers: governor auth (cf-aig) is always required. The downstream provider key is
// only sent when present — the gateway has BYOK, so governor-only auth works; an empty Bearer would 401.
function gatewayHeaders(env: Env): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    "cf-aig-authorization": `Bearer ${env.CFGATEWAYKEY}`,
    "HTTP-Referer": "https://robindex.ai",
    "X-Title": "Robindex",
  };
  if (env.OPENROUTER_KEY) h.Authorization = `Bearer ${env.OPENROUTER_KEY}`;
  return h;
}

// Non-streaming completion (for summaries / weekly distillation). Returns "" on any failure.
export async function completeChat(
  env: Env,
  model: string,
  messages: { role: string; content: string }[],
  opts: { temperature?: number; maxTokens?: number } = {}
): Promise<string> {
  try {
    const res = await fetch(env.GATEWAY_URL, {
      method: "POST",
      headers: gatewayHeaders(env),
      body: JSON.stringify({
        model,
        messages,
        temperature: opts.temperature ?? 0.3,
        max_tokens: opts.maxTokens ?? 600,
      }),
    });
    if (!res.ok) return "";
    const j: any = await res.json().catch(() => null);
    return j?.choices?.[0]?.message?.content || "";
  } catch {
    return "";
  }
}

// Hybrid tool phase: bounded structured tool calling.
// Round 1 fetches missing quotes/news/primary data; round 2 deepens when the route really needs it.
// Best-effort: on any failure, returns the messages collected so far.
// Also returns a summary of tool calls for memory persistence.
export interface ToolCallRecord {
  tool: string;
  args: Record<string, any>;
  result_summary: string;  // first 200 chars of result
}

function compactToolOutput(name: string, out: string): string {
  const text = String(out || "").replace(/\n{3,}/g, "\n\n").trim();
  const lines = text.split("\n");
  const maxLines = name === "get_kline" ? 24 : name === "get_news" ? 8 : 28;
  const maxChars = name === "get_quote" ? 900 : name === "get_news" ? 1400 : 1800;
  let compact = lines.slice(0, maxLines).join("\n");
  if (text.length > compact.length || compact.length > maxChars) {
    compact = compact.slice(0, maxChars).trimEnd() + "\n[truncated for final-answer prompt]";
  }
  return compact || text.slice(0, maxChars);
}

export async function resolveToolPhase(
  env: Env,
  model: string,
  messages: { role: string; content: string }[],
  onEvent?: (evt: { type: "progress" | "tool_call"; text?: string; name?: string; args?: string }) => void,
  maxRounds = 2
): Promise<{ messages: any[]; toolCalls: ToolCallRecord[] }> {
  let msgs: any[] = [...messages];
  const toolCalls: ToolCallRecord[] = [];
  try {
    const rounds = Math.max(0, Math.min(2, Math.floor(maxRounds)));
    for (let i = 0; i < rounds; i++) {
      onEvent?.({ type: "progress", text: `正在分析数据（第 ${i + 1} 轮）…` });
      const res = await fetch(env.GATEWAY_URL, {
        method: "POST",
        headers: gatewayHeaders(env),
        // 1500 (not 600): leaves room for any reasoning text PLUS several tool_call JSON blocks so the
        // assistant turn isn't truncated mid tool-call (which would end the tool phase early).
        body: JSON.stringify({ model, messages: msgs, tools: TOOLS, tool_choice: "auto", temperature: 0.2, max_tokens: 1500 }),
      });
      if (!res.ok) break;
      const j: any = await res.json().catch(() => null);
      const choice = j?.choices?.[0];
      const m = choice?.message;
      if (choice?.finish_reason !== "tool_calls" || !m?.tool_calls?.length) break;
      msgs.push({ role: "assistant", content: m.content || "", tool_calls: m.tool_calls });
      const toolResults = await Promise.all(m.tool_calls.map(async (tc: any) => {
        let args: any = {};
        try {
          args = JSON.parse(tc.function?.arguments || "{}");
        } catch {}
        onEvent?.({
          type: "tool_call",
          name: tc.function?.name || "unknown",
          args: Object.keys(args).join(", "),
        });
        const name = tc.function?.name || "";
        const out = await executeTool(env, name, args);
        return { tc, args, out, compactOut: compactToolOutput(name, out) };
      }));
      for (const { tc, args, compactOut } of toolResults) {
        msgs.push({ role: "tool", tool_call_id: tc.id, content: compactOut });
        toolCalls.push({
          tool: tc.function?.name || "",
          args,
          result_summary: compactOut.slice(0, 200),
        });
      }
    }
  } catch {
    return { messages, toolCalls };
  }
  return { messages: msgs, toolCalls };
}

// Stream a chat completion from the AI Gateway, forwarding deltas to the client as SSE.
export async function streamChat(
  env: Env,
  model: string,
  messages: { role: string; content: string }[],
  citations: Citation[],
  primary: Quote | null,
  onText: (full: string) => Promise<void>
): Promise<Response> {
  const upstream = await fetch(env.GATEWAY_URL, {
    method: "POST",
    headers: gatewayHeaders(env),
    body: JSON.stringify({ model, messages, stream: true, temperature: 0.6 }),
  });

  if (!upstream.ok || !upstream.body) {
    const errText = await upstream.text().catch(() => "");
    return new Response(`event: error\ndata: ${JSON.stringify({ status: upstream.status, errText })}\n\n`, {
      headers: { "Content-Type": "text/event-stream" },
      status: 200,
    });
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let full = "";

  const stream = new ReadableStream({
    async start(controller) {
      const meta = {
        citations,
        chart: primary ? { code: primary.code, symbol: primary.symbol, market: primary.market } : null,
      };
      controller.enqueue(encoder.encode(`event: meta\ndata: ${JSON.stringify(meta)}\n\n`));

      const reader = upstream.body!.getReader();
      let buf = "";
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
              const j = JSON.parse(payload);
              const delta = j.choices?.[0]?.delta?.content || "";
              if (delta) {
                full += delta;
                controller.enqueue(encoder.encode(`event: delta\ndata: ${JSON.stringify(delta)}\n\n`));
              }
            } catch {}
          }
        }
      } catch (e) {
        controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify(String(e))}\n\n`));
      }
      controller.enqueue(encoder.encode(`event: done\ndata: {}\n\n`));
      controller.close();
      await onText(full);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
