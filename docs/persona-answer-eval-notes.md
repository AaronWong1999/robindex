# Persona Answer Evaluation Notes

This file tracks qualitative comparisons between Robindex KOL personas and competitor answers. The goal is to identify repeatable product and algorithm changes, not to tune against a single prompt.

## 2026-06-26 Decision: Keep Current Production Persona, Freeze New Distill Candidate

The latest full-corpus persona distillation experiment should be treated as **failed for production replacement** for now.

What happened:

- A new full-corpus `persona_facts:merged` candidate was generated for `qinbafrank` and `aleabitoreddit`.
- The candidate improved some "direct answer / price range" behavior on DRAM-style questions.
- But it failed badly on CRCL-style questions:
  - one answer had ticker/entity confusion;
  - one answer leaked tool-call JSON/DSL in the draft preview path;
  - Serenity's candidate also showed language drift because much of the persona pack is English.
- The eval gate rejected the candidate; the live `kols.persona_pack` was not overwritten.

Conclusion:

- Do **not** publish the new candidate persona pack without another round of design and user review.
- Keep the current production `v2-mapreduce` persona packs.
- Future distillation changes must be compared side-by-side on real user questions before publication.
- Candidate improvements can still inform prompt/runtime changes, but should not replace the old persona globally.

Important nuance:

- The new candidate is not necessarily shorter because it skipped data. Full-corpus chunk/reduce records exist.
- It is shorter/cleaner partly because the new distill prompt intentionally removed `honest_boundaries`, `uncertainty_style`, disclaimers, and prohibition-style items.
- That cleanup is directionally right, but the whole candidate still regressed on robustness.

## Minimal Fix Direction For Current Production Persona

We should **not** solve the price-answering issue by replacing the persona pack yet. The smallest useful fix is in the inference/final-answer contract.

Observed production issue:

- Existing persona packs can contain cautious style, old "Agentic Protocol" text, or examples where the KOL avoids exact point prediction.
- When the user asks "今天该不该买 / 什么价格挂单 / 什么价格卖", the model sometimes over-respects that cautious style and answers with principles instead of usable conditional ranges.

Minimal production fix:

1. Keep current live `persona_pack`.
2. Do not add a new product mode.
3. Do not change distillation output yet.
4. Strengthen the final prompt only when the latest user question asks for price/action levels.
5. Use already-fetched live quote/kline/news/profile data.
6. Require conditional ranges, not fake precision.

Recommended final-prompt rule:

```text
If the latest user question asks for a price, action level, entry, exit, trim, add, stop, order, buy zone, or sell zone, answer that request directly first.
Do not stop at principles or say only that the persona does not provide exact points.
Translate the persona's framework into bounded conditional ranges using LIVE MARKET DATA.
Use ranges and conditions, not a single fake-precise number.
If data is missing, say what is missing and give a range-derivation method instead of refusing.
```

Expected answer shape:

```text
先给结论：
- 今天：买 / 不买 / 等财报后 / 只适合小仓试。
- 买入：第一档 X-Y；更深一档 A-B；如果跌破 B 且基本面变量变坏，就不要接。
- 卖出/减仓：反弹到 M-N 可以减；突破并站稳 P 再看新高。
- 打脸条件：...

然后再展开 KOL 风格的逻辑、引用和风险。
```

Why this is the right first step:

- It directly addresses the user experience gap.
- It does not risk persona regression.
- It does not add a new route/mode.
- It can be A/B tested against the same DRAM/CRCL questions.
- It preserves KOL caution by making ranges conditional instead of pretending to give guaranteed signals.

What not to do yet:

- Do not publish the new distill candidate.
- Do not add a separate `trade_decision` mode.
- Do not introduce more hard-coded ticker-specific logic.
- Do not rely on persona cleanup alone to fix answer actionability.

## Current Hypothesis: Actionable Trading Questions

Observed issue: Robindex personas are usually stronger on KOL logic, evidence, and voice, but can under-answer users who ask for immediate execution guidance such as "should I buy today?", "what price should I bid?", "how much position?", or "can it return to the high?"

This does not appear to be caused mainly by excessive safety guardrails. It is more likely caused by three system gaps:

1. Persona distillation captures worldview and analytical frameworks, but not enough of the KOL's execution style.
2. Tools fetch quotes, candles, fundamentals, and news, but do not synthesize deterministic trading context such as supports, drawdowns, volatility, event risk, and ladder-entry levels.
3. The final prompt asks the model to answer directly, but does not force a structured conditional execution plan when the user asks for a trade action.

## Proposed Algorithm Improvements

Revision after reviewing the current code path:

The earlier idea of adding a separate `trade_decision` mode is probably too heavy for the current architecture. The product need is real, but it does not require a new route/mode at first.

Current runtime already has these routing concepts:

- `quick`: corpus/persona-only route, minimal live tool work.
- `deep`: live-data route for current/actionable/market questions.
- `needs_tools`: boolean controlling whether the LLM tool phase should run.
- Retrieval mode at KOL level: `tagged` vs `query_side`.

So the system already has at least two user-visible answer routes and one KOL retrieval strategy dimension. Adding a third answer mode called `trade_decision` would increase branching, testing, observability, and future prompt drift. The lower-risk path is to keep the existing `quick/deep` route and add an "actionability contract" only when the user wording requires it.

### Recommended Minimal Change: Actionability Contract, Not A New Mode

Do not add a new route. Instead:

1. Keep `plan.route = deep` for current buy/sell questions.
2. Add a deterministic helper such as `detectActionRequest(userMessage)` that returns booleans:
   - `asks_now_decision`
   - `asks_buy_price`
   - `asks_sell_price`
   - `asks_position`
   - `asks_invalidation`
3. If any flag is true, append a short `ACTIONABILITY REQUIREMENTS` block to the final user instruction.
4. If market data is available, inject a compact `EXECUTION CONTEXT` block derived from the already-fetched quote/kline, not from model imagination.

This changes output behavior without creating a new pipeline branch.

Example final-instruction addition:

```text
The user is asking for an actionable trading decision.
Before the long analysis, include a compact decision box:
- 今天买不买 / 等不等
- 如果非要买: conditional bid range(s)
- 如果已持有或想卖: trim/sell range(s)
- 打脸条件 / 什么时候不做

Do not give fake precision. If the persona dislikes chart-based trading, say that, but still translate the framework into conditional execution ranges using LIVE MARKET DATA.
Use ranges, not single exact prices.
```

The important nuance is the last line: we do not make Serenity pretend to love TA, but we do make her answer the user's order-placement need.

### Add Deterministic Execution Context

The current `gatherMarketData()` already fetches:

- live quote: price, open/high/low, previous close, volume
- recent daily candles
- financial profile
- stock/macro news

For action questions, add a small derived block:

- current price and day change
- intraday high/low
- 5/10/20 day high and low
- drawdown from recent high
- rebound from recent low
- simple volatility proxy: average daily range over recent candles
- nearest recent support/resistance candidates from prior highs/lows

This can be done inside the existing prefetch path. No new external data source is required.

The final LLM should be instructed to use these levels as "execution ranges" and cite the KOL sources for the logic, not for the exact technical numbers.

### Why This Should Fix The Observed Problem

The four eval cases show a consistent pattern:

- Robindex usually wins on KOL fidelity and citation quality.
- The competitor often wins when it gives a clean order ladder.
- In the Qinbafrank CRCL case, Robindex won because it happened to provide both buy and sell zones.
- In the Serenity CRCL case, Robindex lost actionability because it stayed too faithful to "no TA / no specific action" and did not translate the framework into a usable ladder.

So the issue is not mostly missing tools or excessive guardrails. It is a final-answer contract issue: when the user explicitly asks for action, the model must answer in an action-shaped way while preserving persona caveats.

### Implementation Scope Ranking

Low-risk first patch:

- Add regex/keyword `detectActionRequest`.
- Add `buildActionabilityInstruction(flags)` and append it to the final generation prompt.
- Add `deriveExecutionContext(market.klineText, market.primary)` and append it to the variable context only when action flags are true.
- No DB migration, no persona schema migration, no new route.

Medium-risk follow-up:

- Distill `execution_style` and `action_templates` into persona metadata.
- Use that to tune how direct each KOL is.
- Example: Serenity can say "I don't trade off TA, but here is how I'd translate the framework"; Qinbafrank can say "个人角度不猜精确底，但如果非要挂，分几档看".

High-risk / defer:

- Add a new `trade_decision` mode or route.
- Add a separate trading-agent prompt.
- Add separate eval harness and product UI state for trading mode.

Recommendation: defer this until the lightweight contract fails in eval.

### Concrete Target Answer Shape

For user questions like:

> 今天该不该买？应该什么价格挂单买入？什么价格挂单卖出？

Answer should start with something like:

```text
先给结论：
- 今天：不建议追，除非你接受左侧试错。
- 买入：第一档 X-Y；更深一档 A-B；如果跌破 B 且基本面变量变坏，就不要接。
- 卖出/减仓：短线反弹到 M-N 可以减；如果长期逻辑兑现则另看。
- 打脸条件：...
```

Then continue with the persona-style reasoning and citations.

This structure directly addresses the user's job without turning the product into an unbounded trading-signal engine.

### Model-First Variant: Let The Planner Decide Answer Requirements

If we want to avoid building a brittle keyword/regex classifier, the best path is to reuse the existing LLM query planner. The system already calls `planQuery()` before retrieval and market data fetch. That planner is a better place to ask: "what kind of answer does the user need?"

Current behavior:

- The main classification is model-based: `planQuery()` outputs `quick/deep`, `needs_tools`, instruments, entities, concepts, etc.
- There are regex fallbacks in `index.ts` / `chat.ts` for news/current-market/tool coverage, but they mainly decide whether to fetch more data, not how the final answer is shaped.
- There is no explicit rule saying "do not answer price questions."

Observed likely cause:

- The system prompt already says "first answer the user's concrete decision/question directly" and "use live market data."
- But it also says "not investment advice", and the persona pack may contain cautious habits such as not giving exact trade instructions.
- For a persona like Serenity, the retrieved source tweets repeatedly say fundamentals matter more than charts, so the model overgeneralizes that into refusing any buy/sell levels.
- Therefore the problem is less "tool missing" and more "the final answer contract does not override soft refusal when the user explicitly asks for execution."

Recommended model-first fix:

Extend the `QueryPlan` JSON schema with an `answer_requirements` object generated by the planner model:

```ts
answer_requirements: {
  direct_decision: boolean;     // user asks should I buy/sell/hold now
  buy_levels: boolean;          // user asks where to bid/buy/add
  sell_levels: boolean;         // user asks where to sell/trim/take profit
  position_sizing: boolean;     // user asks how much / position size
  invalidation: boolean;        // user asks risk/stop/what would change the thesis
  time_horizon: "intraday" | "swing" | "long_term" | "unknown";
  data_needed: ("quote" | "kline" | "news" | "fundamentals" | "macro")[];
}
```

Then the final prompt can be assembled from model-produced requirements instead of our own keyword lists.

Example final instruction:

```text
ANSWER REQUIREMENTS from planner:
direct_decision=true, buy_levels=true, sell_levels=true, invalidation=true.

You must satisfy these requirements in the final answer.
Do not refuse to provide price ranges solely because this is investment-related.
You may say it is not a guarantee and not investment advice, but still provide conditional ranges or a range-derivation method.
If the persona usually avoids exact calls, phrase it as a framework-to-execution translation:
"我不靠精确点位交易，但如果一定要挂单，我会分成..."
```

This keeps the system model-driven while avoiding a new route.

Simpler variant, likely better for v1:

Do not split `buy_levels` / `sell_levels` / `position_sizing` too early. Add one broader planner field:

```ts
answer_requirements: {
  wants_price_or_action_level: boolean; // user asks for any price/level/range/order/entry/exit/stop/trim/add
  wants_current_decision: boolean;      // user asks should I buy/sell/hold now/today
  time_horizon: "intraday" | "swing" | "long_term" | "unknown";
  data_needed: ("quote" | "kline" | "news" | "fundamentals" | "macro")[];
}
```

Then the final prompt only needs one strong rule:

```text
If the user asks for a price, level, order, entry, exit, stop, trim, add, buy zone, or sell zone, you must answer that request with conditional ranges or a clear range-derivation method.
Do not end with "I don't provide specific buy/sell points" when live price/candle data is available.
You may say the range is conditional, not guaranteed, and not investment advice.
```

This leaves the large model to decide whether the requested level is a buy price, sell price, stop, trim zone, or invalidation line. The app only tells the model: "the user asked for a level; do not dodge it."

This is probably the best first implementation because it avoids overfitting the planner schema before we have more eval cases.

### Quick vs Deep Route: Current Behavior And Simplification Proposal

Current code path:

- `planQuery()` asks a small/fast model to output `route: "quick" | "deep"` and `needs_tools`.
- The prompt says:
  - `quick/needs_tools=false`: corpus methodology, past stance, viewpoint, framework, why/how, verification, bubble/theme questions.
  - `deep/needs_tools=true`: current actionable data, live price, today/now buy-sell timing, K-line/trend/technical, fresh news/events, fundamentals, valuation/financials, market ranking/fund flow.
- Regardless of route, named instruments still get pre-fetched live quote context through `gatherMarketData()`.
- `shouldRunToolPhase()` then uses a few regex fallbacks to decide whether the extra LLM tool-calling phase is needed. If quote + kline + profile + relevant news are already pre-fetched, it often skips the tool phase even for deep stock questions.

So `quick/deep` currently does two jobs:

1. It tells retrieval/final generation whether the question needs current/live context.
2. It helps decide whether to spend latency on the tool-calling phase.

Question: is `quick/deep` truly necessary?

Probably useful, but it should not become a product "mode". It is useful as an internal cost/latency control:

- Quick avoids unnecessary market/news/tool work for pure persona questions like "你怎么看某个框架", "这个 KOL 过去怎么判断 CPO", "他的方法论是什么".
- Deep is needed for anything time-sensitive: "今天", "现在", "最近", price, buy/sell, news, earnings, valuation.

But it should not control whether the model is allowed to answer actionably. The final answer should be driven by `answer_requirements`, not by route name.

Recommended simplification:

- Keep `route` internally for cost/latency only.
- Rename conceptually in code/comments later if useful:
  - `route=quick` → `freshness="corpus_only"`
  - `route=deep` → `freshness="live_context"`
- Add `answer_requirements` as a separate field:
  - `wants_price_or_action_level`
  - `wants_current_decision`
  - `time_horizon`
  - `data_needed`
- Final prompt should read `answer_requirements`, not `route`.

Minimal v1 schema:

```ts
interface QueryPlan {
  intent: string;
  route: "quick" | "deep"; // keep for now: controls freshness/cost, not answer shape
  needs_tools: boolean;
  instruments: PlannedInstrument[];
  exact_entities: string[];
  aliases: string[];
  concepts: string[];
  related_entities: RelatedEntity[];
  required_stances: string[];
  exclude_topics: string[];
  answer_requirements?: {
    wants_price_or_action_level: boolean;
    wants_current_decision: boolean;
    time_horizon: "intraday" | "swing" | "long_term" | "unknown";
    data_needed: ("quote" | "kline" | "news" | "fundamentals" | "macro")[];
  };
}
```

Practical rule:

- `route` answers: "how much live data/tool work should we spend?"
- `answer_requirements` answers: "what must the final answer contain?"

This separation avoids adding a new user-facing mode and reduces the risk that `deep` becomes a grab bag of unrelated behavior.

Observed on the four DRAM/CRCL eval chats:

- `resp.toolCalls` was `[]` for all four saved `chat_history` records.
- So these chats did not enter the extra LLM tool-calling phase.
- They used:
  - planner LLM
  - deterministic market/news/profile prefetch
  - tweet retrieval, possibly with rerank
  - final answer LLM
- The "18 sources" visible in UI is the deep retrieval citation cap (`KEEP=18`), not 18 tool calls.

Architectural implication:

- For normal stock/action questions, deterministic prefetch already covers most "deep" needs.
- The expensive extra tool phase is not the main issue in the observed cases.
- The main issue remains final-answer obligations: the model had enough data but sometimes declined to translate it into price ranges.

Potential simplification:

- Keep a freshness decision, but consider replacing `quick/deep` with planner fields:
  - `needs_live_context: boolean`
  - `needs_extra_tool_phase: boolean`
  - `answer_requirements`
- This would make the route semantics clearer:
  - live context and extra tool calls are cost/data decisions
  - answer requirements are output-shape decisions

Do not merge everything blindly before measuring:

- Removing `quick/deep` would not necessarily save one LLM call, because planner is still needed for query expansion and instrument detection.
- To save a model call, we would need to remove or replace `planQuery()` itself, not just merge route labels.
- But `planQuery()` is doing more than route classification: it expands bilingual search terms, tickers, aliases, concepts, related entities, and required stances. Removing it could hurt retrieval quality.

Recommended v1:

- Keep `planQuery()`.
- Simplify its route semantics to `needs_live_context` and `needs_extra_tool_phase` later.
- Add `answer_requirements`.
- Add observability for retrieval:
  - route / needs_tools
  - pool size / keep size
  - rerank_used
  - rerank_skip_reason
  - top IDs before rerank and after rerank

Only after we have that telemetry should we decide whether LLM rerank is worth its cost.

Updated decision:

- Keep rerank for now.
- Do not add retrieval telemetry yet; avoid extra complexity until there is a stronger reason.
- Keep planner, but stop thinking in terms of product modes like `quick` vs `deep`.
- Planner should answer data questions:
  - Does this need live quote?
  - Does this need kline/candles?
  - Does this need news or event scan?
  - Does this need fundamentals/valuation?
  - Does this need macro/market context?
- Final answer contract should answer output questions:
  - Did the user ask for a price/range/action?
  - Did the user ask whether to buy/sell/hold now?
  - Did the user ask for risk/invalidation?

The user question itself should be the main source of answer requirements. We do not need heavy classification. The planner can expose a light flag only to stop the final model from losing the user's requested action under persona/style/safety/citation pressure.

### Event Risk Must Be Front-Loaded For Action Questions

For `wants_current_decision=true` or any price/action-level request, the final answer should first identify near-term event risk:

```text
Before giving buy/sell ranges, identify the most important event risks in the next 48 hours.
If there is an earnings report, FOMC/CPI/PPI event, major regulatory vote/headline, geopolitical shock, or known company catalyst, mention it up front and explain how it changes the timing.
```

Why this matters:

- In the DRAM case, the decisive short-term variable was Micron earnings.
- Robindex retrieved and mentioned MU earnings in some answers, but did not consistently front-load it as the reason not to rush the order.
- For trading questions, event timing is part of the answer, not background context.

Answer shape:

```text
先说今天/48小时事件风险：
- 今晚/明天有什么事件；
- 它会影响什么变量；
- 所以买卖时点应该等、试、还是分批。

再给挂单/减仓/打脸条件。
```

### Dynamic Citation Budget

The current route logic uses:

```ts
KEEP = quick ? 14 : 18
```

That is simple but too blunt. More citations are not always better.

Recommended dynamic policy:

- Normal range should be 8-18 citations when the KOL corpus has enough relevant material.
- Plain single-instrument question: retrieve enough, but final answer should rely on 8-12 strongest sources.
- Broad theme / multi-factor / macro + sector question: 14-18 sources can be useful.
- If the KOL has very few relevant source tweets for that topic, use fewer and explicitly say coverage is thin.
- Right-side source panel may keep more sources for transparency.
- Final answer should be forced to use the most relevant 8-18 citations depending on question breadth and source availability, not a fixed count.

Practical implementation:

- Retrieval can keep `panel_citations` up to 18.
- Final prompt can receive or emphasize `answer_citations` top 8-12.
- Or simpler v1: keep sending 18, but prompt says:

```text
Use only the strongest, directly relevant citations in the answer. Do not cite sources just because they were retrieved.
For a single-stock/action question, 8-12 citations is usually enough when the corpus has enough relevant material.
```

This should reduce answer sprawl while preserving the right panel's evidence richness.

### Tool/Data Handling For Price Questions

For questions asking current price, bid, sell, support/resistance, or "today":

- The planner should mark `data_needed` with `quote` and usually `kline`.
- `gatherMarketData()` already prefetches validated quote and daily candles for detected instruments.
- If the user asks "最近" or there is event risk, `news` should also be included.
- If the user asks valuation/long-term "贵不贵", include `fundamentals`.

Important: if prefetch already has quote + kline + profile, we do not need an extra tool phase. The model can answer from the injected live data. If a required data type is missing, either run the tool phase or explicitly say the level is less grounded.

### Prompt Change To Remove Soft Refusal

Add a stronger instruction in the final generation step:

```text
If the user asks for a buy/sell/bid/trim price, you must answer that part.
Do not answer only with broad principles.
Give conditional ranges, not a single guaranteed target.
Allowed: "如果非要今天挂，我会看 X-Y；更稳的是等 A；反弹到 M-N 我会考虑减。"
Not allowed: "我不提供具体买卖点，你自己决定" unless no live price data is available.
```

This is not removing risk boundaries. It is replacing refusal with bounded, conditional execution.

The "not investment advice" sentence should probably move to UI/footer or remain one short footer. It should not be the semantic center of the answer.

### Earlier Option: Add A Trade Decision Intent

Detect questions containing terms such as:

- 买不买 / 能不能买 / 该不该买
- 今天 / 现在 / 当前
- 挂单 / 价格 / 买入价
- 加仓 / 减仓 / 仓位
- 抄底 / 追高 / 止损 / 止盈
- 回到高点
- 财报前 / 财报后 / 盘前 / 盘后

Earlier idea: when detected, route the answer through a `trade_decision` mode rather than ordinary deep analysis.

Current recommendation: do not introduce this as a new route yet. Use the existing `deep` route plus an actionability contract.

Required response shape:

1. Direct conclusion first: buy / do not buy / only small position / wait for confirmation.
2. Two or three conditional scenarios.
3. Each scenario maps to an action: wait, small starter, ladder bid, add, reduce, abandon.
4. If the user asks for a bid price, provide a range or a method for deriving the range.
5. Always state invalidation conditions.

This should not produce unconditional investment advice. It should produce bounded, scenario-based execution guidance.

### 2. Distill Execution Style Into Persona JSON

Extend persona distillation with fields such as:

```ts
execution_style: {
  directness: string;
  gives_price_levels: "often" | "conditional" | "rarely";
  position_sizing_style: string;
  risk_language: string;
  invalidation_style: string;
}

trade_playbooks: [
  {
    trigger: "earnings-week buy / panic dip / high-level pullback / valuation reset",
    answer_pattern: "classify valuation reset vs earnings reset vs thesis break, then map scenarios to actions",
    evidence: ["verbatim quote"]
  }
]

action_templates: [
  {
    user_intent: "asks whether to buy today",
    response_shape: "conclusion -> key variables -> ladder plan -> invalidation"
  }
]
```

Extraction should prioritize tweets containing terms like 买, 卖, 加仓, 减仓, 仓位, 抄底, 追高, 回调, 止损, 止盈, 挂单, 等, 财报, 指引, 杀估值, 杀逻辑, 上车机会.

### 3. Add Deterministic Execution Context

For `trade_decision` questions, compute and inject an `EXECUTION CONTEXT` block before final generation:

- current price and intraday move
- 5/10/20 day high and low
- drawdown from recent high
- distance to 20D/50D moving averages
- recent average daily range or ATR-like volatility
- prior breakout / prior low / recent support and resistance candidates
- known event risk such as earnings tonight
- relevant analyst target/forward valuation only as context, not as a direct buy point

The final model should not invent trading levels. It should use this deterministic context and the KOL's playbook to turn levels into conditional actions.

### 4. Prompt Change For Trade Mode

Append a dynamic instruction only for trade intent:

```text
The user is asking for an actionable trading decision. Do not stop at broad analysis.
If exact certainty is impossible, give conditional execution ranges.
Use language like: "如果你非要今天挂，我会...；更稳的是...；打脸条件是..."
Do not give a single unconditional command. Give a scenario-based plan.
```

### 5. Evaluation Track

Add a dedicated eval slice for trade-action prompts:

- Does the answer directly address the user's action?
- Does it provide scenario-based levels or a level derivation method?
- Does it keep KOL voice?
- Does it cite relevant source tweets?
- Does it avoid fabricated precision?
- Does it state invalidation conditions?

## Case 1: Qinbafrank, DRAM Buy/Hang-Order Question

Prompt:

> 今天你觉得应该买 DRAM么，你怎么看 DRAM 目前的情况，他还能回到高点么，我今天应该在什么价格挂单买入？

Robindex answer summary:

- Directly said not to bid today; wait for MU earnings.
- Correctly used Qinbafrank's frameworks: memory cycle, supply/demand, MU earnings "not just strong, but how long strong", true bottleneck vs theme-related, macro denominator pressure.
- Used 18 citations and broad source coverage.
- Felt closer to Qinbafrank's "personal angle, wait for variables, avoid guessing bottom" style.

Competitor answer summary:

- More immediately useful to a trader because it gave concrete levels such as 1005-1015 and 855-870.
- But it sounded like a generic research report, not Qinbafrank.
- Citation coverage was weak: only one cited source, while many PE/PEG/SMA/technical level claims were not traceable to the KOL source corpus.
- More risk of fabricated precision.

Evaluation:

| Dimension | Robindex | Competitor |
| --- | ---: | ---: |
| KOL logic fidelity | 8/10 | 6/10 |
| KOL voice fidelity | 7.5/10 | 4.5/10 |
| Citation coverage | 8.5/10 | 3/10 |
| Solves user's immediate action need | 6.5/10 | 8/10 |
| Risk boundary | 8/10 | 5.5/10 |
| Overall | 7.7/10 | 5.8/10 |

Takeaway:

Robindex is better as a true KOL persona. Competitor is better at giving a trader a number. The product gap is not "more confidence"; it is conditional execution structure.

## Case 2: Serenity, DRAM Buy/Hang-Order Question

Prompt:

> 今天你觉得应该买 DRAM么，你怎么看 DRAM 目前的情况，他还能回到高点么，我今天应该在什么价格挂单买入？

Robindex answer summary:

- Stronger than the Qinbafrank version on directness. It says: "买，但不是无脑接飞刀."
- Correctly recognizes DRAM as a memory exposure ETF and cites Serenity's own post saying DRAM is a genuinely great ETF for memory exposure.
- Uses Serenity's recurring memory-supercycle logic: hyperscaler demand, memory shortage, NAND/DRAM price hikes, forward PE, MU/SK Hynix/Samsung/SNDK basket, fundamentals eventually taking over.
- Gives a concrete-ish execution zone: watch the 1000-1020 area, and if it breaks 1000 on emotion while fundamentals remain unchanged, that can be a better entry.
- Uses 18 Serenity citations, including highly relevant source tweets on DRAM ETF, memory cycle, MU earnings repricing, Counterpoint, NAND/DRAM hikes, Phison interview, forward PE, and TurboQuant/Jevons.

Competitor answer summary:

- Gives a clear "do not blindly bid before earnings" conclusion.
- Provides concrete levels: 950-1000 as light-entry zone and 850-880 as defense / heavy-entry zone.
- Includes invalidation conditions: gross margin guide below expectations, HBM4 timeline delay, architecture shift.
- But it leans into generic Chinese research-report structure and adds claims that feel less Serenity-like, such as heavy White House / Made in America framing and CPO substitution as DRAM invalidation.
- It cites 6 tweets, but appears less current than Robindex's 18-source answer and less anchored to the user's exact ETF question.

Evaluation:

| Dimension | Robindex | Competitor |
| --- | ---: | ---: |
| KOL logic fidelity | 8.5/10 | 7/10 |
| KOL voice fidelity | 8/10 | 5.5/10 |
| Citation coverage | 9/10 | 6/10 |
| Solves user's immediate action need | 7.5/10 | 8/10 |
| Risk boundary | 7/10 | 7.5/10 |
| Overall | 8.0/10 | 6.8/10 |

Takeaway:

Robindex wins this Serenity case more clearly than the Qinbafrank case because it is both persona-faithful and reasonably actionable. The remaining gap is still execution structure: competitor's bid ladder is cleaner even if its persona fidelity is weaker.

Serenity-specific observation:

Serenity's persona naturally permits more direct trading language than Qinbafrank. For Serenity, the execution playbook should allow stronger directional language when the corpus supports it:

- "I would buy / stay long / buy the dip" style when supported by source tweets.
- Still avoid single-point precision; use ranges and conditions.
- Lean into valuation mismatch and bottleneck economics.
- More compact, less formal, more "here is why people are overthinking it."

## Case 3: Qinbafrank, CRCL Buy/Sell Hang-Order Question

Prompt:

> 最近你怎么看 CRCL，今天该不该买，我如果想买我应该在什么价格挂单，然后在什么价格挂单卖出？

Robindex answer summary:

- Directly answers the action question: short-term sentiment is weak, not an urgent dip-buy.
- Gives actual conditional execution levels: if forcing a left-side test, consider 70-72; if already holding, 80-82 may be a short-term reduce zone.
- Uses relevant Qinbafrank logic: low-float IPO pricing is driven by market trend, narrative expectation, and liquidity sentiment; CRCL's long-term ceiling depends on USDC issuance growth and CPN/non-interest revenue.
- Correctly separates short-term low-float trading from long-term stablecoin infrastructure logic.
- Uses 18 citations, including CRCL/Circle-specific material and macro denominator framework.

Competitor answer summary:

- Has a solid long-term framing: CRCL as "stablecoin market upside + compliant number two", USDC growth, CPN, Coinbase/BlackRock/regulatory positioning.
- Does not really answer the user's explicit sell-order question with a price. It says not to set a short-term target and to use thesis invalidation instead.
- Its buy plan is less concrete: current price as base, then every 5%-10% drawdown as a grid. This is directionally useful, but weaker than a concrete conditional range.
- It sounds more like a generic research memo than Qinbafrank: more formal, more slogan-like, and less like his usual "个人角度 / 核心看几点 / 边际变量" writing rhythm.
- Citation support was not visible/provided in the transcript. The screenshot shows no source cards yet, so source coverage cannot be verified from the provided material.

Evaluation:

| Dimension | Robindex | Competitor |
| --- | ---: | ---: |
| KOL logic fidelity | 8/10 | 7/10 |
| KOL voice fidelity | 7.5/10 | 5.5/10 |
| Citation coverage | 8.5/10 | 2/10 visible |
| Solves user's immediate action need | 8/10 | 5.5/10 |
| Risk boundary | 7.5/10 | 7/10 |
| Overall | 7.9/10 | 5.8/10 |

Takeaway:

This is the first case where Robindex is clearly more useful on the user's immediate trading need. It gives both a buy zone and a sell/reduce zone while preserving Qinbafrank's cautious style. The main remaining issue is answer structure: the actionable plan is buried after several analysis sections. For trade-intent prompts, Robindex should put a compact "decision box" at the top before the deeper KOL-style reasoning.

CRCL-specific algorithm observation:

- The answer did well because source retrieval found the right KOL playbooks: low-float IPO behavior, CPN as long-term ceiling, macro denominator pressure, growth-vs-valuation digestion.
- The next upgrade should make "buy/sell ladder" a first-class output whenever the user explicitly asks both buy and sell prices.
- The model should distinguish "sell because thesis is broken" from "trim because short-term resistance is hit." Users asking for挂单卖出 often mean the latter.

