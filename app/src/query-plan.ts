import type { Env } from "./env";
import { completeChat } from "./chat";

// Step 1 of retrieval: a cheap/fast model turns the user question into a STRUCTURED query plan
// (not a single FTS5 string). rag.ts then runs one FTS5 route per facet of the plan and merges.

export interface RelatedEntity {
  name: string;
  weight: number;
}
// A tradable instrument the planner spotted in the question. We feed name/ticker straight into the
// quote resolver (which validates against the live feed) — so price/news fetch needs NO extra LLM call.
export interface PlannedInstrument {
  name: string;          // company/ETF/crypto name or symbol as written
  ticker: string;        // best-guess ticker (e.g. SOXL, NVDA, 00700, 600519, BTC)
  market: string;        // us | hk | a | crypto | unknown
}
export type RouteMode = "quick" | "deep";
export interface QueryPlan {
  intent: string;
  route: RouteMode;            // quick = answer from corpus/persona only (no tool phase); deep = needs live data/tools
  needs_tools: boolean;        // true → run the tool phase (live prices/timing/financials/news/comparison)
  instruments: PlannedInstrument[];
  exact_entities: string[];
  aliases: string[];
  concepts: string[];
  related_entities: RelatedEntity[];
  required_stances: string[];
  exclude_topics: string[];
}

export const EMPTY_PLAN: QueryPlan = {
  intent: "",
  route: "deep",       // safe default: if classification fails, assume deep (keep tools)
  needs_tools: true,
  instruments: [],
  exact_entities: [],
  aliases: [],
  concepts: [],
  related_entities: [],
  required_stances: [],
  exclude_topics: [],
};

const PLAN_SYS =
  "You are the retrieval brain of a finance-KOL research assistant. The KOL's past tweets are stored " +
  "as ORIGINAL TEXT and searched with a substring full-text index — there is NO semantic/vector layer, " +
  "so a tweet is only found if the search terms literally appear in it. Your job: expand the user's " +
  "question into the actual WORDS that a relevant tweet would contain, in BOTH Chinese and English " +
  "(the corpus mixes the two). This bilingual expansion is the ONLY thing bridging language — do it well.\n\n" +
  "Think: 'If the KOL had written about this, what exact words/tickers/phrases would be in that tweet?' " +
  "Then output ONLY this JSON object (no markdown):\n" +
  "{\n" +
  '  "intent": "<one line: what kind of past view we are looking for>",\n' +
  '  "route": "quick" | "deep",\n' +
  '  "needs_tools": true | false,\n' +
  '  "instruments": [{"name":"<as written>","ticker":"<real ticker e.g. SOXL/NVDA/00700/600519/BTC>","market":"us|hk|a|crypto|unknown"}],\n' +
  '  "exact_entities": ["<named tickers/companies/people/products — keep tight & literal>"],\n' +
  '  "aliases": ["<every alternate surface form: CN name, EN name, ticker, abbreviation, codename, common misspelling — e.g. 英伟达, NVDA, Nvidia, 老黄>"],\n' +
  '  "concepts": ["<the ideas/themes as words that would actually appear in a tweet, each given in BOTH 中文 AND English, prefer 3+ char terms, include domain jargon>"],\n' +
  '  "related_entities": [{"name":"<adjacent ticker/person/product likely co-mentioned>","weight":0.0-1.0}],\n' +
  '  "required_stances": ["<attitude words to look for: 看多 看空 支持 质疑 担忧 评价 ...>"],\n' +
  '  "exclude_topics": ["<topics that would be off-target>"]\n' +
  "}\n\n" +
  "Rules:\n" +
  "- For EVERY concept and entity, give BOTH a Chinese and an English surface form (e.g. 流动性/liquidity, " +
  "准备金/bank reserves, 快速迭代/rapid iteration, 火星殖民/Mars colonization, 钱荒/liquidity squeeze).\n" +
  "- Prefer the words the KOL would really type (tickers, $cashtags, jargon, slang) over textbook phrasing.\n" +
  "- Be generous on aliases & concepts (recall is won here); keep exact_entities literal and tight.\n" +
  "- Expand to the CONCRETE, mechanism-level vocabulary a domain expert would actually type (the specific " +
  "metrics, programs, codenames, products, jargon — in BOTH 中文 and English), not just the surface words " +
  "from the question. Think about which exact words a relevant tweet would contain.\n" +
  "- COVER THE ECOSYSTEM: include the closely-linked names the KOL discusses alongside the subject " +
  "(related/competitor tickers, key people, sub-products) in related_entities and aliases.\n" +
  "- instruments: only genuinely tradable things; give the real ticker, leave it empty if unsure (never guess wildly).\n\n" +
  "ROUTE CLASSIFICATION (critical for speed — this decides whether we spend extra seconds on live data):\n" +
  'Set route="quick" and needs_tools=false when the answer lives in the KOL\'s CORPUS/methodology and does NOT ' +
  "depend on fresh live data — e.g. asking the persona's view/opinion/framework on a company/sector/theme " +
  "(他怎么看 / 怎么看 X / 怎么看 AI 泡沫), verifying a past stance (验证观点), definitional or framework " +
  "questions, '他的逻辑是', '为什么', comparing the persona's positions. These are answered from past tweets.\n" +
  'Set route="deep" and needs_tools=true ONLY when the user explicitly wants CURRENT actionable data the ' +
  "corpus cannot supply: live price / 现在 / 今天 / 现在 该不该买 / 该不该抄底 / 现价, intraday or recent " +
  "K-line/走势/技术面, fresh news/事件/利好利空/政策, fundamentals/财务/估值/财报/PE, multi-name live " +
  "comparison, market-wide ranking/资金流/龙虎榜/板块. When unsure, prefer quick (the pre-fetched quote for " +
  "any named instrument is still injected for context).";

