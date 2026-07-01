import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const evalSource = readFileSync(new URL("../src/eval.ts", import.meta.url), "utf8");
const rag = readFileSync(new URL("../src/rag.ts", import.meta.url), "utf8");
const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");
const systemLlm = readFileSync(new URL("../src/system-llm.ts", import.meta.url), "utf8");
const personaDistill = readFileSync(new URL("../src/persona-distill.ts", import.meta.url), "utf8");
const personaGen = readFileSync(new URL("../src/persona-gen.ts", import.meta.url), "utf8");
const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");

assert(!wrangler.includes('"30 9 * * 1"'), "weekly model cron must stay disabled");
assert(!wrangler.includes('"0 10 1 * *"'), "monthly full-rebuild cron must stay disabled");
assert(!index.includes("automatic retry after failed update"), "failed persona jobs must not auto-revive");
assert(index.includes("passRate >= 0.65"), "candidate gate must enforce per-case pass rate");
assert(index.includes("steps > 120"), "distill jobs need a hard Worker-step budget");
assert(evalSource.includes("opts.realQa ?? 8"), "eval set must stay compact");
assert(evalSource.includes("opts.synth ?? 4"), "synthetic eval set must stay compact");
assert(evalSource.includes("judgeQualityBatch"), "background eval should use one combined judge");
assert(evalSource.includes("skipLlmRerank: true"), "background eval must avoid paid LLM reranking");
assert(evalSource.includes("answer_text=?"), "eval answers must be persisted for audit");
assert(readFileSync(new URL("../src/persona-distill.ts", import.meta.url), "utf8").includes("chunks.length > 96"),
  "full-corpus map needs a hard chunk budget");
assert(rag.includes("source NOT LIKE 'persona_backup:%'"), "persona backups must never enter RAG");
assert(rag.includes("let remaining = 6000"), "knowledge context needs a total character budget");
assert(chat.includes("reasoning: { enabled: false }"), "background completions must disable paid reasoning");
assert(systemLlm.includes("api.deepseek.com"), "system client must target DeepSeek official API");
assert(systemLlm.includes('thinking: { type: opts.thinking ? "enabled" : "disabled" }'),
  "system calls must explicitly control thinking");
assert(!personaDistill.includes("env.GATEWAY_URL"), "persona distill must not use OpenRouter gateway");
assert(!personaGen.includes("env.GATEWAY_URL"), "persona generation must not use OpenRouter gateway");

console.log("Eval safety tests passed");
