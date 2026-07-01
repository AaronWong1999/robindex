import type { Env } from "./env";
import { completeSystemChat as completeChat } from "./system-llm";

// Offline / write-time search-field generation.
//
// For every tweet we keep the ORIGINAL text in `tweets`. Here we ask deepseek-flash to
// produce *machine* search fields — entities / aliases / topics / stances / style — which
// go into the FTS5 columns (tweet_search) and into tweet_tags for inspection/rebuild.
// The answer model never sees these fields; they exist only to widen retrieval recall so
// that e.g. an English-only "Another step toward making life multiplanetary." tweet is
// found by a Chinese "火星移民" query.

export interface SearchFields {
  entities: string; // proper nouns / tickers / companies (space-separated)
  aliases: string;  // alternate names / codenames / abbreviations / CN<->EN equivalents
  topics: string;   // concepts / themes, CN + EN
  stances: string;  // the opinion / attitude expressed (看多/看空/质疑/担忧/支持 …)
  style: string;    // tone / rhetoric markers (voice exemplars)
}

const EMPTY: SearchFields = { entities: "", aliases: "", topics: "", stances: "", style: "" };

const TAG_SYS =
  "You generate SEARCH metadata for finance-KOL tweets so they can be retrieved later. " +
  "You are given a JSON array of tweets [{i, text}]. For each tweet output an object " +
  "{i, entities, aliases, topics, stances, style} where every value is a SPACE-SEPARATED " +
  "string of search terms (NOT a sentence):\n" +
  "- entities: named tickers/companies/people/products/places mentioned (keep $CASHTAGS, keep both the literal form and a normalized form).\n" +
  "- aliases: alternate names, abbreviations, codenames, and Chinese<->English equivalents for those entities (e.g. 英伟达 NVDA, BFR Super Heavy).\n" +
  "- topics: the concepts/themes the tweet is about, in BOTH Chinese and English (e.g. 火星殖民 Mars colonization 多行星文明 快速迭代 rapid iteration).\n" +
  "- stances: the opinion/judgment/attitude expressed (e.g. 看多 看空 支持 质疑 担忧 反对 评价 中性).\n" +
  "- style: rhetorical/tone markers that characterize how it is written (e.g. 反问 类比 调侃 数据驱动 长推 金句).\n" +
  "PREFER terms of 3+ characters (a substring index needs them). Do NOT copy the raw sentence. " +
  "If a field has nothing, use an empty string. Output ONLY a JSON array, no markdown.";

function safeFields(o: any): SearchFields {
  const s = (v: any) =>
    Array.isArray(v) ? v.filter((x) => typeof x === "string").join(" ") : typeof v === "string" ? v : "";
  return {
    entities: s(o?.entities).slice(0, 600),
    aliases: s(o?.aliases).slice(0, 600),
    topics: s(o?.topics).slice(0, 800),
    stances: s(o?.stances).slice(0, 300),
    style: s(o?.style).slice(0, 300),
  };
}

// Cheap lexical fallback when the LLM is unavailable for a chunk: derive coarse topic terms from
// the text so the tweet still gets a populated (if weaker) index entry. The `text` FTS column is
// always present regardless, so retrieval never fully breaks.
function heuristicFields(text: string): SearchFields {
  const ents = new Set<string>();
  for (const m of String(text).matchAll(/\$?[A-Z]{2,6}\b/g)) ents.add(m[0].replace(/^\$/, ""));
  return { ...EMPTY, entities: Array.from(ents).slice(0, 12).join(" ") };
}

async function tagChunk(
  env: Env,
  model: string,
  chunk: { id: string; text: string }[]
): Promise<Map<string, SearchFields>> {
  const out = new Map<string, SearchFields>();
  const payload = chunk.map((t, i) => ({ i, text: String(t.text || "").slice(0, 600) }));
  // Cache strategy: TAG_SYS is a module constant, so it is byte-identical on every call. DeepSeek's
  // automatic context caching keys on this prefix → all batches after the first read it from cache
  // (~10x cheaper input). Only the small JSON batch varies. Token budget is sized so ~10 CJK-heavy
  // tweets never truncate (a truncated JSON array fails to parse and would drop the WHOLE chunk to
  // the heuristic fallback). One retry absorbs transient gateway throttling under parallel backfill.
  let parsed: any[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await completeChat(
        env,
        model,
        [
          { role: "system", content: TAG_SYS },
          { role: "user", content: JSON.stringify(payload) },
        ],
        { maxTokens: 3600, temperature: 0.2 }
      );
      const arr = JSON.parse(raw.match(/\[[\s\S]*\]/)?.[0] || "[]");
      if (Array.isArray(arr) && arr.length) { parsed = arr; break; }
    } catch {}
    if (attempt === 0) await new Promise((r) => setTimeout(r, 800));
  }
  const byIndex = new Map<number, any>();
  if (Array.isArray(parsed)) for (const o of parsed) if (o && typeof o.i === "number") byIndex.set(o.i, o);
  chunk.forEach((t, i) => {
    const o = byIndex.get(i);
    out.set(t.id, o ? safeFields(o) : heuristicFields(t.text));
  });
  return out;
}