function strArr(v: any, max = 16): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => typeof x === "string" && x.trim().length >= 1).map((x) => x.trim()).slice(0, max);
}

export async function planQuery(
  env: Env,
  model: string,
  userQuestion: string,
  tickers: string[]
): Promise<QueryPlan> {
  const usr =
    `Question: ${userQuestion}\n` +
    `Instruments already detected (treat as exact_entities): ${tickers.join(", ") || "none"}`;
  try {
    const raw = await completeChat(
      env,
      model,
      [
        { role: "system", content: PLAN_SYS },
        { role: "user", content: usr },
      ],
      { maxTokens: 500, temperature: 0.2 }
    );
    const obj = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || "{}");
    const related: RelatedEntity[] = Array.isArray(obj.related_entities)
      ? obj.related_entities
          .filter((r: any) => r && typeof r.name === "string")
          .map((r: any) => ({ name: r.name.trim(), weight: Math.max(0, Math.min(1, Number(r.weight) || 0.4)) }))
          .slice(0, 10)
      : [];
    const instruments: PlannedInstrument[] = Array.isArray(obj.instruments)
      ? obj.instruments
          .filter((x: any) => x && (typeof x.name === "string" || typeof x.ticker === "string"))
          .map((x: any) => ({
            name: String(x.name || x.ticker || "").trim(),
            ticker: String(x.ticker || "").trim(),
            market: String(x.market || "unknown").trim().toLowerCase(),
          }))
          .filter((x: PlannedInstrument) => x.name || x.ticker)
          .slice(0, 4)
      : [];
    const plan: QueryPlan = {
      intent: typeof obj.intent === "string" ? obj.intent.slice(0, 240) : "",
      route: obj.route === "quick" ? "quick" : "deep",
      // needs_tools defaults to route==deep; explicit false always honored, explicit true forces tools.
      needs_tools: obj.needs_tools === false ? false : obj.needs_tools === true ? true : (obj.route !== "quick"),
      instruments,
      exact_entities: strArr(obj.exact_entities),
      aliases: strArr(obj.aliases),
      concepts: strArr(obj.concepts, 20),
      related_entities: related,
      required_stances: strArr(obj.required_stances, 8),
      exclude_topics: strArr(obj.exclude_topics, 10),
    };
    // Always fold in detected tickers as exact entities.
    for (const t of tickers) if (t && !plan.exact_entities.includes(t)) plan.exact_entities.push(t);
    return plan;
  } catch {
    return { ...EMPTY_PLAN, exact_entities: [...tickers] };
  }
}