## Case 4: Serenity, CRCL Buy/Sell Hang-Order Question

Prompt:

> 最近你怎么看 CRCL，今天该不该买，我如果想买我应该在什么价格挂单，然后在什么价格挂单卖出？

Robindex answer summary:

- Very persona-faithful to Serenity's source corpus: "fundamentals matter more than charts", watch USDC supply, interest rates, and Clarity Act; do not rely on TA lines.
- Correctly cites Serenity's actual CRCL playbook: liked CRCL at $54 / ~$12B market cap, USDC supply still $70B+, rate cuts hurt but USDC printer keeps going, Clarity Act as a risk.
- It gives a directional answer but refuses the user's explicit buy/sell price request: "I won't give specific buy/sell points."
- It is honest and source-faithful, but under-solves the user need. A user asking for挂单买入/卖出 leaves without a usable execution plan.

Competitor answer summary:

- Much stronger on immediate actionability: first buy order $74.70-$75.60, second buy order $65-$66, short-term sell/trim $105-$110, long-term $130-$150+.
- Gives clear invalidation conditions: USDC supply deterioration, rate collapse, stablecoin legislation setback.
- Persona fidelity is weaker. It sounds like a Chinese structured research desk, not Serenity's more direct X-native style.
- It introduces technical indicators such as RSI and support levels even though Serenity's own corpus repeatedly says fundamentals matter more than charts. This makes the answer less faithful, even if it is more useful for order placement.
- Citation coverage is only 6 visible tweets, but the cited tweets are highly relevant: CRCL at $54, $109 follow-up, fundamentals over TA, AI agent micropayments, stablecoin funding, CRCL as $200 stock at $130.

Evaluation:

| Dimension | Robindex | Competitor |
| --- | ---: | ---: |
| KOL logic fidelity | 8.5/10 | 7/10 |
| KOL voice fidelity | 8/10 | 5.5/10 |
| Citation coverage | 9/10 | 6.5/10 |
| Solves user's immediate action need | 4.5/10 | 9/10 |
| Risk boundary | 7.5/10 | 7.5/10 |
| Overall | 7.1/10 | 7.1/10 |

Takeaway:

This is the clearest conflict case so far. Robindex is much more faithful to Serenity, but the competitor better satisfies the actual "I want to place orders" job. The right product move is not to make Serenity suddenly love TA. It is to add a separate deterministic execution layer that can say: "Serenity would not trade from chart lines, but if you still need order ranges, here is a conditional ladder derived from current price, drawdown, prior high/low, and thesis triggers."

Serenity-CRCL algorithm observation:

- For personas who dislike TA, the model should not pretend the KOL endorses chart-based precision.
- But when the user explicitly asks for buy and sell orders, the system should still provide an "execution translation" section:
  - `fundamental buy condition`: USDC supply stable/growing, Clarity Act risk contained, valuation reset enough.
  - `starter bid`: near current drawdown/support zone, sourced from deterministic market data.
  - `panic bid`: deeper drawdown zone.
  - `trim zone`: prior high / valuation overextension zone.
  - `hard exit`: thesis-breaking conditions.
- Label the section as a translation from framework to execution, not as the KOL's native style.

## Open Product Questions

1. Should trade-decision mode be globally enabled for all KOLs, but parameterized by each KOL's `execution_style`?
2. Should the model always produce a ladder when the user asks for a bid, or only when deterministic execution context is available?
3. Should "not investment advice" be moved to the footer/UI while the answer itself uses KOL-native risk language?
4. How much technical-analysis support should be computed by tools vs inferred by the model?
5. Should the eval harness compare "persona fidelity" and "actionability" separately, so we do not optimize one at the expense of the other?


## Raw Evaluation Dataset

Raw materials captured for later eval dataset construction. Robindex entries are exported from production D1 chat history. Competitor entries are user-provided transcript text.

### Case 1A Raw: Robindex Qinbafrank Answer And Citations

Source chat: `c_cd616b16-e1d8-4f87-9845-b93ec26c6b69`

Prompt:

> 今天你觉得应该买 DRAM么，你怎么看 DRAM 目前的情况，他还能回到高点么，我今天应该在什么价格挂单买入？

Answer raw:

~~~markdown
DRAM今天跌了14个多点，收盘69.22，这个幅度确实不小。但先明确说我的看法：我不建议你今天就去挂单买入，至少等财报尘埃落定再说。

先回答你最直接的问题——能不能回到高点？从基本面看，DRAM作为存储产业链里的一个环节，它的走势跟整个存储周期高度相关。我之前反复聊过，存储的拐点要看供给和需求两条线[9]：供给端，三星、海力士、美光的新产线产能释放要到27年下半年[8]；需求端，AI的快速迭代还在狂飙，长上下文、多模态、agent对存储的消耗非常大[9]。只要这两个条件没变，存储的景气周期就没结束。所以DRAM回到高点是有可能的，但问题在于节奏和时机。

今天为什么跌这么多？核心是美光财报前的恐慌情绪在扩散。美光今晚盘后出财报，市场在提前price in各种可能性。你看MU今天也跌了13个点，WDC跌了8.5个点，整个存储板块都在承压。我之前在美光财报前瞻里详细聊过[1]，这次财报不是简单验证"强不强"，而是要看它能强多久。市场最怕的不是业绩差，而是"好但不够好"——如果指引只是符合预期而不是远超最乐观预期，那前期涨上去的估值就要被消化。

DRAM这个标的本身，我之前的框架里聊过，存储产业链里要区分"真实瓶颈"和"主题相关"[15]。DRAM确实受益于AI需求，但它不是HBM那种最核心的瓶颈环节。HBM的供给紧张程度、技术壁垒和客户绑定深度都远高于普通DRAM[7][11]。所以DRAM的波动性天然就比美光、海力士这些核心存储厂要大，涨的时候跟涨，跌的时候更猛。

关于今天挂单的价格，我很难给你一个精确的数字，因为我的判断体系属于定性不定量[16]。但有几个原则可以参考：第一，等美光财报出来再看，如果MU的指引能到45-49亿收入、EPS 25-30这个区间[1]，那整个存储板块的情绪会被重新提振，DRAM也会跟着反弹；如果指引只是符合预期甚至偏低，那可能还有一波下杀。第二，看整个板块的调整幅度，MU从6月3日高点1089跌到今天1051，其实还没到之前那轮20%的回撤深度[16]，说明调整可能还没完全释放完。第三，注意宏观面——CPI、FOMC、地缘这些分母端的压力还没完全解除[16]，市场情绪的修复需要时间。

所以我的建议是：先观察，别着急。存储的中长期逻辑没变，但短期波动很大，等财报和宏观信号都明朗了再动手，比现在去猜底要安全得多。拿不住的资产，说明你不够了解它。
~~~

Citation raw snippets (18):

#### T1 2026-06-22 https://x.com/qinbafrank/status/2068979504081469789

Tweet id: `2068979504081469789`

~~~text
美光财报前瞻，核心看哪些点？本周AI产业上最重要的事件可能就是美光的财报了，大家会很关心美光财报之后走势进而带动市场如何走，个人角度这次美光财报不是简单验证“强不强”，而是要看它能强多久。几个点值得聊聊：1、本季业绩不能只超公司指引，还要能达到市场最乐观预期上限；
上一次财报电话会上美光给本季的指引是335亿美金，但市场目前普遍预期收入已经抬到了348-355亿左右，EPS在19.8-20.7美元。只是超公司指引已经远远不够，还要能超市场的预期才行。

最强beat则是远超市场预期，毛利率83%，并且管理层能清晰拆解出营收的来源：
1）多少来自ASP（平均销售价格）
上一季美光说DRAM价格环比涨了60%，NAND价格涨了70%，这就是ASP上涨带来的贡献。ASP上涨通常是周期性最强的部分（供需紧张导致涨价），但也最容易反转；
2）多少来自bit出货
实际卖出去的存储容量（用“比特”这个单位来算），核心就是让市场清楚业绩增长多少是来自单价增长，多少是来自出货量增长；
3）多少来自产品mix（产品组合 / 产品结构）
高毛利产品和低毛利产品在总销售里的占比变化，即使总bit出货量没变，只要把更多产品卖给高价、高毛利的市场（比如HBM、DDR5高端、企业级SSD），整体收入和毛利率就会上升；
4）多少来自成本下降
即使价格和销量都不变，成本降了，毛利率也会自动提高。这是最“硬”的利润来源之一，因为它是公司自己努力的结果，不容易被竞争对手立刻复制。

2、不仅要看本季业绩，还要看下一季度指引
本季度是过去式，下一季度和2027年的可见度才真正决定卖方模型会不会继续上修。高盛目前给的FYQ4模型非常激进（收入约488亿、毛利率86.1%、EPS 29.95），而市场一致预期大概在404亿收入、23.68美元EPS左右。

如果下一季度指引能到45-49亿收入、EPS 25-30区间，高端卖方模型就有继续支撑，目标价上修潮大概率延续。
如果只到40-42亿、EPS 23-24附近，数字依然很强，但对当前股价可能只是“兑现”而非进一步催化。
如果低于高端预期，同时管理层对2027年供需避而不谈，短线回调压力会明显增大。

3、“SCA/LTA长协机制”：这是估值提升的核心
过去两个月市场开始把存储股票从周期股往成长股看，核心就是长期协议。存储股过去最大问题不是赚不到钱，而是市场不相信高利润能持续。之前这里https://x.com/qinbafrank/status/2059116625153122791?s=20还聊过闪迪一季度财报时披露的长期协议条款，之前美光也宣布达成多份SCA策略性��户协议，如果SCA能够把未来供给、客户承诺、价格机制、capex回报绑定起来，MU的估值倍数就可能从“周期峰值折价”切到“AI基础设施资产折价较小”。

美光上一季已经确认几点：
第一，SCA不同于传统LTA，传统LTA通常偏一年期；
第二，SCA是多年协议；
第三，包含客户的specific commitments；
第四，目标是提高业务可见度和稳定性；
第五，公司已签下首个五年期SCA。
 但公司也明确说，由于保密原因，不披露价格、取消条款、下行保护等细节。

所以这次电话会要听管理层有没有比上一季更进一步。最重要的不是“再说一遍robust terms”，而是有没有以下信息：
1）覆盖范围：SCA覆盖HBM、DDR5、LP DRAM、NAND/eSSD，还是只覆盖某些AI数据中心产品？
2）承诺强度：是take-or-pay、产能预留、预付款、最低采购量，还是偏软性的forecast？
3）价格机制：有没有价格下限、公式定价、成本+回报、ROIC-linked pricing？
 4）取消成本：如果客户在2027-2028需求放缓，取消/延后订单是否需要补偿？
 5)capex绑定：美光新扩产是否以客户承诺为前提，而不是在价格高点主动加杠杆扩产？
如果管理层只能重复“我们有多年协议、有robust terms”，但不能让市场相信下行毛利率被保护，那么SCA对估值倍数的帮助会被打折。如果管理层能让投资人相信2027利润的一部分已经被合同化，那就会明显支持更高目标价。

4、“HBM4/HBM4E路线图”
美光已经正式宣布，HBM4 36GB 12H进入高量产，面向NVIDIA Vera Rubin，带宽超过2.8TB/s，能效较HBM3E提升20%以上；同时已经向客户送样HBM4 48GB 16H，单堆容量比36GB 12H高33%。 公司在上一季电话会还表示，HBM4E开发正在推进，预计2027年放量，并将使用1-gamma DRAM。

但这里要补一个反直觉点：当下美光毛利率最强的可能不是HBM，而是非HBM DRAM/DDR5。 TrendForce提到，美光管理层上一季表示“non-HBM margins are currently higher than HBM”，这意味着当前81%+毛利率很大程度来自传统DRAM极端紧缺，而不是HBM本身独立拉高毛利率。

所以电话会听HBM时，不要只听“出货”“认证”“路线图”，还要听：
HBM4良率是否比HBM3E更快成熟；
HBM4/HBM4E是否能维持或提升公司在HBM中的份额；
HBM4E的custom base die/TSMC合作是否带来更强客户绑定；
HBM mix上升后，整体毛利率是继续上升、持平，还是被先进封装成本稀释；
NVIDIA Vera Rubin、Rubin Ultra以及其他XPU客户中，美光是核心供应商，还是第三供应商补位。
竞争也不能忽视。三星已经开始向客户送样HBM4E，SK海力士也已向主要客户送样12层HBM4E，速度最高16Gbps/pin、能效提升超过20%。  这不一定利空美光，但意味着HBM4E不是单边故事，平台认证和份额稳定性非常重要

5、“NAND/eSSD数据中心业务”
这一块其实被可能被市场低估，这是美光区别于“纯HBM故事”的重要部分。上一季管理层说得很明确：AI推理、向量数据库、KV cache offload正在拉动数据中心NAND bit需求；数据中心SSD市占率连续第四个日历年提升；FY2Q26数据中心NAND收入环比超过翻倍，创下显著新高，并预计下一季继续增长。 同时美光已经量产PCIe Gen6数据中心SSD，Micron 9650面向AI训练和推理，支持最高28GB/s顺序读和550万随机读IOPS。

这条线的意义有三层：
第一，它让美光不只是HBM供应商，而是AI memory + storage组合供应商。
第二，它提升NAND周期的质量，因为数据中心SSD比消费NAND更偏高价值池。
第三，它能解释为什么NAND价格也会强，而不是简单“DRAM涨，NAND跟涨”。

电话会需要去看：
数据中心NAND收入是否再次大幅环比增长；122TB/245TB高容量SSD采用情况；
PCIe Gen6 SSD客户验证和放量节奏；
QLC在数据中心容量层的盈利能力；
以及NAND供给是否也进入长期紧平衡。

当前“AI内存”不是单一HBM叙事,如果电话会只讲HBM，故事不完整；如果能讲清楚AI服务器、传统服务器refresh、agentic AI带来的CPU内存、LPDRAM、eSSD共同增长，估值逻辑更扎实。

额外需要关注的点
1）Capex纪律要和SCA一起看
上一季股价盘后受压，一个重要原因就是强业绩被大幅提高capex部分抵消。当时美光上调FY2026资本开支到250亿美元以上，并预计2027年继续增加，市场担心这意味着未来供给正常化、周期性重新出现。

财报电话会要问：
新增capex中多少是shell/cleanroom，多少是设备？
这些产能什么时候形成有效bit supply？
是HBM相关、DRAM相关、NAND相关，还是通用扩产？
是否有客户SCA或预付款支撑？
目标ROIC是多少？
如果2027需求低于预期，capex能否延后？
如果capex被描述为“基于客户承诺的长期投资”，这是利多估值；如果像传统周期高点扩产，就是估值折价来源。

2）毛利率不是越高越简单，80%以后要看“可维持性”
FYQ3公司指引毛利率约81%，已经远高于美光历史常态。上一季管理层也提醒，在��种毛利率水平下，价格继续上涨对毛利率的边际提升会变小。
 所以市场不会只奖励“毛利率再高2个点”，而会问：
2027毛利率能不能长期保持70%以上。MarketWatch也提到，投资者关注长期毛利率能否超过70%，这会被视为强积极信号。
重点不是Q3毛利率82%还是83%，而是管理层是否愿意暗示：即使价格回落，SCA、mix、成本曲线和供需结构也能让毛利率维持在历史高位。

3）需求强不等于没有“需求破坏”
价格上涨太快会让PC、手机、消费电子客户削配置或延迟采购。上一季管理层已经承认，在价格敏感市场，高价格可能影响部分需求，但整体需求仍强；同时也说公司中期只能满足客户需求的 50%到三分之二。

这次要看：
PC/手机是否开始降内存配置？OEM是否推迟采购？汽车/工业客户是否接受涨价？客户是否出现提前拉货？如果出现明显需求破坏，市场会担心2027是峰值。

目前MU已经站在1134美元附近，市值接近1.3万亿美元，市场已经在财报前把很大一部分乐观预期提前兑现了。很容易出现稍微指引不及市场最乐观预期，或者某些业务阐述不够细致市场没有拿到足够的预期信息和数据导致波动。但是从中长期来看，还是要深入到业务最底层的逻辑去看增长的驱动力是什么？业绩都来自哪里？未来的业绩增长的持续性和确定性如何？这是最关键的

此内容由@BITstocks_CN 赞助，买美股上BIT—16000+ 只美股与 ETF，真实持仓，享股息分红。
~~~

Quoted context:

~~~text
@qinbafrank: 美股6月下旬7月初走势推演：高位压力测试，关键窗口在6月25-30日。过去一周多美股大盘算是摆脱6月初的Fomo修正去杠杆行情https://x.com/qinbafrank/status/2062912854983086556?s=46&t=k6rimWsEbo2D2tXolYcM-A，个人角度最大的催化剂是6月11号五月核心cpi环比低预期、12号开始就是美伊停战备忘录即将达成的强烈预期（也符合更合6月8号这里https://x.com/qinbafrank/status/2063804130074775578?s=46&t=k6rimWsEbo2D2tXolYcM-A
~~~

#### T2 2026-04-06 https://x.com/qinbafrank/status/2041036739536629933

Tweet id: `2041036739536629933`

~~~text
看韩国媒体的报道微软谷歌争相与SK海力士洽谈DRAM“三年长约”，“打破惯例”引入底价保障及预付定金机制。SK海力士与微软就DDR5长期供应合同的最终条款正处于收尾阶段，协议覆盖期限为今年起三年，规模达数十万亿韩元。双方正在讨论的核心条款包括：
设置价格下限以防止合同期内DRAM单价大幅下跌；
以及要求买方预付合同总额10%至30%作为定金。

应该是存储厂商首次在长期协议里设置低价保障机制，而且预付金制度也以前也很少见。同时SK海力士也在与谷歌就高带宽内存（HBM）及服务器通用DRAM的长期供应展开协商。

能看出来头部科技企业的采购策略已由"价格最优化"转向"优先锁定物量"，并愿意为此承担更高的价格刚性风险和资金占用成本。

本条由@bitget_zh赞助，「Bitget 买美股：秒级入场，丝滑交易 」
~~~

Quoted context:

~~~text
@qinbafrank: 昨天GTC大会老黄是怎么说存储的？他说AI数据中心已从“检索式计算”转向“生成式计算”，三大支柱是计算、网络、存储，而存储必须被完全重新发明。

传统存储：基于文件检索，存的是原始数据，调用时靠关键词/路径找。

AI时代存储（他叫semantics-based / semantics-aware storage）： https://t.co/WlMlKxhhQ8
~~~

#### T3 2026-04-23 https://x.com/qinbafrank/status/2047145369394659791

Tweet id: `2047145369394659791`

~~~text
SK海力士一季度炸裂的财报，营收达52.58万亿韩元，环比增长160%，同比增幅高达298%。营业利润为37.61万亿韩元，环比暴涨196%，同比激增505%，对应营业利润率72%，创下单季历史最高水平。净利润为40.35万亿韩元，净利润率77%。

营收激增主要源于两大因素：
其一，DRAM和NAND内存价格大幅上涨；其二，高附加值产品占比持续提升。
从产品端来看，DRAM环比出货量（B/G）持平，但平均售价（ASP）环比上涨超过60%；NAND出货量环比下降约10%，但ASP环比上涨超过70%。下面这张图能看出来SK海力士的各项财务指标在过去几个季度一路走高。

随着AI技术从模型训练向推理及Agentic AI阶段演进，AI代理产生的数据量持续增加，对DRAM和NAND的总需求基础正在拓宽，高性能内存的供需紧张格局预计将在一定时期内维持。

3月中还写过一篇长文，梳理SK了海力士传奇的发展经历，推荐看看。

本条由@bitget_zh赞助，「Bitget 买美股：秒级入场，丝滑交易 」
~~~

Quoted context:

~~~text
@qinbafrank: http://x.com/i/article/2032434236725280768
~~~

#### T4 2026-05-15 https://x.com/qinbafrank/status/2055150717674143853

Tweet id: `2055150717674143853`

~~~text
为什么光模块公司总市值比美光还低？原因无它，这主要是由市场容量和产业集中度来决定的。详细说说：
1、存储的的市场规模十倍于光模块/CPO
25年全球存储芯片规模接近2500亿美金，26年全球存储市场规模预计能到3700～4000亿美金，而对29年存储市场规模各个投行预计差别有点大保守有看到六七千亿美金，乐观的有看到九千一万亿美金的体量。

全球光模块与CPO市场整体规模预计从 2025 年的165亿美元增长至 2026年的 260亿美元，年增长率超过 57%。cpo在26年规模还很小，主要是光模块。未来几年到29件对于光模块/CPO市场容量平均估计能到五百多亿美金以上，看到有乐观的能到八九百亿美金。

但整体上来看，存储市场规模差不多是光模块十倍以上。

你看营收体量就能看出来：
海力士最新一季度营收350亿美金，美光280亿美金。
而中际旭创单季营收25亿美金，cohr差不多18亿美金，lite单季不到10亿美金。

营收体量也决定了市值规模

2、产业集中度
存储行业高度寡头垄断，中高端存储芯片三星+SK海力士+美光占八九成份额，壁垒极高（资本+工艺），龙头护城河深。而且存储厂商垂直整合能力很强，产业链掌控环节很强。三星、海力士、美光、铠侠，再加上国内的长鑫、长存基本上内存芯片看这几家就可以了。如果再往上游

光模块/CPO领域产业链碎片化严重，相信大家看光模块市场对其产业链环节众多、各个环节上竞争对��也很多、印象非常深。从上游材料、到硅光、激光器、组件、连接等等。再加上技术路线还在从光模块、NPO、CPO的路径迭代，新的玩家也不少。

所以是市场体量、公司体量、产业集中度，共同决定了存储企业的规模市值远大于光模块/CPO企业，特别是中级旭创市值已经1500亿美金，cohr、lite体量800亿美金，去看其营收体量其实能match的。

如果只是光模块企业比存储企业是市值差异来进行投资决策、这其实是有误区的。

核心是看产业市场容量能到什么量级，这个企业能吃到多大份额，特别是光领域正在从光模块到npo、再到cpo快速演进，谁掌握核心技术自然谁的空间更大。
~~~

Quoted context:

~~~text
@ArtofSpecuycky: 所有人都在买GPU和存储。没有人告诉你光模块公司的总市值比美光还低

我想从一个反常识的问题开始：GPU是AI的大脑，存储是AI的记忆。那光是什么？光是AI的神经系统。但神经系统从来不是最先被注意到的。存储已经涨了10倍，GPU更不用说。光的时代，刚刚开始。

1. 先说一个结构性的错误定价
~~~

#### T5 2026-02-27 https://x.com/qinbafrank/status/2027332981678072184

Tweet id: `2027332981678072184`

~~~text
三星存储部门漫天要价，苹果照单全收。25日据韩媒报道三星电子旗下半导体部门以100%涨幅向苹果报价，却出人意料地被立即接受。然导致三星手机部门不得不采购美光存储芯片来填补50%的空缺。自家手机部门都买不到自家的存储产品，也是离谱了 https://t.co/Eq6XI0M7Lo
~~~

Quoted context:

~~~text
@qinbafrank: 英伟达的最新财报来看AI算力产业链上的最卡点。英伟达昨天财报里对Q1营收指引中值比买方机构最乐观预期还高4%，指引比市场想的更强，意味着那么市场预期得再往上挪一格。高盛昨天在最新报告中明确表示，与以往部分季度不同有三大因素在未来的路径更为清晰：
~~~

#### T6 2026-06-05 https://x.com/qinbafrank/status/2062731695330148711

Tweet id: `2062731695330148711`

~~~text
英伟达最新的GPU少用Dram是怎么回事？昨晚SemiAnalysis这个报道说英伟达主动将下一代AI超级计算机平台——Rubin NVL72机架的CPU侧SOCAMM DRAM容量砍半。消息一出，整个存储板块大跌。详细聊聊：
1、这到底在说什么？
NVIDIA 2026年主力AI机架平台，一柜装72颗Rubin GPU + 36颗Vera CPU，通过NVLink全互联，形成“一块巨型GPU”。GPU侧用HBM4（每柜约20.7TB），CPU侧用SOCAMM——一种可插拔的LPDDR5X系统内存模块，便于维护和故障隔离。

原计划：每颗Vera CPU用8个192GB SOCAMM模块（最高约1.53TB/CPU），全柜CPU侧总DRAM约55TB。
现在：大部分系统切换到96GB SOCAMM模块，全柜CPU侧DRAM降至约28TB（砍~50%）。
关键不变：GPU的HBM4容量和带宽完全没动，核心算力（训练/推理FLOPS）不受影响。

SemiAnalysis估算机架硬件成本（BoM）：从$7.6M 降到 $6.8M（省约10%）。

简单说英伟达在“非核心”CPU系统内存上主动降配，只为更快、更稳地出货整机。

2. 核心原因是什么？
其实本质是供应链现实打脸，LPDDR5X高密度SOCAMM严重短缺。这次下调原因不是需求不足，是供给瓶颈。16 层超高密度 LPDDR5X 极其困难的封装良率，Hynix/三星无法提供足够数量的192G内存给到客户，为了保证所有Rubin GPU都能有对应的DRAM可以用，英伟达主动进行供应链风控，下调了单机柜用量

所以也是英伟达的战略选择，与其等高规格内存、导致整柜延误/缺货，不如主动降到96GB版本，确保所有Rubin GPU都能配齐系统内存，快速进入量产/交付阶段。

这其实是变相验证了，当下存储领域处于“供给结构性短缺”状态，而AI对内存需求则是爆炸式增长（HBM + LPDDR5X）。特别是hbm配置完全没有变动

3、而且还有其正面影响
1）加速Rubin部署：成本更低、TCO更好， hyperscalers（MSFT、CoreWeave、xAI等）更愿意大规模采购。MSFT已完成首柜bring-up，降配后量产节奏更快。 
2）客户获利：每柜省80万刀，单GPU-hour便宜0.26刀，长期token economics更好，推动更多AI投资。 
3）英伟达生态强化：继续把控供应链（直接买内存），进一步巩固AI工厂主导地位。 

当然CPU侧DRAM配比下降，内存密度降低（原55TB，现在28TB），对极长上下文推理、多Agent并行、超大KV Cache等场景会有影响（可能需要更多跨节点通信��SSD offload）。这应该会利好SSD和光连接用量上升：
逻辑当在于 CPU 侧用于承载庞大上下文（KV Cache）的系统内存缩水后，GPU算力瓶颈将无可避免地向SSD侧和互连侧转移，CSP需要采购更多的高性能SSD或者采用更高性能的柜内连接（Scale Up）连接方案，利好NAND企业和光链接企业的需求。

本条由@bitget_zh赞助，「Bitget 买美股：秒级入场，丝滑交易 」
~~~

Quoted context:

~~~text
@qinbafrank: 存储大厂变身“超级乙方”，不得不说长期协议改变存储大厂的业务逻辑和估值逻辑。昨天瑞银一份报告把美光推到万亿美金市值，今天朝鲜日报的报道也让海力士跨越万亿美金市值门槛。核心逻辑跟昨天聊闪迪的长期协议是一致的：存储厂商与客户签订多年期长期供应协议，不再像传统存储行业那样靠季度现货议价， https://t.co/vFnuCs7v43
~~~

#### T7 2026-04-29 https://x.com/qinbafrank/status/2049421072530128932

Tweet id: `2049421072530128932`

~~~text
非常深度一篇文章，从GPU架构进化的第一性原理出发，重点解答市场长期担忧的问题：为什么每个GPU的HBM内存需求必然是指数级增长？为什么HBM需求不会像传统DRAM那样停滞或周期性崩盘？记录个要点当做阅读笔记
1. AI推理时代的核心KPI已彻底改变
CPU时代：最高KPI是“performance / FLOPS”（跑分越快越好）。
AI推理时代（尤其是agentic flow兴起后）：最高KPI变成token经济学——单位成本/单位电力下的token吞吐量（throughput） + token生成速度。

Nvidia的“AI工厂”本质就是：最低成本输出最多token，同时尽量提高token速度。Pareto frontier曲线要不断向右上方移动。

2. Token吞吐量的第一性原理公式（核心结论）
Token throughput = HBM Size（容量） × HBM Bandwidth（带宽）Batch size（同时处理的请求数） 的瓶颈 = HBM Size

因为每个请求都自带hot KV cache，必须放在HBM里。随着batch增大，KV cache线性增长，HBM容量必须同步线性增长（否则就像接驳车车厢太小，要分多趟拉人）。
每个user的token生成速度 的瓶颈 = HBM Bandwidth
生成每一个token都要多次高频读取HBM里的权重和KV cache。带宽越高，decode速度越快（就像接驳车车门越宽，旅客上下车越快）。

完整类比：
吞吐量 = 接驳车车厢容量（HBM Size） × 车门宽度（HBM Bandwidth）。
只要想让token吞吐量每一代翻倍，HBM的Size × BW乘积就必须翻倍。这是硬件天花板，软件优化无法根本替代。

3. CPU时代 vs. AI时代的本质差异
CPU时代：DDR只是“辅助”，升级极慢（DDR3到DDR5花了15年）。
原因：CPU有大量cache、superscaler等隐藏延迟；日常workload对带宽/容量需求低；app size增长慢。
AI/GPU时代：计算范式彻底转向“memory-bound”（内存受限）。
推理即内存，KV cache + 上下文长度 + 多请求并发，把所有压力都压在HBM上。HBM已从“锦上添花”变成决定性因素。

4. 验证与现实对应
Nvidia从A100 → Rubin Ultra的token吞吐曲线，与HBM Size × BW曲线在对数轴上几乎完全重合（文章提到图二）。
即使利用率（utilization）很难达到100%，HBM仍是整个系统的天花板。老黄必须逼御三家（三星、海力士、美光）不断升级，否则GPU就卖不出去。

5. 软件优化无法改变硬件需求
软件再优化（如LPU把权重搬到SRAM），也只是从另一个维度改善Pareto曲线，硬件天花板仍由HBM决定。就像CPU时代软件再快，CPU厂也必须持续升级跑分一样
~~~

Quoted context:

~~~text
@fi56622380: AI半导体终局推演2026(I)
当新token经济学范式从GPU算力转移到HBM

本文从从GPU架构进化路线本质出发，解释这个市场长久以来担心的问题:
每个GPU的HBM内存需求为什么一定会是指数增长，为什么HBM需求指数增长不会停滞?

并推导token经济学在当前架构下第一性原理:token吞吐 = HBM size X HBM BW带宽 https://t.co/yVGGMyv17R
~~~

#### T8 2026-05-19 https://x.com/qinbafrank/status/2056586676911428025

Tweet id: `2056586676911428025`

~~~text
今天这篇三星电子设备解决方案（DS）部门前负责人兼高级顾问姜启贤预测存储半导体价格将从明年下半年开始下降，并敦促韩国产业提前做好准备的观点传播很广。其实跟我上周在这篇推文https://x.com/qinbafrank/status/2054174740282216464?s=46&t=k6rimWsEbo2D2tXolYcM-A最后聊到的逻辑是一致的。核心就是看供给和需求：
1）海力士、三星、美光最高端的存储厂商御三家在去年底到今年都开始扩产，新产线释放产能在27年下半年；
2）中国存储厂商也在积极扩产，不过中国厂商扩产主要是dram、nand的产能上，因为没有euv极紫外线光刻线。长鑫和长江存储短期内在hbm3和hbm4上突破其实还有难度，特别是认证周期巨长；
3）姜顾问还有第三点是认为如果大科技公司资本开支的ROI恶化，可能缩减投资，导致存储需求减弱。