// Generate search fields for many tweets, batched to keep LLM calls (and cost) bounded.
export async function generateSearchFields(
  env: Env,
  model: string,
  tweets: { id: string; text: string }[],
  chunkSize = 16 // tweets per LLM call — backfill is gateway-call-rate-bound, so pack more per call
): Promise<Map<string, SearchFields>> {
  const result = new Map<string, SearchFields>();
  const chunks: { id: string; text: string }[][] = [];
  for (let i = 0; i < tweets.length; i += chunkSize) chunks.push(tweets.slice(i, i + chunkSize));
  // Bounded concurrency so a backfill request doesn't fan out unboundedly.
  const CONCURRENCY = 4;
  for (let i = 0; i < chunks.length; i += CONCURRENCY) {
    const batch = chunks.slice(i, i + CONCURRENCY);
    const maps = await Promise.all(batch.map((c) => tagChunk(env, model, c)));
    for (const m of maps) for (const [k, v] of m) result.set(k, v);
  }
  return result;
}

// Make tweets searchable IMMEDIATELY with NO LLM call: write the original text into tweet_search with
// empty tag columns, for any tweet not already present. trigram FTS over the raw text is enough to
// search/cite; the machine tag columns are an enhancement layer filled in later by indexTweets().
// This is what lets a brand-new KOL go live in minutes (fetch → store → raw-index) instead of hours.
export async function indexRawTweets(
  env: Env,
  kolId: string,
  rows: { id: string; text: string }[]
): Promise<number> {
  // NOTE: no existence pre-check here. tweet_search is FTS5 with an UNINDEXED tweet_id, so checking
  // "is X already present" is a full table scan — at scale that 500s on D1. Callers must pass only NEW
  // rows: the reindex endpoint filters via `NOT IN tweet_search`, and daily ingest only passes freshly
  // fetched tweets. (indexTweets, the tag path, does DELETE+INSERT so it stays idempotent regardless.)
  const real = rows.filter((r) => r.id && r.text);
  if (!real.length) return 0;
  let n = 0;
  const GROUP = 100;
  for (let i = 0; i < real.length; i += GROUP) {
    const slice = real.slice(i, i + GROUP);
    await env.DB.batch(
      slice.map((r) =>
        env.DB.prepare(
          `INSERT INTO tweet_search (text,entities,aliases,topics,stances,style,tweet_id,kol_id)
           VALUES (?,?,?,?,?,?,?,?)`
        ).bind(r.text, "", "", "", "", "", r.id, kolId)
      )
    );
    n += slice.length;
  }
  return n;
}

// Write tweet_tags + tweet_search rows for the given tweets. Generates fields first (LLM).
// Idempotent per tweet_id (deletes any existing FTS row — incl. a raw one — before inserting).
export async function indexTweets(
  env: Env,
  kolId: string,
  model: string,
  rows: { id: string; text: string }[]
): Promise<number> {
  const real = rows.filter((r) => r.id && r.text);
  if (!real.length) return 0;
  const fields = await generateSearchFields(env, model, real);
  let n = 0;
  // D1 batch in groups to stay well under statement limits.
  const GROUP = 50;
  for (let i = 0; i < real.length; i += GROUP) {
    const slice = real.slice(i, i + GROUP);
    const stmts: D1PreparedStatement[] = [];
    for (const r of slice) {
      const f = fields.get(r.id) || heuristicFields(r.text);
      stmts.push(
        env.DB.prepare(
          `INSERT INTO tweet_tags (tweet_id,kol_id,entities,aliases,topics,stances,style,generated_at)
           VALUES (?,?,?,?,?,?,?,datetime('now'))
           ON CONFLICT(tweet_id) DO UPDATE SET kol_id=excluded.kol_id,entities=excluded.entities,
             aliases=excluded.aliases,topics=excluded.topics,stances=excluded.stances,
             style=excluded.style,generated_at=excluded.generated_at`
        ).bind(r.id, kolId, f.entities, f.aliases, f.topics, f.stances, f.style)
      );
      stmts.push(env.DB.prepare(`DELETE FROM tweet_search WHERE tweet_id=?`).bind(r.id));
      stmts.push(
        env.DB.prepare(
          `INSERT INTO tweet_search (text,entities,aliases,topics,stances,style,tweet_id,kol_id)
           VALUES (?,?,?,?,?,?,?,?)`
        ).bind(r.text, f.entities, f.aliases, f.topics, f.stances, f.style, r.id, kolId)
      );
      n++;
    }
    await env.DB.batch(stmts);
  }
  return n;
}
