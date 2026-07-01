import assert from "node:assert/strict";
import { build } from "esbuild";
import { pathToFileURL } from "node:url";

const outfile = `/tmp/robindex-finance-test-${process.pid}.mjs`;
await build({
  entryPoints: [new URL("../src/finance.ts", import.meta.url).pathname],
  outfile,
  bundle: true,
  platform: "browser",
  format: "esm",
});
const { parseQuoteLine } = await import(pathToFileURL(outfile).href);

const fields = Array(68).fill("");
fields[0] = "200";
fields[1] = "达泰莱";
fields[2] = "DRAM.AM";
fields[3] = "71.51";
fields[4] = "71.88";
fields[5] = "70.78";
fields[6] = "56659255";
fields[30] = "2026-06-29 15:19:59";
fields[33] = "71.69";
fields[34] = "66.47";
fields[35] = "USD";
fields[46] = "Roundhill Etf Trust Memory Etf";
fields[56] = "GP-ETF";
const dram = parseQuoteLine("usDRAM", `v_usDRAM="${fields.join("~")}"`);
assert.equal(dram?.name, "Roundhill Memory ETF");
assert.equal(dram?.canonicalName, "Roundhill Memory ETF");
assert.equal(dram?.assetType, "etf");
assert.equal(dram?.exchange, "AM");

const equityFields = [...fields];
equityFields[1] = "苹果";
equityFields[2] = "AAPL.OQ";
equityFields[46] = "Apple Inc";
equityFields[56] = "GP";
const equity = parseQuoteLine("usAAPL", `v_usAAPL="${equityFields.join("~")}"`);
assert.equal(equity?.name, "Apple Inc");
assert.equal(equity?.assetType, "equity");

console.log("Finance identity tests passed");
