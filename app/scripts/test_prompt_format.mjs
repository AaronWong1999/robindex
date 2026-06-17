import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";

const sourcePath = join(process.cwd(), "src/source-format.ts");
const source = await readFile(sourcePath, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

const withQuote = mod.sourceTweetForPrompt({
  ref: "T7",
  date: "2026-06-17",
  snippet: "这个订单如果兑现，逻辑就不是短炒。",
  quoted: {
    handle: "company",
    date: "2026-06-16",
    text: "We signed a multi-year AI infrastructure contract.",
  },
});

assert.match(withQuote, /^\[T7\] \(2026-06-17\) KOL tweet: /);
assert.match(withQuote, /Quoted context \(@company 2026-06-16\): We signed a multi-year AI infrastructure contract\./);

const withoutQuote = mod.sourceTweetForPrompt({
  ref: "T2",
  date: "2025-12-01",
  snippet: "先看流动性，再看产业，再看个股。",
});

assert.equal(withoutQuote, "[T2] (2025-12-01) KOL tweet: 先看流动性，再看产业，再看个股。");

const chatPrompt = await readFile(join(process.cwd(), "src/chat.ts"), "utf8");
assert.doesNotMatch(chatPrompt, /You ARE/);
assert.doesNotMatch(chatPrompt, /Stay 100% in character/);
assert.match(chatPrompt, /do not claim to be the KOL/);
assert.match(chatPrompt, /Do not use first person on behalf of the KOL/);
assert.match(chatPrompt, /never invent alternate spellings/);

const finalPrompt = await readFile(join(process.cwd(), "src/index.ts"), "utf8");
assert.match(finalPrompt, /原文是否直接提到/);
assert.match(finalPrompt, /不要冒充博主本人/);
assert.match(finalPrompt, /不要用“我的框架\/我认为\/我多次说\/我发过”/);
assert.ok(finalPrompt.includes(".replace(/[（(]\\s*(T\\d+)\\s*[）)]/g"));
assert.ok(finalPrompt.includes(".replace(/(^|[^\\[\\w])\\b(T\\d+)\\b"));
assert.match(finalPrompt, /不要把旧原文当成当前实时观点/);

console.log("Prompt format tests passed");
