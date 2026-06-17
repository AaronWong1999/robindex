// Build the FTS5 search index for a KOL's existing corpus.
//
// Tagging runs SERVER-SIDE in the Worker (single source of truth = src/tagger.ts, which uses the
// AI Gateway). This script just drives /api/admin/reindex in a loop until nothing is left untagged.
// New tweets from the daily cron are tagged inline, so this only needs running once per KOL (or with
// FULL=1 to rebuild after changing the tagger prompt).
//
// Usage:
//   BASE=https://robindex.ai ADMIN_KEY=adm_... KOL_ID=qinbafrank node scripts/build_search_index.mjs
//   FULL=1 ...                      # wipe + rebuild this KOL's tags/index first
//   BATCH=80 ...                    # tweets per request (default 60, max 200)

const BASE = process.env.BASE || "https://robindex.ai";
const ADMIN_KEY = process.env.ADMIN_KEY;
const KOL_ID = process.env.KOL_ID;
const BATCH = Math.min(parseInt(process.env.BATCH || "60", 10), 200);
const FULL = process.env.FULL === "1";
// Parallel backfill: run several copies with the same SHARDS but different SHARD (0..SHARDS-1).
// Each shard owns a disjoint id set, so they never collide. e.g.:
//   for s in 0 1 2 3; do SHARDS=4 SHARD=$s KOL_ID=qinbafrank node scripts/build_search_index.mjs & done
const SHARDS = Math.max(1, parseInt(process.env.SHARDS || "1", 10));
const SHARD = Math.max(0, parseInt(process.env.SHARD || "0", 10));
// MODE=raw → fast pass: write original text into FTS with NO LLM (KOL becomes searchable in minutes).
// MODE=tag (default) → slow pass: LLM-tag the tweets to add cross-lingual recall. Run raw first.
const MODE = process.env.MODE === "raw" ? "raw" : "tag";
if (!ADMIN_KEY) throw new Error("ADMIN_KEY required");
if (!KOL_ID) throw new Error("KOL_ID required");

const H = { "x-admin-key": ADMIN_KEY };
const TAG = `[${MODE}${SHARDS > 1 ? ` ${SHARD}/${SHARDS}` : ""}] `;

async function reindex(full) {
  const shardQs = SHARDS > 1 ? `&shards=${SHARDS}&shard=${SHARD}` : "";
  const url = `${BASE}/api/admin/reindex?kol_id=${encodeURIComponent(KOL_ID)}&mode=${MODE}&batch=${BATCH}${shardQs}${full ? "&full=1" : ""}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url, { method: "POST", headers: H });
      if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
      return await r.json();
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
    }
  }
}

let total = 0;
let first = true;
for (;;) {
  // FULL clear happens only on the first call; subsequent calls just continue tagging.
  const out = await reindex(first && FULL);
  first = false;
  total += out.indexed || 0;
  console.log(`${TAG}indexed +${out.indexed} (cum ${total}), remaining ${out.remaining}`);
  if (!out.indexed && !out.remaining) break;
  if (!out.indexed && out.remaining) {
    // No progress but rows remain (e.g. all errored to heuristic-only). Avoid an infinite loop.
    console.error(`${TAG}no progress but rows remain; stopping. remaining=`, out.remaining);
    break;
  }
}

const stats = await fetch(`${BASE}/api/admin/search-stats`, { headers: H }).then((r) => r.json());
console.log("SEARCH STATS:", JSON.stringify(stats));
console.log("DONE. indexed this run:", total);
