import type { Env } from "./env";

export interface Citation {
  ref: string;        // 'T1'
  tweet_id: string;
  url: string;
  date: string;
  snippet: string;
}
export interface RetrievedKnowledge {
  source: string;
  title: string | null;
  text: string;
}

const cosine = (a: number[], b: number[]) => {
  let dot = 0,
    na = 0,
    nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
};

export async function embed(env: Env, text: string): Promise<number[] | null> {
  try {
    const r: any = await env.AI.run("@cf/baai/bge-m3", { text: [text.slice(0, 2000)] });
    return r?.data?.[0] ?? null;
  } catch {
    return null;
  }
}

// Batch embed (bge-m3 accepts an array). Returns vectors aligned to input order (null on failure).
export async function embedBatch(env: Env, texts: string[]): Promise<(number[] | null)[]> {
  const out: (number[] | null)[] = [];
  const B = 50;
  for (let i = 0; i < texts.length; i += B) {
    const slice = texts.slice(i, i + B).map((t) => (t || "").slice(0, 2000));
    try {
      const r: any = await env.AI.run("@cf/baai/bge-m3", { text: slice });
      const vecs: number[][] = r?.data || [];
      for (let j = 0; j < slice.length; j++) out.push(vecs[j] ?? null);
    } catch {
      for (let j = 0; j < slice.length; j++) out.push(null);
    }
  }
  return out;
}

// Hybrid retrieval, hard-scoped to one kol_id. Entity/keyword prefilter + recency,
// then optional bge-m3 cosine rerank over the (small) candidate set.
export async function retrieve(
  env: Env,
  kolId: string,
  handle: string,
  query: string,
  tickers: string[]
): Promise<{ citations: Citation[]; knowledge: RetrievedKnowledge[] }> {
  // 1) Candidate tweets: ticker/keyword hits + recent.
  const terms = new Set<string>();
  for (const t of tickers) {
    terms.add(t.toUpperCase());
    terms.add("$" + t.toUpperCase());
  }
  for (const w of query.split(/[^A-Za-z一-龥]+/)) {
    if (w.length >= 3) terms.add(w);
  }
  const likeClauses: string[] = [];
  const binds: any[] = [kolId];
  for (const term of Array.from(terms).slice(0, 8)) {
    likeClauses.push("text LIKE ?");
    binds.push(`%${term}%`);
  }
  const where = likeClauses.length ? `AND (${likeClauses.join(" OR ")})` : "";
  let rows: any[] = [];
  if (likeClauses.length) {
    const r = await env.DB.prepare(
      `SELECT id,text,created_at_iso,views,embedding FROM tweets
       WHERE kol_id=? AND is_retweet=0 ${where}
       ORDER BY created_at_ts DESC LIMIT 40`
    )
      .bind(...binds)
      .all();
    rows = r.results || [];
  }
  // Always add some recent context tweets.
  const recent = await env.DB.prepare(
    `SELECT id,text,created_at_iso,views,embedding FROM tweets
     WHERE kol_id=? AND is_retweet=0 ORDER BY created_at_ts DESC LIMIT 20`
  )
    .bind(kolId)
    .all();
  const seen = new Set(rows.map((r) => r.id));
  for (const r of recent.results || []) if (!seen.has(r.id)) rows.push(r);

  // 2) Optional embedding rerank.
  let ranked = rows;
  const qvec = rows.some((r) => r.embedding) ? await embed(env, query) : null;
  if (qvec) {
    ranked = rows
      .map((r) => {
        let score = 0;
        if (r.embedding) {
          try {
            score = cosine(qvec, JSON.parse(r.embedding));
          } catch {}
        }
        // small lexical + recency boost
        for (const t of tickers) if ((r.text || "").toUpperCase().includes(t.toUpperCase())) score += 0.15;
        return { r, score };
      })
      .sort((a, b) => b.score - a.score)
      .map((x) => x.r);
  } else {
    // lexical/recency fallback
    ranked = rows
      .map((r) => {
        let score = Math.log10((r.views || 0) + 10);
        for (const t of tickers) if ((r.text || "").toUpperCase().includes(t.toUpperCase())) score += 5;
        return { r, score };
      })
      .sort((a, b) => b.score - a.score)
      .map((x) => x.r);
  }

  const top = ranked.slice(0, 6);
  const citations: Citation[] = top.map((r, i) => ({
    ref: `T${i + 1}`,
    tweet_id: r.id,
    url: `https://x.com/${handle}/status/${r.id}`,
    date: (r.created_at_iso || "").slice(0, 10),
    snippet: r.text,
  }));

  // 3) Knowledge chunks (methodology / theses / analysis), rerank if embeddings exist.
  const kr = await env.DB.prepare(
    `SELECT source,title,text,embedding FROM knowledge_chunks WHERE kol_id=? LIMIT 60`
  )
    .bind(kolId)
    .all();
  let kchunks = kr.results || [];
  if (qvec && kchunks.some((k: any) => k.embedding)) {
    kchunks = kchunks
      .map((k: any) => {
        let s = 0;
        if (k.embedding) {
          try {
            s = cosine(qvec, JSON.parse(k.embedding));
          } catch {}
        }
        return { k, s };
      })
      .sort((a, b) => b.s - a.s)
      .map((x) => x.k);
  }
  const knowledge: RetrievedKnowledge[] = kchunks
    .slice(0, 4)
    .map((k: any) => ({ source: k.source, title: k.title, text: k.text }));

  return { citations, knowledge };
}
