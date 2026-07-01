import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";

const source = await readFile(join(process.cwd(), "src/onboarding-access.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

for (const [input, expected] of [
  ["https://x.com/wufantouzi", "wufantouzi"],
  ["https://twitter.com/WuFanTouZi/?s=20", "wufantouzi"],
  ["@shufen46250836", "shufen46250836"],
  ["qinbafrank", "qinbafrank"],
]) {
  assert.equal(mod.normalizeTwitterHandle(input), expected);
}
for (const invalid of [
  "https://example.com/qinbafrank",
  "https://x.com/qinbafrank/status/123",
  "https://x.com/search?q=test",
  "has space",
  "",
]) {
  assert.throws(() => mod.normalizeTwitterHandle(invalid));
}

const env = { KOL_ONBOARD_INVITE_SECRET: "a".repeat(64) };
const request = new Request("https://app.robindex.ai/add-kol", {
  headers: { "cf-connecting-ip": "203.0.113.8" },
});
const issued = await mod.issueInviteSession(env, request);
assert.match(issued.cookie, /HttpOnly/);
assert.match(issued.cookie, /SameSite=Strict/);
const cookie = issued.cookie.split(";")[0];
const restored = await mod.readInviteSession(env, new Request("https://app.robindex.ai/add-kol", {
  headers: { cookie, "cf-connecting-ip": "203.0.113.8" },
}));
assert.equal(restored.id, issued.session.id);
assert.equal(restored.sessionHash, issued.session.sessionHash);
assert.equal(restored.ipHash, issued.session.ipHash);
assert.equal(await mod.readInviteSession({ KOL_ONBOARD_INVITE_SECRET: "b".repeat(64) }, new Request(
  "https://app.robindex.ai/add-kol", { headers: { cookie } },
)), null);

assert.equal(mod.validSameOrigin(new Request("https://app.robindex.ai/api/onboarding/submit", {
  headers: { origin: "https://app.robindex.ai" },
})), true);
assert.equal(mod.validSameOrigin(new Request("https://app.robindex.ai/api/onboarding/submit", {
  headers: { origin: "https://evil.example" },
})), false);

console.log("Onboarding access tests passed");
