// Load qinbafrank corpus (tweets + persona pack) into the deployed Worker.
// Usage: BASE=... ADMIN_KEY=... node load_qinbafrank.mjs
import fs from "node:fs";
const BASE = process.env.BASE || "https://robindex.ai";
const ADMIN_KEY = process.env.ADMIN_KEY;
const TWEETS = process.env.TWEETS || "/tmp/qf_tweets.json";
const PERSONA = process.env.PERSONA || "/Users/aaron/Desktop/aaron/robindex/app/personas/qinbafrank.md";
if (!ADMIN_KEY) throw new Error("ADMIN_KEY required");

const H = { "Content-Type": "application/json", "x-admin-key": ADMIN_KEY };
const post = async (path, body) => {
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(BASE + path, { method: "POST", headers: H, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
      return await r.json();
    } catch (e) { if (a === 2) throw e; await new Promise((res) => setTimeout(res, 1500)); }
  }
};

const EMBED = (process.env.EMBED ?? "true") !== "false";
const persona = fs.readFileSync(PERSONA, "utf8");
const all = JSON.parse(fs.readFileSync(TWEETS, "utf8"));
const rows = all.filter((t) => !t.is_retweet && t.text);
const lastId = all.map((t) => BigInt(t.id)).reduce((a, b) => (b > a ? b : a), 0n).toString();

await post("/api/admin/kol", {
  id: "qinbafrank",
  display_name: "Qinbafrank",
  handle: "qinbafrank",
  twitter_uid: "1338075202798809089",
  avatar_url: "https://pbs.twimg.com/profile_images/1453864539720601606/rEHaWNk1_400x400.jpg",
  tagline: "AI 大趋势 / 宏观传导 / 全球流动性与周期",
  persona_pack: persona,
  persona_version: new Date().toISOString().slice(0, 10),
  last_tweet_id: lastId,
});
console.log("KOL upserted. lastId:", lastId, "tweets:", rows.length);

const B = 100;
let done = 0, emb = 0;
for (let i = 0; i < rows.length; i += B) {
  const r = await post("/api/admin/tweets", { kol_id: "qinbafrank", embed: EMBED, tweets: rows.slice(i, i + B) });
  done += r.inserted; emb += r.embedded;
  console.log(`tweets ${Math.min(i + B, rows.length)}/${rows.length} (emb ${emb})`);
}
console.log("DONE:", done, "embedded:", emb);
const stats = await fetch(BASE + "/api/admin/stats", { headers: { "x-admin-key": ADMIN_KEY } }).then((r) => r.json());
console.log("STATS:", JSON.stringify(stats.tweets));
