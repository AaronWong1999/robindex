// Bulk-load the aleabitoreddit corpus into the deployed Worker.
// Usage: BASE=https://robindex.waaron1999.workers.dev ADMIN_KEY=xxx node load_aleabitoreddit.mjs
import fs from "node:fs";

const BASE = process.env.BASE || "https://robindex.waaron1999.workers.dev";
const ADMIN_KEY = process.env.ADMIN_KEY;
const TWEETS = process.env.TWEETS || "/tmp/tweets.json";
const ALE_DIR = process.env.ALE_DIR || "/tmp/ale";
const PERSONA = process.env.PERSONA || "/Users/aaron/Desktop/aaron/robindex/app/personas/aleabitoreddit.md";
if (!ADMIN_KEY) throw new Error("ADMIN_KEY required");

const H = { "Content-Type": "application/json", "x-admin-key": ADMIN_KEY };
const post = async (path, body) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(BASE + path, { method: "POST", headers: H, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
      return await r.json();
    } catch (e) {
      if (attempt === 2) throw e;
      await new Promise((res) => setTimeout(res, 1500));
    }
  }
};

// ---- 1) KOL row + persona pack ----
const persona = fs.readFileSync(PERSONA, "utf8");
const all = JSON.parse(fs.readFileSync(TWEETS, "utf8"));
const avatar = (all[0]?.author?.profileImageUrl || "").replace("_normal", "_400x400");
const lastId = all.map((t) => t.id).sort((a, b) => (a.length - b.length) || (a < b ? -1 : 1)).pop();

await post("/api/admin/kol", {
  id: "aleabitoreddit",
  display_name: "Serenity",
  handle: "aleabitoreddit",
  twitter_uid: "1940360837547565056",
  avatar_url: avatar,
  tagline: "AI / 半导体供应链瓶颈猎手 · 白毛股神",
  persona_pack: persona,
  persona_version: new Date().toISOString().slice(0, 10),
  last_tweet_id: lastId,
});
console.log("KOL upserted. avatar:", avatar, "lastId:", lastId);

// ---- 2) Knowledge chunks from md files ----
function chunkMarkdown(text, sourceBase) {
  const lines = text.split("\n");
  const chunks = [];
  let title = sourceBase, buf = [];
  const flush = () => {
    const body = buf.join("\n").trim();
    if (body.length > 40) {
      // split overly long sections by paragraph
      if (body.length <= 1800) chunks.push({ title, text: body });
      else {
        let part = [], len = 0, n = 0;
        for (const para of body.split(/\n\n+/)) {
          if (len + para.length > 1600 && part.length) {
            chunks.push({ title: `${title} (${++n})`, text: part.join("\n\n") });
            part = []; len = 0;
          }
          part.push(para); len += para.length;
        }
        if (part.length) chunks.push({ title: `${title} (${++n})`, text: part.join("\n\n") });
      }
    }
    buf = [];
  };
  for (const ln of lines) {
    const m = ln.match(/^##\s+(.*)/);
    if (m) { flush(); title = m[1].trim(); } else buf.push(ln);
  }
  flush();
  return chunks;
}

const kfiles = {
  methodology: "serenity-aleabitoreddit_references_methodology.md",
  theses: "serenity-aleabitoreddit_references_theses.md",
  "track-record": "serenity-aleabitoreddit_references_track-record.md",
  articles: "serenity-aleabitoreddit_references_articles.md",
  "analysis:2025-07_to_09": "serenity-aleabitoreddit_analysis_2025-07_to_09.md",
  "analysis:2025-10_to_11": "serenity-aleabitoreddit_analysis_2025-10_to_11.md",
  "analysis:2025-12_to_2026-01": "serenity-aleabitoreddit_analysis_2025-12_to_2026-01.md",
  "analysis:2026-02": "serenity-aleabitoreddit_analysis_2026-02.md",
  "analysis:2026-03": "serenity-aleabitoreddit_analysis_2026-03.md",
  "analysis:2026-04_to_05": "serenity-aleabitoreddit_analysis_2026-04_to_05.md",
};
let allChunks = [];
for (const [source, fname] of Object.entries(kfiles)) {
  const p = `${ALE_DIR}/${fname}`;
  if (!fs.existsSync(p)) { console.log("missing", p); continue; }
  const txt = fs.readFileSync(p, "utf8");
  const cs = chunkMarkdown(txt, source);
  cs.forEach((c, i) => allChunks.push({ id: `aleabitoreddit:${source}:${i}`, source, title: c.title, text: c.text }));
}
console.log("knowledge chunks:", allChunks.length);
for (let i = 0; i < allChunks.length; i += 20) {
  const r = await post("/api/admin/knowledge", { kol_id: "aleabitoreddit", embed: true, chunks: allChunks.slice(i, i + 20) });
  console.log(`knowledge ${i}-${i + 20}:`, r.inserted, "emb", r.embedded);
}

// ---- 3) Tweets (skip pure retweets) ----
const rows = all
  .filter((t) => !t.isRetweet && t.text)
  .map((t) => ({
    id: t.id,
    text: t.text,
    created_at_iso: t.createdAtISO || "",
    created_at_ts: t.createdAtISO ? Math.floor(new Date(t.createdAtISO).getTime() / 1000) : 0,
    is_retweet: 0,
    lang: t.lang || "",
    likes: t.metrics?.likes || 0,
    retweets: t.metrics?.retweets || 0,
    replies: t.metrics?.replies || 0,
    quotes: t.metrics?.quotes || 0,
    views: t.metrics?.views || 0,
    urls: t.urls || [],
    media: t.media || [],
  }));
console.log("tweets to load:", rows.length);
const B = 100;
let done = 0, emb = 0;
for (let i = 0; i < rows.length; i += B) {
  const r = await post("/api/admin/tweets", { kol_id: "aleabitoreddit", embed: true, tweets: rows.slice(i, i + B) });
  done += r.inserted; emb += r.embedded;
  if (i % 1000 === 0 || i + B >= rows.length) console.log(`tweets ${i + B}/${rows.length} (emb ${emb})`);
}
console.log("DONE tweets:", done, "embedded:", emb);

const stats = await fetch(BASE + "/api/admin/stats", { headers: { "x-admin-key": ADMIN_KEY } }).then((r) => r.json());
console.log("STATS:", JSON.stringify(stats));
