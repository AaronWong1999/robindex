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
  "You plan retrieval for a finance-KOL assistant. Tweets are searched by literal original text, no vectors. " +
  "Expand the question into the exact Chinese/English words, tickers, aliases, jargon, products, people, and mechanisms a relevant tweet would contain. " +
  "Output ONLY compact JSON with this shape:\n" +
  '{"intent":"","route":"quick|deep","needs_tools":false,"instruments":[{"name":"","ticker":"","market":"us|hk|a|crypto|unknown"}],"exact_entities":[],"aliases":[],"concepts":[],"related_entities":[{"name":"","weight":0.4}],"required_stances":[],"exclude_topics":[]}\n' +
  "Keep arrays tight but recall-oriented: exact_entities literal; aliases/concepts bilingual; related_entities adjacent names the KOL likely co-mentions. " +
  "instruments are only tradable things; use real tickers when confident.\n" +
  "Route is LLM-owned: quick/needs_tools=false for corpus methodology, past stance, viewpoint, framework, why/how, verification, bubble/theme questions. " +
  "deep/needs_tools=true for current actionable data: live price, today/now buy-sell timing, K-line/trend/technical, fresh news/events, fundamentals, valuation/financials, market ranking/fund flow. " +
  "When unsure, prefer quick; named instruments still get prefetched live quote context outside tools.";

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
      { maxTokens: 360, temperature: 0.2 }
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