其实核心是第三点，存储厂商扩产新产线建设和产能释放节奏市场都在盯着，大家都知道。核心是还是需求，从存储厂商来看最直接的需求在于大科技的资本开支、而最根本的需求则在于C端和B端的用户/客户需求，在27年下半年是不是还能高速增长，以及AI商业化的进展。

今年一季度财报可以说是AI货币化的拐点，验证了AI能开始大规模赚钱。但明年下半年呢会不会出现营收增速放缓，导致资本开支也放缓，是需要密切关注的。

简单说供给增加的时间节奏比较清晰、需求增加和商业化的增速是不是一直会加速需要持续密切关注。
~~~

Quoted context:

~~~text
@jukan05: Kye-hyun Kyung, Samsung Electronics Senior Advisor: "Memory prices to fall in H2 next year… Korea must cultivate deep-tech manufacturing"

Kye-hyun Kyung, Senior Advisor and former head of Samsung Electronics' Device Solutions (DS) Division, forecast that memory semiconductor https://t.co/FFMTL92N6t
~~~

#### T9 2026-05-12 https://x.com/qinbafrank/status/2054174740282216464

Tweet id: `2054174740282216464`

~~~text
中美能否达成稀土换光刻机的交易？若达成，存储立马就不紧缺了么？怎么看存储未来的拐点？今天巴伦周刊这篇文章传播很广，核心论点是此次川普访华中美可能达成稀土换光刻机的交易，之后台积电、三星海力士就会失去芯片定价权。果真如此么？这里有几个问题和误区需要聊下
1、中美达成稀土换光刻机的概率有多大？
我在昨天川普访华前瞻的推文里也聊过，在关键卡脖子环节上相比英伟达芯片中国更想要光刻机等半导体设备，这比巴伦周刊聊的还要早。

昨天也聊到中国对于解封英伟达芯片其实兴趣不大，更想要扶持国产芯片。但关键的半导体设备（DUV、EUV光刻机）和高端EDA软件则是非常紧缺、中国应该是想要这些设备。

但中美能不能达成这样的协议？我对此并无把握，因为即使去年10月中国都管控稀土了，美国也没在关键半导体设备上松口。特别是26年以来美国是进一步收紧了对中国在半导体关键设备的限制。只能说看谈的结果了

2、如果中美真的达成稀土换光刻机的交易，国内存储立马就能放量么？
其实也不然

中国在先进制程（尤其是EUV/DUV光刻）上确实被卡脖子多年。拿到ASML设备后，国产化加速是大概率事件。中国内存厂商主要是CXMT长鑫存储等国产DRAM玩家，这两年在中低端内存进展很快，也抢占了不少份额。中高端内存上代差还很大。

但也要注意光刻机确实是当前最关键的瓶颈之一，但远不是代差大的唯一原因。
1）光刻机（DUV/EUV）确实是最大硬伤
EUV（极紫外线光刻机）现在国内完全拿不到，三星、SK海力士、美光已在先进DRAM（HBM4）和部分高密度NAND中使用EUV大幅提升密度和良率。

中国厂商（CXMT、YMTC）只能靠DUV + 多重图案化（SAQP等）硬刚，工序复杂、成本高、良率低。 

2）先进DUV（如ASML NXT:2000i/2050i系列）：目前还能进口部分，但2026年美国MATCH Act等新法案已针对CXMT、YMTC等直接封堵高端浸没式DUV及其维修/零件。中国正加速用国产SMEE SSA800等替代，但这些设备目前主要适合28nm及以上，做到先进节点仍需多次曝光，效率远低于ASML最新款。 

这两者直接后果：CXMT先进DRAM良率约50%（领导者80-90%），YMTC高层数NAND虽在量产，但成本和稳定性受限。这直接导致中高端产品（DDR5/LPDDR5X、HBM3、300+层NAND）竞争力弱。 

如果只看这一条，光刻限制确实能解释60%的当前差距——没有它，中国厂商根本无法高效爬坡先进节点。

但是还有其他核心差距，不是光刻机解封瞬间就能解决的
1）专利/IP壁垒：三星、SK海力士、美光在DRAM/NAND核心架构（Xtacking、HBM堆叠等）上有大量专利。中国厂商要么绕路（成本高）、要么受限，无法直接抄最优路径。

2）设备生态不完整：除了ASML光刻，还有Lam Research、Applied Materials、东京电子等美日设备的先进型号也受限。3D NAND垂直堆叠、HBM混合键合需要全套高端工具链。

3）良率与工艺整合：即使设备到位，工艺调试、缺陷控制、材料匹配都需要时间。CXMT/YMTC新线良率爬坡慢是行业公认问题，不只是光刻机的事，还涉及蚀刻、沉积、CMP等全流程配合。 特别是极紫外线光刻机EUV的调试规程更复杂，时间和流程更长。

所以不仅仅缺高端光刻机的原因，还因为专利、设备生态、工艺整合等方面共同造就了国产内存厂商与三星、海力士、美光的差距。

光刻是“卡脖子”，但后面还有“IP/专利、生态、工艺”几道关。这其实就有一个时间差，即使签协议，ASML设备交付、生产线建设、良率爬坡，至少也要1-2年才能形成实质产能。这么看即使中国厂商拿到最先进的半导体设备、基本上28年才能中高端存储上形成产能，这还是克服了IP/专利、生态、工艺等障碍，一切顺利的情况下。

那就不能不说三星、海力士、美光自己的扩产计划了，过去半年存储御三家也开始了积极扩产，这里就包括了三星P4/P5工厂、海力士Yongin工厂？美光Tongluo/ID1等新线，最早2027年下半年到2028年上半年才能形成实质增量。

这意味着，国内存储厂商中高端产能还没完成形成，三星、海力士、美光的扩产产线就开始释放产能了。

3、那么存储未来的拐点怎么看？
个人的框架就是看需求和供给：
1）什么时间需求放缓？
现在的情况是随着AI的快速迭代，长上下文、多模态、agent快速普及，对存储的消耗非常大，需求还在高速增长，没看到放缓迹象。

2）什么时间供给放量？
其实刚才第二部分聊的就是供给放量，现在很明确了三星、海力士、美光扩产的新产线产能释放也得到27年底了。

假如中美能达成稀土换光刻机的协议，中国存储厂商拿到最先进的光刻机，顺利的话也得到28年才能产能落地。

所以至少才明年上半年，存储（特别是高端的HBM、GDDR7/GDDR6x、DDR5，中端的DDR4、高端NAND）的产能还是紧缺的，就看需求的高速增长持续性如何了。而需求现在还在狂飙

未来存储的拐点要么是需求放缓、要么是供给开始放量增加。紧盯着这两点即可
~~~

Quoted context:

~~~text
@qinbafrank: 川普确定本周访华，会谈成什么？个人角度，中美大概率会做一批“可交易”的局部交换，避免全面脱钩失控。做一个前瞻：
1、贸易休战 2.0
这是概率最高的，本质上是：“大家都别再继续升级。”可能包括： https://t.co/fQ7iXVhBNH
~~~

#### T10 2026-05-31 https://x.com/qinbafrank/status/2060929419850723497

Tweet id: `2060929419850723497`

~~~text
个人角度两位聊的其实并不是投资策略的问题，而是产业发展阶段和投资节奏的问题，核心是要去关注产业发展阶段和投资节奏的动态匹配。说说我的理解：
1、当下产业阶段
是一个资本开支高涨+需求同步狂飙的节奏，首先是HBM产能供给不足、然后存储御三家海力士、三星和美光在扩产节奏上也很克制（包括了三星韩国平泽的P4/P5工厂、海力士Yongin工厂，美光在台湾和纽约的Tongluo/ID1等这些新厂还在建设，新产线释放产能到27年下半年了），御三家为了hbm的生产又去缩减挤压了DDR的产能，层层传导nand、ssd的产能又都不足了。同时需求还在狂飙，按老黄的说法是抛物线上扬。

在这个阶段，“无死角持仓三大厂 + 少量NAND”就能吃到最肥的红利，因为全市场都在抢DRAM的增量，细分差异还没到必须精确捕捉的地步。 

2、未来
当AI从“短期上下文”走向“长期上下文 + 智能体工作流 + 海量外部记忆库”时，DRAM和NAND的需求强度会明显分化 。更进一步，如果长期冷存储（HDD）因为成本优势+需求井喷而补涨，NAND和HDD的边界也会被重新定义（WDC剥离SNDK就是历史上的节奏切换案例）。
  
到那个时候，同样的“存储”主题，内部的Alpha差距会拉大。届时确实需要去审视不同阶段，AI发展对于存储的需求不同，自然也会影响其在二级市场的表现。

3、当然不能说hbm和dram就需求少，只要AI加速器需求还在增加，hbm的需求也在加。毕竟英伟达马上要交货的rubin系列GPI用到的hbm更多了。

所以“要不要细分”其实是由产业发展阶段决定的，而非投资人主观策略偏好。

从更久远的角度看，谁的成本曲线更低、谁的产能扩张更理性、谁在细分赛道的技术壁垒更高，就成了决定胜负的关键——这已经不是“策略选边”能解决的，而是看你对产业发展阶段的判断准不准，以及能不能动态调整投资节奏来匹配发展阶段。
~~~

Quoted context:

~~~text
@coolish: 关于存储赛道下注的看法讨论，见引用推（图1）
你们怎么看？ https://t.co/lekGiHPIcd
~~~

#### T11 2026-03-18 https://x.com/qinbafrank/status/2034159370297295330

Tweet id: `2034159370297295330`

~~~text
昨天GTC大会老黄是怎么说存储的？他说AI数据中心已从“检索式计算”转向“生成式计算”，三大支柱是计算、网络、存储，而存储必须被完全重新发明。

传统存储：基于文件检索，存的是原始数据，调用时靠关键词/路径找。

AI时代存储（他叫semantics-based / semantics-aware storage）：  
1）后台持续embedding（把原始数据实时向量化成知识/语义表示）。查询时不是检索文件，而是像聊天一样问问题（自然语言/语义检索）。
2）存储本身变成可生成、可推理的系统，能直接回答“给我总结上季度所有客户投诉”“找出类似这个分子的化合物”等。
3）首次实现GPU加速存储（GPU直接参与embedding、索引、检索）。

老黄认为企业未来每个人都会有这样一个“超级智能存储系统”。

然后今天SK集团董事长崔泰源在英伟达GTC大会上表示，由于芯片生产存在系统性瓶颈，他预计全球内存芯片短缺的情况很可能会持续到2030年。与此同时，他预计DRAM、NAND和HBM等各类存储芯片的价格将持续上涨，涨势可能会持续较长时间。

老黄和老崔，对又把市场给引爆了。海力士都快要回到前高了，两倍做多海力士也是暴涨。

月初这里https://x.com/qinbafrank/status/2029074784429195357?s=46&t=k6rimWsEbo2D2tXolYcM-A有聊到当时的调整：根源还是情绪打满后的调整叠加了地缘冲突带来的潜在能源成本大幅走高的风险，带动半导体股进行估值消化，但并不是趋势的大拐点。所以只要没有看到大科技们资本开支开始见顶放缓的信号，算力产业链的关键环节的调整其实是给了上车机会。
~~~

Quoted context:

~~~text
@qinbafrank: 用稳定币直接交易港股、海力士/三星两倍ETF。过去大半年，美股代币化趋势愈演愈烈，各路玩家竞相入场，到现在已经有几十亿美金的体量，大家可以直接在链上用稳定币交易美股代币。但作为全球最活跃的资本市场之一的港股，这方面则是一直毫无进展，这里面主要是监管因素导致。看到Stablestock正式上线港 https://t.co/tRnUljDDoL
~~~

#### T12 2026-06-24 https://x.com/qinbafrank/status/2069611778435399944

Tweet id: `2069611778435399944`

~~~text
SemiAnalysis对长鑫存储的判断，其实最核心是两点：1）长鑫存储的潜在市值可能被低估；
2）它后续扩产还有很大空间。
这两个点，比单纯讨论HBM差距更重要。长鑫已经从国产替代故事，进入收入、利润、产能和IPO重估阶段。
商品DRAM做得很快，收入在放大利润也能出来，产能利用率很高，全球份额在提升。
如果IPO顺利推进，市场会重新给它定价。

现在长鑫还不能和SK海力士、美光、三星在HBM上正面硬拼。但已经证明，国产DRAM可以进入全球竞争表，这对A股芯片线很关键。

一家半导体公司上市后好不好，要看规模、利润、产能、稀缺性，以及继续扩产的空间：长鑫现在就站在这个位置上。个人也觉得长鑫上市后表现不会差。几重buff叠加了：
国产替代的稀缺性、存储周期的顺风、产能扩张的确定性、有资本市场重新定价的空间。

当然长鑫上市直接的利好就是上游产业链，要扩产就得买设备、材料、电子特气、零部件。这些方向和新产线、新资本开支关系更直接。
~~~

Quoted context:

~~~text
@SemiAnalysis_: China’s CXMT Is Set to Challenge DRAM Incumbents
CXMT IPO, SK Hynix, Micron, Samsung Competition,
Process Node Deficit, China HBM,
Wafer Adds, Memory LTAs

https://newsletter.semianalysis.com/p/chinas-cxmt-is-set-to-challenge-dram
~~~

#### T13 2026-06-23 https://x.com/qinbafrank/status/2069222768496042474

Tweet id: `2069222768496042474`

~~~text
昨晚美光与Authropic的合作还是值得看看的，合作覆盖的四个板块前两个板块值得重点关注：1、内存与存储AI架构设计合作（技术共创层），双方将共同分析内存/存储子系统在不同AI工作负载下的性能表现，以及与整个基础设施栈（计算、互联、软件）的交互。

Anthropic的Claude模型训练/推理对HBM带宽、功耗、延迟极度敏感；美光通过早期介入，可针对Claude workload定制/优化产品（类似NVIDIA与HBM供应商的深度绑定）。这属于联合架构设计（co-design），远超标准供应链关系。

这能推动HBM、DRAM、SSD在性能、能效、总拥有成本（TCO）和token economics上的优化。

2. 多年期内存与存储供应协议（供应锁定层）
美光向Anthropic提供其数据中心全线产品（高带宽内存HBM、DRAM、SSD）。多年度供应协议，覆盖Anthropic“多年代增长轨迹”和“长期计算策略”。

在当前HBM全球供应紧张（尤其是高性能AI集群）的背景下，这为Anthropic提供了优先/稳定供应保障。Micron作为唯一美国本土主要HBM生产商，战略价值凸显，也符合美国芯片法案本土化趋势。

另外两点美光企业内部采用Claude和确认投资Authropic的Series H投资。

这是一套“技术共创 + 长期供应锁定 + 内部互用 + 股权对齐”的四位一体战略协议。核心逻辑就是把AI模型需求直接嵌入基础设施设计和供应链条，实现从“单纯卖内存产品”到“共同定义下一代AI内存架构”的跃升。
~~~

Quoted context:

~~~text
@qinbafrank: 美光财报前瞻，核心看哪些点？本周AI产业上最重要的事件可能就是美光的财报了，大家会很关心美光财报之后走势进而带动市场如何走，个人角度这次美光财报不是简单验证“强不强”，而是要看它能强多久。几个点值得聊聊：1、本季业绩不能只超公司指引，还要能达到市场最乐观预期上限； https://t.co/voDXgBxwRE
~~~

#### T14 2026-02-27 https://x.com/qinbafrank/status/2027238317323137395

Tweet id: `2027238317323137395`

~~~text
英伟达的最新财报来看AI算力产业链上的最卡点。英伟达昨天财报里对Q1营收指引中值比买方机构最乐观预期还高4%，指引比市场想的更强，意味着那么市场预期得再往上挪一格。高盛昨天在最新报告中明确表示，与以往部分季度不同有三大因素在未来的路径更为清晰：
1、超大规模云厂商的2026年资本开支预测仍有上行空间，且2027年资本开支增长的早期迹象已开始显现，意味着英伟达核心下游客户群的需求支撑将持续向远端延伸。

2、以OpenAI和Anthropic为代表的非传统客户，其至2027年的采购计划能见度将随各自融资轮次的落地而显著提升。英伟达披露仍在与OpenAI就投资与合作事宜进行积极磋商，预计近期完成签约；同时已完成对Anthropic的100亿美元投资，协议包括Anthropic将基于Blackwell和Rubin架构训练其大语言模型。

3、随着基于Blackwell架构训练的新一代AI模型相继推向市场，英伟达将在未来数月重新彰显相对AI芯片竞争对手的技术领先优势，从而为市场提供更直观的差异化竞争证据。

这每一条都指向同一个词：资本开支，买单方正在变得更多元，且更“资本密集”，大模型公司自己也在变成基础设施买家。

而在财报电话会上，英伟达自己承认“成本压力”来自 HBM。这意味着AI 需要的不只是更多的算力芯片，还需要更多、更贵、更难扩产的存储。

美银前天发布的亚太科技报告明确看多存储和韩国科技，理由有三条：
1）更高的 DRAM 单价/出货金额（相较他们 1 月的预测）；
2）更强的资本开支（主要投向 HBM）；
3）更可见的 AI 需求主题——材料里直接写了：亚马逊 FY26 目标支出 200bn 美元。

机构们预期2026 年末 DRAM 晶圆开工量同比只增长 7%（来自三星与海力士的产出增长），供给追不上需求，直指HBM/存储是最容易形成“供给溢价”的环节。

之前在资本开支的战争的长文https://x.com/qinbafrank/status/2024361930828419302?s=46&t=k6rimWsEbo2D2tXolYcM-A里有聊过，算力产业链上关键环节依然能攫取最大的价值：芯片、封装测试、存储、光模块等，哪些产能不易快速扩张的，哪些是有极高护城河的，就会享受到庞大资本开支的红利。

虽然市场一直在争论资本开始能否持续，资本开支是否见顶？但是在可见的26年，大科技们的资本开支还是要花出去，让我们暂时站在“还没见顶”这一边，但要跟紧密跟踪“预算/订单/指引”的证据。

后续持续关注是否真如高盛所说继续出现“云厂商资本开支上修”，以及的“2027 年增长信号”是否更早落地到公开口径里。如果说AI基础设施资本开支（CapEx）继续上修，以及由此带来的“供给瓶颈溢价”那就落在了高带宽存储（HBM）和先进封装。

之前看到瑞银报告还把 HBM 的预期份额写到了客户维度：
1）对英伟达服务器相关，瑞银给出的供货结构是：海力士 60%+、美光 24%、三星 15%；
2）对亚马逊的 ASIC 服务器，给的是：海力士 84%、三星 16%；
不同客户组合不同，但共同点是：HBM 的结构性集中度很高。其实主要就落在了SK海力士和三星这两家头上。

这也是一个明显的信号，韩国半导体产业的权重正在显著提升。去年12月在看存储板块的时候，因为美股没有海力士和三星，选择了美光。在之后跟进一步的梳理学习中，看到了韩国指数ETF，这其实是一个很好的标的：如果AI内存成为未来十年的核心变量，那么受益的并不仅是单一公司，而是整个韩国科技板块。

对于希望参与这轮结构性机遇、但又不愿承担单一个股波动风险的投资者而言，通过韩国指数ETF获取敞口，可能是一种更平衡的方式。贝莱德的$EWY 和 富兰克林的$FLKR 都提供对 SK 海力士与三星的整体敞口。在 StableStock 上可以用稳定币交易这些标的。
https://app.stablestock.finance/trade/stock/ewy https://app.stablestock.finance/trade/stock/FLKR 

当然并不是要去追高，昨晚英伟达财报后首日股价出现了sell the news，今天半导体板块都有回调，从个人角度这不是见顶而是情绪打满后的回调，等待回调到位后的好买点。
~~~

Quoted context:

~~~text
@qinbafrank: 这位兄弟给美光的目标价炸裂了，$1330。说实话去年8-10月存储是错过了理解不深入。11月份的美股大盘小级别调整、带动存储一波回调也给了上车机会。整体逻辑是：
26年存储来业绩确定性很高，需求强，业绩爆发； https://t.co/joU01AXc3Z
~~~

#### T15 2026-06-17 https://x.com/qinbafrank/status/2067203577991553148

Tweet id: `2067203577991553148`

~~~text
谁拥有真实瓶颈？谁能把瓶颈兑现成利润、谁在下一代架构迁移中拿到控制点、谁的估值已经提前透支？这是AI算力产业链投资逻辑的新阶段最重要的四个问题。核心逻辑就是当一个产业链上所有环节都被炒过一遍之后，再往后就不能眉毛胡子一把抓，而是要去真正区分哪些公司在产业链真的是不可替代、有极强的核心竞争力，之前市场对其的预期是否已经有足够巨量的订单和超预期的交付在支撑。本质是从撒胡椒面到细细筛选。

换句话说，过去两年可以买“AI 数据中心相关性”；再往后更要去买 稀缺现金流 + 架构控制权 + 可验证的订单持续性。

两大关键问题
问题一：它是“真实瓶颈”，还是“主题相关”？
真实瓶颈的特点是：��期拉长、客户愿意预付款或签长期协议、ASP 上行、毛利率扩张、扩产慢。
主题相关的特点是：收入涨但毛利不涨，客户高度集中，capex 多但 ROIC 不清楚，或者只是“进入供应链”但份额很小。
当前更接近真实瓶颈的是：HBM、高端 server DRAM/eSSD、先进封装、变压器/开关柜/电网设备、部分高端光互连。

问题二：它的价值会在架构升级中上升，还是被架构升级替代？
这是光互连、800V DC、CPU 最关键的问题。CPO 会让部分传统 pluggable 模块价值被压缩，但会抬升硅光、光引擎、激光器、连接器、封装测试和 switch ASIC 的价值。800V DC 会抬升高压电源链、SiC/GaN、保护器件和 rack power architecture 的价值，但可能压缩部分传统低压供电部件。

最危险的投资是：
只因为某家公司“沾 AI 数据中心”就买；只因为它提到 CPO/800V/液冷就给高倍数；
只看收入增长不看毛利、份额、客户集中和架构替代风险。

最有吸引力的投资是：
已经涨业绩，但市场低估持续性的瓶颈资产；
或者尚��完全兑现业绩，但已经被下一代架构平台锁定的控制点资产。

简单说市场都认识到了AI算力产链条的瓶颈和卡脖子，那么投资就要更进一步：不是只站在瓶颈上，不是只处于卡脖子环节就可以了，你还要看这家企业这个在这个瓶颈和卡脖子的节点上是不是独特的、不可替代的、技术路线正确的、不仅订单一大把交付还能持续超预期。同时还要看技术演进和落地的节奏到底是如何的？

本条由@bitget_zh赞助，「Bitget 买美股：秒级入场，丝滑交易 」
~~~

Quoted context:

~~~text
@qinbafrank: http://x.com/i/article/2067062837391020032
~~~

#### T16 2026-06-08 https://x.com/qinbafrank/status/2063804130074775578

Tweet id: `2063804130074775578`

~~~text
熬过一个焦灼的周末本周市场应该怎么看？上周五晚上有详细梳理美股在上周后半周走势几个变化因素，最早还是上周三晚上的space提示了风险。这次调整的核心逻辑：AI/半导体短期涨幅过大、市场FOMO过强、交易结构过度拥挤，抛物线式上涨本身不可持续；随后又遇到SpaceX巨无霸IPO路演和认购抽水、CPI/PPI/FOMC前的自然避险，以及强就业数据强化“高利率更久甚至重新加息”的担忧，最终触发了热门科技股的集中去杠杆。当然这也是再老话重弹，关键是后续应该怎么看

1、可以先回顾下过去大半年的几次调整
去年12月也有一次类似的科技股暴跌。当时是 Oracle 先引爆 AI 投入回报率和资本开支担忧，随后 Broadcom 业绩后市场继续杀一波，直到美光强业绩和偏温和的通胀数据才把情绪拉回来。两次相同点都是利率预期扰动，不同点是：去年底今年初市场更担心AI capex的分子端回报，这一次暂时没有形成“AI逻辑崩了”的共识，市场更担心的是分母端——利率、通胀、Fed、地缘和流动性。

存储板块是这一轮AI交易中最强的主线之一，涨幅最大、景气度最高、盈利弹性最强，因此也最容易成为拥挤交易出清时被集中兑现的对象。以美光为例，本轮从6月3日高点1089.29跌到周五收盘864.01，收盘回撤约20.7%；如果按盘中低点850.18算，最大回撤约22.0%。这已经超过5月中旬那轮约20%左右的回撤，但还没有达到3月战争期间更极端的恐慌水平。

KORU作为韩国市场的3倍杠杆ETF，可以近似观察韩国科技/存储交易的风险偏好，但不能直接等同于韩国指数本身。KORU从6月1日高点1279.70跌到6月5日收盘610.01，回撤约52.3%；若按盘中低点599计算，回撤约53.2%。

从空间看，这次已经超过5月中旬那轮回调；
从时间看，本轮已经连续调整4个交易日，也接近过去几次短线主跌窗口。
因此一个相对合理的判断是：在AI基本面没有被证伪的大背景下，短线主跌浪可能已经完成了相当大一部分，后面连续暴杀的概率下降。

所以本周不一定继续暴跌，但直接V回去的概率不高，更可能是横盘震荡或缩量缓跌；但只要美债收益率不回落、CPI/FOMC还没落地，市场大概率仍是高波动、偏防守、等待确认和时机好转。

2、再看周末到今天的几个大事件
1）以色列和黎巴嫩那边还有摩擦，伊朗导弹和无人机开始打击以色列，特朗普一边压内塔尼亚胡不要报复，一边继续保美伊协议线。这条线会扰动油价，也会让市场重新想起通胀压力。
但目前还没看到重新升温到全面失控的迹象。
看川普昨晚接受的采访，是极力再确保不会让美伊战争升级的。

2）英伟达和SK预计周一公布合作计划。黄仁勋的口径很直接：内存、晶圆、先进封装、硅光这些环节都短缺，而且短缺可能持续数年。这句话把市场之前炒过的几条线又串回来了。

再当下的市场状态下，会带给市场一定的支撑，但应该很难立马带动反转。今天可以观察市场盘面，低开以后，核心标的能不能稳住？有订单、有客户、有产业位置的公司，会不会先被资金接回去？
如果核心公司稳，跟风票乱，那就是分化。
如果核心公司也接不住，这种反抽持续性会很差。

3、等待宏观给出第一个信号
从4月初以来这两个月的大行情，大涨的契机先是宏观伊朗局势的停火、再是算力短缺、然后是AI商业化加速，这三个时间在4月初到4月中依次展开，由此带动一大波行情。
4月是“宏观风险解除 → AI产业逻辑重新被放大”；
现在则是“AI产业逻辑没坏 → 但宏观分母端压住估值 → 所以个人角度也要先等宏观止血”。

那么当下要真正反转，大概率也要先等宏观层面给一个“止血信号”。不一定非要出现一个像4月初“伊朗挺火”那么大的宏观利好；更现实的是，市场需要看到分母端不再继续恶化。

这次为什么需要宏观先给信号？
因为这次下跌的主要矛盾，不是“AI逻辑崩了”，而是 利率、通胀、依稀会议、地缘、巨无霸IPO抽水、市场太过狂热拥挤度 一起冲击估值，去杠杆。

换句话说，市场现在不是在问：“AI还有没有需求？”
而是在问：
“利率如果继续上，AI股票给这么高估值还能不能撑住？”
所以这一次反转，优先级不是先看产业故事，而是先看宏观压力有没有停止上升。

顺序大概率也类似：先要宏观层面止血，至少CPI不能炸、美债收益率不能继续上冲、SpaceX IPO后是不是释放部分资金流动性，FOMC不能进一步放鹰。只有分母端压力缓和之后，市场才会重新回到AI分子端，重新交易算力短缺、存储涨价、AI capex和商业化加速。

当下要反转，先看宏观信号；但不需要宏观全面转好，只需要宏观不再继续恶化。宏观一旦止血，AI产业逻辑会很快重新接上。所以也是上周五晚上聊到的，短期内说很难完全逆转，需要耐心等。

本条由@bitget_zh赞助，「Bitget 买美股：秒级入场，丝滑交易 」
~~~

Quoted context:

~~~text
@qinbafrank: 怎么看这两天美股的大跌？其实是好几个因素共同作用的。1、周三在168X的Space时有聊，本周前半周给我的感觉很不好，老黄在点石成金，资金在疯狂追逐，其实有点狂热了。任何资产这种抛物线式的上涨都不可持续，总会有调整。然后周三晚上美股走势已经显现出调整的端倪了 https://t.co/l9uhb9l8lM
~~~

#### T17 2024-06-27 https://x.com/qinbafrank/status/1806144356367389153

Tweet id: `1806144356367389153`

