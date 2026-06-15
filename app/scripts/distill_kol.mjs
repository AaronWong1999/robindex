// Generalized KOL distiller — drafts a Persona Pack v2 + knowledge chunks from a tweet corpus, for
// HUMAN REVIEW before activation (anti-drift: we never auto-mutate a live persona). API + RAG only, no
// fine-tuning. Outputs:
//   personas/<id>.draft.md            (review, then save as personas/<id>.md)
//   personas/<id>.knowledge.draft.json (review, then POST to /api/admin/knowledge)
//
// Usage:
//   KOL_ID=qinbafrank NAME="Qin Bafrank" HANDLE=qinbafrank TWEETS=tweets/qinbafrank_tweets.json \
//   OPENROUTER_KEY=sk-... node scripts/distill_kol.mjs
//
// Gateway creds: reads CFGATEWAY (compat URL) + CFGATEWAYKEY from env or ../account.guard.json;
// OPENROUTER_KEY must be provided via env (it is a Worker secret, not stored locally).
import fs from "node:fs";
import path from "node:path";

const ID = process.env.KOL_ID;
const NAME = process.env.NAME || ID;
const HANDLE = process.env.HANDLE || ID;
const TWEETS = process.env.TWEETS;
if (!ID || !TWEETS) throw new Error("KOL_ID and TWEETS are required");

const here = path.dirname(new URL(import.meta.url).pathname);
const appDir = path.resolve(here, "..");
const guardPath = path.resolve(appDir, "..", "account.guard.json");
const guard = fs.existsSync(guardPath) ? JSON.parse(fs.readFileSync(guardPath, "utf8")) : {};
const GATEWAY = process.env.CFGATEWAY || guard.CFGATEWAY;
const GATEWAYKEY = process.env.CFGATEWAYKEY || guard.CFGATEWAYKEY;
const OPENROUTER_KEY = process.env.OPENROUTER_KEY || "";
const MODEL = process.env.MODEL || "deepseek/deepseek-v4-pro";
if (!GATEWAY || !GATEWAYKEY) throw new Error("CFGATEWAY/CFGATEWAYKEY missing");

const template = fs.readFileSync(path.resolve(appDir, "personas", "_TEMPLATE.md"), "utf8");

// Build a representative corpus: top tweets by engagement + most recent, deduped, capped.
const all = JSON.parse(fs.readFileSync(path.resolve(appDir, TWEETS), "utf8"));
const tweets = all.filter((t) => !t.isRetweet && (t.text || t.full_text));
const score = (t) => (t.metrics?.likes || t.likeCount || 0) + (t.metrics?.views || t.viewCount || 0) / 50;
const byEngagement = [...tweets].sort((a, b) => score(b) - score(a)).slice(0, 240);
const byRecent = [...tweets]
  .sort((a, b) => new Date(b.createdAtISO || b.createdAt || 0) - new Date(a.createdAtISO || a.createdAt || 0))
  .slice(0, 120);
const seen = new Set();
const sample = [];
for (const t of [...byEngagement, ...byRecent]) {
  const id = String(t.id || t.id_str || "");
  if (seen.has(id)) continue;
  seen.add(id);
  const date = (t.createdAtISO || t.createdAt || "").slice(0, 10);
  sample.push(`(${date}) ${t.text || t.full_text}`);
}
const corpus = sample.join("\n").slice(0, 24000);

async function complete(system, user, maxTokens = 3200) {
  // Governor auth is required; provider key only when present (gateway has BYOK, empty Bearer 401s).
  const headers = { "Content-Type": "application/json", "cf-aig-authorization": `Bearer ${GATEWAYKEY}` };
  if (OPENROUTER_KEY) headers.Authorization = `Bearer ${OPENROUTER_KEY}`;
  const res = await fetch(GATEWAY, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: MODEL, messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ], temperature: 0.3, max_tokens: maxTokens }),
  });
  if (!res.ok) throw new Error(`gateway ${res.status}: ${await res.text()}`);
  const j = await res.json();
  return j.choices?.[0]?.message?.content || "";
}

// 1) Persona Pack v2
const personaSys =
  "You distill a finance KOL into a Persona Pack v2. Follow the provided template's sections EXACTLY. " +
  "Distill ONLY from the supplied posts. A claim is a Mental Model only if it is cross-domain AND generative " +
  "AND exclusive; weaker claims become Decision Heuristics. Preserve contradictions; never invent numbers, " +
  "positions, or dated examples not supported by the posts. Output GitHub-flavored markdown, no preamble.";
const personaUser = `KOL: ${NAME} (@${HANDLE}), id=${ID}\n\n=== TEMPLATE ===\n${template}\n\n=== POSTS ===\n${corpus}`;
console.error("Distilling persona pack...");
const persona = await complete(personaSys, personaUser, 3600);
const draftMd = path.resolve(appDir, "personas", `${ID}.draft.md`);
fs.writeFileSync(draftMd, persona);
console.error("wrote", draftMd);

// 2) Knowledge chunks (methodology / theses / track-record) as reviewable JSON.
const knowSys =
  "From the posts, produce a JSON array of 3 knowledge chunks for a retrieval base: one each with " +
  '"source" of "methodology", "theses", "track-record". Each item: {source, title, text}. ' +
  "text is 200-500 words, factual, third person, distilled only from the posts. Output ONLY the JSON array.";
console.error("Distilling knowledge chunks...");
const knowRaw = await complete(knowSys, `KOL: ${NAME}\n\n=== POSTS ===\n${corpus}`, 3000);
let chunks;
try {
  chunks = JSON.parse(knowRaw.replace(/^[^[]*?(\[)/, "$1").replace(/[^\]]*$/, ""));
} catch {
  chunks = [{ source: "raw", title: "unparsed", text: knowRaw }];
}
const withIds = chunks.map((c, i) => ({ id: `${ID}:${c.source}:${i}`, ...c }));
const draftJson = path.resolve(appDir, "personas", `${ID}.knowledge.draft.json`);
fs.writeFileSync(draftJson, JSON.stringify({ kol_id: ID, embed: true, chunks: withIds }, null, 2));
console.error("wrote", draftJson);
console.error("\nReview the drafts, then: save .draft.md as personas/" + ID + ".md and POST the knowledge JSON to /api/admin/knowledge.");
