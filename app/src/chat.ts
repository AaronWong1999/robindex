import type { Env, KolRow } from "./env";
import { retrieve, type Citation } from "./rag";
import { getKlineCached, type Quote } from "./finance";
import { detectInstruments, type DetectOptions } from "./entities";
import { getStockNews, getMarketNews, type NewsItem } from "./marketdata";
import { TOOLS, executeTool } from "./tools";

// User is asking about news / macro / what's happening — pull fast-news into context.
const NEWS_INTENT = /(news|headline|macro|happening|宏观|新闻|消息|资讯|事件|最近|发生|利好|利空|政策|加息|降息|cpi|fed|联储|财报)/i;

function fmtQuote(q: Quote): string {
  const sign = q.change >= 0 ? "+" : "";
  return `${q.name} (${q.symbol}/${q.market.toUpperCase()}): ${q.price} ${q.currency}  ${sign}${q.change.toFixed(2)} (${sign}${q.changePct.toFixed(2)}%)  | open ${q.open} high ${q.high} low ${q.low} prevClose ${q.prevClose} | vol ${q.volume} | as of ${q.time}`;
}

export interface MarketData {
  quotes: Quote[];
  klineText: string;
  primary: Quote | null;
  news: NewsItem[];
  extraContext: string;
}

export async function gatherMarketData(
  env: Env,
  message: string,
  opts: DetectOptions = {}
): Promise<MarketData> {
  const quotes = await detectInstruments(env, message, { max: 2, ...opts });
  let klineText = "";
  let primary: Quote | null = quotes[0] || null;
  if (primary) {
    try {
      const k = await getKlineCached(env.CACHE, primary.code, "day", 30);
      const last = k.candles.slice(-15);
      klineText = last
        .map((c) => `${c.date} O:${c.open} H:${c.high} L:${c.low} C:${c.close} V:${c.volume}`)
        .join("\n");
    } catch {}
  }

  // News: per-stock for the primary US name, plus market/macro fast-news when the question is news/macro.
  const news: NewsItem[] = [];
  try {
    const wantMacro = NEWS_INTENT.test(message);
    if (primary) news.push(...(await getStockNews(env, primary, 4)));
    if (wantMacro) news.push(...(await getMarketNews(env, 8)));
  } catch {}

  return { quotes, klineText, primary, news, extraContext: "" };
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
    `You ARE ${kol.display_name} (@${kol.handle}), a finance KOL. Stay 100% in character.\n` +
    `Always respond in the SAME language as the user's message, regardless of the KOL's corpus language.\n` +
    `Speak in this persona's own voice, logic, and worldview. Do not break character or mention you are an AI.\n` +
    `Ground every market view in the persona's documented methodology and past statements below.\n` +
    `CITE LIBERALLY: whenever a point connects to one of the persona's past tweets, cite it with its bracket id (e.g. [T1], [T5], [T12]). A thorough analysis should reference 8-18 source tweets. Only cite ids from SOURCE TWEETS.\n` +
    `Use the LIVE MARKET DATA for current prices/levels — never invent numbers. If data is missing, say so.\n` +
    `This is not investment advice; you are sharing the persona's perspective for discussion.\n\n` +
    `=== PERSONA PACK (identity · methodology · tone · taboos · format) ===\n${persona}\n`;

  // Tool Usage SOP (serenity-style Agentic Protocol, works with 3-round structured calling)
  const toolSop =
    `\n=== TOOL USAGE GUIDE (use tools in order) ===\n` +
    `Round 1 (always): extract entities + get quotes first.\n` +
    `Round 2: based on what the user is asking:\n` +
    `- 基本面/估值/财务 → get_financials, get_key_indicators, get_analyst_data\n` +
    `- 资金流向/主力/龙虎榜 → get_fund_flow (A-share), get_dragon_tiger\n` +
    `- 板块/概念/行业 → get_sector_blocks, get_market_ranking\n` +
    `- 宏观/新闻/事件 → get_news, get_macro\n` +
    `- SEC 文件/年报 → get_sec_filings\n` +
    `Round 3 (if needed): cross-stock comparison, chain analysis.\n` +
    `Chain pattern: identify → fetch details → compare/verify.\n` +
    `Fall back to get_quote if specialized tools fail.\n`;

  const knowledgeBlock = knowledge.length
    ? `\n=== PERSONA KNOWLEDGE (distilled theses / methodology / analysis) ===\n` +
      knowledge.map((k) => `# ${k.title || k.source}\n${k.text}`).join("\n\n")
    : "";

  const system = personaBlock + toolSop + knowledgeBlock;

  // ---- VARIABLE SUFFIX: retrieved tweets + live data + user turn. ----
  const tweetsBlock = citations.length
    ? `SOURCE TWEETS (cite by id):\n` +
      citations.map((c) => `[${c.ref}] (${c.date}) ${c.snippet}`).join("\n")
    : `SOURCE TWEETS: (none retrieved)`;

  const dataBlock = market.quotes.length
    ? `LIVE MARKET DATA (as of now):\n` +
      market.quotes.map(fmtQuote).join("\n") +
      (market.klineText ? `\n\nRecent daily candles for ${market.primary?.symbol}:\n${market.klineText}` : "") +
      (market.extraContext ? `\n\nADDITIONAL DATA (pre-fetched by intent):\n${market.extraContext}` : "")
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
    content: `${summaryBlock}${toolMemoryBlock}${tweetsBlock}\n\n${dataBlock}${newsBlock}\n\n=== USER QUESTION ===\n${userMessage}`,
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

// Hybrid tool phase: 3-round structured tool calling.
// Round 1: entity extraction + quotes (extract_financial_entities).
// Round 2: deep data (financials, fund flow, sectors, etc.).
// Round 3: cross-stock comparison / chain analysis (optional).
// Best-effort: on any failure, returns the messages collected so far.
// Also returns a summary of tool calls for memory persistence.
export interface ToolCallRecord {
  tool: string;
  args: Record<string, any>;
  result_summary: string;  // first 200 chars of result
}
export async function resolveToolPhase(
  env: Env,
  model: string,
  messages: { role: string; content: string }[],
  onEvent?: (evt: { type: "progress" | "tool_call"; text?: string; name?: string; args?: string }) => void
): Promise<{ messages: any[]; toolCalls: ToolCallRecord[] }> {
  let msgs: any[] = [...messages];
  const toolCalls: ToolCallRecord[] = [];
  try {
    for (let i = 0; i < 3; i++) {
      onEvent?.({ type: "progress", text: `正在分析数据（第 ${i + 1} 轮）…` });
      const res = await fetch(env.GATEWAY_URL, {
        method: "POST",
        headers: gatewayHeaders(env),
        body: JSON.stringify({ model, messages: msgs, tools: TOOLS, tool_choice: "auto", temperature: 0.2, max_tokens: 600 }),
      });
      if (!res.ok) break;
      const j: any = await res.json().catch(() => null);
      const choice = j?.choices?.[0];
      const m = choice?.message;
      if (choice?.finish_reason !== "tool_calls" || !m?.tool_calls?.length) break;
      msgs.push({ role: "assistant", content: m.content || "", tool_calls: m.tool_calls });
      for (const tc of m.tool_calls) {
        let args: any = {};
        try {
          args = JSON.parse(tc.function?.arguments || "{}");
        } catch {}
        onEvent?.({
          type: "tool_call",
          name: tc.function?.name || "unknown",
          args: Object.keys(args).join(", "),
        });
        const out = await executeTool(env, tc.function?.name, args);
        msgs.push({ role: "tool", tool_call_id: tc.id, content: out });
        toolCalls.push({
          tool: tc.function?.name || "",
          args,
          result_summary: out.slice(0, 200),
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
