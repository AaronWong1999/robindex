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

console.log("Prompt format tests passed");
