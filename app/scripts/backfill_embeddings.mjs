// Backfill bge-m3 embeddings for a KOL's unembedded tweets, in chunks, until quota
// is hit or nothing remains. Resumable: re-run on later days as Workers AI quota resets.
// Usage: ADMIN_KEY=.. KOL=qinbafrank node backfill_embeddings.mjs
const BASE = process.env.BASE || "https://robindex.ai";
const ADMIN_KEY = process.env.ADMIN_KEY;
const KOL = process.env.KOL || "qinbafrank";
const CHUNK = parseInt(process.env.CHUNK || "200", 10);
if (!ADMIN_KEY) throw new Error("ADMIN_KEY required");

const H = { "x-admin-key": ADMIN_KEY };
let lastRemaining = Infinity, totalEmbedded = 0;
for (let i = 0; i < 200; i++) {
  const r = await fetch(`${BASE}/api/admin/embed?kol_id=${KOL}&limit=${CHUNK}`, { method: "POST", headers: H });
  if (!r.ok) { console.log("HTTP", r.status, await r.text()); break; }
  const j = await r.json();
  totalEmbedded += j.embedded || 0;
  console.log(`+${j.embedded} embedded (remaining ${j.remaining}), total this run ${totalEmbedded}`);
  if (!j.embedded || j.remaining === 0) { console.log(j.remaining === 0 ? "ALL EMBEDDED" : "quota likely hit (0 embedded)"); break; }
  if (j.remaining >= lastRemaining) { console.log("no progress; stopping"); break; }
  lastRemaining = j.remaining;
}
