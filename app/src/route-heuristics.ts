import type { QueryPlan } from "./query-plan";

const QUICK_CORPUS_INTENT =
  /(怎么看|看待|观点|框架|逻辑|为什么|复盘|验证|是否泡沫|泡沫|他怎么看|如何理解|view|opinion|framework|thesis|bubble)/i;
const DEEP_LIVE_INTENT =
  /(现在|今天|今日|现价|走势|k线|技术面|该不该|能不能买|可以买|要不要买|买入|卖出|抄底|加仓|减仓|仓位|新闻|消息|事件|利好|利空|财报|估值|pe|资金流|龙虎榜|排名|price|today|current|trend|buy|sell|news|earnings|valuation)/i;

function surfaceTerms(text: string): string[] {
  const terms = new Set<string>();
  for (const m of String(text || "").matchAll(/\$?[a-z][a-z0-9.]{1,12}|[\u3400-\u9fff]{2,8}/gi)) {
    const t = m[0].replace(/^\$/, "").trim();
    if (t.length >= 2) terms.add(t);
  }
  return Array.from(terms).slice(0, 18);
}

export function isLikelyCorpusOnlyQuestion(question: string): boolean {
  const q = String(question || "");
  return QUICK_CORPUS_INTENT.test(q) && !DEEP_LIVE_INTENT.test(q);
}

export function fallbackQuickPlan(question: string): QueryPlan {
  const terms = surfaceTerms(question);
  return {
    intent: "KOL corpus-only viewpoint/framework question",
    route: "quick",
    needs_tools: false,
    instruments: [],
    exact_entities: [],
    aliases: terms,
    concepts: terms,
    related_entities: [],
    required_stances: [],
    exclude_topics: [],
  };
}
