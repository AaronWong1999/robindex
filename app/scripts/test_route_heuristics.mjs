import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";

const sourcePath = join(process.cwd(), "src/route-heuristics.ts");
const source = await readFile(sourcePath, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

assert.equal(mod.isLikelyCorpusOnlyQuestion("怎么看 AI 泡沫？请用 Qinbafrank 的框架回答。"), true);
assert.equal(mod.isLikelyCorpusOnlyQuestion("SPCX 这波走势怎么看？"), false);
assert.equal(mod.isLikelyCorpusOnlyQuestion("中际旭创现在该不该买？"), false);

const fallback = mod.fallbackQuickPlan("怎么看 AI 泡沫？");
assert.equal(fallback.route, "quick");
assert.equal(fallback.needs_tools, false);
assert.ok(fallback.concepts.some((x) => x.includes("泡沫") || x.toLowerCase() === "ai"));

console.log("Route heuristic tests passed");