~~~text
内存芯片制造龙头$美光科技 (https://t.co/9w7u0hPH0v)$发布了截至5月的2024财年第三季度业绩。尽管财报各项指标均超预期，但对下个财季的指引仅“符合市场预期”，不够亮眼，令美光科技盘后一度跌超9%。

美股市场对于企业业绩的要求是越来越高了，不仅要业绩超预期，还要未来指引超预期。随着基数越来越大增速终归是要降下来的，到时就要看估值消化的速度来。
~~~

#### T18 2024-10-16 https://x.com/qinbafrank/status/1846425682328592861

Tweet id: `1846425682328592861`

~~~text
美股财报季，银行业摩根大通、富国银行、高盛等财报都很好，昭示了经济基本面的强韧。但是昨晚阿斯麦的财报，业绩都是超预期但是在手订单只有市场预期的一半，大跌近17个点，带动了芯片股票的小崩。作为半导体最领先的光刻机制造商、阿斯麦在手订单大幅下滑市场很担心其下游需求出了问题。

阿斯麦官方表示，人工智能相关的芯片需求确实激增，但半导体市场的其他部分比预期更为疲弱，导致逻辑芯片制造商推迟订单，而内存芯片制造商只计划“有限的”新增产能。简单说就是AI芯片需求仍然强，但是其他方面逻辑芯片、存储芯片需求在减退了。17号就是台积电的财报了，估计能看出来Ai芯片需求是继续强势还是也有了衰减迹象。
~~~


### Case 1B Raw: Competitor Qinbafrank Answer And Visible Citation

Source: user-provided transcript from TheMarketBrew. Some citation text may be UI-visible/truncated.

Prompt:

> 今天你觉得应该买 DRAM么，你怎么看 DRAM 目前的情况，他还能回到高点么，我今天应该在什么价格挂单买入？

Answer raw:

~~~markdown
根据博主 @qinbafrank 的公开投资方法论以及对半导体存储行业的长期研究，我们可以从产业叙事机制、价格周期定性、技术估值约束三个维度来系统拆解今天是否该买 DRAM（以美光 MU 2026年6月24日最新财报前夕的数据及情况为例），以及具体的挂单策略。

一、 核心定性：这依然是“结构性紧平衡”的黄金时代吗？
在博主的投研框架中，首要原则是：不把存储行业当作纯粹的周期股来看待，而应该看作是“学精了”的半导体大厂在 AI 时代形成的结构性紧平衡 [[#1\]](https://x.com/qinbafrank/status/2025195888491286833)。

产业叙事是否仍在加速？
是的。 这一轮存储行业最核心的叙事并非老旧产能的无序扩张，而是三星、海力士、美光三大厂在尝过往年惨烈出清的教训后学精了 [[#1\]](https://x.com/qinbafrank/status/2025195888491286833)。它们主动削减了 DDR4 和普通低端 DRAM 的产能，全力将产能转移到 GPU/HBM 以及高价值的 DDR5 上 [[#1\]](https://x.com/qinbafrank/status/2025195888491286833)。
这种主动克制产能的行为，加上 AI 数据中心的爆炸式需求，使存储厂商变身为了“超级乙方”。
价格周期能回到高点吗？
事实上，价格的节奏已经呈现非线性的高速运转 [[#1\]](https://x.com/qinbafrank/status/2025195888491286833)。
历史上的内存涨价周期需要慢慢走 2–3 年；但在目前的体制下，2025 年 DRAM 整体上涨了约 60%，甚至在短短 2 个月内个别合约价就能飙升 60% [[#1\]](https://x.com/qinbafrank/status/2025195888491286833)。根据历史观点，2026 年 DDR4/DDR5 预测仍有 30%–40% 的上涨空间，且三星等大厂预期 HBM 的紧缺状态会一直维持到 2027 年 [[#1\]](https://x.com/qinbafrank/status/2025195888491286833)。
结合 2026 年 6 月的最新行业预期，瑞银（UBS）等顶级机构指出，在 2026/2027 年，Memory / Storage 极有可能占据整个半导体行业总收入的近半数。因此，不仅是回到高点，由于 HBM 狂飙、DDR5 升级、先进封装/Rubin机柜交付等多维逻辑的共振，行业高确定性的景气周期大概率将延续更久。

二、 美光（MU）当前的估值与博主的“上车”标准
博主常说：“高预期下，业绩好但不够炸裂，就杀估值。” 那么美光目前的性价比处于什么区间？

财报前夕的市场情绪：目前市场正处于高度紧张地等待美光即将发布的最新季报（由于市场剧烈波动，美光最近一交易日收于 $1051.77，跌幅 13.18%）。这种跌幅很大程度是财报前的“杀估值”宣泄。
估值指标交叉验证：
动态 PE 极低：虽然美光目前的滚动市盈率（Trailing PE）较高（约 49x），但由于 2026/2027 财年的业绩增长预期极其炸裂（分析师预计 2027 财年 EPS 平均可达 $121.33），其 2027 财年前瞻/动态市盈率（Forward PE）仅为 8.67x。
PEG 远小于 1：美光的 PEG 指标仅为 0.31。在博主的框架中，PEG < 1 是妥妥的高成长股标配 [[#1\]](https://x.com/qinbafrank/status/2025195888491286833)。动态 PE 远低于业绩增速，意味着该标的并没有估值泡沫，依然挂在最确定的产业卡脖子环节上。

三、 今天的操作：我应该买吗？在什么价格挂单？
博主对于操作有非常硬性的约束，坚决反对精确预测点位，更不提供具体的买卖指令。但我们可以用他的风控法则（小、中、大三级风险管理）以及技术面的关键支撑位，为您推演出一套科学的“建仓和挂单逻辑”：

1. 明确您的风险认知（“打脸条件”与“拿得住”原则）
博主常问：“如果这只股票回调 30%，你能不能拿得住？” 如果拿不住，说明认知不够，今天不该重仓甚至不该进场。
建仓前置条件：今天的下跌是美光财报前的恐慌性“杀估值”。如果财报出来，指引依然强劲，这就是典型的“忽略大盘指数、杀估值上车”机会；但如果最新财报给出的毛利率或 HBM 产能扩张计划过分激进，导致供求天平开始失衡，那么这就升级为了“杀逻辑”。
2. 技术面支撑与挂单策略（以 2026-06-24 $1051.77 股价为基准）
当前技术指标显示美光依然处于大级别的上升趋势中（50日均线 $761.22，200日均线 $410.85 维持多头排列），但短期因财报情绪出现了较强的宽幅震荡。

强支撑 1（近端回踩位）：$1000 整数关口
20日均线（SMA 20）目前在 $1003.08。整数关口 $1000 既是心理防线，也是短期均线粘合处。
挂单建议：如果您属于温和看多、想在财报前进行底仓配置的投资者，可以在 $1005 - $1015 之间分批挂第一档买单。
强支撑 2（波段防御底）：$850 - $860
技术分析显示核心支撑位 1 在 $854.35。如果大盘遭遇系统性流动性紧张，或美光财报后的反应呈现极度恐慌（哪怕业绩好但指引没亮瞎眼而被“杀估值”），股价有概率下探至此。
挂单建议：如果您风格极其克制，不愿在财报前承担过大波动，可在 $855 - $870 挂一笔“防守型”的捡漏单。
阻力位：第一阻力位在 $1089.29。如果日内股价直接站回 $1090 以上，说明多头情绪提前修复，不需要急于追高，让子弹自己飞着看看。

总结建议
该不该买：如果你认可“大厂克制扩产+AI结构性紧平衡”的中期逻辑，且能承受半导体板块财报季 20%+ 的中级别波动风险，当前美光 PEG < 1 的估值显然具备极高的基本面性价比。
如何挂单：不要一次性全仓买入。 建议利用财报前的 whipsaw（剧烈拉锯），将资金分成 2-3 份。今日可在 $1005 - $1015（20日线关口） 挂第一注；并在 $860（核心支撑带） 挂第二注。
打脸警惕（退场条件）：如果接下来的行业财报或追踪数据里，三大厂（美光/三星/海力士）的加权平均长合约期限开始明显缩短，或者厂商们彻底放弃供给纪律开始疯狂建厂扩产能，那么“结构性紧平衡”就会退化回“传统大周期”，届时必须无条件削减仓位。
~~~

Visible citation raw:

#### #1 https://x.com/qinbafrank/status/2025195888491286833

~~~text
Section: 1. 价格：2 年走完过去一个完整上行周期的幅度

### 1. 价格：2 年走完过去一个完整上行周期的幅度

- DRAM / DDR / HBM 的价格暴涨节奏：2025 年：DRAM 价格上涨~60%，预测 2026 年再涨30–40%，特别是 DDR4/DDR5。2025 年 9–11 月，Samsung 的 32GB DDR5 合约价从大约 $149到$239，两个月涨了 60%；其他容量模块涨 30–50%。

- HBM：SEMI 预计 HBM 设备投资 2025、2026 两年每年再增长 15%；HBM 价格已经创历史新...
~~~

### Case 2A Raw: Robindex Serenity Answer And Citations

Source chat: `c_d472e7dd-06dd-4e6a-a4bf-3ecdc7827151`

Prompt:

> 今天你觉得应该买 DRAM么，你怎么看 DRAM 目前的情况，他还能回到高点么，我今天应该在什么价格挂单买入？

Answer raw:

~~~markdown
今天DRAM跌了14%，MU跌了13%，WDC跌了8%，整个memory板块被砸得挺狠。你问我该不该买，我的答案是：**买，但不是无脑接飞刀，要用框架去定价，而不是看K线恐慌。**

先说结论：**DRAM这个ETF本身没问题，我四月份就公开说过这是个好东西**[1]。它把MU、三星、SK Hynix、SNDK、Kioxia、WDC、Nanya、Winbond全打包了，等于一键持有全球memory bottleneck。今天这个跌幅，放在整个memory supercycle的背景下，更像是情绪驱动的错杀，而不是基本面反转。

让我把推理链展开。

第一，**今天跌的原因跟memory基本面无关**。你看新闻，没有一条说NAND/DRAM价格突然崩了，没有一条说hyperscaler砍capex了。跌的是整个科技板块的情绪共振——Barrons那篇"Micron Paradox"文章提到市场在等MU earnings，担心"post-print selloff"[2]，加上Yahoo Finance那篇"tech stock turmoil makes sense"的宏观情绪图[3]。这就是典型的sector contagion，市场因为对宏观的恐惧把整个memory板块一起砸了，但MU、SK Hynix、Samsung的基本面跟这些宏观噪音毫无关系。我过去反复说过：**这种非基本面的板块性抛售，恰恰是买入被错杀个股的机会**[4]。

第二，**memory的基本面不仅没变，还在加速**。Counterpoint Research的原话是："There is no scenario where memory prices correct in the second half [of 2027], given that hyperscaler purchasing intent remains unbroken"[4]。Intel CEO也说过"no relief on memory shortage until 2028"[4]。NAND价格Q1涨了100%+，Q2三星又翻倍涨了100%+，DRAM也在持续涨价[5][6]。Phison CEO的访谈里说得更直白：memory foundries现在要求客户提前三年预付现金才能保证供应，单是NVDA Vera Rubin一个平台就需要20+TB SSD per unit，这就会消耗去年全球NAND产能的20%[7]。这不是周期性的需求，这是结构性的黑洞。

第三，**MU现在的估值是荒谬的便宜，不是贵**。PE-TTM 49.8看起来高，但那是用过去的利润算的。Forward PE只有8.6倍，PEG 0.38，营收增长196%，净利润增长762%，毛利率74.4%[8]。我去年就用NAND/DRAM价格报告提前推算过MU的毛利率，跟后来财报报出来的一模一样[9]。按现在的价格 hike 趋势，MU 2026年的net income估计在$46.5B左右，2027年可能到$63.5B[10]。一个年利润$46B+的公司，今天跌完市值大概$520B左右，Forward PE不到12倍。SK Hynix更夸张，Macquarie的预测是2026-2027两年operating income合计可能超过$500B，而它市值才$514B[11]。**这些公司正在成为人类历史上最赚钱的机器，但市场还在用周期股的框架给它们定价。**

第四，**今天这个跌幅放在历史模式里看，是典型的"好消息出来先跌后涨"**。我三月初就注意到一个反直觉的现象：每次Trendforce或Digitimes报道DRAM/NAND大幅涨价，Samsung和SK Hynix反而先跌，然后一个月后涨27%[11]。市场总是把涨价解读为"通胀风险"或"需求见顶"，但最终fundamentals takeover。今天MU从$1211跌到$1051，跌幅13%，跟之前几次pattern一致。而且你看K线，6月18日刚冲到$1149的高点，然后回调，今天加速下跌——**这更像是earnings前的仓位调整，而不是基本面崩盘**。

第五，**关于"还能回到高点吗"**——高点$1211是昨天的事，不是去年的事。memory cycle的price hikes预计持续到2028年，需求是结构性的，不是周期性的[12]。我跟踪的指标只有一个：hyperscaler capex projections。只要这个不崩，memory就还在超级周期里。Google的TurboQuant这种算法优化确实可能边际减少DRAM需求，但它不影响NAND，而且Jevons Paradox决定了效率提升只会扩大总使用场景[13]。真正需要担心的是软件效率极端提升或者hyperscaler突然砍capex，这两件事目前都没有任何迹象。

**关于挂单价位**，我不给具体的买卖建议，但我可以分享我的思考框架。MU从$1211跌到$1051，跌幅13%，Forward PE已经到8.6倍。如果你相信Counterpoint说的"no correction until 2H 2027"，那这个位置就是打折买入超级周期的机会。我会关注$1000-1020这个区间——那是6月16日的低点附近，也是这轮回调的一个技术支撑位。如果跌破$1000，那可能是更深的情绪性抛售，但基本面没变的话，那反而是更好的买入点。**记住，entry point很重要，我当初说$MU和$AXTI的时候，不是所有人都买在最低点**[14]。

最后，**DRAM这个ETF的设计本身就是冲着memory bottleneck去的**[1]。如果你没有韩国股票账户买不了SK Hynix和三星，或者不想承担单一个股风险，那DRAM是很好的工具。今天跌14%之后，它的持仓里MU、三星、SK Hynix、SNDK全都在Forward PE 5-10倍的区间，而它们的利润还在以三位数的速度增长。**市场在用一个周期股的框架给一个结构性需求爆发的行业定价，这就是alpha所在。**

不是投资建议，这是我的思考过程。DYOR。
~~~

Citation raw snippets (18):

#### T1 2026-04-03 https://x.com/aleabitoreddit/status/2039894556871913726

Tweet id: `2039894556871913726`

~~~text
If you want exposure to memory, $DRAM is a genuinely great ETF.

I normally don't praise ETFs, but this is solid.

1. $MU - 24.63%
2. Samsung - 24.11%
3. SK Hynix - 23.08%
4. $SNDK  - 4.9%
5. Kioxia - 4.86%
6. $WDC - 4.77%
7. Nanya - 3.89%
8. Winbond - 2.4%

Disclosure: Friends over at @roundhill did reach out about the launch, but I'm not getting paid to say this (just in case you think this random post is sponsored, it's not). 

Just a genuinely great ETF for memory exposure if you don't have access to foreign stocks. 

And I’d encourage more institutions to make ETFs like this.
~~~

#### T2 2026-03-15 https://x.com/aleabitoreddit/status/2033320724291813503

Tweet id: `2033320724291813503`

~~~text
The Memory Cycle.

Is probably going to look like this chart?

With SK Hynix,  $SNDK, Samsung,  $MU and others:

-> Price Hikes until 2028
-> Demand Increase Permanent
-> Price Decreases After 2028

-> Increased Capacity * Increased Demand * lower margin = High Profit Anyway. 

For example:

2026 Q1: DRAM, NAND Price Hikes
- NAND prices 100%+ Q/Q, DRAM up 70%+. 

2026: Q2: DRAM NAND Price Hikes
- Samsung hikes Q2 NAND prices 100%+ Again, DRAM up. 

Q3 -> 2028 Price Hikes. 

1. Counterpoint: "There is no scenario where memory prices correct in the second half [of 2027], given that hyperscaler purchasing intent remains unbroken"
2. Intel CEO: "No Relief on Memory Shortage Until 2028".

However what people misunderstand:

-> Memory Demand Is Structural with AI. 
-> Prices are not. 

We'll likely keep seeing price hikes with the extreme memory shortage in 2026. 

But prices start to fall in 2028. What people conflate is:

-> Extreme demand for AI will not cause prices to go to 0.
-> More capacity will not cause demand to suddenly go to 0.  

More Supply * Price * More Demand * lower operating margin = more profit anyway. 
 
Operating income will not be 10000%+ Q/Q like now. 

But if SK Hynix is producing a more steady ~$100B+ operating income Y/Y at a $400B MC from increased capacity but lower margin: 

Compared to $100B -> $220B -> $90B -> $120B.

 Then that itself looks undervalued. 

I don't see a world where it ends up being $100B-> $180B (2027) -> $10B what doomposters are projecting, where they operate at a loss from both demand downturn (eg. smartphones) and margin downturn. 

The main two things is to look out for is if software/memory usage gets extremely, extremely efficient or hyperscaler capex suddenly disappears (AI is no longer a thing).

Same could be said around GPUs for training/inference. 

But, I would mainly be looking out for hyperscaler capex projections as the #1 indicator. Not random out of context quotes taken from Samsung executives to signal operating income two years out. 

AI has fundamentally changed what the "commodity" memory is, similar to GPUs back in 2023.
~~~

#### T3 2026-03-21 https://x.com/aleabitoreddit/status/2035179905235992614

Tweet id: `2035179905235992614`

~~~text
I see a lot of retail panicking over $MU earnings at $468. 

In general, re-pricing in stocks happen before earnings are announced. 

The exception is "unless there's a major surprise with guidance".  

Micron earnings beat was not a major surprise. 

Here's my take: 

- Jan 25th 2026: Public news broke out Samsung was doubling NAND prices Q1, DRAM ~70% compared to Q/Q estimates of 33-38%. 

Institutions probably got word a few days early from 300 paid vendor analysis, which is why $MU went from $300 -> $400. 

- Back in early March: News broke out Samsung was doubling NAND prices for Q2, which was a major surprise, beating some estimates by 20 times, while beating others by 5 times. 

There was also news that Samsung/SK Hynix were planning large DRAM price increases for the next quarter. 

However, this was coupled with index dropping/broader macro fears from the Ukraine war. 

While there was a major sell-off in majority of names, these fundamental changes, likely led $MU to outperform names like $MU that dropped 20% YTD.

Leading up to earnings, there was a Bloomberg terminal report projecting Micron to beat earnings, which sent the stock from $400's to $460. 

The thing is: 

Majority of this earnings beat was known in advanced and priced in throughout the entire year.

If you ever read my posts, 

- I've been trying to track DRAM/NAND prices along with estimating hyperscaler demand:
- Tracking to track crude/LNG/Helium disruption on semi supply chains and modeling in any margin impact

Which is how you price in memory companies. 

-> Earnings are just confirmation that your estimates before were right. 

So if you're buying options on the earnings week:

This is a terrible idea. 

All the profit to be made is before information is known and priced in by the broader market.
~~~

#### T4 2026-03-13 https://x.com/aleabitoreddit/status/2032260350457102748

Tweet id: `2032260350457102748`

~~~text
Memory Price Market Research from Counterpoint:

"There is no scenario where memory prices correct in the second half [of 2027], given that hyperscaler purchasing intent remains unbroken"

In regards to $SNDK, $MU, $EWY (Sk Hynix, Samsung), and other memory names.

They commented: DRAM output from Samsung, SK Hynix, Micron, CXMT, and Nanya is forecast to grow 26% this year, with NAND up 24%. 

But hyperscaler demand will likely far outstrip supply for the foreseeable future. 

This mirrors $INTC CEO's comments about "No Relief on Memory Shortage Until 2028". 

With NAND prices Q1 increasing 100% + Samsung hiking NAND prices Q2. 

And DRAM prices going through constant price hikes. 

The explosive increase in operating margins from memory makers across the board are poised to outweigh any macro.
~~~

#### T5 2026-04-30 https://x.com/aleabitoreddit/status/2049960149876719991

Tweet id: `2049960149876719991`

~~~text
I said with memory companies like $SNDK or $MU, the repricing happens before the actual earnings. Not actual earnings.

You can estimate it with third party NAND/DRAM Trendforce type price hike reports. Then estimate gross margins off of those. 

I did it for Micron earlier as an example and got reported gross margins spot on.
~~~

#### T6 2026-03-07 https://x.com/aleabitoreddit/status/2030297739783970882

Tweet id: `2030297739783970882`

~~~text
@PronologieFR Samsung just doubled NAND prices the other day, DRAM prices hiked. 

imo SK Hynix looks like a terrific buy on the dip. Fears are overblown on oil/LNG imports.
~~~

#### T7 2026-02-02 https://x.com/aleabitoreddit/status/2018260327293751484

Tweet id: `2018260327293751484`

~~~text
Memory Company Overview (February 2nd).

Forward P/E Estimates for 2026/2027: 

Micron ( $MU ) +31.5% YTD:
~10.4x (2026)

Sandisk ( $SNDK ) | +109.36% YTD:
~14.6x (2026)
~6.3x (2027)

Samsung Electronics | + 17.04% YTD:
~5.1x (2026)
~4.3x (2027)

SK Hynix | +22.6% YTD:
~4.3x (2026)
~3.4x (2027)

Numbers were derived from Morgan Stanley's research note for Samsung/SK Hynix. Bernstein for Sandisk. HSBC report for Micron.

Sandisk/Samsung/SK Hyinx are most up to date.

Micron's report was January 23. But recent updates today show "Micron Proposed A 115–125% QoQ Increase for server DRAM"  (dramexchange). 

With rumors that NAND prices increased 100%+ from Samsung the other week: new calculations would may bring Micron to ~6.9x-7.3x forward P/E. 

Original calculations were using prior analyst reports.

The net income memory companies are expected to bring in is absurd. But clearly the market is pricing in some skepticism with the rally (with Samsung/SK Hynix). 

However if the memory cycle continues past 2027-2028, these companies could be the most profitable in history.
~~~

#### T8 2026-03-16 https://x.com/aleabitoreddit/status/2033447091679416393

Tweet id: `2033447091679416393`

~~~text
Imagine all the people who sold their memory positions.

From SK Hynix, Sandisk, and Micron because of “Helium”?

Sk Hynix: +7.03% 1D
$SNDK: +31.75% 1W
$MU: +19.66% 1W
Samsung: +2.83% 1D

Look at NAND, DRAM hikes, which were all way beyond estimates. 

As well as company statements that there was zero material effect. 

Media doomposters and panic sellers. drives short term prices.

Operating profit drives long stock prices.
~~~

#### T9 2026-02-15 https://x.com/aleabitoreddit/status/2023035297089638788

Tweet id: `2023035297089638788`

~~~text
@KAnalyser1 Yes. $MU projections are a bit lower though.

$10.8B (2025) -&gt; $46.5B (2026) -&gt; ~$63.5B (2027) were some estimates. Of course if you model in NAND/DRAM price increases those numbers might go up more, but they’re generally less than the big 5 above
~~~

#### T10 2026-03-13 https://x.com/aleabitoreddit/status/2032581623275991301

Tweet id: `2032581623275991301`

~~~text
IV $EWY trade was successful. Volatility of the Korean Index went from 32% IV -> 46-48%. 

Now it's more of a directional long on memory from SK Hynix/Sasmung. 

NAND prices hiked up 100%+ Q1 and Samsung reportedly jacked up 100%+ again Q2. DRAM prices also hiked way past expectations.

Helium/Oil/LNG fears are overblown currently so I'm staying long on Korean memory sector.  

Operational income should blow away any macro fears.
~~~

#### T11 2026-03-07 https://x.com/aleabitoreddit/status/2030423108902154703

Tweet id: `2030423108902154703`

~~~text
No, $EWY is Samsung/SK Hynix which are primarily memory.   

Q2 NAND prices were hiked 100%+ by Samsung yesterday while analyst expectations were all projecting 5-30% increases from Q1.   

NAND/DRAM is a separate bottleneck but we're midcycle (but demand is likely structural, 100%/quarter price hikes, probably not). 

Photonics is early.
~~~

#### T12 2026-02-16 https://x.com/aleabitoreddit/status/2023323844346618010

Tweet id: `2023323844346618010`

~~~text
TLDR of Phison CEO interview on Memory and Investment Framework:

"Toll Collectors": 
- Micron ( $MU ) 
- SK Hynix (000660.KS)
- Samsung Electronics,
- Western Digital ( $WDC )
- $SNDK.

T2: 
- $MRVL
- $SIMO
- Phison Electronics

Companies that design the logic/software controllers connecting memory to compute will capture massive value as AI moves to the edge.

T3: 
- Pure Storage ( $PSTG )
- NetApp ( $NTAP )
- Seagate ( $STX)

As Vera Rubin inference servers roll out, the explosion in KV Cache and data generation will trigger a massive hardware upgrade cycle specifically focused on data center storage density and high-capacity Enterprise SSDs.

Hilariously: $EBAY (refurbished electronics), might be a beneficiary. 

- Short / Avoid Low-Margin Consumer Hardware.
- Short / Avoid Unhedged Auto/IoT Makers

Main alpha points:

- The "3-Year Prepayment" Cash Flow. Memory foundries are demanding 3 years of cash prepayments to guarantee supply. 

- The Inference Bottleneck is Storage, Not GPUs. A single 10-million-unit run of $NVDA Vera Rubin platform requires 20+TB of SSD per unit, which alone would consume 20% of last year's global NAND capacity.

- The "Chinese Supply Glut" Bear Thesis is Dead: 

Pan entirely dismisses this point around YMTC and CXMT. China’s internal AI demand is so massive that it will instantly swallow 100% of its domestic production. No cheap Chinese memory will leak into the global market to rescue western hardware OEMs.

TLDR from the interview: 

Memory demand is structural. No supply end in sight. $INTC CEO confirmed this last month.
~~~

#### T13 2026-01-28 https://x.com/aleabitoreddit/status/2016487104000446545

Tweet id: `2016487104000446545`

~~~text
Nanyna (TPE: 2408) is one of my longs alongside $MU, SK Hynix, and Samsung for memory.

But for a different reason.  

You might be thinking if this parabolic trend (+972% 1Y). is going to stop? Probably not. 

And it just keeps going up 7% a day.

Here's a simple TLDR why: 

The forward P/E is only ~13.62 (likely lower now with price hikes).

With +357.7% Revenue Growth/+804.27% Net Income Growth Y/Y, their profits are astronomical. 

Similar to Micron and their 57.56%+ last month, and more than doubling since I first mentioned it: 

The stock price literally can't keep up. 

While the giants (Samsung, SK Hynix, and $MU) are fighting over the high-end AI market, Nanya specialized in the legacy and specialty DRAM products from PCs, computer electronics, and  industrial. (They are doing advanced chips though with 1b Nodes though).

And the memory companies left a massive void Nanya filled: 

Micron - Total Exit from Consumer Lines
SK Hynix - Focusing almost entirely on HBM4 and server-grade DRAM.
Samsung - Reallocating 30–40% of legacy lines to advanced AI memory.
Nanya - Last man standing

Demand stayed steady but legacy DRAM supply suddenly fell off a cliff. And it's still widely used from:

- Consumer PCs and Laptops: Millions of computers built between 2015 and 2023 use DDR4
- Smartphones: Most mid-range and budget smartphones use LPDDR4
- Home Electronics: Smart TVs, gaming consoles (like the older Nintendo Switch or PS4) use these.

Basically, they still need to make these, but Nayna has all the cards. 

Buyers are paying a "scarcity premium" for older memory because they can't find it anywhere else and seeing a supply shock in a boring market. 

Nanya essentially became the guy selling water in a desert. And they can keep jacking up the price of water.

I'm long on the cat sounding company selling water in the desert.
~~~

#### T14 2026-04-18 https://x.com/aleabitoreddit/status/2045570512034910342

Tweet id: `2045570512034910342`

~~~text
@ArkhamInvests I'm still personally long 2028 leaps on $EWY for memory exposure. Those are up over triple digits, since I expect Samsung/Sk Hynix to be printing.

$DRAM was another good vehicle for exposure.
~~~

#### T15 2026-02-15 https://x.com/aleabitoreddit/status/2022927747795087572

Tweet id: `2022927747795087572`

~~~text
@elicapitalgroup Great companies. But it's actually appears to be the start of a new hoarding cycle, wasn't thinking about $WDC, $STX, or $SNDK.
~~~

#### T16 2026-03-02 https://x.com/aleabitoreddit/status/2028374385544093829

Tweet id: `2028374385544093829`

~~~text
Samsung Electronics and SK Hynix reportedly sharp DRAM price increases from Digitimes today.

Part of source was the Seoul Economic Daily report this week that stated:

“Customers may need to accept prices more than double their previous contract rates to receive DRAM allocations”.

The sharp DRAM price hikes come with NAND price hikes as “Phison shifts to prepayments as NAND prices hike 500%” today.

There is a relentless black hole on memory demand.
~~~

#### T17 2026-03-25 https://x.com/aleabitoreddit/status/2036862433319583898

Tweet id: `2036862433319583898`

~~~text
Google's TurboQuant...

And it's effect on $SNDK, $MU, SK Hynix, and others:

What it does:
-> 6x reduction in KV cache memory footprint
-> 8x Speedup on H100 GPUs

It's a compression algorithm.

Now... Will it beat down memory?

-> Prob not.

Implications might be bullish for $ARM and others though where you can run AI locally, rather than DRAM heavy DCs.

However:

->This is basically DeepSeek round 3. You can make algorithms more efficient. But that doesn't replace either memory or GPUs.
-> It could structurally (and slightly) reduce DRAM demand.
-> think it's only been tested on small models so far like Gemma, Mistral, and Llama-3.1 (and paper's been out for a year)

Also, markets conflated DRAM with NAND... this algo compresses the KV cache (DRAM). Doesn't do anything to NAND storage?

Regardless:

Algorithms will always get more efficient. People keep saying Jevons Paradox, which is true since this just scales use cases.

Main thing to look out for is hyperscaper capex projections, not Google Algorithms that made things more efficient.

Feels more like a narrative headwind than anything material to earnings.
~~~

#### T18 2026-03-02 https://x.com/aleabitoreddit/status/2028487006708539512

Tweet id: `2028487006708539512`

~~~text
Not sure if it's just me? 

But I've been tracking Samsung/SK Hynix correlation to DRAM/NAND price hikes reports.

Every time there's news about reported massive hikes on DRAM on NAND, they both + $EWY seem to drop.

Then afterwards, it pulls off a rally?

For example, last month Trendforce reported 70% DRAM and 100%+ NAND hikes and Samsung/Sk Hynix both dropped following the news. 

1 month later it increased 27.8%. 

This time both have dropped again after DRAM price hikes from sedaily and digitimes. But maybe the war in Iran is more of a confounding factor. 

Seems very counterintuitive going down on positive news. But eventually fundamentals take over?

Especially if by next year, SK Hynix's operating income for 2026-2027 ends up surpassing its marketcap?

eg. ~$190.5 billion USD+ ~$312.8 billion USD operating income projections ($503B operating income vs. Sk Hynix~$514B MC) from Macquarie on the 24th-25th in Feb.
~~~


### Case 2B Raw: Competitor Serenity Answer And Visible Citations

Source: user-provided transcript from TheMarketBrew. Some citation text may be UI-visible/truncated.

Prompt:

> 今天你觉得应该买 DRAM么，你怎么看 DRAM 目前的情况，他还能回到高点么，我今天应该在什么价格挂单买入？

Answer raw:

~~~markdown
1. 核心定位与白话结论
今天不适合在季报公布前的混乱波动中盲目挂单抢入。

从供应链下沉和物理咽喉的方法论来看，存储器（Memory/DRAM）毫无疑问是这轮 AI 资本开支周期（AI 资本开支 Cycle）中最核心的瓶颈之一 [[#4\]](https://x.com/aleabitoreddit/status/2015241123896369372)。

然而，我们必须将“产业长期超级周期”与“个股即期博弈”分开：

为什么不能盲目挂单？ 今天是 2026年6月24日，正是美光科技（Micron, $MU）公布最新季度财报的“大考之日”。当前市场期权定价显示股价可能会有超过 11% 的剧烈双向波动，市场情绪处于极度敏感的临界点。
它还能回到高点吗？ 答案是大概率能，并且有望创下新高。当前的短期调整只是“估值回撤”与季报前的“防守性洗盘”，并非“逻辑破裂”。白宫对“美国本土制造”（Made in America）的政策支持 [[#2\]](https://x.com/aleabitoreddit/status/2016126247869546583) 和 [[#6\]](https://x.com/aleabitoreddit/status/2014278521741553793)、三星与 SK 海力士在 Q2 开启的 DRAM 翻倍式涨价潮 [[#3\]](https://x.com/aleabitoreddit/status/2028374385544093829)，都在支撑存储超级周期继续超预期演绎 [[#4\]](https://x.com/aleabitoreddit/status/2015241123896369372)。
2. 核心判断理由
理由一：AI 已经打破了存储器的传统猪周期
在历史认知中，存储芯片是一个高波动的周期性商品。但正如当年英伟达在 4000 亿美元市值时被市场误认为“只是短期的矿卡/游戏周期”一样 [[#6\]](https://x.com/aleabitoreddit/status/2014278521741553793)，AI 资本开支的指数级增长已经彻底打破了存储器的旧循环 [[#6\]](https://x.com/aleabitoreddit/status/2014278521741553793)。

需求端：GPU 的每一次迭代（Blackwell 乃至后续的 Rubin 平台）都对 HBM（高带宽存储器）的容量和速度提出了翻倍的要求。
供给端：巨头之间正在进行“产能锁定”。Mag7 等超大规模云厂商直接出资帮 SK 海力士等上游厂商融资以锁定 HBM 产能。这种“多功能、多年可见度（Multi-year visibility）”的瓶颈才是机构追逐的确定性。
理由二：价格暴涨的逻辑未变，估值依然被严重压制
Digitimes 和首尔经济日报的最新数据显示，三星和 SK 海力士将在第二季度大幅调高 DRAM 价格，部分合约价甚至要求客户接受翻倍（100%+）的涨幅 [[#3\]](https://x.com/aleabitoreddit/status/2028374385544093829)。 再看基本面：虽然美光（$MU）在今天暴跌 13.17% 至 1051.77 美元（主要由于季报前资金获利了结与恐慌去杠杆），但根据估算，随着 NAND 和 DRAM 的持续提价，美光的远期前瞻毛利率有望触及 75-77% 的惊人水平 [[#2\]](https://x.com/aleabitoreddit/status/2016126247869546583)。对应其 2027 财年的前瞻 P/E 仅在 8.6x 左右，在盈利高速增长下，估值依然处于被严重压制的“前瞻错配”状态 [[#2\]](https://x.com/aleabitoreddit/status/2016126247869546583) 和 [[#5\]](https://x.com/aleabitoreddit/status/2018260327293751484)。

理由三：“美国本土制造”是无法替代的地缘防线
美光与英特尔（$INTC）一样，拥有白宫最顶级的法案护城河 [[#2\]](https://x.com/aleabitoreddit/status/2016126247869546583) 和 [[#6\]](https://x.com/aleabitoreddit/status/2014278521741553793)。随着地缘政治紧张局势的加剧，拥有美国本土晶圆厂制造能力（Made in America）的美光，其估值溢价是亚洲其他纯代工厂无法比拟的 [[#2\]](https://x.com/aleabitoreddit/status/2016126247869546583) 和 [[#6\]](https://x.com/aleabitoreddit/status/2014278521741553793)。这也是机构中长线资金（被动与主动）在每次暴跌时都会选择重新买入的底气。

3. 今日操作与挂单价格策略
由于今天是美光财报公布日，当前技术面上日线虽然依然维持多头排列（SMA 50 仍处于 761.22 美元的上升轨道中），但由于日内遭遇了约 13% 的砸盘，短期波动率（IV）极高。

操作姿态：等待财报靴子落地

如果你是中长线投资者：不必急于在今天的盘中挂单。财报公布后的 24-48 小时，做市商会对期权链（Option Chain）进行清洗，这通常会带来一个极为干净的低点（Entry Point）。
挂单价格区间建议：
第一支撑防线（轻仓分批吸纳位）：$950 - $1000 区间。这一区间接近千元整数心理大关，也是前期强力突破后的筹码密集区。
第二黄金防御位（重仓做多/期权 LEAPS 布局位）：若财报后指引出现噪音导致市场错杀，极限洗盘位在 $850 - $880 附近（技术面第一强支撑位在 $854.35 ）。如果在此区间企稳，将是极佳的无脑加仓机会。
打脸与下修信号（何时需要警惕？）

美光在财报中给出低于预期的毛利率指引（如果由于非 HBM 的传统消费电子拖累，导致毛利率无法如预期般爬坡至 70% 以上）。
HBM4 在 2026 年下半年的量产时间线出现严重推迟。
光电共封装（CPO）技术等底层带宽架构的落地速度远超预期，从而在更上游部分替代了对部分 DRAM 物理带宽的需求。
~~~

Visible citation raw snippets:

#### #1 2026-03-02 https://x.com/aleabitoreddit/status/2028374385544093829

~~~text
Samsung Electronics and SK Hynix reportedly sharp DRAM price increases from Digitimes today.

Part of source was the Seoul Economic Daily report this week that stated:

“Customers may need to accept prices more than double their previous contract rates to receive DRAM allocations...
~~~

#### #2 2026-02-03 https://x.com/aleabitoreddit/status/2018703864409870379

~~~text
There's a lot of disinformation around $MU, SK Hynix, and Memory after the new Nikkei Asia piece. 

Expected this to happen, since this is so badly written and misleading when the memory industry is so nuanced. 

This has close to 0 material impact on Micron and Sk Hynix.

CXMT a...
~~~

#### #3 2026-02-02 https://x.com/aleabitoreddit/status/2018260327293751484

~~~text
Memory Company Overview (February 2nd).

Forward P/E Estimates for 2026/2027: 

Micron ( $MU ) +31.5% YTD:
~10.4x (2026)

Sandisk ( $SNDK ) | +109.36% YTD:
~14.6x (2026)
~6.3x (2027)

Samsung Electronics | + 17.04% YTD:
~5.1x (2026)
~4.3x (2027)

SK Hynix | +22.6% YTD:
~4.3x (202...
~~~

#### #4 2026-01-27 https://x.com/aleabitoreddit/status/2016126247869546583

~~~text
"Made in America" is the greatest moat $MU and $INTC have. 

Here's the recent developments with Micron:

From NAND + DRAM hike est. on the 25th:

$MU forward P/E would likely be ~8.2-8.5 with gross margins sitting at 75-77%.

This is followed by new comments from Trump and Lutni...
Holy crap. This just happened:

"Samsung increases NAND prices by 100%" - ETNews

Estimates were 33-38% Q/Q growth - Trendforce

This is an ...
~~~

#### #5 2026-01-25 https://x.com/aleabitoreddit/status/2015241123896369372

~~~text
Holy crap. This just happened:

"Samsung increases NAND prices by 100%" - ETNews

Estimates were 33-38% Q/Q growth - Trendforce

This is an absolute shock. 

It's called the "Memory Supercycle" for a reason with $MU, Samsung, and SK Hynix + $SNDK.

In simpler terms:

That extra 6...
$MU looks like the next Nvidia. 

When Nvidia was $400B (now $4.5T+), markets thought GPUs were a short-term cycle.

Same with memory today....
~~~

#### #6 2026-01-22 https://x.com/aleabitoreddit/status/2014278521741553793

~~~text
$MU looks like the next Nvidia. 

When Nvidia was $400B (now $4.5T+), markets thought GPUs were a short-term cycle.

Same with memory today. 

AI has broken that cycle.

With the same "Made in America" and White House backing like $INTC:

Don't overthink things with Micron. https...
$MU forward P/E is still ~11.6

It's projecting: 

- 133% Y/Y Revenue Increase
- 319% Y/Y EPS Increase

This is called the memory supercycle...
~~~


### Case 3A Raw: Robindex Qinbafrank CRCL Answer And Citations

Source chat: `c_762ad49e-8dc5-450f-be8a-57647b826c69`

Prompt:

> 最近你怎么看 CRCL，今天该不该买，我如果想买我应该在什么价格挂单，然后在什么价格挂单卖出？

Answer raw:

~~~markdown
聊聊CRCL，这个问题问的时机很有意思，今天刚好跌了5个多点，收盘75.68，破了前几天的震荡区间。

先回答你最直接的问题：**今天该不该买？我的看法是短期情绪偏弱，现在不是急着抄底的位置。**

理由我按框架来拆解：

**1、CRCL现在到底在交易什么？**

CRCL是六月刚IPO的稳定币第一股，我在之前的分析里反复聊过一个规律——刚IPO的公司，特别是低流通标的，短期市场定价的核心不是业务基本面，而是市场走势、叙事预期和资金情绪 [1]。CRCL现在全流通盘非常有限，本质上还是个高度情绪驱动的筹码博弈。

对比之前聊过的几个案例：Alab、Crwv、Crcl（这里的另一个指代），无一例外在限售股解禁前都有一波由低流通和叙事驱动的大涨，然后临近解禁就开始剧烈调整 [1]。CRCL现在是IPO后大概三周，距离180天解禁期还很远，但已经经历了一轮从101到75的调整，这轮调整不是基本面崩了，是低流通筹码博弈的出清过程。

**2、短期压力来自哪几个方向？**

第一，宏观分母端在收紧。今天新闻里特朗普又威胁伊朗关于霍尔木兹海峡的事，油价一有扰动，通胀预期就下不来，利率预期就居高不下。而CRCL这种稳定币发行商的核心收入来源是储备利息——利率越高，利息收入越厚，这本来是利好。但市场现在担心的不是利率本身，而是高利率环境下整个风险资产的估值锚在收紧，成长股集体承压 [5][6]。CRCL的PE和PS倍数在低流通阶段被推得很高，现在市场开始重新定价这些倍数。

第二，稳定币赛道的监管叙事面临重新评估。今天有全球银行业机构对稳定币扩张发出警告 [news]，这会部分对冲之前清晰法案通过的利好。虽然法案框架已经定了，但执行层面的摩擦和银行端的对抗可能会制造间歇性噪音。

第三，CPN（Circle Payment Network）的进展需要时间验证。我之前详细聊过，Circle长期估值的天花板取决于能否从“稳定币发行商+储备利息”升级成“B2B支付基础设施提供商” [4]。这个方向是对的，但CPN才刚起步，非利息收入占营收比例还很低，市场在当前的宏观环境下缺乏耐心去等“未来故事”兑现。

**3、如果用成长股消化估值的框架看，现在贵不贵？**

之前聊过“EPS高速增长消化估值”的逻辑 [15]。CRCL现在的核心是：USDC发行量还在增长（这是基本盘），但储备利息收入高度依赖利率环境。如果油价下行、通胀预期回落、沃什重新回到降息轨道上，那CRCL的利息收入边际上会受损。也就是说，它面临一个悖论：

- 如果利率不下，分母端压力大，估值倍数撑不住；
- 如果利率下了，分子端利息收入也下来了。

要打破这个僵局，只能靠非利息收入（CPN的交易费、FX点差、订阅费）高速增长，让营收结构更抗周期。目前看这个拐点还没到，需要后续财报来验证。

**4、什么价格可以考虑进场？什么价格考虑卖出？**

说实话，我很难给你一个精确到小数点后两位的买卖点位，我的判断体系是定性不定量的，更多是推演大概率走势区间。

从技术面看，CRCL从6月2号的101跌到今天的75.68，累计跌幅约25%。这个幅度在低流通标的里不算极端，但也已经反映了相当一部分悲观预期。短期支撑位要看前低大概在74-75区域（6月5日那波暴跌的低点在78.4附近，今天已经破了）。

如果要我给一个框架性的建议：

- **想买的话**：个人倾向于等右侧信号，比如USDC发行量出现新一轮加速增长，或者CPN有实质性的客户落地公告。如果你确实想左侧试探，可以考虑在70-72附近挂单，那是6月初恐慌低点再往下的一个心理支撑区域。但要注意，在低流通环境下，情绪恶化时砸穿支撑的概率也不小，要控制仓位。

- **想卖的话**：如果你已经持有，短线反弹到80-82附近（前期震荡区间的下沿变为阻力）可能是减仓的机会。中长期如果CPN逻辑开始兑现，USDC发行量突破新高，那估值天花板会被重新打开，但这是以季度为单位的事，不是以天为单位。

**5、中长期怎么看？**

中长期我看好CRCL的产业逻辑。稳定币是加密-金融自循环经济体里的核心基础设施 [persona model]，USDC现在是合规最完善、储备最透明的美元稳定币，法案通过后发行量大概率继续上台阶。Circle的商业模式从“卖美元稳定币”升级到“卖全球支付轨道”这个方向是对的，CPN就是那个关键变量 [4]。

但节奏上，现在处于“产业逻辑没坏、但宏观分母端压住估值”的状态。跟之前在AI/半导体上看到的调整逻辑类似——需要先等宏观止血，市场才会重新回到产业分子端的交易 [5]。

所以综合下来，我的态度是：中长期不悲观，短期不急着抄底。等个更好的位置，或者等个更明确的催化剂再动手。个人观点，不作为投资建议。
~~~

Citation raw snippets (18):

#### T1 2026-05-15 https://x.com/qinbafrank/status/2055115312526434650

Tweet id: `2055115312526434650`

~~~text
昨晚Cbrs上市开盘就翻倍市值直接顶到800多亿美金，还是前两天聊到的上市时机很好，现在推理正在快速拓展、市场也希望能找到新的潜在英伟达挑战者、也会给更高的定价和预期。

看昨晚成交3349万股，基本上IPO发行的股份全都换了一遍手。IPO后到解禁期前只有15%的流通盘，市场的定价核心并不是业务，而是市场走势、叙事预期和资金情绪。靠资金和情绪在推一把，摸到千亿门槛也是有可能的。但也不能上头，虽然Cbrs现在15%流通，也只是百亿美金的流动盘，比之前的几个热门新股上市流动盘规模都要大不少。

从中长期角度、真正值得布局入手可能是解禁期之后，看CBRS IPO文件、解禁期是ipo后180天或提前至Q3 2026财报发布后两个交易日（取较早者）。那个时候85%的限售股解禁巨大抛压都会给你砸出一个长周期的的安全垫出来。

过去两年有三支热门的新股上市之后走势可以做参考：
24年3月IPO的半导体链接方案的Alab；
25年3月IPO的新云厂商代表Crwv；
25年6月IPO的稳定币第一股Crcl。
无一例外在限售股解禁后都砸出了一个坑。不一样的事Alab上市后一路走低、一直到解禁后才拉低一波4倍，crwv和crcl都IPO后都爆拉了一波，越临近解禁跌的越猛。

本条由@bitget_zh赞助，「Bitget 买美股：秒级入场，丝滑交易 」
~~~

Quoted tweet (qinbafrank): https://x.com/qinbafrank/status/2053642250446573611

~~~text
Cerebras的IPO火爆，官方考虑大幅上调IPO定价区间。看路透社报道，Cerebras正考虑将IPO定价区间从此前的每��115至125美元上调至150至160美元，涨幅高达约28%。与此同时，公司还计划将发行股数从2800万股增至3000万股。若最终以每股160美元定价，Cerebras此次IPO募资规模将达约48亿美元。 https://t.co/03t9vF9fkY
~~~

#### T2 2025-12-04 https://x.com/qinbafrank/status/1996437245545594907

Tweet id: `1996437245545594907`

~~~text
@Guilin_Chen_ 吓一跳以为咱俩不是一个crcl、一看确实不是一个😂
~~~

#### T3 2025-11-28 https://x.com/qinbafrank/status/1994421436547760155

Tweet id: `1994421436547760155`

~~~text
@BTCdayu 原来今晚crcl被大宇拉盘了👍
~~~

#### T4 2026-05-08 https://x.com/qinbafrank/status/2052771715739234600

Tweet id: `2052771715739234600`

~~~text
关于Coin与Circle的合作协议以及看circle未来空间的三个关键点。今天coinbase CFO首席财务官AHaas在电话会议上表示“Coinbase的USDC合同(注：指的是与Circle的分销协议)每三年会自动续约，并且是永久续约。该合同无法被终止”很多人被这个表态吓到了。

其实这个续约条款在双方23年签署合作协议就是明确的，当时协议就是公开的，之前在SEC备案的EX-10.1（Circle S-1相关附件）和Coinbase 10-K/年报中都有明确披露，并不是今天才变的。其实部分投资人对此应该是有预期的

虽然之前我也期待续约谈判能新的改变，

对于Circle的未来空间、其实关注三点就好：
1）先看usdc发行量的增长，这个决定储备收入的增加，这是基本盘。未来几年usdc发行量是不是能增加到几千亿美金、整体营收也会水涨船高。

2）然后看CPN的发展，这个才是决定未来circle的上限。前两天有聊过：CPN Managed Payments的推出标志着 Circle 从“稳定币发行商 + 储备利息主导” 开始向 “B2B SaaS 支付基础设施提供商”的角度进一步迭代升级。

未来收入来源不再仅靠储备利息，而是交易量驱动的 recurring revenue（交易费 bps、服务订阅费、基础设施使用费、FX 点差等），这也跟Circlezai 26年将非利息收入规模化的目标是一致的。收入更具可持续性和抗周期性（即使利率下降，交易量增长也能带来稳定现金流）

商业模式迭代升级的核心就在于此：
从“卖美元稳定币”进化到“卖全球支付轨道”，通过 B2B SaaS形式提供类似 SWIFT的网络服务。

3）再看非利息收入里的cctp v2“fast transfer”的探索收费模式，估计arc公链未来的营收。

非利息收入里个人最看重第二点，Circle Payment network的增长情况，未来circle商业模式的基石。

个人的理解是，因为与coin的分成协议很多人都认为circle被吸血，也不看好。其实之前的crcl的走势里或多或少也计价了这些质疑。这个时候更要去关注边际变量，新业务的新的收入来源，只要这一块增长很快、也就意味着商业模式的转型是在加快的。
~~~

Quoted tweet (qinbafrank): https://x.com/qinbafrank/status/2051624254417092868

~~~text
清晰法案通过预期的催化之外，也要注意到Circle正在进行的商业模式升级和迭代，这里最关键的就是4月8号Circle推出的Circle Payments Network (CPN) Managed Payments，这是一个全栈托管式稳定币结算平台。

CPN是Circle在25年5月上线的全球稳定币支付网络，连接银行、PSP、VASP 和企业，实现 24/7 https://t.co/3savmvY7vo
~~~

#### T5 2026-06-08 https://x.com/qinbafrank/status/2063804130074775578

Tweet id: `2063804130074775578`

~~~text
熬过一个焦灼的周末本周市场应该怎么看？上周五晚上有详细梳理美股在上周后半周走势几个变化因素，最早还是上周三晚上的space提示了风险。这次调整的核心逻辑：AI/半导体短期涨幅过大、市场FOMO过强、交易结构过度拥挤，抛物线式上涨本身不可持续；随后又遇到SpaceX巨无霸IPO路演和认购抽水、CPI/PPI/FOMC前的自然避险，以及强就业数据强化“高利率更久甚至重新加息”的担忧，最终触发了热门科技股的集中去杠杆。当然这也是再老话重弹，关键是后续应该怎么看

1、可以先回顾下过去大半年的几次调整
去年12月也有一次类似的科技股暴跌。当时是 Oracle 先引爆 AI 投入回报率和资本开支担忧，随后 Broadcom 业绩后市场继续杀一波，直到美光强业绩和偏温和的通胀数据才把情绪拉回来。两次相同点都是利率预期扰动，不同点是：去年底今年初市场更担心AI capex的分子端回报，这一次暂时没有形成“AI逻辑崩了”的共识，市场更担心的是分母端——利率、通胀、Fed、地缘和流动性。

存储板块是这一轮AI交易中最强的主线之一，涨幅最大、景气度最高、盈利弹性最强，因此也最容易成为拥挤交易出清时被集中兑现的对象。以美光为例，本轮从6月3日高点1089.29跌到周五收盘864.01，收盘回撤约20.7%；如果按盘中低点850.18算，最大回撤约22.0%。这已经超过5月中旬那轮约20%左右的回撤，但还没有达到3月战争期间更极端的恐慌水平。

KORU作为韩国市场的3倍杠杆ETF，可以近似观察韩国科技/存储交易的风险偏好，但不能直接等同于韩国指数本身。KORU从6月1日高点1279.70跌到6月5日收盘610.01，回撤约52.3%；若按盘中低点599计算，回撤约53.2%。

从空间看，这次已经超过5月中旬那轮回调；
从时间看，本轮已经连续调整4个交易日，也接近过去几次短线主跌窗口。
因此一个相对合理的判断是：在AI基本面没有被证伪的大背景下，短线主跌浪可能已经完成了相当大一部分，后面连续暴杀的概率下降。

所以本周不一定继续暴跌，但直接V回去的概率不高，更可能是横盘震荡或缩量缓跌；但只要美债收益率不回落、CPI/FOMC还没落地，市场大概率仍是高波动、偏防守、等待确认和时机好转。

2、再看周末到今天的几个大事件
1）以色列和黎巴嫩那边还有摩擦，伊朗导弹和无人机开始打击以色列，特朗普一边压内塔尼亚胡不要报复，一边继续保美伊协议线。这条线会扰动油价，也会让市场重新想起通胀压力。
但目前还没看到重新升温到全面失控的迹象。
看川普昨晚接受的采访，是极力再确保不会让美伊战争升级的。

2）英伟达和SK预计周一公布合作计划。黄仁勋的口径很直接：内存、晶圆、先进封装、硅光这些环节都短缺，而且短缺可能持续数年。这句话把市场之前炒过的几条线又串回来了。

再当下的市场状态下，会带给市场一定的支撑，但应该很难立马带动反转。今天可以观察市场盘面，低开以后，核心标的能不能稳住？有订单、有客户、有产业位置的公司，会不会先被资金接回去？
如果核心公司稳，跟风票乱，那就是分化。
如果核心公司也接不住，这种反抽持续性会很差。

3、等待宏观给出第一个信号
从4月初以来这两个月的大行情，大涨的契机先是宏观伊朗局势的停火、再是算力短缺、然后是AI商业化加速，这三个时间在4月初到4月中依次展开，由此带动一大波行情。
4月是“宏观风险解除 → AI产业逻辑重新被放大”；
现在则是“AI产业逻辑没坏 → 但宏观分母端压住估值 → 所以个人角度也要先等宏观止血”。

那么当下要真正反转，大概率也要先等宏观层面给一个“止血信号”。不一定非要出现一个像4月初“伊朗挺火”那么大的宏观利好；更现实的是，市场需要看到分母端不再继续恶化。

这次为什么需要宏观先给信号？
因为这次下跌的主要矛盾，不是“AI逻辑崩了”，而是 利率、通胀、依稀会议、地缘、巨无霸IPO抽水、市场太过狂热拥挤度 一起冲击估值，去杠杆。

换句话说，市场现在不是在问：“AI还有没有需求？”
而是在问：
“利率如果继续上，AI股票给这么高估值还能不能撑住？”
所以这一次反转，优先级不是先看产业故事，而是先看宏观压力有没有停止上升。

顺序大概率也类似：先要宏观层面止血，至少CPI不能炸、美债收益率不能继续上冲、SpaceX IPO后是不是释放部分资金流动性，FOMC不能进一步放鹰。只有分母端压力缓和之后，市场才会重新回到AI分子端，重新交易算力短缺、存储涨价、AI capex和商业化加速。

当下要反转，先看宏观信号；但不需要宏观全面转好，只需要宏观不再继续恶化。宏观一旦止血，AI产业逻辑会很快重新接上。所以也是上周五晚上聊到的，短期内说很难完全逆转，需要耐心等。

本条由@bitget_zh赞助，「Bitget 买美股：秒级入场，丝滑交易 」
~~~

Quoted tweet (qinbafrank): https://x.com/qinbafrank/status/2062912854983086556

~~~text
怎么看这两天美股的大跌？其实是好几个因素共同作用的。1、周三在168X的Space时有聊，本周前半周给我的感觉很不好，老黄在点石成金，资金在疯狂追逐，其实有点狂热了。任何资产这种抛物线式的上涨都不可持续，总会有调整。然后周三晚上美股走势已经显现出调整的端倪了 https://t.co/l9uhb9l8lM
~~~

#### T6 2026-05-14 https://x.com/qinbafrank/status/2054874676531519643

Tweet id: `2054874676531519643`

~~~text
美国四月PPI也比较很强，国债收益率还在继续走强，应该怎么看？警惕长时间高油价的灰犀牛问题。昨晚公布的美国四月PPI及核心PPI的同比环比均大幅度超出预期，主要也是能源和运输成本大幅上升导致的。而周二晚上公布cpi略超预期，能源依然是通胀上行首要贡献项，如食品价格受到运输成本与化肥价格上涨的影响而上行，以及除住房外核心服务中机票价格受燃油短缺而涨价。而且特别要注意PPI是CPI的上游，其实暗暗隐含如果高油价持续5月通胀数据估计也不好看。

与此同时，昨晚美国财政部发行30年期美债标售得标利率自07年金融危机以来首次升破5.0%，最终得标利率为5.046%。

把这些问题放在一起，怎么看？
1、现在最大的焦点还是在于高油价的持续时间上，这决定了通胀反弹持续的时间。现在的通胀核心还是霍尔木兹海峡封锁导致的供给问题，供给问题最终还是要供给恢复才行。

伊朗局势军事上再升级的概率不大，能看得出来美伊双方对于动武兴趣不大。但是如果谈判一直没有进展、油价下不来，到了6月全球原油库快消耗完了、夏季又是能源消耗高峰、也是挺要命。

2、现在看伊朗对条件卡得很死、川普要么让军事行动升级要么做出很大让步。军事行动再升级，川普自己也没信心，但他估计也不想做出更大让步。那就继续封锁阿曼海，消耗伊朗经济，倒逼伊朗松口让步，但是想通过经济消耗让伊朗感受到痛苦估计也需要时间。

3、也的看看明天中美联合声明会怎么样以及川普回国后的表态。因为市场之前对中美在伊朗问题上的沟通是有期待的，川普也有此期许，之前这里https://x.com/qinbafrank/status/2053818161284497914?s=46&t=k6rimWsEbo2D2tXolYcM-A也有聊过。
1）谈的好，中国表态愿意出手斡旋美伊，自然是利好。

2）如果中美谈的没有超出预期的话，是会打击市场信心的、特别是如果中美没有聊伊朗。 也要做好美国希望中国出面斡旋伊朗，但是中国不接招的局面。

4、而对于国债收益的问题，个人一直的观点就是重点看十年美债收益率的走势，而非二十年和三十年，因为十年美债收益率才是真正的无风险利率。时隔一年，当下美债收益率又回到了25年五六月份的状态，是不是轮回了。

其实去年这个时候https://x.com/qinbafrank/status/1925245211736944991?s=46&t=k6rimWsEbo2D2tXolYcM-A也有聊过，US10Y持续往上有一个阈值个人观察下来是4.6%，一旦US10Y突破4.6%，时常会明显感受到压力、在4.6%以下则还好。

5、而十年美债收益率的走势非常依赖财政部的操作，不知大家是否还记得25年五六月财政部几次出手托底，US10Y几次快要突破4.6%都被打下来了。去年有聊过https://x.com/qinbafrank/status/1925871211923296629?s=46&t=k6rimWsEbo2D2tXolYcM-A

而且看上周财政部再融资计划，财政部继续常态化国债回购（Buybacks）： 财政部的定期回购操作正在按计划推进。预计在接下来的季度中，将购买高达380亿美元的非活跃长端债券（用于流动性支持），并在1个月至2年期区间内购买高达250亿美元的债券（用于现金管理）。如果真的财政部回购长债、那是会打压长债收益率的。

所以整体上来说对于长债收益率走势个人觉得财政部手段会不少、就看什么时候发力。

6、核心个人还是担心可能会出现这种情况：
伊朗局势也不会有大的升级、双方都不想打了。但是谈也迟迟谈不拢，因为双方条件差距比较大。高油价就这么一直持续，时间越长就不是高油价的事，整个上游资产都要涨价，价格从短期脉冲变成了惯性向上。

担心高油价持续太长时间，变成一个越来越大的灰犀牛。灰犀牛大家都看得到，但灰犀牛越来越大也就是个问题和风险了。

因为持续高油价会导致通胀持续反弹，物价如果变成了惯性向上，美联储新主席沃什上台即使不加息、那么降息的概率会越来越小。

这个最终要看什么时候美伊能谈好。希望谈判不要变成一场马拉松，拖的时间越长通胀持续的风险越大，最终还是会引发市场担忧和避险。

7、对于市场来说
油价走高、长债收益率走高、股市走高，都在同一方向上运动还是有些问题的。
这里关键点就是油价持续走高的问题。

对于美股本身来说、基本面自然是强劲的。之前这里https://x.com/qinbafrank/status/2049654559707177279?s=46&t=k6rimWsEbo2D2tXolYcM-A有聊过，四大科技巨头一季度财报可以说是AI货币化的拐点，缓解市场对“烧钱不赚钱”的担忧，在某些程度上还是很超预期的。

在周一这里https://x.com/qinbafrank/status/2053634911001849932?s=46&t=k6rimWsEbo2D2tXolYcM-A也有聊到：今年一季度美股盈利超预期幅度近十多年最大的一次，也是四年来标普500所有板块第一次录得正增长。都是基本面强劲的表征。

个人角度，基本面强劲能对冲宏观上的小级别风险。但是如果之后灰犀牛越来越大（高油价持续很长时间、终会在某个时间打压市场），也会带动整体大盘来个小级别回调的、但基本面的强劲也意味着如果跌下去不要慌反倒是再上车布局的好机会。当下涨的越是好，适当部分止盈也是很好的操作。

接下来
1）先看中美谈的怎么样，重点看明天川普访华尾声的联合公报或者声明内容。
2）再看美伊谈判何时能有个结果，标志就是霍尔木兹海峡何时恢复正常，油价能持续回到90以下甚至更低，这才是意味着灰犀牛真正被杀死了。

本条由@bitget_zh赞助，「Bitget 买美股：秒级入场，丝滑交易 」
~~~

Quoted tweet (qinbafrank): https://x.com/qinbafrank/status/2054213700383658196

~~~text
晚上公布的美国4月cpi，cpi及核心cpi同比环比四项中三项都超预期，如前面聊到的核心是“数据与市场预期的偏离度”远胜于数据本身的绝对水平。关于这次cpi： https://t.co/W4EjKV7Kal
~~~

#### T7 2026-05-12 https://x.com/qinbafrank/status/2054174740282216464

Tweet id: `2054174740282216464`

~~~text
中美能否达成稀土换光刻机的交易？若达成，存储立马就不紧缺了么？怎么看存储未来的拐点？今天巴伦周刊这篇文章传播很广，核心论点是此次川普访华中美可能达成稀土换光刻机的交易，之后台积电、三星海力士就会失去芯片定价权。果真如此么？这里有几个问题和误区需要聊下
1、中美达成稀土换光刻机的概率有多大？
我在昨天川普访华前瞻的推文里也聊过，在关键卡脖子环节上相比英伟达芯片中国更想要光刻机等半导体设备，这比巴伦周刊聊的还要早。

昨天也聊到中国对于解封英伟达芯片其实兴趣不大，更想要扶持国产芯片。但关键的半导体设备（DUV、EUV光刻机）和高端EDA软件则是非常紧缺、中国应该是想要这些设备。

但中美能不能达成这样的协议？我对此并无把握，因为即使去年10月中国都管控稀土了，美国也没在关键半导体设备上松口。特别是26年以来美国是进一步收紧了对中国在半导体关键设备的限制。只能说看谈的结果了

2、如果中美真的达成稀土换光刻机的交易，国内存储立马就能放量么？
其实也不然

中国在先进制程（尤其是EUV/DUV光刻）上确实被卡脖子多年。拿到ASML设备后，国产化加速是大概率事件。中国内存厂商主要是CXMT长鑫存储等国产DRAM玩家，这两年在中低端内存进展很快，也抢占了不少份额。中高端内存上代差还很大。

但也要注意光刻机确实是当前最关键的瓶颈之一，但远不是代差大的唯一原因。
1）光刻机（DUV/EUV）确实是最大硬伤
EUV（极紫外线光刻机）现在国内完全拿不到，三星、SK海力士、美光已在先进DRAM（HBM4）和部分高密度NAND中使用EUV大幅提升密度和良率。

中国厂商（CXMT、YMTC）只能靠DUV + 多重图案化（SAQP等）硬刚，工序复杂、成本高、良率低。 

2）先进DUV（如ASML NXT:2000i/2050i系列）：目前还能进口部分，但2026年美国MATCH Act等新法案已针对CXMT、YMTC等直接封堵高端浸没式DUV及其维修/零件。中国正加速用国产SMEE SSA800等替代，但这些设备目前主要适合28nm及以上，做到先进节点仍需多次曝光，效率远低于ASML最新款。 

这两者直接后果：CXMT先进DRAM良率约50%（领导者80-90%），YMTC高层数NAND虽在量产，但成本和稳定性受限。这直接导致中高端产品（DDR5/LPDDR5X、HBM3、300+层NAND）竞争力弱。 

如果只看这一条，光刻限制确实能解释60%的当前差距——没有它，中国厂商根本无法高效爬坡先进节点。

但是还有其他核心差距，不是光刻机解封瞬间就能解决的
1）专利/IP壁垒：三星、SK海力士、美光在DRAM/NAND核心架构（Xtacking、HBM堆叠等）上有大量专利。中国厂商要么绕路（成本高）、要么受限，无法直接抄最优路径。

2）设备生态不完整：除了ASML光刻，还有Lam Research、Applied Materials、东京电子等美日设备的先进型号也受限。3D NAND垂直堆叠、HBM混合键合需要全套高端工具链。

3）良率与工艺整合：即使设备到位，工艺调试、缺陷控制、材料匹配都需要时间。CXMT/YMTC新线良率爬坡慢是行业公认问题，不只是光刻机的事，还涉及蚀刻、沉积、CMP等全流程配合。 特别是极紫外线光刻机EUV的调试规程更复杂，时间和流程更长。

所以不仅仅缺高端光刻机的原因，还因为专利、设备生态、工艺整合等方面共同造就了国产内存厂商与三星、海力士、美光的差距。

光刻是“卡脖子”，但后面还有“IP/专利、生态、工艺”几道关。这其实就有一个时间差，即使签协议，ASML设备交付、生产线建设、良率爬坡，至少也要1-2年才能形成实质产能。这么看即使中国厂商拿到最先进的半导体设备、基本上28年才能中高端存储上形成产能，这还是克服了IP/专利、生态、工艺等障碍，一切顺利的情况下。

那就不能不说三星、海力士、美光自己的扩产计划了，过去半年存储御三家也开始了积极扩产，这里就包括了三星P4/P5工厂、海力士Yongin工厂？美光Tongluo/ID1等新线，最早2027年下半年到2028年上半年才能形成实质增量。

这意味着，国内存储厂商中高端产能还没完成形成，三星、海力士、美光的扩产产线就开始释放产能了。

3、那么存储未来的拐点怎么看？
个人的框架就是看需求和供给：
1）什么时间需求放缓？
现在的情况是随着AI的快速迭代，长上下文、多模态、agent快速普及，对存储的消耗非常大，需求还在高速增长，没看到放缓迹象。

2）什么时间供给放量？
其实刚才第二部分聊的就是供给放量，现在很明确了三星、海力士、美光扩产的新产线产能释放也得到27年底了。

假如中美能达成稀土换光刻机的协议，中国存储厂商拿到最先进的光刻机，顺利的话也得到28年才能产能落地。

所以至少才明年上半年，存储（特别是高端的HBM、GDDR7/GDDR6x、DDR5，中端的DDR4、高端NAND）的产能还是紧缺的，就看需求的高速增长持续性如何了。而需求现在还在狂飙

未来存储的拐点要么是需求放缓、要么是供给开始放量增加。紧盯着这两点即可
~~~

Quoted tweet (qinbafrank): https://x.com/qinbafrank/status/2053818161284497914

~~~text
川普确定本周访华，会谈成什么？个人角度，中美大概率会做一批“可交易”的局部交换，避免全面脱钩失控。做一个前瞻：
1、贸易休战 2.0
这是概率最高的，本质上是：“大家都别再继续升级。”可能包括： https://t.co/fQ7iXVhBNH
~~~

#### T8 2026-03-02 https://x.com/qinbafrank/status/2028343749873668349

Tweet id: `2028343749873668349`

~~~text
伊朗局势后续怎么看，为什么说之后影响伊朗局势的真眼是在霍尔木兹海峡的态势上？聊聊个人的理解和看法：1、伊朗现在谁在领导？
昨天聊到哈梅内伊在美以的第一轮袭击中就被死掉，过去两天伊朗的反击强度和范围相比以往都是很大的，说明有人快速接管了指挥权，保持了指挥体系的完整性。

现在梳理各方面信息，在新的最高领袖被选出来之后，现在伊朗的实际运转领导体系有是三个层面：
行政日常 ，还是总统佩泽希齐扬和第一副总统阿雷夫，实际山应该是阿雷夫主导；
最高战略 ，由总统佩泽希齐扬、司法总监、宪法监护委员会阿拉菲三人组成临时领导委员会，其中后面两者都是强硬派。
军方和国家安全，则由伊朗革命卫队新的总司令艾哈迈德·瓦希迪和最高国家安全委员会（SNSC）秘书长拉里贾尼主导。

这里面行政日常部分重要性不高，更重要的在后面两者：
1）临时领导委员会成员司法总监是伊朗的强硬派任务，阿拉菲则是妥妥的宗教保守派人士。临时领导委员会近期最重要的工作就是选择新的伊朗最高领袖，三人组两个都是强硬派和保守派，可以想象新的最高领袖的政治倾向。

2）而军方和国安层面的领袖人，瓦希迪和拉里贾尼也都试强硬派的代表：
瓦希迪是伊朗革命卫队的资深将领和创始成员之一，也是伊朗不对称战争学说和什叶派之弧的主要架构师。作为强硬派人物，在伊朗军政体系中地位稳固，有足够的威望快速负担起指挥体系。
拉里贾尼虽未正式进入三人临时领导委员会，但已成为伊朗实际权力核心中的关键人物，负责协调国防、核谈判、地区代理人网络、对内镇压等多项最高敏感事务，并在哈梅内伊遇刺后迅速公开宣布过渡机制启动。

3）还有一点就是伊朗的马赛克防御模式作战模式：把全国分为31个独立指挥区（德黑兰1个 + 30个省各1个），省级/地方指挥官拥有高度自主权，可在中央指挥链被切断时依据“预设任务命令”独立作战。  
需要重视下瓦希迪的不对称战争学说，但其核心逻辑（代理 + 导弹 + 无人机）也是现在伊朗反击最重要的手段。

4））也能看出来，周六下午和晚上伊朗应该就是马赛克防御模式开启，周日开始就是拉里贾尼和瓦希迪在哈梅内伊死后主导了伊朗的军事行动。
就在中午拉里贾尼还表态不会跟美国谈判。

2、川普的目标
周六川普公开声明，宣布美国已启动“重大作战行动“”，并公开目标包括摧毁伊朗核能力、导弹工业、海军，并呼吁伊朗人民推翻政权，核心直指更迭政权。

昨晚上川普再次表态，“我们预计会持续大约四周的时间。这是一个很大的国家，所需时间大概是四周左右——或者更短。”

从川普的角度最理想结果真如他说的更迭伊朗政权；
次优结果则强力施压跟伊朗新领导人达成协议：彻底废掉伊朗核进程，限制弹道导弹射程；
最差结果就是伊朗头铁不谈，美以不出动地面部队只有空袭虽然把伊朗干的七零八落，但百足之虫死而不僵，持续袭击霍尔木兹海峡油轮。
当然还有一种情况就是拖得时间足够长，伊朗内部强硬派被点杀的差不多了，鼓动内部温和派起来夺权。这个可能时间周期拉的很长了。

但说实话，现在决定局势走向和持续时间确实取决于未来伊朗新的最高领袖的态度，革命卫队以及强硬派的抵抗意志。特别是强硬派这一点上。

3、为什么霍尔木兹海峡是后续局势演变影响市场的阵眼？
逻辑就是昨天这里https://x.com/qinbafrank/status/2028116182830858678?s=20聊到的：现在市场更关心霍尔木兹海峡是能正常航运还是实质上被伊朗革命卫队的恐吓而实质上停航、这条位于伊朗南部狭窄的水道是全球约20%石油运输的咽喉要道。这决定了市场对于原油走势的判断，而原油持续性飙升，对通胀的担忧又要来了。风险之源

小规模的针对油轮的袭击叠加保险公司撤回霍尔木兹海峡航运承保，不用实质上的物理封锁，商业恐惧就能导致海峡航线实质上停航。

今天市场开盘布伦特原油开盘暴涨12%，不过随后迅速回吐部分涨幅，比较好的点在于市场并没做出最激烈的反馈。这里一方面是因为冲突刚刚开始，各国原油储备还很充足，短期内不至于短缺的地步。然后昨天欧佩克成员国宣布增产短期内也能缓解市场担忧。

但要谨防的一种可能性就是：伊朗方面的不停手，霍尔木兹海峡的长期实质性停运，如果停航超过一周以上，估计市场还是会很担心。

看高盛策略团队在最新报告中指出，只有当原油供应中断从“短暂跳升”演变为“持续重创”，市场才会遭受实质性打击。

冲突的“持续时间”已取代“爆发本身”，成为决定原油、黄金、美股走向的核心变量。川普自己都说可能要持续四周左右，实际上时间可能更长。

而这里“持续时间”最关键的还是霍尔木兹海峡的航运停摆的持续时间，而不是局势本身。如果霍尔木兹海峡没有实质性停航，说实话伊朗局势持续超过一周以上市场就会脱敏。可以参考��乌战争，真正对市场影响很大就是开战后一周多时间，之后战争的具体走势对市场已经没有影响。

4、后续走向的推演
前面在第二部分聊到，对川普来说四个可能的结果。正好看到《纽约时报》评估认为，伊朗政府出现彻底更迭的可能性不大；相反，伊斯兰革命卫队成员可能加强对政权的控制，但或许愿意限制该国的核计划，或对美国采取更为和解的态度。情报机构同时认为，伊朗国内有组织的反对力量仍相对薄弱。

次优结果强力施压跟伊朗新领导人达成协议：彻底废掉伊朗核进程，限制弹道导弹射程；
最差结果就是伊朗头铁不谈，美以不出动地面部队只有空袭虽然把伊朗干的七零八落，但百足之虫死而不僵，持续袭击霍尔木兹海峡油轮。

个人也认为未来局势走势大概率就落在前面第二部分的次优结果和最差结果之间。当然希望是次优结果，这样对市场影响最小了。但这个我们说了不算，只能持续跟踪关注了。

本条由@bitget_zh赞助，「Bitget 买美股：秒级入场，丝滑交易 」
~~~

Quoted tweet (qinbafrank): https://x.com/qinbafrank/status/2027888886207348870

~~~text
哈梅内伊真死了么？他死后最重要的问题是什么？从polymarket和大饼走势来看，个人倾向于是真死了。现在最大的问题是如果哈梅内伊在美以的第一轮轰炸时就已经死了，那之后伊朗反击报复是谁在指挥？昨天伊朗反击力度和范围远超以往：一开始就把美军在海湾各国的军事基地作为目标，甚至威胁禁航霍尔木兹海 https://t.co/Ipo0pXdPc6
~~~

#### T9 2026-05-07 https://x.com/qinbafrank/status/2052316328246247804

Tweet id: `2052316328246247804`

~~~text
过去半年最重要的一个产业观察框架：就是技术普及渗透率的提升变化，趋势比估值更重要。2月中的这篇推文也是应该今年最重要的一个思考：AI可能只需要更短的时间就能走完移动互联网10年才走完的路（而同样的路互联网走了二三十年），我们是处在一个新技术普及渗透越来越快的时代。这很关键，决定了你怎么看AI浪潮的进化和迭代。

核心是什么？
核心就是软件PC互联网、移动互联网，再到现在的AI，每一代技术浪潮都为下一代打下了坚实的基础，基础设施相比之前更完善，渗透率自然越来越快。渗透率是一切商业化的原点，逻辑有二：
1）不是革命性技术，渗透率根本起不来。10%一个走向主流大众的关键鸿沟；
2）渗透率不断提升，用户人群越来越大，付费群体也会越来越多，人均token消耗量也能往上走；

2000年互联网泡沫破裂之后那么长的沉寂期核心在于：
1）当时渗透率还很低、关键是渗透率的提升比较慢，主要因为基础设施还不完善；
2）互联网一直到05、06年才形成比较完整的商业模式（游戏、广告、增值服务、电商等）。

当下是一个基础设施完善、信息扩散极快、各种商业化手段齐备的时代。

去年9月高盛的报告，AI在美国企业的渗透率是10%，看3月底高盛最新的报告调查显示AI在企业的渗透率已经到了18%，处在一个快速的增长期。

这也是去年9月在这里https://x.com/qinbafrank/status/1966309713211175233?s=46&t=k6rimWsEbo2D2tXolYcM-A聊到：科技股本质上是吃行业渗透率的红利、趋势比估值更重要。一旦迈过10%的渗透率关口，增长的斜率会增加陡峭。相信过去半年大家感受了“加速正在被加速”的推背感。

10%～接近50%，是投资的黄金期。
当然渗透率接近50%甚至再往上，相当于大部分企业和人群都深度拥抱AI了，那么红利则是越来越小的。

推荐大家看看2月中和去年9月中的这两篇推文。
~~~

Quoted tweet (qinbafrank): https://x.com/qinbafrank/status/2023982690144579970

~~~text
移动互联网用了不到10年就走完了互联网需要20年才能走完的路，AI可能只需要更短的时间就能走完移动互联网10年才走完的路。00年互联网泡沫破裂后有长达数年的互联网产业低迷，现在也看到很多说法一旦破裂也要好多年的低迷。其实我们是处在一个新技术普及渗透越来越快的时代。 https://t.co/XA7SLPO2Q8
~~~

#### T10 2026-06-02 https://x.com/qinbafrank/status/2061718814254100559

Tweet id: `2061718814254100559`

~~~text
老黄点名了下一个将达到万亿美金市值的公司，相比这个Murphy（MRVL的CEO）今天演讲以及他与来黄的对话更值得一看。Murphy用近一个小时的时间，系统阐述Marvell如何押注数据基础设施、为什么光互联将成为AI时代的关键技术，以及这场从铜缆到光纤的转型将如何重塑整个数据中心架构，看完murphy的演讲，相信能对光互联的技术演化有更深的理解和认识，梳理下Murphy的演讲要点：
1、十年豪赌：如何成为数据中心之王
Murphy演讲从一段自我剖白开始。2014年加入Marvell 时，这家公司60%的收入来自消费电子市场，数据中心业务占比不到10%。也正是在那个时刻，他做出了一个大胆的判断——半导体行业的下一个增长周期，将由 Google、Amazon、Microsoft、Meta 等平台公司驱动，核心需求是“以大规模移动、存储、处理和保护数据的半导体技术”。

这个判断在当时并不被广泛认可。“数据基础设施”甚至还不是一个被行业承认的市场类别，只是 Marvell 用来描述未来愿景的内部术语。但 Murphy 和他的团队展现了惊人的执行力：通过一系列精准的并购和剥离，Marvell 在十年间投入了约285亿美元（225亿美元收购+60亿美元内部研发-40亿美元资产剥离），系统性地构建了从毫米到千公里、覆盖 AI 基础设施全栈的连接技术平台。

这些并购包括2018年收购 Cavium 强化计算和网络能力；2019年收购 Avera 建立定制芯片业务、收购 Aquantia 增强连接产品组合；
2021年以100亿美元收购 Inphi 获得世界级数据中心连接技术；
以及最近12个月内收购 Celestica AI 的光子结构技术和 Xcon 的 scale-up 交换能力。

结果是惊人的：Marvell 从2014年的25亿美元营收增长到2026财年预计的110亿美元，最近几年增速更是达到每年40%。根据上周财报电话会议后的华尔街共识预期，2027财年 Marvell 营收将达到164亿美元。更关键的是，数据中心业务占比已从不到10%飙升至上季度的75%以上。

2、连接性：AI 基础设施的真正瓶颈
Murphy 在演讲中抛出了一个核心问题：什么定义了 AI 基础设施的性能？大多数人会想到处理器、GPU、制程节点（3nm、2nm 甚至未来的1.4nm、1.6nm），或者高带宽内存。这些当然重要，但 Murphy 指出，这些都不是系统的决定性特征。

“因为一个处理器，无论它有多快、连接了多少内存，对于今天的 AI 工作负载来说根本不够。你需要数万个、最终是数百万个处理器作为一个单一的大规模计算引擎协同工作。这就是为什么这种规模的计算从根本上是一个连接性挑战。”Murphy 说道，“而且越来越多地，正是连接性的架构和特性定义了系统的性能。”

这个判断得到了英伟达 CEO 黄仁勋的呼应。在 Murphy 邀请下登台的黄仁勋强调，AI Agent 的计算模式是“分解和分布式的”（disaggregated and distributed）——当你把一个计算问题分解成许多部分，并分布到整个数据中心时，连接性就成为必需品。“我们分解和分布式计算，使其运行在这些巨大的集群上，这样我们就能聚合总计算量、总内存和总带宽。而使这一切成为可能的，就是连接性。”黄仁勋说，“这就是为什么 Matt 做得这么好，为什么 Marvell 如此关键。”

Murphy 进一步解释了连接性瓶颈的演变逻辑：过去几年，AI 基础设施先后解决了计算瓶颈（英伟达引领的 GPU 革命）和内存瓶颈（HBM 高带宽内存的规模化），现在瓶颈正在再次转移。“现在是连接性将定义基础设施的极限，就像计算和内存一样。”他引用了与最大客户的对话：“世界上最大的超大规模云服务商现在正在重新构想他们的整个网络架构。他们认识到，扩展 AI 基础设施现在首先是一个连接性挑战。”

随着推理模型、专家混合架构（mixture of experts）、生成式 AI 的持续演进，更多数据必须在基础设施中移动，需要更高的带宽和更低的延迟。当工作负载不再适合单个数据中心时，就需要建设更大的数据中心或整个数据中心园区，以及它们之间的所有高速连接。“因此，连接性成为扩展计算的关键推动力，我们的客户越来越认识到光学是前进的方向。”Murphy 说。

3、从千公里到毫米：Marvell 的全栈连接布局
Murphy 用一张图展示了 AI 基础设施跨越的所有距离——从数据中心之间的数百甚至上千公里，到封装内部的毫米级距离。每一个距离都需要不同的解决方案、不同的技术、不同的工程团队，甚至不同的供应链。“这些不是同一问题的变体，而是根本不同的工程挑战。”

1）跨数据中心连接（数百至上千公里）
这需要非常专门的相干调制（coherent modulation）技术，核心是专用的数字信号处理器（DSP）。Marvell 是全球少数几家能够构建这种相干 DSP 的公司之一，已经领导了从100Gbps 到400Gbps 再到800Gbps 的代际演进。Murphy 在现场展示了一个相干光模块实物——这是一个极其复杂的工程产品，包含了 Marvell 最复杂的先进制程 CMOS DSP 芯片、第四代硅光子技术（已量产十年），以及用硅锗工艺设计的自研宽带模拟组件。“今年晚些时候，我们将采样世界上首个1Tbit、2nm 制程的相干光学解决方案。”Murphy 宣布。

2）数据中心内部连接（数百米）
数据中心内部包含成排的计算服务器，每个机架顶部通常有一个交换机，机架级交换机连接到脊柱和核心交换机，通过光纤电缆形成整个数据中心的网络结构。这部分使用的是更节能的 PAM4调制技术。Marvell 构建了业界领先的 PAM4 DSP 解决方案，以及高速模拟组件（包括跨阻放大器 TIA 和激光驱动器），并引领了从25Gbps、100Gbps、200Gbps、400Gbps 到800Gbps 的每一次重大转型。去年，Marvell 开始量产业界领先的1.6Tbps PAM4解决方案。在以太网交换方面，Marvell 拥有从51.2Tbps 到51.2Tbps 的完整产品组合，并在 ComputeX 当天宣布了专为 AI 数据中心设计的新一代102.4Tbps 以太网交换机，具有业界最低功耗。

3、机架内部连接
目标是以全互联（any-to-any）配置连接尽可能多的处理器——每个处理器都能直接与其他每个处理器通信。英伟达的 NVLink 72（因机架内连接72个 GPU 而得名）首次将这种架构推向市场。这需要完全不同的交换类别，以及通过机架内铜背板驱动超高速信号的能力。“今天，这不是光学的领域，这是铜的领域。”Murphy 说。核心差异化因素是电气 SerDes 技术而非光学。Marvell 拥有目前领先的200Gbps 电气 SerDes，并已在过去几年中演示了面向未来的400Gbps 技术，这些 SerDes 被集成到客户的定制芯片、XPU 以及 Marvell 自己的 scale-up 交换机中。

4）封装内部连接（毫米级）
当今最先进的芯片内部有多个 chiplet，2.5D 或3D 封装本质上是一种连接技术，允许这些 chiplet 在封装内非常靠近地放置，并通过超高速短距离 die-to-die 接口通信。Marvell 拥有领先的 die-to-die SerDes 和先进封装能力，使客户能够构建业界最复杂、最独特的多 die 芯片。

Murphy 强调，拥有所有这些能力“在一个屋檐下”是不寻常的、独特的。“当我们去竞争时，通常在每个类别中我们面对的是不同的竞争对手。但这就是我们的独特之处——我们是一站式商店，是整个连接堆栈的领导者。”

4、铜墙将移：光互联的物理必然性
Murphy 演讲的核心洞察集中在一个概念上：铜墙（Copper Wall）。他用一张图清晰地展示了当前 AI 基础设施中的连接分界线——左侧是光学连接（使用光纤电缆传输光信号，两端有复杂的电子设备驱动和调制激光），右侧是电气连接（使用铜缆、PCB 上印刷的铜走线，或封装内部的微观铜布线）。中间是“铜墙”，定义了信号在必须转向光学连接之前可以通过铜传输的最长距离。

“这是一个重要的区别，因为铜很简单、成本低，正如 Jensen 所说，你想尽可能长时间地使用它，这非常实用。但光学更复杂，需要激光器、光子学、复杂的电子设备。”Murphy 说，“而铜墙，我今天要告诉你们的是，它即将移动。它将再次移动，并将接管机架本身。这正在为光学行业创造需求的爆炸式增长。”

这不是偏好问题，而是物理定律。信号通过铜缆传输的距离与带宽成反比——每次带宽翻倍，距离就必须减半。Murphy 给出了具体数据：当今世界上最高速的生产系统运行在每通道200Gbps。在这个带宽下，电缆长度限制在大约1.5米。相比之下，100Gbps 系统可以使用约3米的电缆。而机架的高度约为2米，考虑到机架内部的所有布线，2.5米正好是极限。“所以当我们转向1.6Tbps 时，我们不能再用铜完全连接机架了。墙正在移动，而且是现在。”

Murphy 强调，这不是遥远的未来：“今后，即使是机架内的连接也将变成光学的。整个行业都知道这一点即将到来，所以我们一直在为这一刻做准备——不仅仅是 Marvell，而是整个行业。你可以在台湾看到这一点，在供应链和正在发生的产能爬坡中。”

铜墙每向右移动一步，连接数量至少增加一个数量级。“这正在创造我提到的需求爆炸，光学供应链需要大规模扩展并做好准备。”Murphy 回顾了20年前的类似转型：当时数据中心内部的最先进技术是10Gbps，整个数据中心都使用铜缆，光学基本上只是电信技术，保留用于非常长的距离。但当墙移动时，光学行业迎接了挑战，今天世界上所有的超大规模数据中心都是光学连接的。这次转型催生了新的解决方案——针对数据中心内部优化的 PAM4技术，而 Marvell 是那里的关键创新者之一。

5、CPO：光互联的下一个前沿
当光学进入机架内部时，需要的新技术叫做共封装光学（Co-Packaged Optics, CPO）。Murphy 花了相当篇幅详细阐述这一技术：“CPO 是一种将光学连接一直带到封装本身、紧邻计算的技术，无论是定制计算还是交换芯片。”

CPO 要解决的根本挑战是密度和功耗。机架内的连接数量是机架之间连接数量的10倍。“如果我们只是尝试使用数据中心机架间使用的相同光学技术，你不会有足够的功率，不会有足够的物理空间，无法容纳所有这些标准光学模块和电缆——这根本行不通，不可能。”Murphy 解释道。

CPO 的概念是将光纤直接带到封装，将驱动光纤信号的电子设备与定制计算或交换芯片紧密耦合。“这是一个巨大的变化，而且很难，因为你要结合芯片行业中一些最先进的技术：领先制程 CMOS、硅光子学、先进封装、光互连，所有这些都在一个小型紧密集成的系统中制造。复杂性非常高，但这是继续扩展带宽并克服我谈到的铜限制同时降低功耗的唯一方法。”

Murphy 强调这不是未来主义的东西，而是正在发生的现实。他在现场进行了实物展示：一边是传统的以太网交换机——当天宣布的102.4Tbps Teralink 交换机，可以看到板中央的交换芯片，PCB 内部的铜走线将信号传输到前面板，所有光学模块都插在那里。另一边是基于 CPO 的交换机——封装中央仍然是交换芯片（51.2Tbps 交换机），但边缘周围是16个3.2Tbps 光学引擎。“16乘以3.2，你得到51.2Tbps。所以光纤现在直接连接到这些引擎，而不是前面板。我们完全消除了 PCB 上的铜走线。光直接从封装中出来。这是一个非常非常复杂的工程作品。”Murphy 说。

Marvell 为 CPO 投入了十多年：硅光子学、光学 DSP、所有周围的模拟宽带组件，以及实现这一切所需的所有先进封装。“这一切实际上都需要在 CPO 中汇聚。”Murphy 说。

6、英伟达的背书与 NVLink Fusion 合作
Murphy 特别强调了与英伟达的战略合作扩展。几个月前宣布的合作中，英伟达向 Marvell 投资了10亿美元，双方正在扩展跨多个维度的合作，包括光学、光子学和 NVLink Fusion。黄仁勋亲自登台与 Murphy 对话，这本身就是一个强有力的信号。

黄仁勋详细解释了 NVLink Fusion 的战略意义：“有时候，也许云服务提供商想要设计自己的定制芯片。在我们之间，我们也在 NVLink Fusion 上合作，这使得你可以使用相同的系统架构，内部有 Marvell 的一些半定制芯片、大量互连、硅光子和光学技术。我们可以创建一个本质上分解、分布和异构的数据中心。”

关键是系统架构保持一致。“他们的网络技术可以利用大量英伟达的堆栈。CPU 可以是 Vera，但它可以利用大量你们的堆栈。所以 NVLink Fusion 是关于采用英伟达的技术和我们的平台、Marvell 的技术和平台，然后我们融合它。这就是为什么它被称为 fusion。”黄仁勋说。

Murphy 追问了铜到光学的转型时间表。黄仁勋的回答非常务实：“我们应该尽可能长时间地使用铜，但铜有其限制——带宽和距离的限制。所以最终正确的策略是：尽可能长时间地用铜进行 scale up。之后，用光学进一步 scale up，用光学 scale out，用光学跨越连接。所以你在必须的地方使用光学，在可以的地方使用铜。”

但黄仁勋随即给出了乐观的市场预测：“底线是，在未来五到十年，我们将使用大量的铜，也将使用大量大量的光学。这些数据中心现在是基础设施的一部分。我说 AI 现在有用、有用的 AI 已经到来的原因是，现在 AI 是有利可图的，token 是有利可图的。当 token 生产有利可图时，每个人都想制造更多 token，这就是为什么 Marvell 的需求如此之高，我们的需求也如此之高。因为每个人都想生产更多 token，因为它被 Agent 到处使用。”

7、无距离数据中心：光互联的终极愿景
Murphy 在演讲的最后部分描绘了一个激进的未来愿景：他当数据传输全部变成光学时，距离实际上不再重要。“这是一个深刻的变化。”说。

今天的服务器、机架和整体数据中心架构都是围绕距离的约束设计的，软件工作负载也围绕这些相同的约束进行了优化。但如果距离不再重要呢？

首先，scale-up 网络的规模可以从72个或144个 XPU/GPU 扩展到1000个或更多，全部光学互连。“对工作负载的影响是巨大的。今天，AI 工作负载必须分解成适合 scale-up 集群的更小子问题，因为在集群外部通信今天更慢、带宽低得多。但光学互连系统可以管理数量级更大的工作负载。”

其次，服务器本身可以被解构。现代 AI 服务器由一定数量的 CPU、XPU、内存和网络接口组成，它们都在同一系统上的原因是距离——CPU 和 XPU 需要以非常高的带宽访问内存，这意味着它们需要紧挨着坐在板上，铜走线作为它们之间的连接。“但在这些连接都是光学的未来，距离实际上不重要。你可以想象一个完全解构的架构——XPU 在一个系统中，内存在另一个系统中，巨大的 CPU 在另一个系统中。”

这解锁了另一种可能性：今天系统中 CPU 和 XPU/GPU 的比例是固定的，必须在系统构建和部署时定义。但没有两个工作负载需要完全相同的比例，这意味着在任何给定时间，计算或内存的某些部分可能未被充分利用——这要花钱。“但一旦我们将系统分解为独立的计算池和内存池，并且它们都是光学互连的，我们就可以动态组合专用系统，然后针对任何工作负载进行优化。”

Murphy 的终极愿景是“全球光学互连的数据基础设施”：“我们今天拥有的这些系统中的刚性边界开始消失。计算现在可以被池化，内存可以被池化，基础设施可以大规模动态组合。架构师第一次可以开始围绕模型的需求设计 AI 系统，而不是围绕互连的限制。”

他将这个愿景命名为“无距离数据中心”（data center without distance）：“计算、内存、网络和光子学作为一个统一系统运行，数据中心中的数百万资源可以像一台机器一样协同工作，一个由工作负载需求定义的架构，而不是连接性的限制。我们相信这是计算基础设施的下一个时代，Marvell 正在帮助构建使这一切成为可能的连接基础。”

最后再多说点，
Marvell的核心竞争力集中在两个细分领域。
1、定制芯片（ASIC/XPU）设计。 Marvell与博通是全球两大定制AI加速器设计巨头。大厂自研芯片的趋势正在加速——比如微软的Maia 200推理芯片、亚马逊的Trainium系列，背后都有Marvell的参与。TrendForce的预测数据值得留意：2026年定制AI芯片销售增速预计为45%，而同期GPU的增速仅为16%。不是GPU不行，而是超大规模云厂商在推理端的成本压力正在推动它们加速自研定制方案。

2、数据中心互连产品线。 这是Marvell更深的一条护城河。根据其财报，光学互连产品收入保持两位数季度环比增长，数据中心交换机业务预计2027财年将突破5亿美元。Marvell过去十年通过一系列并购累计投入约360亿美元，围绕连接搭建了涵盖定制芯片、高速交换器、光模块、硅光子和先进封装的完整技术平台。
~~~

Quoted tweet (qinbafrank): https://x.com/qinbafrank/status/2060037239120511305

~~~text
“我们的数据中心业务燃爆了”，“订单异常强劲”，这是MRVL的CEO在财报电话会上的原话，记录下电话会上值得重视的要点：
1、连续多个季度上调指引
1）Q2指引方面，公司预计营收约27亿美元（上下浮动5%），同比增长约35%，高于分析师此前预期的26亿美元
~~~

#### T11 2024-09-28 https://x.com/qinbafrank/status/1839826849989570577

Tweet id: `1839826849989570577`

~~~text
@BilibiliYoLo 短期应该还行、一方面能看出来风险偏好提升，另一方面当下无论是大A和币都是长期调整下的反弹价格也并没有涨的很离谱。但还是需要密切关注后续能不能改善，后面流动性如果迟迟不改善、那就得注意了。你怎么看呢
~~~

#### T12 2026-05-15 https://x.com/qinbafrank/status/2055174307635208513

Tweet id: `2055174307635208513`

~~~text
今天市场整体走弱韩股熔断，昨晚的推文其实已经聊到了核心逻辑，这里再聊聊：
1、油价走高、长债收益率走高、股市走高，都在同一方向运动是有问题的。
2、今天市场走弱核心驱动是长债收益率走高，重点关注十年美债率。4.6%是US10Y一个阈值（具体看引用的昨天推文），越往上市场越能感受到压力。
昨天US10y还在4.4%、今天已经飙升4.53%了。
3、整体财政部压制长债收益率的工具还很多：
1）二三季度再融资计划里已经披露了长债回购计划；
2）贝森特本身就是基金经理出身、勾兑一些债市机构联手行动也不是难事。去年同期其实隐隐有过类似的操作。
看下周贝森特回国后会不会出手了，能不能守住4.6%的阈值。

4、最核心的是高油价
油价走高推高通胀（三四月份美国cpi和ppi走强很大程度都是油价走高通胀反弹）自然也推动长债收益率走高，风险市场承压。这里传导的底层逻辑

昨天聊到高油价持续太长时间，变成一个越来越大的灰犀牛。灰犀牛大家都看得到，但灰犀牛越来越大也就是个问题和风险了。

油价则来自伊朗局势的走向，现在主要看谈判走向：一方面看中国是否出面斡旋，昨天白宫说中国已经同意出面斡旋但是中国的声明还没出来，还要看中国怎么看？
另一方面，看美伊谁让步、让多大才行。

5、昨天也提示部分止盈是比较好的操作，涨的太多获利资金出走长债收益率走高风险资产承压。

但也要注意到当下基本面还是很强劲，即使高油价、高长债收益率对市场带来压制，个人角度这会带动美股大盘小级别调整，调整完还是上车良机。
~~~

Quoted tweet (qinbafrank): https://x.com/qinbafrank/status/2054874676531519643

~~~text
美国四月PPI也比较很强，国债收益率还在继续走强，应该怎么看？警惕长时间高油价的灰犀牛问题。昨晚公布的美国四月PPI及核心PPI的同比环比均大幅度超出预期，主要也是能源和运输成本大幅上升导致的。而周二晚上公布cpi略超预期，能源依然是通胀上行首要贡献项，如食品价格受到运输成本与化肥价格上涨的 https://t.co/rPMMJDMzfy
~~~

#### T13 2026-06-08 https://x.com/qinbafrank/status/2063957707695251823

Tweet id: `2063957707695251823`

~~~text
算是一个能缓解紧张情绪的好消息，今天在思考的点是以内塔尼亚胡最近动不动暴走单干，会不会从川普的亲密盟友变成川普的“负资产”呢？美伊的谈判过程中，能看出俩美伊都不想主动升级局势，有小级别的摩擦都是浅尝辄止。但在这个过程中，以色列的利益尤其是以色列领导人内塔尼亚胡的个人利益，与川普和美国的利益呈现出越来越明显的分歧：
1、以色列基于本国安全，希望战争继续进行，以不断削弱伊朗的实力；川普则基于经济形势和国内选举，希望尽快达成协议，从而打开海峡以稳定全球经济，并避免即将到来的中期选举蒙受战争的更大冲击。
在这种情况下，美国与以色列的分歧显然是越来越大，双方利益引发的矛盾也是愈发尖锐。

2、这一点已经公开化了。昨天Axios 报道称川普6要求内塔不要报复伊朗导弹袭击；特朗普还对《金融时报》说，内塔“没有选择”，并称“我说了算，他说了不算”。
这就说明美以战略优先级开始冲突

3、那么川普未来会不会越来越压制内塔？
个人角度可能性很大
川普最不能忍的不是盟友强硬，而是盟友让他看起来“失控”“被拖累”“谈判失败”。

所以内塔如果继续破坏谈判，川普对他的反击大概率不是传统外交式的温和劝说，而会越来越像特朗普式政治操作：
1）公开羞辱、公开切割、把责任甩给内塔、绕过内塔接触以色列其他政治力量。
这已经有迹象。AP 报道称川普承认曾在通话中用“crazy”等措辞批评内塔，并表示以色列与真主党的战斗正在妨碍美国与伊朗的和平谈判。 

这里已经不是简单“骂了一句”，川普有点开始把内塔描述成妨碍美国外交成果的人的信号。

4、如果真的要压制内塔、川普会怎么做？
1）公开说“以色列人民需要一个能把事情办成的领导人”。
2���见以色列反对派领袖，比如甘茨、拉皮德、贝内特、艾森科特等。
3）在以色列大选前减少对内塔的个人背书。
4）在军事援助、弹药节奏、情报共享、联合行动授权上给内塔施压。
5）让美国中东特使、共和党建制派、美国犹太组织释放“内塔已经成为负资产”的信号。

这不一定等于直接“动员以色列国内反对势力搞他”，但效果可能类似：川普不需要亲自推翻内塔，只要不再替内塔兜底，内塔的国内政治成本就会暴涨。

可以预期随着川普内塔的分歧越来越大，内塔的政治空间也将会被压制。

当然短期，内塔不会马上倒。
因为他仍然掌握执政机器、右翼基本盘、战争状态下的安全话语权，也很擅长分化反对派。

中期，如果继续暴走单干，内塔处境会显著恶化。
尤其是如果特朗普把他定义为“破坏美国和平协议的人”，那内塔的美国牌就会从资产变成负债。

仅是个人思考，供参考
~~~

Quoted tweet (qinbafrank): https://x.com/qinbafrank/status/2063804130074775578

~~~text
熬过一个焦灼的周末本周市场应该怎么看？上周五晚上有详细梳理美股在上周后半周走势几个变化因素，最早还是上周三晚上的space提示了风险。这次调整的核心逻辑：AI/半导体短期涨幅过大、市场FOMO过强、交易结构过度拥挤，抛���线式上涨本身不可持续；随后又遇到SpaceX巨无霸IPO路演和认购抽水、CPI/PPI/F https://t.co/39VSAIJkwT
~~~

#### T14 2026-02-28 https://x.com/qinbafrank/status/2027661583296696621

Tweet id: `2027661583296696621`

~~~text
“咆哮的狮子”行动美以对伊朗已经开打，后续怎么看？昨晚的推文最后有聊到，“从战略时机上看，此刻似乎确实存在一个“窗口期”。伊朗的区域代理网络在与以色列的多轮冲突中受到削弱，经济制裁长期积压导致内部的压力几度爆发，国内社会不满情绪并未完全消散。对一个擅长抓“窗口”的政治人物来说，这样的时刻天然具有诱惑力。特别是川普在内政受挫的时间点，自然容易转向从外事上来找补回来。从这点上，概率是在增大的。”现在已经开始动手了，那么就要看看后续会如何？

1、从以色列官员披露的信息来说，今天主要就是打击伊朗的高官和导弹机场等基地，包括哈梅内伊以及总统的官邸。核心直指的就是斩首行动和瘫痪军事力量。不过貌似哈梅内伊并不在德黑兰，对伊朗总统的刺杀也未遂。

而选在美东时间周六凌晨开始，不难理解周末时间动作减少会金融市场的冲击（导弹不幸有砸在币市上了），同时还给了川普出来安抚市场的时间。

之前这里https://x.com/qinbafrank/status/2024339758672203977有聊过“未来一旦动手，作战行动可能持续数天至数周。打击目标可能涵盖多个层面——从针对武器设施和中层官员的定点打击，到可能推翻现有政权的"斩首行动"。首要目标是摧毁伊朗的导弹、发射器、无人机及无人机工厂，以防止对美军和以色列的报复性打击。” 今天美以的行动也确实如此，

2、但是轰炸和刺杀伊朗最高领导人和总统的斩首行动都没有成功，那么大概率伊朗是要发起一波报复的。只要最高领导人和总统都还在，那么领导体系还能保持。同时之前有聊过，去年6月之后伊朗快速恢复了导弹产能，导弹库存已经回升到去年6月之前的水平，同时每月产能还有2~300枚。虽然伊朗导弹基地，固定发射井容易被攻击，但是伊朗还有大量的导弹发射车四处移动，这也给了伊朗反击报复的底气。

今天晚些时候估计能看到伊朗的第一波报复行行动，就是向以色列境内各类设施发射导弹。同时，美以的第二波攻击可能随后又要开始。

3、美国的意图是什么？如共和党参议院领袖图恩前两天说到的，如果美国对伊朗采取行动，目的就是为了更迭政权。但问题是，更迭伊朗正确概率大么？其实不大的，如果今天行动没能炸死哈梅内伊和总统泽希齐扬（本身还属于亲美派），那么后续再要搞这俩难上加难。因为伊朗内陆纵深很大，不像委内瑞拉首都加拉加斯离加勒比海岸就十几公里，直升机就能快速突击。德黑兰离海几百公里，特种兵突击难度很大。

同时伊朗革命卫队实力也是有的，美以也很难发动大规模的地面攻击，容易陷入泥潭。这也是川普不想看到的。最可能就是趁机在伊朗内部在挑起暴动和暴论，鼓动反对派来起来搞事，给美以进一步行动创造机会。

如果不能更迭政权，退而求其次川普最希望的永久废掉伊朗核能力，废掉导弹能力（这一点以色列更想看到，美国可能也接受限制伊朗导弹射程这一提议）。

4、从这个角度上看，今天的行动还是威慑第一位，逼着伊朗把日内瓦会谈上拒绝的条款捡起来再谈。当然最佳剧本是双方互殴过后，重新谈判，伊朗看到了川普的决心，做出巨大的让步以换取短期的平静。

当然悲观情景就是伊朗也不妥协，川普没法给国内交待。大张旗鼓没有成果，声誉更是一落千丈。那么只能继续互殴，拉锯战开始。这对市场是最难受的。

5、接下来的观察焦点在于：
1）双方在一轮互殴过后，是否透露出再次谈判的信号？
2）如果伊朗不退让，拉锯战开始。霍尔木兹海峡是否有封锁迹象（海峡关键航道很窄，用远程大炮就可能封锁）？ 当然现在离“霍尔木兹封锁”还很远，因为那是伊朗的最后手段，不会轻易动用。毕竟对自己经济损害也会非常大。

如果有再次谈判的信号出来，市场自然会缓一口气。否则周一大概率还是恐慌开盘。

而对于市场的影响则在于，如果短期一两次互殴然后快速会到谈判桌上， 对市场的恐慌但这种冲击往往都是短期一次性的。市场会快速的演绎各种最悲观的预期。一旦确认还能谈判斡旋后，市场还是会回到原来的驱动逻辑上。

但如果是长期拉锯战的话，最大的影响就是油价易涨难跌。同时不确定性则是继续加大的。特别是现在美股本身还没有从“春劫行情”里走出来。
~~~

Quoted tweet (qinbafrank): https://x.com/qinbafrank/status/2027357081578377685

~~~text
美伊日内瓦谈完后最后的十天窗口期？昨天美国伊朗日内瓦谈完没有谈成协议，川普给出的窗口只有10到15天。没有明确的“最后通牒”，却有明确的心理预期——如果谈不成，��项不会只停留在外交层面。 https://t.co/MSzWsbZ49b
~~~

#### T15 2026-06-12 https://x.com/qinbafrank/status/2065367231866036522

Tweet id: `2065367231866036522`

~~~text
成长股的核心本质是什么？就是用业绩的高速增长来消化估值。很多人看成长股，尤其是AI产业链的股票，第一反应就是“市盈率这么高，还敢买？”  正好借着早上这个回复把“EPS高速增长消化估值”的逻辑聊一聊。核心就一句话：公司赚钱速度够快，就能用时间把现在看起来贵的估值，拉到合理甚至便宜的水平。

1、先聊聊最容易混淆的点
市盈率 = 股价 ÷ 每股盈利（EPS）
市盈率高 = 你现在为每一块钱盈利付的钱多，看起来贵。
但成长股买的从来不是“现在已经赚到的钱”，而是未来几年能赚多少钱。
如果公司EPS（每股盈利）每年都在快速增长，那未来EPS的基数会越来越大。
同样的股价，除以越来越大的EPS，市盈率自然就下来了。这就是“消化”。
简单说就是增长把分母（盈利）做大了，高估值就被稀释掉了。

2. 举个最直白的数字例子
假设现在有一只股票：股价100块
今年EPS只有2块
市盈率50倍（很多人一看就说“太贵了”）
情况A：每年EPS增长30%（比较稳健的成长）第1年：EPS变成2.6块 → 市盈率降到约38倍
第2年：EPS变成3.4块 → 市盈率降到约29倍
第3年：EPS变成4.4块 → 市盈率降到约23倍
第5年：EPS变成7.4块 → 市盈率只剩约13.5倍

情况B：每年EPS增长50%（很多AI供应链公司努力的方向）第1年：市盈率约33倍
第2年：约22倍
第3年：约15倍
第5年：只剩6-7倍

你看，股价没怎么变，只是因为公司赚钱越来越猛，市盈率自己就掉下来了。这就叫用增长消化估值。增长越快，消化得越彻底。2-3年时间就能看到明显效果，5年基本就完全消化了。

3.、为什么有些高市盈率的股票还能买？
因为市场给的不是“当前盈利”的价格，而是对未来盈利增长的定价。在AI基础设施这个阶段，很多公司现在还在重投入、盈利还没完全释放出来，市盈率自然高。但只要后面有真实订单落地，EPS就会加速增长。这时候你买的不是“故事”，而是能看得见的业绩兑现节奏。

增长一旦兑现，高估值就逐步被消化，股价反而有空间。反过来，如果只靠讲远期故事，没有订单、没有验证、没有业绩增速，那高估值就消化不了，反而是风险。

所以大家会看前瞻市盈率、前瞻市销率，本质就是这个逻辑。核心是看未来一年，或者两年业务增长能把估值消化到什么地步。

4、怎么判断增长够不够“消化”估值？
最早是彼得.林奇提出来的简单的一个指标叫PEG（把增长考虑进去的市盈率）：
PEG = 市盈率 ÷ 预期年增长率（%）
PEG接近1 → 价格和增长基本匹配，比较合理
PEG明显小于1 → 增长很快，相对来说不算贵
PEG明显大于1 → 增长一般，价格偏贵

举例：一只股票市盈率50倍，但预期每年增长50% → PEG=1（可以接受）
同样市盈率50倍，但只增长20% → PEG=2.5（贵）
市盈率20倍，但只增长10% → PEG=2（也贵）
所以不能只看市盈率高低，要看增长能不能跟得上。

5、实际投资里怎么用这个逻辑？
投资节奏很重要。纯讲“未来AI会怎么牛”的故事股，容易被高估值反噬。
真正有订单、能看到2026-2027年EPS明显增长的公司，才是增长在真实消化估值。
核心判断三条：
增长是不是有真实驱动（订单、客户验证、产能爬坡）？
增长速度能不能覆盖当前估值？（看PEG、看未来2-3年EPS复合增速）
万一增长没达预期，安全边际在哪儿？

6、也说说风险
增长消化估值不是自动的，它的前提是增长真的发生了。如果公司出了很多问题：
订单没落地
竞争太激烈导致价格战
宏观或者行业周期反转
公司自己执行力出问题
那高估值不仅消化不了，还会因为失望而进一步杀估值，这时候最惨。

所以真正明知的做法是：买那些增长路径清晰、已经开始兑现、而不是还在画饼的公司。这样即使短期波动，也能用时间和真实增长把估值消化掉。

上面聊了这么多，其实最核心还是看增长，特别是增长的速度，高市盈率不可怕，可怕的是增长跟不上。
只要EPS能保持高速增长，用2-5年时间，就能把现在看起来贵的估值，消化成合理的、甚至低估的水平。这不是理论，是过去很多成长股走过的真实路径。

所以成长股投资关键永远是两件事：
增长的确定性和兑现的节奏。

对一只成长股我们需要清楚：它到底是在用增长消化估值，还是在用故事透支估值。
~~~

Quoted tweet (qinbafrank): https://x.com/qinbafrank/status/2065241894070960526

~~~text
@success_cw 这两年你按传统估值体系都没法去下手，按照成长来看，核心是看业绩增速，业绩增速的本质用高速增长来消化估值。
~~~

#### T16 2026-06-21 https://x.com/qinbafrank/status/2068580313584804205

Tweet id: `2068580313584804205`

~~~text
沃什正在重构美联储的“央行操作系统”，周四有聊到决定长期资产定价的是制度在未来几年内缓慢移动的方向，而这个制度的方向就在于沃什成立的五个特别工作组在年底提出的结论上。个人角度分析沃什未来的政策方向，核心就是要看这个五个特别工作组未来能提出什么框架，而不是看其他的。这五个工作组分别聚焦：美联储沟通、资产负债表、数据源使用、生产率与就业（AI的影响）、通胀框架。细看沃什成立的这个五个工作组的聚焦方向，很容易得出他其实就是重构美联储的底层操作系统。

过去十多年，市场熟悉的是一套“鲍威尔—伯南克—耶伦式”的央行操作系统：大量沟通、点阵图、前瞻指引、QE/QT、以金融条件作为传导渠道、必要时快速修复市场压力。沃什现在想改的，是这套系统的底层逻辑。从过去
“美联储会告诉市场它大概率会怎么做” 转向“只告诉市场目标和事实，市场自己给风险定价”这会改变资产价格的生成机制。过去市场交易的是“美联储路径”；未来可能更多交易“经济状态本身”。

1、看看五个工作的聚焦方向
1）沟通机制：从“安抚市场”转向“减少承诺”
沟通机制的核心不是话多话少，而是央行是否愿意提前给市场一条可交易路径。过去点阵图和前瞻指引降低了政策不确定性，也压低了波动率，但副作用是市场会把联储话术当成隐含担保。

这意味着未来可能出现三件事：市场更难提前“锁定”美联储路径；数据公布后的利率、美元、股指反应会更剧烈；FOMC会议本身重新变成真正的风险事件，而不是被提前充分预告的例行确认。这会提高政策惊喜溢价。

2）资产负债表：从“永久市场压舱石”回到“必要时工具”
这是最重要的一组。沃什真正想问的是：货币政策到底通过什么生效？是利率这个价格工具，还是资产负债表这个数量工具？

官方说，资产负债表工作组会审查当前充裕准备金制度的收益和风险、资产负债表构成，以及替代性的货币政策实施框架。

为什么这重要？因为2008年后，央行不只通过短端利率影响经济，还通过买债压低期限溢价、压低风险溢价、改善市场流动性。纽约联储早期研究就认为，大规模资产购买显著并持久压低了长期利率，主要是通过降低风险溢价和期限溢价。 美联储自己的2022年研究也给过一个粗略换算：模型中，减少相当于GDP 1%的10年期等价美债持仓，会使10年期美债期限溢价上升约10个基点；把资产负债表缩小约2.5万亿美元，大���相当于持续加息略高于50个基点。

这说明沃什问的不是学术问题，而是资产定价的核心问题：如果美联储少买债、少压期限溢价，那么长期利率、股票估值、信用利差、房地产资本化率都要重新定价。

3）数据源：从滞后宏观数据转向更实时、更可执行的数据
官方说，数据工作组会评估新的信息来源和方法变化，目标是给政策制定者更准确、相关、同步、可执行的信息。

这背后有一个很现实的问题：传统宏观数据在结构转型期经常滞后。就业数据会修正，通胀分项会受供给冲击扭曲，生产率提升不一定马上反映在统计口径里。如果AI、移民、关税、能源和财政补贴同时冲击经济，单靠传统月度数据，很可能会误判周期位置。

所以这组工作组可能带来一个变化：未来美联储不会只看“失业率、CPI/PCE、非农”这些旧指标，还会更重视高频就业、企业定价、工资、供应链、金融市场流动性、实时消费与信贷数据。这会让政策更“实时”，但也会让市场更难预测，因为反应函数不再只绑定几个传统数据点。

4）生产率与就业：AI不是主题投资，而是货币政策变量
沃什把“AI时代的生产率与就业”放进货币政策工作组，非常关键。官方说，这一组会研究包括AI在内的新通用技术的速度、范围、经济影响，以及对就业和通胀双重使命的含义。

这其实是在重估三个变量：
潜在增速：AI是否提高劳动生产率，使经济可以更快增长而不产生通胀？
自然失业率/就业质量：AI是否导致局部岗位被替代，同时创造新岗位？
中性利率：如果AI带来更高投资需求、更高资本回报率，真实中性利率可能上移。

这会直接影响利率定价。假如AI是真生产率革命，美联储可以容忍更强的GDP和资本开支；假如AI只是资本开支泡沫，而生产率迟迟不兑现，短期内带来的是再通胀压力，之后就是高估值、高融资成本、高折旧压力并存。

5）通胀框架：重建2%目标的可信度
官方长期框架仍强调，长期通胀主要由货币政策决定，PCE通胀2%最符合美联储法定使命，并且美联储准备采取有力行动稳定长期通胀预期。 这次沃什又强调通胀高于目标已经持续多年，并提出通胀框架工作组要研究通胀驱动因素和实现价格稳定的完整方案。

这实际是在处理2020年后框架遗产：当时平均通胀目标制是在低通胀、低利率、低中性利率时代设计的；但现在面对的是财政赤字、地缘能源、关税、供应链、移民政策、AI投资和高债务并存的世��。沃什可能想把框架从“防通胀过低”重新转向“防通胀预期松锚”。

所以，通胀框架的变化不是2%会不会改，而是：当通胀来自供给、财政、关税或能源冲击时，美联储到底忍多久？什么时候认定它会传导成广义通胀？什么时候必须牺牲增长来重新锚定预期？

这里面还有一点就是：
“Fed put触发条件”不是公开列名的第六个工作组，官方列出五个工作组的聚焦方向，其中资产负债表和沟通机制的改变，会间接决定美联储未来是在“市场下跌”时出手，还是只在“市场功能失灵/融资管道堵塞”时出手。

2、“利率工具 vs 资产负债表工具”：这件事为什么决定长期资产定价？
资产价格可以简化成：
资产价格 = 未来现金流 / 折现率 + 风险偏好 + 流动性溢价

利率工具主要影响短端利率和未来短端利率预期；
资产负债表工具主要影响期限溢价、流动性溢价、风险资产的估值锚。所以，利率是“钱的价格”，资产负债表是“央行对久期、流动性和尾部风险的吸收能力”。

过去美联储扩表时，相当于央行替私人部门持有久期风险，市场不用自己吸收那么多长期债券，期限溢价下降，股票估值上升，信用利差收窄。反过来，如果美联储长期缩小市场足迹，私人部门要吸收更多久期风险，长期利率就更容易包含财政风险、通胀风险、期限风险和流动性风险。

这就是为什么沃什的资产负债表工作组对美股估值极其重要。它决定未来市场是不是还能默认：
“经济一差，Fed就扩表；市场一跌，Fed就救；长端收益率一冲，Fed就压。”
如果答案变成“不一定”，长期资产定价的底层锚就变了。

3、Fed越来越克制，财政的触角会不会越来越大？
如果货币政策不再频繁用QE压低长端利率，不再用沟通安抚市场，不再轻易给Fed put，那么市场会更直接面对财政现实：赤字多大、发多少债、发短债还是长债、谁来买、以什么期限溢价买。

CBO最新基线显示，美国2026财年赤字预计为1.9万亿美元，到2036年升至3.1万亿美元；赤字占GDP比重从5.8%升至6.7%，高于过去50年3.8%的平均水平；公众持有联邦债务预计从2026年的101% GDP升至2036年的120%。 这意味着财政不再是背景变量，而是收益率曲线的核心供给变量。

财政的影响会通过四条线进入市场：
第一，发债结构。 财政部发多少Bills、多少2年、10年、30年，直接影响曲线形态和期限溢价。财政部5月再融资文件显示，财政部会持续评估票据需求、SOMA组合变化、名义券和FRN拍卖规模，并通过票据和CMB处理季度融资需求。

第二，现金管理。 TGA余额、税期、票据发行和回购会改变银行准备金、货币基金、逆回购和短端流动性。财政部也明确说现金管理回购的目标之一是降低TGA和票据发行波动，流动性支持回购则是给市场一个可预测的出售老券渠道。

第三，产业政策。 财政通过税收抵免、补贴、关税、国防采购、能源政策、AI基础设施、半导体和电网投资影响企业现金流，而不是通过美联储估值倍数统一抬升所有资产。

第四，债务利息反馈。 利率越高，财政利息成本越高；利息成本越高，发债越多；发债越多，期限溢价越高。这会形成内生波动。

所以我会这样定义未来：不一定已经进入“强财政主导”，但大概率进入财政定价权上升的时代。

4、那么新范式是什么？
我认为新范式可以概括为：
从“Fed流动性范式”转向“财政供给 + 央行克制 + AI生产率 + 期限溢价再定价”的范式

旧范式里，市场最重要的问题是：
美联储什么时候降息？什么时候扩表？金融条件是否太紧？Fed put在哪里？

新范式里，市场最重要的问��会变成：
财政赤字由谁吸收？长端债券需要多少期限溢价？AI到底提升生产率还是只推高资本开支？通胀目标是否可信？美联储到底救市场价格，还是只救市场功能？

这会带来几个资产定价结果。
1）长端利率的重要性超过短端利率。 过去市场盯2年期和点阵图，未来要更重视10年/30年期限溢价、拍卖需求、海外买盘、银行资产负债表约束和财政部发债结构。

2）美股从“流动性普涨”进入“现金流分化”。 低利率和QE时代，久期越长、故事越远，估值越容易被抬升。新范式下，现金流质量、定价权、资本开支回报率、资产负债表韧性会更重要。

3）AI不是简单的成长股叙事，而是宏观供给冲击。 如果AI提升生产率，它能缓解工资—通胀压力，并支撑利润率；如果AI只带来算力、电力、芯片和数据中心的资本开支竞赛，而收入回报滞后，那就会形成高估值、高折旧、高融资成本三重压力。

4）财政受益板块会有结构性溢价。 国防、电网、电力、核能、天然气、半导体设备、工业自动化、网络安全、基础设施、关键矿产、AI基础设施，可能比传统“低利率高久期”资产更符合新环境。

这自然会导致波动更大，沟通减少本身会增加政策惊喜，Fed put边界后移，这些都可能是波动的来源。

过去半年有三篇写沃什的文章值得看看
1）之前2月初这里https://x.com/qinbafrank/status/2018129302114689163聊到的沃什可能得政策和节奏，节奏比速度更重要，聊的是节奏问题；
2）3月底这里https://x.com/qinbafrank/status/2048568392643465426，聊的沃什的愿景问题；
3）今天其实聊的是他的愿景落在实处上，最终会形成一套什么样的框架和操作系统。

所以真正的观察点是 他能不能把美联储从“市场情绪管理者”重新变成“价格稳定和金融管道稳定的守门人”。
1）如果成功，长期结果可能是：通胀锚更稳，Fed put更窄，市场价格发现更真实，财政责任重新暴露。
2）如果失败，结果就是：沟通减少但框架不清，财政压力上升但央行不兜底，市场同时担心通胀、增长、债务和流动性，那波动会显著放大。

简单说，沃什想重建的框架，是一个更少承诺、更小资产负债表足迹、更依赖真实数据、更重视AI供给冲击、更强调2%通胀信誉的美联储。对市场来说，新范式不是“货币不重要”，而是“央行不再替市场压低所有风险溢价；财政、期限溢价和生产率，开始重新成为定价核心”。
~~~

Quoted tweet (qinbafrank): https://x.com/qinbafrank/status/2067547681745178808

~~~text
再聊聊今天的利率决议和沃什首秀：
~~~

#### T17 2026-03-09 https://x.com/qinbafrank/status/2030959983521911041

Tweet id: `2030959983521911041`

~~~text
G7联合释放应急石油储备，油价能被摁住么？看媒体报道，G7财政部长在周一召开紧急会议，讨论在国际能源署（IEA）协调下联合释放应急石油储备的可能性。包括美国在内的三个G7国家迄今已表示支持这一想法。知情人士表示，一些美国官员认为，联合释放3亿至4亿桶石油储备将是合适的，这相当于12亿桶总储备的25%至30%。

1、IEA国际能源署32个成员国（含全部G7国家）拥有集体应急石油储备系统，正是1973年石油危机后专门为“严重供应中断”设计的。这32个成员国共拥有12亿桶石油储备（另有6亿桶工业库存）。美国现在储备4.1亿桶，日本3亿桶，美日合计7亿桶石油储备。剩下的就是其他各国了。

从这个角度IEA协同成员国是释放应急石油储备是可行的，而且讨论的释放3亿桶到4亿桶也只占IEA成员国储备的25%～30%。

霍尔木兹海峡实质性停运前，每天经过霍尔姆海峡运输的原油是2000万桶。所以如果各国真的联合释放石油储备，差不多能弥补15-20天霍尔木兹海峡实质性停运带来的缺口。

当然释放方式通常是分批（例如每周几千万桶）进行，不是说一次性就把储备释放到市场上。

2、其实22年俄乌战争爆发后，IEA成员国也释放了应急石油储备。
1）22年2月底-3月初，俄乌冲突爆发初期），布伦特原油从约90-95美元/桶快速飙升，3月8日左右触及峰值约130-135美元/桶，创2014年以来新高，直接原因就是地缘风险和供应担忧推动。

2）22年3月1日第一次IEA协调释放（约6000万桶，美国贡献3000万桶）：宣布后立即产生效果，价格从高点回落约10-15美元/桶，3月中���布伦特回落至约105-110美元/桶区间。当时IEA报告称释放向市场发出“统一信号”，缓解了恐慌性买盘。

3）22年月底-4月初第二次更大规模释放，美国宣布1.8hi桶SPR释放，IEA协调1.2一桶，总计约3亿桶分6个月投放）：4月1日宣布后，布伦特从约107-110美元进一步下跌，4月中旬降至约100-105美元，单周跌幅达13%（两年最大周跌幅）。IEA 4月报告指出，价格回落近10美元/桶，至约104美元/桶附近，接近入侵前水平，但仍处于令人担忧的高位。

4）整体上半年（22念3-6月）
尽管两次释放缓冲了涨幅，价格仍维持高位震荡。6月布伦特月均价约117-122美元，创年度峰值，当时受OPEC+减产、欧洲制裁俄油等驱动；
22念下半年（7-12月），释放效果逐渐消退，但全球需求放缓、经济衰退担忧、中国疫情封控、美国产量增加等因素主导，价格持续回落，到22年底讲到80美元/桶左右。

3、22年释放石油应急储备的效果
1）短期有效，
22变两次释放合计3.6亿桶，成功将价格从峰值压低10-20美元/桶，持续4-12周不等（历史经验显示类似释放可带来8-15%的短期抑制）。

2）中期有限，无法完全抵消俄油出口减少（约300-500万桶/日缺口）和OPEC+政策，价格在高位维持数月。

3）长期看需求，22变年下半年回落更多归因于需求端疲软而非储备释放本身。

4、怎么看这次释放应急石油储备的影响？
1）与22年相比，当前2026年霍尔木兹海峡停运每天影响2000万桶石油供给，22年俄乌冲突缺口每日500万桶，现在缺口更大。

2）如果今天G7/IEA最终确定释放3～4亿桶，短期内可能类似带来10-20美元/桶的缓冲回落。毕竟现在油价走高很大程度上还是投机资金的驱动，下游需求还没有完全传导。

3）中长期走势仍取决于冲突持续时间，取决于霍尔木兹海峡停运的时间。释放石油储备并不能无法永久替代中东供应。如果冲突长期化，仍需其他措施（如海军护航、增加非OPEC产量等）
~~~

Quoted tweet (qinbafrank): https://x.com/qinbafrank/status/2030805517921333545

~~~text
整体聊一下近期的大盘及“春劫行情”逻辑主线的变化，其实从一个多月前说“春劫行情”，过去几周几乎每周都在说还在持续，还没完事。但是整体市场的驱动逻辑也发生了几次变化：
~~~

#### T18 2026-06-16 https://x.com/qinbafrank/status/2066684653717917767

Tweet id: `2066684653717917767`

~~~text
SpaceX上市大涨之前说的安全期和太空经济板块怎么看？Spcx昨晚大涨，市值突破2.5万亿美金，之前6月1号https://x.com/qinbafrank/status/2061389019414696005?s=46&t=k6rimWsEbo2D2tXolYcM-A聊到：SpaceX上市后两个月是安全期，低流通+指数纳入能有一波行情，然后业务预期也很好，也算是得到了印证。这两天想了下对于安全期再修正下：
1）7月7号进入指数前后是是安全期；
2）7月中参与IPO的散户可以无惩罚卖出，上周聊到https://x.com/qinbafrank/status/2065423706193825939?s=46&t=k6rimWsEbo2D2tXolYcM-A现在各个IPO认购券商平台都设置了翻转期，30天之内卖出的散户会有惩罚措施。
3）7月底Q2财报前尽量维持股价在IPO价格的30%以上以完成绩效，第一次可以多解锁10%的份额。

而对于近期太空经济板块，个人看法是：
1）也是上周六聊到的SpaceX成功是长期利好整个生态（更便宜的发射、更多卫星上天，需求扩张）。

2）虽然上周五spcx在ipo当天太空经济板整体大跌，但换个角度SpaceX的市值越往上走事实上也是打开了整个产业的市值天花板、想象力天花板。

3）SpaceX之外，有真实订单、清晰路径、执行力强的太空经济板块公司短期应该也会被带动起来，长期也能继续分化��赢。
~~~

Quoted tweet (qinbafrank): https://x.com/qinbafrank/status/2065644169373364391

~~~text
SpaceX上市开��大涨，太空经济板块却普跌。从25年11月开始关注太空经济并在X上持续写了几十篇推文，是时候复盘下哪些是看对了哪些看错了？个人角度不是故事结束了，而是市场在快速分化。详细做个梳理与复盘
1、昨晚太空经济板块分化的原因是什么？
1）资金轮动+代理溢价消退 https://t.co/C0TsJ7lYFo
~~~

### Case 3B Raw: Competitor Qinbafrank CRCL Answer And Visible Citations

Source URL provided by user: `https://www.themarketbrew.com/research?agent=kol&persona=qinbafrank`

Prompt:

> 最近你怎么看 CRCL，今天该不该买，我如果想买我应该在什么价格挂单，然后在什么价格挂单卖出？

Answer raw from user transcript:

~~~markdown
一、 核心态度与判断框架（@qinbafrank 的长期视角）
在博主的方法论和投研框架中，Circle Internet Group（CRCL） 被明确定义为**“稳定币市场十倍空间 + 合规龙二”**。在理解和交易这只股票时，必须首先牢记以下几个底线原则：

基本面主导：不要把 CRCL 当作“USDC 价格”标的。 USDC 作为稳定币，其本身锚定 1 美元，不具有价格波动性。CRCL 是其发行母公司的股票。
核心投资逻辑（原始判断）：
市场天花板极高： 预计未来三到五年内，稳定币将发展为 3 万亿美金 的庞大市场。
格局优越： USDT 是龙一但合规性较弱；CRCL 则是龙二且是机构 + 监管最友好的合规代名词。
团队进取心强： Circle 与 Coinbase、贝莱德等巨头深度绑定，并在积极推动 CPN（Circle Payment Network）等支付基建升级。这代表了其将从单一的“利差收租商”向“Web3 / AI 时代支付清算网络”迭代的野心。
不要押注短期立法节奏： 监管进程（如《清晰法案》的实质落地）是公司逻辑彻底释放的超级催化剂，但博主向来不适合散户去对赌立法的具体周/月度时间点。
二、 当前基本面与估值数据拆解
结合prefeteched提供的最新市场与公司数据（截至 2026-06-23）：

当前股价： $75.68（2026年6月23日收盘价）
IPO 背景： 公司于 2025-06-04 正式上市。目前在公开市场交易刚满一周年，历史估值序列正处于上市后的重新定价和沉淀阶段。
业务现状： 当前主营业务高度依赖 USDC 发行规模以及其储备金（美债等高流动性资产）的利息收入。
三、 今天该不该买？博主方法论下的决策
根据 core/operating-system 中的决策框架：

1. 为什么“今天该不该买”是个伪命题？
博主坚信：“拿不住的资产，说明你不够了解它。” 如果你在买入前问的是“今天该不该买”这种基于短期波动的择时问题，说明你并没有做好持有一只可能回调 20%~30% 资产的心理准备，根据 一票否决（一票否决）规则，如果没有建立深度的产业认知，就不该在今天盲目建仓或重仓。

2. 如果要买，合理的建仓姿态是什么？
已持有者（长线逻辑）： 只要 USDC 流通量同比增速维持在 50% 以上，且利息收入没有因宏观利率雪崩（短期内美联储未开启暴烈降息）而断崖式下跌，长持 3-5 年的“十倍空间”叙事就依然未破。
未持有者（上车策略）： 由于近两日暂无重磅监管立法或重大财报事件，短期的波动多为跟随大盘或加密板块（如 Coinbase、Robinhood）的β共振。博主一贯的策略是：“等小级别到中级别的杀估值时再分批评估。” 当大盘出现小级别调整（个位数跌幅），或者板块因为地缘/宏观情绪阶段性回撤，而 CRCL 的底层基本面（USDC 发行量）依然向上加速时，即是性价比最高的买入点。
四、 如何在特定价格“挂单买入和卖出”？（交易纪律纠偏）
你提问：“应该在什么价格挂单，然后在什么价格挂单卖出？”

对于这个交易细节，博主的投资方法论有较强的约束和一票否决（一票否决）规则：

❌ 严禁预测精确的买卖点位： 博主从不预测大顶、大底或精确的 K 线支撑阻力位。在基本面主导的市场里，试图靠挂单精准套利是“捡了芝麻丢了西瓜”。博主的原则是：“让子弹自己飞着看看。”
❌ 严禁把长线基本面股当成超短线 Meme 股炒作： CRCL 不是微策略（MSTR）那种高杠杆的 DAT 资本运作标的，更不是 Meme 股。它是一家拥有扎实金融基建逻辑、需要 3-5 年网络效应释放的公司。如果你想今天挂单，明天或下周挂单卖出套利，这完全背离了博主的投资框架。
正确的操作姿态（分批网格/阶段建仓）：
买入挂单（防御性吸筹）： 不适合在日内高点去 FOMO 追高。你可以将资金拆分为 3-4 份。在市场经历宏观逆风、板块杀估值时，以当前价格（如 $75.68）为基准，向下每回撤 5%~10% 作为一个网格挂单分批吸筹。
卖出挂单（何时离场）： 不要设置一个“拍脑袋”的短期卖出目标价（比如 $85 或 $90）。你应当以“打脸/证伪条件”作为你的软/硬离场挂单线：
硬性警报线（杀逻辑）： 若 USDC 发行量同比增速跌破 50%，或者大行自发合规稳定币集体推出并对 Circle 形成实质性替代。一旦发生这种“杀逻辑”事件，不论什么价格，必须坚决清仓，不能对估值心存幻想。
估值过热（杀估值）： 如果短期内因为某项监管法案（如《清晰法案》）突然通过导致股价暴涨 50% 以上，预期透支，可以挂单止盈部分仓位，锁定利润。
总结： 不要把它当做投机工具去寻找日内完美的挂单点位。CRCL 的核心逻辑在于其作为“AI 时代金融清算网络”的超级潜力，建议首先评估自己的风险承受能力，在产业逻辑未发生颠覆性变化（USDC 增速 > 50%）的前提下，逢调整分批评估，长线持有。
~~~

Visible citation raw from user transcript:

~~~text
No competitor citation text was provided in the transcript. The attached screenshot shows the source-support panel placeholder rather than visible source cards for this answer.
~~~


### Case 4A Raw: Robindex Serenity CRCL Answer And Citations

Source chat: `c_dea1e9a7-aa07-40a5-bed5-c9ba16939d73`

Prompt:

> 最近你怎么看 CRCL，今天该不该买，我如果想买我应该在什么价格挂单，然后在什么价格挂单卖出？

Answer raw:

~~~markdown
$CRCL今天75.68，跌了5.34%。之前从$54一路涨到$108附近，现在回撤到这个位置，很多人又开始慌了。

直接说我的判断：

**今天该不该买？** 取决于你对USDC流通量和《Clarity Act》这两个核心变量的判断。

**挂单价？** 我不会给具体买卖点——我一贯不推荐具体动作。但我可以告诉你我看的是什么，然后你自己决定。

---

让我拆一下框架。

$CRCL本质上不是软件公司，不是支付公司，也不是传统金融公司。它是一个**基于USDC稳定币的利息收入机器** [13]。它的核心逻辑就三个变量：

1. **USDC流通量** — 印钞机开没开？
2. **利息费率环境** — 美联储利率走向
3. **监管政策** — 《Clarity Act》这种立法

3月初我喊$CRCL的时候，$54，USDC流通量还在$70B+ [12]。当时所有人都在抛售，但我说USDC的"printer keeps on going"，加上锁仓期结束，$19B MC是机会 [4]。结果一个月内涨了148% [5]。

现在的问题是：**USDC流通量有没有萎缩？利息环境有没有恶化？《Clarity Act》有没有实质性推进？**

从新闻看，全球银行机构刚对稳定币boom发出警告，数字欧元通过了议会投票。这些对$CRCL是负面情绪压制 [新闻1, 新闻2]。

更重要的是，《Clarity Act》这个立法，我之前就说过"extremely damaging" [15]。如果它真的推进，会直接压缩Circle的商业模式空间。

所以我的分析是：

**驱动的乐观因素** — USDC作为美元锚定稳定币，在加密货币生态里的地位依然稳固。$COIN和Circle的关系也没变，50%利息收入分成模式还在。

**压制的悲观因素** — 《Clarity Act》风险还没消除，利息费率预期在走低，情绪面现在很负面。从$100+跌到$75，说明早期获利盘在离场。

从定量看，$CRCL在$54时是$12B MC [12]，USDC流通量$70B+。现在价格$75，MC大概$17-18B。如果USDC流通量没有大幅增长（我目前没看到确切数字），那这个估值修复空间已经消耗了一部分。

如果你想买，你应该盯的是**USDC流通量数据**，而不是K线图 [6, 8]。流通量持续增长+《Clarity Act》不通过+利率环境稳定 = 这个价格有吸引力。反之就得谨慎。

我不建议现在追跌，也不要试图抄底猜最低点。如我之前说的，"没有人能100%预测短期走势"——但我能告诉你的是，**基本面变量比价格走势更重要**。

卖出点也一样：如果你的买入逻辑被破坏（比如《Clarity Act》通过、USDC大规模流出、或者MC涨回不合理估值比如再接近$COIN的一半）就走。如果逻辑还在，就持有。

我不会给出"买在X卖在Y"的公式，因为那不是我的风格。我的原则是提供方向和分析框架，让每个人自己得出判断。
~~~

Citation raw snippets (18):

#### T1 2025-09-16 https://x.com/aleabitoreddit/status/1968068563471897087

Tweet id: `1968068563471897087`

~~~text
Rant: this $CRCL chart is a great lesson on why TA means very little - fundamentals matter more.

When people were posting $BULL TA's at IPO, I was doing arbitrage between warrants and rolling my eyes. 

BULL went from $10 to $70+ but people were trading on 1% of float. When shares were unlocked, BULL went back to $10 IPO price.

For CRCL, we saw the rally from $31 IPO price to $200+ because people are trading on a limited float and MC was almost the same as $COIN. (which has 50% interest revenue sharing with Circle on top of their crypto exchange)

When 1.4m+ Circle shares had early unlock, the price crashed back down to $130.  If you ever see $CRCL at $200, it's an easy short Circle long Coinbaes play. 

The full 180 day lock up is December 2nd and you have another $10B+ USD of potential selling pressure in two months.  

I am bullish on USDC and Circle/Coin but with the existing business model it doesn't make sense that $CRCL should ever be worth more than 1/2 of $COIN today at $200 given how Stablecoin businesses like Tether make money off interest income. 

TA doesn't mean anything with upcoming share lockups.

Lesson: Float & fundamentals > lines on a chart.
~~~

#### T2 2025-12-01 https://x.com/aleabitoreddit/status/1995300647336612045

Tweet id: `1995300647336612045`

~~~text
So, this is partially true. However I’d argue the main reason for $CRCL ~50% drop was lockups and float dynamics, not just rate cuts. 

We saw this with $BULL ipo where it traded on 2% float upward of $50B and crashed back to $6B post lockup.

$CRCL was only trading with a limited float (~17%) if I remember correctly, and another 34M+ got unlocked recently.
~~~

#### T3 2026-03-09 https://x.com/aleabitoreddit/status/2031079292474650686

Tweet id: `2031079292474650686`

~~~text
$CRCL is now at $109. 

Circle has increased more than 100% to $109... Since my post at $54. 

This was 1 month ago. 

I really love going back and seeing all the bearish comments claiming it would

"Go down"50%" or "chart looks ugly" so it ends up at $20. 

Everyone on X was bearish on $CRCL at $50, but now that it's back at $100, people are bullish again. 

The market is the final arbiter of right and wrong. 

But the biggest lesson: Look at underlying fundamentals, not the chart.
~~~

#### T4 2025-12-09 https://x.com/aleabitoreddit/status/1998453391203389533

Tweet id: `1998453391203389533`

~~~text
Added very heavily in $TSM today ~$302.5.

Also added a decent amount in $CRCL positions at ~$87.2.

We’ve been chopping since record breaking earnings from $TSM just felt it would breakout anytime now. This is just gut feeling.

As for $CRCL rate cuts hurt, but the USDC printer keeps on going. Crypto also rebounding from Dec rate cut, and share unlock is done. 

So felt $19B MC was a good opportunity. I wanted to go long on Circle ever since IPO but never got the opportunity to until recently.
~~~

#### T5 2026-03-18 https://x.com/aleabitoreddit/status/2034166166676230238

Tweet id: `2034166166676230238`

~~~text
$CRCL is now up 148.15% in 1 month.

If people are wondering why my YTD is ~500%?

It’s because I look at fundamentals, not scribbles on a chart. 

The comment section back here aged like 2021 monkey JPEG prices. https://t.co/X5EH5SIrTP
~~~

Quoted tweet (aleabitoreddit): https://x.com/aleabitoreddit/status/2034166166676230238

~~~text
$CRCL is now up 148.15% in 1 month.

If people are wondering why my YTD is ~500%?

It’s because I look at fundamentals, not scribbles on a chart. 

The comment section back here aged like 2021 monkey JPEG prices. https://t.co/X5EH5SIrTP
~~~

#### T6 2026-03-03 https://x.com/aleabitoreddit/status/2028912096713511401

Tweet id: `2028912096713511401`

~~~text
$CRCL is a good lesson why fundamentals matter more than stock price/charts. 

Things to watch are USDC supply, interest rates, and Clarity Act.

Not whether or not sentiment is bad or if the XYZ TA says it’s going to $30.

Everyone on X was rushing to buy this at $200 but chickened out at $50.
~~~

#### T7 2026-02-25 https://x.com/aleabitoreddit/status/2026683292679024811

Tweet id: `2026683292679024811`

~~~text
I love going back in history to see how well the comment section ages.

$CRCL up 20% today. https://t.co/E47K80CRG4
~~~

Quoted tweet (aleabitoreddit): https://x.com/aleabitoreddit/status/2026683292679024811

~~~text
I love going back in history to see how well the comment section ages.

$CRCL up 20% today. https://t.co/E47K80CRG4
~~~

#### T8 2026-02-26 https://x.com/aleabitoreddit/status/2027068051749998875

Tweet id: `2027068051749998875`

~~~text
$CRCL... is now back up 53% in 3 weeks. 

$54 was the best chance to buy, not 50%+ later after earnings. 

Really hard to go against the sentiment sometimes. 

But for example, on: 

$CRCL - USDC circulating supply one of the top indicators I looked at despite the stock price tanking. 

$AXTI - 7N InP nonstandard on SMM. 

Alive lives within: the disconnect between stock prices and operational indicators. 

Sometimes, stock prices might reflect one thing, but the earnings and reality are another.
~~~

#### T9 2026-05-15 https://x.com/aleabitoreddit/status/2055409017003094402

Tweet id: `2055409017003094402`

~~~text
@Partfortynineg1 $54 x 2 =$108 with $CRCL https://t.co/2LaN9mX322
~~~

Quoted tweet (aleabitoreddit): https://x.com/aleabitoreddit/status/2055409017003094402

~~~text
@Partfortynineg1 $54 x 2 =$108 with $CRCL https://t.co/2LaN9mX322
~~~

#### T10 2026-05-14 https://x.com/aleabitoreddit/status/2055068788975157672

Tweet id: `2055068788975157672`

~~~text
Not a fan of $CBRS, especially at ~$90B-100B MC valuations.

But I do like the company.

There’s a lot of short term valuation disconnects with float dynamics after IPO as seen with $CRCL or $BULL though. 

So would not be surprised if it ends up trading at absurd valuations for a short time until things correct.
~~~

Quoted tweet (TheMarathon8320): https://x.com/TheMarathon8320/status/2055061193279287643

~~~text
@aleabitoreddit Are you buying crbs here?
~~~

#### T11 2026-03-17 https://x.com/aleabitoreddit/status/2033742384937549979

Tweet id: `2033742384937549979`

~~~text
@Sam_Badawi Still can’t believe everyone capitulated $CRCL back at $50… when USDC supply has only grown.
~~~

#### T12 2026-02-03 https://x.com/aleabitoreddit/status/2018724759262085467

Tweet id: `2018724759262085467`

~~~text
I really, really like $CRCL at $54. 

Valuation has been completely reset back to $12B MC. 

Everyone was rushing to buy it back at $150-200 but at $54, it's a ghost town. USDC supply still $70B+ and I expect stablecoins to continue growing in usage. https://t.co/R2Habycf7d
~~~

Quoted tweet (aleabitoreddit): https://x.com/aleabitoreddit/status/2018724759262085467

~~~text
I really, really like $CRCL at $54. 

Valuation has been completely reset back to $12B MC. 

Everyone was rushing to buy it back at $150-200 but at $54, it's a ghost town. USDC supply still $70B+ and I expect stablecoins to continue growing in usage. https://t.co/R2Habycf7d
~~~

#### T13 2026-02-27 https://x.com/aleabitoreddit/status/2027406294425178336

Tweet id: `2027406294425178336`

~~~text
$CRCL is not put in the software bucket. You can't vibe code US based stablecoins because it's highly regulated. 

The selloff was mainly do to broader digital asset sentiment, clarity act interest rate (proxies to exchanges like $COIN where ppl keep USDC deposits), and potential rate cuts.

I just found circulating supply was the same above ~$70B despite the stock selling off 50%+ and found $CRCL at $54 to be highly attractive. 

That being said I am long Circle for the long run because I do think USDC is a money printer.
~~~

#### T14 2026-03-07 https://x.com/aleabitoreddit/status/2030293869250965799

Tweet id: `2030293869250965799`

~~~text
@101010_jv Ayden - $33B
$PYPL - $43B
$HOOD - $69B
$CRCL - $23B

33+43+69+23. You can literally put together all the leaders in Fintech for around the same price as Stripe.
~~~

#### T15 2026-03-24 https://x.com/aleabitoreddit/status/2036479336572920037

Tweet id: `2036479336572920037`

~~~text
@DigestingX Clarity Act is extremely damaging for $CRCL. still looking into the legislation right now
~~~

#### T16 2026-03-10 https://x.com/aleabitoreddit/status/2031203334984790095

Tweet id: `2031203334984790095`

~~~text
@LOGOinvestor Thanks, $CRCL ended up being free real estate.

Don’t need a substack when I can post all my ideas for free here on X!
~~~

#### T17 2026-02-03 https://x.com/aleabitoreddit/status/2018732315166618047

Tweet id: `2018732315166618047`

~~~text
@AI_PowerFlow We did see -$4B outflows from $73B -&gt; $69B from last month (hence the drop) but largely priced into $CRCL stock price. https://t.co/9kAZXxSald
~~~

Quoted tweet (aleabitoreddit): https://x.com/aleabitoreddit/status/2018732315166618047

~~~text
@AI_PowerFlow We did see -$4B outflows from $73B -&gt; $69B from last month (hence the drop) but largely priced into $CRCL stock price. https://t.co/9kAZXxSald
~~~

#### T18 2026-02-03 https://x.com/aleabitoreddit/status/2018730306229186887

Tweet id: `2018730306229186887`

~~~text
@Kevin60162526 FinX with $CRCL in a nutshell. https://t.co/i5NxQFmJ7D
~~~

Quoted tweet (aleabitoreddit): https://x.com/aleabitoreddit/status/2018730306229186887

~~~text
@Kevin60162526 FinX with $CRCL in a nutshell. https://t.co/i5NxQFmJ7D
~~~

### Case 4B Raw: Competitor Serenity CRCL Answer And Visible Citations

Source URL provided by user: `https://www.themarketbrew.com/research?agent=kol&persona=aleabitoreddit`

Prompt:

> 最近你怎么看 CRCL，今天该不该买，我如果想买我应该在什么价格挂单，然后在什么价格挂单卖出？

Answer raw from user transcript:

~~~markdown
1. 核心定位与白话结论
Circle (NYSE: CRCL) 是加密金融与稳定币支付生态的物理咽喉（底层结算基建），绝非短期炒作的 Meme 币概念股 [[#5]](https://x.com/aleabitoreddit/status/2028912096713511401)。

对于**“今天该不该买、在什么价格挂单”**：

白话结论：当前的 CRCL 处于高信念击球区。股价从今年 3 月的 $109 高点 [[#4]](https://x.com/aleabitoreddit/status/2031079292474650686) 回调至目前的 $75.68，估值重回相对舒适的区间。如果你是认同稳定币基础设施长期逻辑的投资者，当前价格分批评估是合理的，建议将第一笔挂单设在 $74.70 - $75.60 之间（日线级别强支撑位附近）；如果市场出现情绪性抛售，可在 $65.00 - $66.00 挂单二次补仓。
卖出策略：在基本面没有逻辑破裂的前提下，中短期获利挂单可以设在 $105 - $110（前高阻力区间，对应 3 月高点 [[#4]](https://x.com/aleabitoreddit/status/2031079292474650686)）；长期可作为底仓持有，静待稳定币法案通过与 AI 代理微支付的全面爆发 [[#5]](https://x.com/aleabitoreddit/status/2028912096713511401) 和 [[#6]](https://x.com/aleabitoreddit/status/2034559475533910175)。
2. 支撑原始判断的关键理由
根据方法论，评估 CRCL 的价值，要看以下三大底层事实与趋势，而非纠结于短期的日 K 线波动 [[#5]](https://x.com/aleabitoreddit/status/2028912096713511401)：

① USDC 规模与利差的“前瞻错配” [[#5]](https://x.com/aleabitoreddit/status/2028912096713511401)
Circle 的核心商业模式是吸收无息（或极低息）的 USDC 存款，并将其投资于短期美债及高流动性资产，赚取几乎无风险的利差。

目前 USDC 的流通规模维持在 $700 亿以上的高位 [[#2]](https://x.com/aleabitoreddit/status/2018724759262085467)。
市场往往用一般的“支付公司”或“金融科技”对它进行低估定价，但只要美联储利率维持在相对高位，USDC 的庞大池子就是源源不断的现金流印钞机。
② AI 代理微支付（Micropayments）的终极咽喉 [[#6]](https://x.com/aleabitoreddit/status/2034559475533910175)
在 AI 代理（AI Agents）进行跨平台自动化交易时，传统信用卡网络（如 Visa、Mastercard）因其高额的通道费（Interchange Fees）和繁琐的清算时间，无法承载小额、高频的资金往来。

事实支撑：根据 Circle 披露的数据，在过去 9 个月里，AI 代理通过 USDC 完成了 1.4 亿笔微支付，平均每笔金额仅为 $0.31 [[#6]](https://x.com/aleabitoreddit/status/2034559475533910175)。这在传统卡网络上是根本无法盈利且不现实的。
CRCL 正在结构性地颠覆传统卡网络，成为 AI 时代机器与机器之间结算的物理咽喉 [[#6]](https://x.com/aleabitoreddit/status/2034559475533910175)。
③ 情绪驱动的估值重置机会 [[#2]](https://x.com/aleabitoreddit/status/2018724759262085467)
在博主的方法论中，优秀的标的往往会在“大家都想买时贵得离谱（如 IPO 初期或暴涨至 $150-200），而在回调时无人问津” [[#2]](https://x.com/aleabitoreddit/status/2018724759262085467)。

之前 CRCL 跌至 $54 时市场情绪极度恐慌，博主明确指出估值已重置到合理的 $120 亿市值 [[#2]](https://x.com/aleabitoreddit/status/2018724759262085467)，随后股价成功反弹超 100% 至 $109 [[#4]](https://x.com/aleabitoreddit/status/2031079292474650686)。
如今从 $109 回撤至 $75.68，RSI 指标已回落至 34.96（逼近超卖区），属于情绪退潮后的高信念左侧分批买入窗口。
3. 具体挂单交易操作建议
免责声明：以下仅为基于方法论和当前技术面支撑位的客观拆解，不构成直接的投资及买卖指令。具体入场请结合自身风险承受能力与杠杆情况。

🟢 买入挂单区间（Buy Orders）
利用分批挂单法来对冲大盘的短期波动：

第一档建仓单（$74.70 - $75.50）：
逻辑：技术指标显示，CRCL 当前日线强支撑位 1 在 $74.73。目前价格 $75.68 距离该位置极近，适合在此处挂入首笔基础仓位，防范价格直接缩量企稳反弹。
第二档安全垫单（$65.00 - $66.00）：
逻辑：技术面强支撑位 2 在 $64.92。若遭遇大盘系统性去杠杆、宏观地缘噪音或散户恐慌，股价可能惯性下探。在此区间挂单可以有效摊低成本，且非常接近之前博主强烈看好的 $54 铁底区间 [[#2]](https://x.com/aleabitoreddit/status/2018724759262085467)。
🔴 卖出/分批止盈挂单区间（Sell Orders）
短期/波段止盈（$105.00 - $109.00）：
逻辑：前高阻力区（3 月高点 $109 附近 [[#4]](https://x.com/aleabitoreddit/status/2031079292474650686)）。当基本面利好兑现、市场情绪重新狂热时，可在该区间挂单锁定 40% 以上的波段利润。
中长期持有（$130 - $150+）：
逻辑：如果美国《清晰稳定币法案》（Clarity for Payment Stablecoins Act）获得通过 [[#5]](https://x.com/aleabitoreddit/status/2028912096713511401)，或者 AI 代理微支付的规模呈现指数级暴涨，机构资金将不得不被动追认这只独一无二的合规稳定币基建标的。此时估值将彻底 re-rating（重估）。
4. 关键打脸条件与观察信号
高信念不等于盲目死守。如果出现以下信号，该交易逻辑必须下修：

基本面指标恶化：USDC 的流通供应量（Supply）出现结构性萎缩（例如跌破 $500 亿），说明其市场份额正在被 USDT 或其他银行合规稳定币大幅蚕食 [[#2]](https://x.com/aleabitoreddit/status/2018724759262085467) 和 [[#5]](https://x.com/aleabitoreddit/status/2028912096713511401)。
宏观变局（利率暴跌）：如果美联储出现恐慌性降息、利率迅速归零，这将直接重创 Circle 账面美债的利息收入收入捕获能力。
政策法案受阻：关于稳定币监管的《清晰法案》（Clarity Act）在立法层面遭遇毁灭性推迟，导致机构级资金无法合规接入 [[#5]](https://x.com/aleabitoreddit/status/2028912096713511401)。
~~~

Visible citation raw from user transcript (6):

#### C1 2026-03-19 https://x.com/aleabitoreddit/status/2034559475533910175

~~~text
I’m surprised markets aren’t pricing in long term disruption of card networks + interchange like $V and $MA.

By $CRCL and $COIN.

From Global Markets Head at Circle:

"Over the past nine months, AI agents completed 140 million payments with a total transaction volume of 43 milli...
~~~

#### C2 2026-03-10 https://x.com/aleabitoreddit/status/2031079292474650686

~~~text
$CRCL is now at $109. 

Circle has increased more than 100% to $109... Since my post at $54. 

This was 1 month ago. 

I really love going back and seeing all the bearish comments claiming it would

"Go down"50%" or "chart looks ugly" so it ends up at $20. 

Everyone on X was bea...
~~~

#### C3 2026-03-04 https://x.com/aleabitoreddit/status/2028912096713511401

~~~text
$CRCL is a good lesson why fundamentals matter more than stock price/charts. 

Things to watch are USDC supply, interest rates, and Clarity Act.

Not whether or not sentiment is bad or if the XYZ TA says it’s going to $30.

Everyone on X was rushing to buy this at $200 but chicke...
~~~

#### C4 2026-02-04 https://x.com/aleabitoreddit/status/2018724759262085467

~~~text
I really, really like $CRCL at $54. 

Valuation has been completely reset back to $12B MC. 

Everyone was rushing to buy it back at $150-200 but at $54, it's a ghost town. USDC supply still $70B+ and I expect stablecoins to continue growing in usage. https://t.co/R2Habycf7d
~~~

#### C5 2025-12-21 https://x.com/aleabitoreddit/status/2002688753710887007

~~~text
amount of funding pour into USDC-related companies: whether that's Stablecoin Neobanks (banks like Mecury, just powered by USDC) or settlement infrastructure with USDC.

And of course many public-news about private sector acquisitions such as Stripe acquisition of bridge for $1.1...
~~~

#### C6 2025-09-17 https://x.com/aleabitoreddit/status/1968068563471897087

~~~text
Rant: this $CRCL chart is a great lesson on why TA means very little - fundamentals matter more.

When people were posting $BULL TA's at IPO, I was doing arbitrage between warrants and rolling my eyes. 

BULL went from $10 to $70+ but people were trading on 1% of float. When shar...

$CRCL is a $200 stock trading at $130.

Has a similar business model to Tether, which is stupidly profitable &amp; does $90M per employee(!!...
~~~
