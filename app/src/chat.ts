import type { Env, KolRow } from "./env";
import { retrieve, type Citation } from "./rag";
import { resolveSymbolCached, getKlineCached, type Quote } from "./finance";

const COMMON_WORDS = new Set([
  "THE","AND","FOR","ARE","BUT","NOT","YOU","ALL","CAN","HER","WAS","ONE","OUR","OUT","DAY","GET","HAS","HIM","HOW","NOW","SEE","TWO","WHO","BOY","DID","ITS","LET","PUT","SAY","SHE","TOO","USE","ETF","CEO","CFO","USD","CPI","GDP","FED","IPO","ATH","YOY","QOQ","EPS","WSB","DCA","FYI","LOL","IMO","TBH",
]);

// Detect candidate tickers from a message: $cashtags (strong) + bare UPPER tokens (weak).
function detectTickers(message: string): string[] {
  const out = new Set<string>();
  for (const m of message.matchAll(/\$([A-Za-z]{1,6})\b/g)) out.add(m[1].toUpperCase());
  for (const m of message.matchAll(/\b([A-Z]{2,5})\b/g)) {
    const w = m[1];
    if (!COMMON_WORDS.has(w)) out.add(w);
  }
  return Array.from(out).slice(0, 4);
}

function fmtQuote(q: Quote): string {
  const sign = q.change >= 0 ? "+" : "";
  return `${q.name} (${q.symbol}/${q.market.toUpperCase()}): ${q.price} ${q.currency}  ${sign}${q.change.toFixed(2)} (${sign}${q.changePct.toFixed(2)}%)  | open ${q.open} high ${q.high} low ${q.low} prevClose ${q.prevClose} | vol ${q.volume} | as of ${q.time}`;
}

export interface MarketData {
  quotes: Quote[];
  klineText: string;
  primary: Quote | null;
}

export async function gatherMarketData(env: Env, message: string): Promise<MarketData> {
  const tokens = detectTickers(message);
  const quotes: Quote[] = [];
  const seen = new Set<string>();
  for (const tk of tokens) {
    if (quotes.length >= 2) break;
    const q = await resolveSymbolCached(env.CACHE, tk);
    if (q && !seen.has(q.code)) {
      seen.add(q.code);
      quotes.push(q);
    }
  }
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
  return { quotes, klineText, primary };
}

export function buildMessages(opts: {
  kol: KolRow;
  persona: string;
  knowledge: { source: string; title: string | null; text: string }[];
  citations: Citation[];
  market: MarketData;
  history: { role: string; content: string }[];
  userMessage: string;
}) {
  const { kol, persona, knowledge, citations, market, history, userMessage } = opts;

  // ---- STABLE PREFIX (cache-friendly): persona pack first, never changes per turn. ----
  const personaBlock =
    `You ARE ${kol.display_name} (@${kol.handle}), a finance KOL. Stay 100% in character.\n` +
    `Speak in this persona's own voice, logic, and worldview. Do not break character or mention you are an AI.\n` +
    `Ground every market view in the persona's documented methodology and past statements below.\n` +
    `When you rely on one of the persona's past tweets, cite it inline with its bracket id (e.g. [T1]). Only cite ids that appear in SOURCE TWEETS.\n` +
    `Use the LIVE MARKET DATA for current prices/levels — never invent numbers. If data is missing, say so.\n` +
    `This is not investment advice; you are sharing the persona's perspective for discussion.\n\n` +
    `=== PERSONA PACK (identity · methodology · tone · taboos · format) ===\n${persona}\n`;

  const knowledgeBlock = knowledge.length
    ? `\n=== PERSONA KNOWLEDGE (distilled theses / methodology / analysis) ===\n` +
      knowledge.map((k) => `# ${k.title || k.source}\n${k.text}`).join("\n\n")
    : "";

  const system = personaBlock + knowledgeBlock;

  // ---- VARIABLE SUFFIX: retrieved tweets + live data + user turn. ----
  const tweetsBlock = citations.length
    ? `SOURCE TWEETS (cite by id):\n` +
      citations.map((c) => `[${c.ref}] (${c.date}) ${c.snippet}`).join("\n")
    : `SOURCE TWEETS: (none retrieved)`;

  const dataBlock = market.quotes.length
    ? `LIVE MARKET DATA (as of now):\n` +
      market.quotes.map(fmtQuote).join("\n") +
      (market.klineText ? `\n\nRecent daily candles for ${market.primary?.symbol}:\n${market.klineText}` : "")
    : `LIVE MARKET DATA: (no specific instrument detected in the question)`;

  const messages: { role: string; content: string }[] = [{ role: "system", content: system }];
  for (const h of history.slice(-6)) messages.push({ role: h.role, content: h.content });
  messages.push({
    role: "user",
    content: `${tweetsBlock}\n\n${dataBlock}\n\n=== USER QUESTION ===\n${userMessage}`,
  });
  return messages;
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
    headers: {
      "Content-Type": "application/json",
      // Gateway-level auth (governor):
      "cf-aig-authorization": `Bearer ${env.CFGATEWAYKEY}`,
      // Provider (OpenRouter) key, passed through by the gateway:
      Authorization: `Bearer ${env.OPENROUTER_KEY || ""}`,
      "HTTP-Referer": "https://robindex.ai",
      "X-Title": "Robindex",
    },
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
