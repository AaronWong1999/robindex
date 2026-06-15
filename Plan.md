# Robindex.ai — Build Plan & Progress Log

> **Living document.** Any AI picking up this project reads this top-to-bottom first, then
> continues from the next unchecked item. Update the **Status** and **Progress Log** as you go.
> Keep decisions here, not in your head — the next AI has no memory of this session.

Last updated: 2026-06-16

---

## 1. What we are building

**Robindex.ai** — an "AI Trader Desk". Users chat with an AI that faithfully impersonates a chosen
finance Twitter/X KOL: the KOL's **knowledge, logic, theses, and tone** are "distilled" and injected
into the model (no fine-tuning — API + retrieval only, so we ride model upgrades for free).

When a user asks something like *"qinbafrank, 你怎么看最近 SOXL 的走势"*, the system must:
1. Recognize **SOXL** is a tradable instrument (US-listed leveraged semiconductor ETF).
2. Fetch **live market data** (quote, recent K-line, fundamentals) for it.
3. Answer **in that KOL's voice, using that KOL's logic/views**, grounded in the fresh data.
4. **Cite** which of the KOL's actual tweets/articles a view comes from (clickable to source).

Reference product being emulated (concept, not pixel-clone — site is bot-blocked): themarketbrew.com/kol.
Feel: like Codex / Claude Cowork / WorkBuddy. **Mobile-first.**

### KOLs at launch
| id | Display | X handle | Source of distilled corpus |
|----|---------|----------|----------------------------|
| `aleabitoreddit` | Serenity (白毛股神) | [@aleabitoreddit](https://x.com/aleabitoreddit) | **Ready** — github.com/yan-labs/serenity-aleabitoreddit (5,857 tweets + persona/methodology/theses/track-record + monthly analyses) |
| `qinbafrank` | qinbafrank | [@qinbafrank](https://x.com/qinbafrank) | **TODO** — scrape via Apify, then distill with same pipeline |

Architecture must make adding more KOLs trivial and **contamination-proof** (see §4).

---

## 2. Constraints & credentials

- **Cloudflare-only** architecture. Account `686bee522c90d03e13ba35077f04ff49` (Waaron1999@icloud.com).
  Zones `robindex.ai` and `robindex.net` already exist on the account. Token in `account.guard.json`.
- **AI Gateway** (provided in `account.guard.json`): OpenAI-compatible endpoint
  `…/v1/686bee…/robin/compat/chat/completions`, key `CFGATEWAYKEY`. Launch models (user-selectable):
  `deepseek/deepseek-v4-flash` and `deepseek/deepseek-v4-pro`.
- **Prompt caching / cost**: put *stable* content first in the prompt (persona pack, methodology) so the
  gateway/provider cache hits. Variable content (live data, user turn) goes last.
- **Twitter ingestion** is paid (Apify). Pull **incremental only** (track `last_tweet_id` per KOL),
  once/day. Apify actor `apidojo/tweet-scraper`, token in README §5. Store *everything* (text, time,
  quotes, urls, media, metrics) in our DB.
- Charts: use benji.org/liveline for price/K-line rendering.
- ⚠️ `account.guard.json` contains live secrets and is git-tracked. Gateway key must live as a Worker
  **secret**, not in committed code. (Flagged to user.)

---

## 3. Target architecture (Cloudflare-only)

Single **Worker** (Hono + TS) under `app/`, serving static frontend (Workers Static Assets) + JSON/SSE API.

| Concern | Cloudflare primitive | Notes |
|---|---|---|
| Frontend (mobile-first SPA) | Static Assets on the Worker | vanilla HTML/CSS/JS, no build step |
| App + API + SSE streaming | Worker | `/api/kols`, `/api/chat` (stream), `/api/quote`, `/api/kline`, `/api/cron/*` |
| Structured store | **D1** (`schema.sql`) | kols, tweets, articles, analysis_chunks, conversations, messages, sync_state |
| Vector retrieval (RAG) | **Vectorize** index `kol-knowledge` | 1024-dim (bge-m3), cosine; **every vector tagged `kol_id`** → hard filter |
| Embeddings | **Workers AI** `@cf/baai/bge-m3` | multilingual (EN tweets + ZH queries) |
| Chat completions | **AI Gateway** → deepseek v4 flash/pro | OpenAI-compatible; stable-prefix prompt for caching |
| Caches (quotes, persona packs, ticker map) | **KV** | quote TTL ~30–60s; persona pack cached assembled |
| Daily tweet sync + weekly persona refresh | **Cron Triggers** | incremental Apify → D1 → embed new → Vectorize upsert |
| Raw backups / avatars (optional) | **R2** | nice-to-have |

### Financial data (works from a Worker — verified live)
Public Tencent endpoints, no key needed. Code format: A `sh######`/`sz######`/`bj######`, HK `hk#####`, US `us<SYM>`.
- Realtime quote: `https://qt.gtimg.cn/q=usSOXL` (GBK-encoded `~`-delimited line).
- US K-line: `https://web.ifzq.gtimg.cn/appstock/app/usfqkline/get?param=usSOXL,day,,,<N>,qfq`
- A/HK K-line: `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=<code>,day,,,<N>,qfq`
- Intraday minute: `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=usSOXL`
- Search/resolve ticker: `https://proxy.finance.qq.com/ifzqgtimg/appstock/smartbox/search/get?app=search&q=<kw>` (to verify)
- Deeper fundamentals/financials available via the bundled local skills (`westock-data`, NeoData, Futu)
  for offline enrichment, but the **runtime** path is the public endpoints above.

### Chat request flow
1. Input: `{kol_id, model, conversation_id, message}`. Session is **bound to one kol_id**.
2. **Entity/ticker detection**: regex for `$TICKER`/cashtags + a lightweight resolver (Tencent search)
   to map names→codes and confirm instrument + market.
3. **Live data fetch**: quote + recent K-line (+ fundamentals when relevant) for detected instruments. Cache in KV.
4. **RAG**: embed query (bge-m3) → Vectorize query **filtered by kol_id** → top tweet/analysis chunks,
   each given a citation id `[T1]`, `[T2]`… mapped to tweet id/url/date.
5. **Assemble prompt** (stable→variable for caching):
   `[Persona Pack (identity, methodology, tone, taboos, format)]` →
   `[Retrieved KOL knowledge w/ citation ids]` → `[Live market data block]` →
   `[bounded conversation history]` → `[user message]`.
6. **Stream** completion from AI Gateway (selected model). Model must cite `[Tn]` when leaning on a view.
7. Frontend renders streamed answer, expands `[Tn]` → quoted source tweet linking to `x.com/<handle>/status/<id>`,
   and renders a liveline chart for the primary instrument.

---

## 4. Anti-contamination & persona stability (hard requirements)

- **Per-KOL Persona Pack** = fixed identity + methodology + tone + taboos + answer format. Stored as
  source files in `app/personas/<kol_id>.md`, seeded into D1. **Injected every turn** — never rely on
  the model "remembering". Stable text first (cache-friendly).
- Persona Pack is **not** auto-rewritten on every new tweet. Refresh on a **weekly** scheduled job.
- **Knowledge layer carries `kol_id` everywhere** (tweets, articles, analysis, vectors). Retrieval is
  **hard-filtered by kol_id** — the model never chooses which person's library to search.
- **Session ↔ one KOL.** Multi-turn memory is **bounded** (last N turns + rolling summary), not infinite.

---

## 5. Phases & checklist

### Phase 0 — Recon & decisions ✅ DONE
- [x] Read all skills/credentials/README; confirm CF token + zones.
- [x] Verify financial endpoints callable from server (quote/kline/minute live-tested).
- [x] Confirm aleabitoreddit distilled corpus available; capture tweet JSON schema + sync_state.
- [x] Decide stack: Worker(Hono+TS) + D1 + Vectorize + KV + Workers AI + AI Gateway + Cron.

### Phase 1 — Scaffold & first deploy  ✅ DONE
- [x] `app/` scaffold: package.json, wrangler.jsonc, tsconfig, schema.sql, src/, public/.
- [x] Create CF resources: D1 (`a4f1e62d…`), KV `CACHE` (`83cb63c5…`). **Vectorize blocked** — token lacks scope; using D1-stored bge-m3 embeddings + hybrid retrieval instead.
- [x] Put gateway key as Worker secret (`CFGATEWAYKEY`); admin key (`ADMIN_KEY`) for import.
- [x] Mobile-first frontend shell: KOL picker, model picker, streaming chat UI, citation + chart slots.
- [x] Deployed: **https://robindex.waaron1999.workers.dev**.

### Phase 2 — Financial data service  ✅ DONE
- [x] `finance.ts`: quote (GBK decode, Tencent), kline (A/HK via Tencent, **US via Yahoo** — Tencent US only returns latest), ticker resolve.
- [x] `/api/quote`, `/api/kline` endpoints live + canvas candlestick chart in UI with accessible text summary.
- [ ] KV cache on quotes/klines (TODO — currently uncached; cheap to add).

### Phase 3 — Ingest aleabitoreddit corpus  ✅ DONE
- [x] Persona Pack `personas/aleabitoreddit.md` built from SKILL.md + methodology + voice sampling.
- [x] Admin import endpoints (`/api/admin/kol|tweets|knowledge|stats`, key-gated) + server-side bge-m3 embedding.
- [x] Knowledge chunks (methodology/theses/track-record/articles + 6 analyses): **201 chunks, embedded**.
- [x] **5,857 tweets loaded into D1, all 5,857 embedded** (bge-m3, stored in D1). `scripts/load_aleabitoreddit.mjs`.

### Phase 4 — Chat pipeline  ✅ DONE (verified live)
- [x] Persona injection (stable prefix) + hybrid RAG (kol_id-scoped) + live-data + bounded history → SSE stream.
- [x] Citation mapping `[Tn]` → source tweet (clickable to x.com); rendered in UI with sources panel.
- [x] Model selector (flash/pro) honored.
- [x] **AI Gateway auth resolved**: route is `…/robin/openrouter/v1/chat/completions`; headers
  `cf-aig-authorization: Bearer <CFGATEWAYKEY>` + `Authorization: Bearer <OPENROUTER_KEY>`.
  Models `deepseek/deepseek-v4-flash` & `deepseek/deepseek-v4-pro` exist on OpenRouter (1M ctx). Both set as Worker secrets.
- [x] **End-to-end verified**: "你怎么看 SOXL 的走势" → in-character Chinese answer using live K-line + his methodology + inline [T1][T3][T5] citations + risk framing.

### Phase 5b — UI 1:1 replication of themarketbrew.com/kol  ✅ DONE
- [x] Got real reference screenshots from user. Rebuilt frontend to match (Robindex branding):
  - `public/index.html` — 研究室 selection landing (two KOL cards, 怎么选, 使用边界, footer) — copy verbatim.
  - `public/research.html` + `research.js` — full **/research?agent=kol&persona=<id>** workspace:
    left conversation sidebar, center chat (empty-state avatar + persona switcher + 4 prompt cards),
    right **原文支持** source-tweets panel (shows only tweets the answer actually cited).
  - Markdown rendering, candlestick chart inline, Flash/Pro toggle, daily-quota counter, conv history (localStorage).
- [x] **Bug fixed**: KV `expirationTtl` min is 60s; quote cache used 45 → threw 500 on the 2nd+ ticker query
  (cached-resolve branch). Changed to 60. Verified repeat ticker queries now stream fine.
- [x] Verified live in a real browser: landing + workspace render faithfully; SOXL query → in-character
  streamed markdown answer + candlestick chart + actions; conversation saved to sidebar.

### Phase 5c — Second-pass comparison against live TheMarketBrew pages  🚧 IN PROGRESS
- [x] Inspected the reference pages in the user's browser on 2026-06-16:
  `/kol`, `/kol/qinbafrank`, and `/research?agent=kol&persona=qinbafrank`.
- [x] Gap found: Robindex landing was close, but card feature chips were not real links and "进入研究室"
  skipped the KOL landing page. Fixed: KOL cards now link to `/kol/<persona>` and library chips link to
  `/kol/<persona>/{highlights,sectors,stocks,latest}` or the persona-bound research assistant.
- [x] Gap found: Robindex lacked the KOL research-room landing page. Fixed: added `public/kol.html`,
  `public/kol.js`, and Worker deep-link routes for `/kol/:persona` and `/kol/:persona/:section`.
  The page now has KOL side nav, hero,资料库入口, Ultra CTA/pricing card, method cards, fit/not-fit section,
  and real sample-question links into `/research?agent=kol&persona=...&q=...`.
- [x] Gap found: library subpages were missing. Fixed: `/kol/<persona>/highlights`, `/sectors`, `/stocks`,
  `/latest` now render an Ultra-style gate matching the reference behavior for locked sections.
- [x] Gap found: research prompt cards were decorative. Fixed: prompt cards now expand into real inputs,
  quick chips, and option buttons for stock, sector, market, and view-verification workflows.
- [x] Gap found: conversation rows lacked management controls. Fixed: local conversation rows now support
  rename/delete, and the history sidebar can be collapsed.
- [x] Browser QA on production after deploy: verified `/kol/qinbafrank`, `/kol/qinbafrank/highlights`, and
  `/research?agent=kol&persona=qinbafrank&q=SOXL` render correctly on `robindex.ai`. Final deployed version:
  `41d7e9c0-9653-4d40-a860-e50bc256715d`.
- [ ] Remaining parity gaps: reference has richer dropdown navs, billing/account flows, and actual unlocked
  library content pages. Robindex currently ships locked/gated library shells plus functional research assistant.

### Phase 7 — Domain & launch  ✅ DONE
- [x] Custom domain root now serves the Trader Desk frontend. Verified on 2026-06-16:
  `https://robindex.ai` title is `Robindex — AI 驱动的市场洞察` and shows the KOL research-room landing.
- [x] API routes are live on the custom domain. Verified on 2026-06-16:
  `https://robindex.ai/api/kols` returns JSON with 2 KOLs.
- [x] Live finance endpoints are live. Verified on 2026-06-16:
  `/api/quote?q=SOXL` returns Tencent live quote, `/api/kline?code=usSOXL&limit=5` returns 5 Yahoo candles.
- [x] Chat SSE is live. Verified on 2026-06-16:
  `POST /api/chat` with qinbafrank + SOXL returns `text/event-stream`, source tweet citations, chart meta
  `{ code: "usSOXL", symbol: "SOXL" }`, and an in-character Chinese answer.
- [x] KV quote/kline caching, prompt-cache stable prefix, retrieval caps, disclaimers — code is in place.
- [x] Cloudflare deploy/secret operations verified with Global API Key. Latest deployed version:
  `84e65c1c-d3e8-4601-bbd0-7b55197b3831`.

### Phase 5 — Daily/weekly automation  ✅ DONE
- [x] Cron code now prefers **GetXAPI** incremental pull (per-KOL `twitter_uid` + `last_tweet_id`, strict
  author guard, max 4 pages/day for cost control), falls back to Apify only if GetXAPI is absent.
- [x] Worker secret `GETXAPI_KEY` uploaded successfully.
- [x] Triggered production ingest once via protected admin endpoint. Evidence:
  `aleabitoreddit` fetched 58 candidate tweets and inserted 1; `qinbafrank` fetched 0 new tweets;
  `sync_state.last_run_at` updated for both.
- [x] Weekly persona checkpoint job deployed and verified. Cron `30 9 * * 1`; manual trigger updated
  both KOLs to `persona_version=weekly-2026-06-15`.

### Phase 6 — Second KOL (qinbafrank)  ✅ DONE — live with citations
- [x] **721 tweets scraped (720 non-RT, 0 wrong-author), loaded + in D1.** Covers pinned + recent
  ~4 months (GetXAPI `user/tweets` caps history there). This is **NOT the full qinbafrank corpus**:
  GetXAPI account metadata showed ~14,664 lifetime tweets, so the current D1 corpus covers only a recent
  slice. Verified: qinbafrank answers in-character with
  **live data + 原文支持 citations** to his real tweets (HOOD/Robinhood/稳定币 test → cited [T1–T5]).
- [⚠️] Only 70/720 embedded — hit **Workers AI daily quota** (after ~6,600 vectors today). Retrieval uses
  lexical/recency fallback (works well); backfill embeddings when quota resets (cron `embedPending`, 50/day,
  or re-run the loader). Lesson re scraping below.
- Earlier vendor notes (ScrapeBadger wrong-account, Apify noResults) retained for history:
- **Working source: GetXAPI** (`api.getxapi.com`, `Authorization: Bearer <key>`). MCP pkg `@getxapi/mcp`,
  REST base discovered from its manifest. Endpoint `GET /twitter/user/tweets?userId=<id>&cursor=<c>` →
  `{tweets[], has_more, next_cursor}`, 19/page, **~$0.001/call** (`/account/me` shows balance). Returns
  correct author with full `author.userName` on every tweet — verified consistent (unlike ScrapeBadger).
  `scripts/scrape_getxapi.py` (strict per-tweet `author==target` guard). **Gotcha: don't name the target
  env var `USERNAME`** — it's reserved/preset in the shell and silently overrode the guard (flagged all as
  wrong-author). Renamed to `TARGET_USER`.
- [x] Pulling ~250 pages (~4,750 recent tweets, ~$0.25) → `scripts/load_qinbafrank.mjs` loads + embeds.
- qinbafrank: uid `1338075202798809089`, 14,664 lifetime tweets, avatar `…rEHaWNk1` (→ _400x400).
- [x] Persona Pack `personas/qinbafrank.md` (macro top-down framework, 杀逻辑/打脸指标, PEG/cycle, liquidity).
- [x] **KOL row loaded (persona only, 0 tweets)** → his research room is LIVE and answers in-character
  using persona + live market data. **Verified.** Gap: 原文支持 tweet-citation panel stays empty until tweets load.
- [x] `scripts/load_qinbafrank.mjs` + `scrape_sb.py` retained for future backfills.
- **Historical scraper notes — resolved by GetXAPI:**
  - **ScrapeBadger** `/v1/twitter/users/qinbafrank/latest_tweets` is **inconsistent**: some calls return his
    real Chinese content, others return a *different account* (`@aaron`, English sports/theScore tweets) for
    the identical request — a vendor username-resolution bug. My first Node scraper also re-encoded the
    cursor via `URLSearchParams` (compounding drift) and, crucially, didn't validate `author==qinbafrank`
    per tweet → I burned ~800 of 1000 credits on the wrong account before catching it. Rewrote in Python
    (`scrape_sb.py`) with proper cursor encoding + per-tweet author guard; it STILL got `@aaron` on the next
    run. ~10 credits remain. (20 credits/call, rate limit 5/min.)
  - **Apify** apidojo `tweet-scraper` ("Tweet Scraper V2") returns `{"noResults":true}` for qinbafrank across
    every input variant tried (twitterHandles, searchTerms `from:`, startUrls profile, with/without date range).
- **Resolution:** GetXAPI is now the reliable tweet source for qinbafrank citations and daily incrementals.
  Account-info endpoint: `GET /v1/twitter/.. ` → `/v1/account/me` (free, shows balance).
- **Full-corpus status (2026-06-16, RESOLVED):**
  - `aleabitoreddit`: materially complete. Remote D1 has 5,930 tweets, 5,929 embedded. Daily increment active.
  - `qinbafrank`: **now complete**. Remote D1 has 13,750 tweets (was 720). Pulled the full original-tweet
    history back to 2021-10-03 via GetXAPI **`twitter/tweet/advanced_search`** with `from:qinbafrank` + `until:`
    date-windowing (`scripts/scrape_qinbafrank_deep.py`) — the timeline endpoint (`user/tweets`) had capped at
    ~4 months. 705 API calls (~$0.70), 0 wrong-author. Lifetime `tweet_count` ~14.6k includes retweets, which
    `from:` search excludes, so 13,747 originals/replies is effectively the full set. Two empty windows before
    2021-10 confirmed account start. Embeddings only 170/13,750 (Workers AI daily quota) — backfill resumes via
    `scripts/backfill_embeddings.mjs` / cron `embedPending` as quota resets; lexical+recency retrieval covers it.
  - **Raw archive in R2:** `robindex-raw/raw/<kol>/full.json` for both KOLs; daily cron writes append-only
    `raw/<kol>/incr-<ts>.json` deltas (Twitter data is paid → never overwritten). Also in repo `data/raw/`.
  - **Daily cron** confirmed registered (`0 9 * * *`) and uses the cheapest incremental path: timeline endpoint,
    early-stop at `last_tweet_id`, 4-page cap (≈1 call on a quiet day).

### Phase 7 — Polish, domain, launch  ✅ DONE
- [x] Fixed local Worker config so `/api/*` runs through the Worker before Static Assets SPA fallback
  (`assets.run_worker_first: ["/api/*"]`). Before this fix, `/api/kols` returned landing-page HTML.
- [x] Added `/api/kline` failure isolation: if Yahoo/Tencent history fetch fails, the endpoint returns
  `{ candles: [], error: "kline_unavailable" }` with HTTP 200 instead of crashing the app.
- [x] Added `npm run preflight` to verify Cloudflare token, root page, `/api/kols`, `/api/quote`, and `/api/kline`.
- [x] Custom domain `robindex.ai` core route/API/chat path is live.
- [x] SEO/meta baseline in place: title, description, viewport, theme-color.
- [x] Cost guards in place: KV quote/kline cache, prompt-cache stable prefix, retrieval caps, daily ingest
  page cap, admin ingest `embed_limit` cap. Launch checks pass.

#### Current deployment blocker (2026-06-16)

Deployment/ops notes:

- Local DNS resolves Cloudflare hosts to `198.18.*`, causing TLS resets. Workaround is committed at
   `app/scripts/cloudflare-dns-patch.cjs`, and npm scripts `whoami:cf` / `deploy:cf` preload it.
- The credential in `account.guard.json` is a **Global API Key** (`cfk_...`), not a Bearer API Token.
  Use `CLOUDFLARE_API_KEY` + `CLOUDFLARE_EMAIL`, or `npm run preflight` which auto-detects this.

Exact retry commands from `app/` when network/API access is healthy:

```bash
CF_TOKEN=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('../account.guard.json','utf8')).CLOUDFLARE_API_TOKEN)")
GX_KEY=$(node - <<'NODE'
const fs=require('fs');
const text=fs.readFileSync('../README.md','utf8');
const m=text.match(/get-x-api-[A-Za-z0-9]+/);
if(!m) process.exit(2);
process.stdout.write(m[0]);
NODE
)
printf '%s' "$GX_KEY" | CLOUDFLARE_API_TOKEN="$CF_TOKEN" NODE_OPTIONS="--require ./scripts/cloudflare-dns-patch.cjs" npx wrangler secret put GETXAPI_KEY
CLOUDFLARE_API_TOKEN="$CF_TOKEN" npm run deploy:cf
```

---

## 5c. Raw tweet storage (durability — IMPORTANT)

Scraped tweets are **expensive to acquire**, so originals are persisted in two durable places (never
vector-only):
1. **Cloudflare D1 `tweets` table** (live store): full `text` + `created_at_iso/ts`, all engagement metrics
   (likes/retweets/replies/quotes/views), `urls`, `media`, `lang`, `is_retweet`. The `embedding` column is
   an *extra* field alongside the text, not a replacement. This is the queryable source of truth.
2. **Repo `data/raw/*.json`** (git-tracked archive): `aleabitoreddit_tweets.json` (full GitHub schema),
   `qinbafrank_tweets.json` (GetXAPI mapped schema). Committed so the corpus survives even if D1 is reset.

R2 (`robindex-raw` bucket) would be the ideal Cloudflare-side archive but the API token lacks R2 perms
(same gap as Vectorize) — add `R2 Edit` to the token to enable. Until then, D1 + repo archive cover it.
**Rule for any future scrape: always write the raw JSON to `data/raw/` AND upsert into D1.**

## 6. Key reference data (captured)

- **Tweet JSON schema** (per record): `id, text, author{id,name,screenName,profileImageUrl,verified},
  metrics{likes,retweets,replies,quotes,views,bookmarks}, createdAt, createdAtLocal, createdAtISO,
  media[], urls[], isRetweet, retweetedBy, lang, score`.
- **aleabitoreddit** user id `1940360837547565056`; avatar
  `https://pbs.twimg.com/profile_images/1996176688414367744/LXfA_lIx_normal.jpg`
  (swap `_normal`→`_400x400` for hi-res). last_tweet_id at capture `2065973347897557093`.
- Repo paths of interest: `data/aleabitoreddit_tweets.json`, `serenity-aleabitoreddit/SKILL.md`,
  `serenity-aleabitoreddit/references/{methodology,theses,track-record,articles}.md`,
  `serenity-aleabitoreddit/analysis/*.md`, `update.py` (incremental-sync reference impl).
- raw.githubusercontent.com is blocked in this sandbox; fetch repo files via
  `api.github.com/repos/<repo>/contents/<path>` with `Accept: application/vnd.github.raw`.

---

## 6b. v2 upgrade — instrument detection · live-data skills · distillation ✅ (code complete; deploy pending)

Research-backed (nuwa/colleague/serenity for distillation; financial NER + Tencent smartbox for entity
resolution; Workbuddy for skill/tool dispatch). Full design: plan file
`~/.claude/plans/users-aaron-desktop-aaron-robindex-west-snuggly-ocean.md`.

- **A — Instrument detection (`app/src/entities.ts`)** ✅ DONE. `detectInstruments()` layers
  $cashtags → static alias dict (CN/EN names → code, instant) → CJK spans (split on Chinese stopwords,
  name-overlap validated) → Capitalized EN phrases → bare UPPER tickers (stopword-filtered), capped +
  per-KOL universe bias (`getKolUniverse`, KV-cached from tweet cashtags, passed from `index.ts`). Fixed a
  real bug: `searchSymbol` parsed the old GBK `v_hint=` format but smartbox now returns JSON → Chinese
  names never resolved; now `searchSymbolHits()` parses `data.stock[[mkt,code,cn,en,type]]`. Verified live:
  CRCL; 茅台+宁德时代 (glued "宁德时代怎么选" handled); 苹果+英伟达; Apple vs Tesla; 腾讯; $CRCL+PLTR;
  no false positives (分钟/"the CEO"). Future option: promote alias dict to a `symbol_dict` D1 table.
- **B — Live-data endpoints** ✅ DONE. Minute K-line (`finance.ts`): `getKline` accepts `m1/m5/m15/m30/m60`
  — A-share via Tencent `ifzq…/kline/mkline`, US/HK via Yahoo intraday (`getKlineYahoo`+`yahooSymbol`);
  served via `/api/kline?period=m1`. News/macro (`app/src/marketdata.ts`): `getStockNews` (US via Yahoo
  search) + `getMarketNews` (CN/macro 7x24 via Eastmoney 快讯, JSONP-stripped), KV-cached 300s; routes
  `/api/news`, `/api/macro`; wired into chat pre-fetch via `NEWS_INTENT` + a NEWS prompt block. Verified
  live. Note: numeric macro indicators / economic calendar deferred (TE guest API discontinued; 快讯
  covers macro *events*). Per-CN/HK single-stock news not ported (market news covers CN).
- **C — Distillation upgrade** ✅ DONE (code). C1 Persona Pack v2 spec `personas/_TEMPLATE.md` (nuwa
  triple-verification + Expression DNA, colleague layers, serenity evidence tiers, honest boundaries).
  C2 `scripts/distill_kol.mjs` — offline drafter: corpus → v2 persona pack + knowledge chunks via gateway,
  written as `.draft` files for human review (no auto-activation). C3 real weekly refresh in `ingest.ts`:
  LLM-distills the week's new tweets into a dated `analysis:<week>` knowledge chunk (embedded + Vectorize),
  persona pack itself never auto-mutated. C4 rolling memory: `maybeUpdateSummary` (chat.ts) fills
  `conversations.summary` for long threads via `waitUntil`, injected as a CONVERSATION-SO-FAR block.
  C5 Vectorize (`rag.ts` `retrieveVectorize`/`indexVectors`, guarded — falls back to D1+JS-cosine until
  `wrangler vectorize create robindex-index --dimensions=1024 --metric=cosine` + binding uncomment +
  backfill). C6 citation faithfulness: persist only `[T#]` refs the answer actually used. Added
  `completeChat` (non-streaming gateway helper) + shared `gatewayHeaders`. Typechecks; LLM-call paths
  verifiable only post-deploy (need provider key).
- **D — Hybrid orchestration** ✅ DONE. **Verified deepseek-v4-flash supports function calling** via the
  gateway (`finish_reason: tool_calls`); the `openrouter` route has BYOK so governor-only auth works.
  `app/src/tools.ts`: 5 tools (`get_quote`, `get_kline` incl. m1/m5, `get_news`, `get_macro`,
  `search_symbol`) backed by A/B. `resolveToolPhase` (chat.ts) runs a ≤2-iteration tool loop before the
  streamed answer (best-effort: degrades to pre-fetch on any error); wired in `index.ts` before
  `streamChat`. Fixed `resolveSymbol` to accept already-internal codes (sh600519/hk00700/usAAPL) so
  tool-passed codes resolve. End-to-end tested live: model chained `search_symbol`+`get_quote`+
  `get_kline(m1)` and executed each correctly.

### Handoff — deploy, activate, verify

New/changed files: `app/src/entities.ts`, `app/src/marketdata.ts`, `app/src/tools.ts` (new);
`app/src/finance.ts`, `chat.ts`, `index.ts`, `ingest.ts`, `rag.ts`, `env.ts`, `wrangler.jsonc` (changed);
`app/personas/_TEMPLATE.md`, `app/scripts/distill_kol.mjs` (new). Typechecks clean (`cd app && npx tsc --noEmit`).

**Gateway auth (important):** the AI Gateway has **BYOK**, so **governor-only auth works** — the Worker
needs the `CFGATEWAYKEY` secret; `OPENROUTER_KEY` is now *optional* (`gatewayHeaders` omits the
`Authorization` header when it is unset; an empty Bearer 401s). Secrets live in `account.guard.json`
(CFGATEWAYKEY, CLOUDFLARE_API_TOKEN, ADMIN_KEY) and as Worker secrets. Verified: `deepseek-v4-flash`
returns `finish_reason: tool_calls` on the `…/robin/openrouter/v1/chat/completions` route.

1. **Deploy:** needs **Node ≥22** (use nvm: `export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"`)
   and **Global API Key** auth, not a token: `export CLOUDFLARE_API_KEY=<guard.CLOUDFLARE_API_KEY>
   CLOUDFLARE_EMAIL=<guard.expectedEmail>` (unset `CLOUDFLARE_API_TOKEN`), then `cd app && npx wrangler
   deploy`. Live domains: robindex.ai, www.robindex.ai. Confirm secrets: `npx wrangler secret list`.
2. **Smoke-test (no deploy needed for data layer):**
   - `/api/news?q=AAPL` and `/api/macro` → headlines.
   - `/api/kline?code=sh600519&period=m1&limit=5` → minute candles.
   - `POST /api/chat` (kol_id + message "茅台1分钟K线 + 最近宏观新闻") → streamed, in-character, with data.
3. **Activate Vectorize (optional, biggest recall win):**
   `npx wrangler vectorize create robindex-index --dimensions=1024 --metric=cosine`, uncomment the
   `vectorize` binding in `wrangler.jsonc`, redeploy, then backfill: re-run `POST /api/admin/embed?kol_id=…`
   (tweets) and `POST /api/admin/knowledge` (chunks) per KOL. Until then retrieval auto-falls-back to
   D1+JS-cosine, so nothing breaks.
4. **Persona v2 re-distill (optional):** `KOL_ID=… NAME=… HANDLE=… TWEETS=tweets/<file>.json node
   scripts/distill_kol.mjs` → review `personas/<id>.draft.md` + `<id>.knowledge.draft.json`, then promote.

**Known limitations / next:** numeric macro indicators + economic calendar deferred (TE guest API
discontinued; Eastmoney 快讯 covers macro *events*); per-CN/HK single-stock news not ported (market news
covers CN); tool phase adds one non-streaming model call per turn (latency vs. flexibility tradeoff);
LLM-call paths (weekly refresh, rolling summary, tool loop) only runtime-verified after deploy.

---

## 7. Progress Log (newest first)

- **2026-06-16 (session 7, v2 upgrade — code complete)** — Built the A→B→C→D upgrade (see §6b for the
  full per-workstream detail). A: layered instrument detection (`entities.ts`) — fixed a real bug where
  `searchSymbol` parsed the dead GBK smartbox format so Chinese names never resolved. B: minute K-line +
  news/macro (`finance.ts`, `marketdata.ts`). C: persona v2 spec + distiller, real weekly refresh, rolling
  conversation summary, guarded Vectorize retrieval, citation faithfulness. D: verified deepseek function
  calling and added the hybrid tool loop (`tools.ts`, `resolveToolPhase`). Made gateway auth robust to a
  missing `OPENROUTER_KEY` (BYOK → governor-only works). All typechecks pass; data-layer paths verified
  live; LLM-call paths pending deploy. Not yet deployed/committed. Next: `wrangler deploy` + optional
  Vectorize provisioning (commands in §6b Handoff).
- **2026-06-16 (session 6, launch complete)** — User supplied the working Cloudflare Global API Key.
  Verified wrangler access to account `686bee522c90d03e13ba35077f04ff49`, uploaded `GETXAPI_KEY` and
  `ADMIN_KEY` secrets, deployed version `84e65c1c-d3e8-4601-bbd0-7b55197b3831` to `robindex.ai` and
  `www.robindex.ai`. Verified schedules via Cloudflare API: daily `0 9 * * *` and weekly `30 9 * * 1`.
  Triggered production ingest through `/api/admin/ingest?embed_limit=0`; D1 `sync_state` updated and
  `aleabitoreddit` inserted 1 new tweet from GetXAPI. Added/verified weekly persona checkpoint through
  `/api/admin/persona-refresh`; both KOLs now have `persona_version=weekly-2026-06-15`. Final launch checks:
  `npm run preflight` green, `npx tsc --noEmit` green, and live qinbafrank+SOXL chat streams answer with
  citations and chart meta.

- **2026-06-16 (session 5, blocked audit)** — Re-ran launch checks. `npx tsc --noEmit`,
  `node --check scripts/preflight.mjs`, and `node --check scripts/cloudflare-dns-patch.cjs` pass. Product
  runtime is still live: `/` returns the Trader Desk HTML, `/api/kols` returns JSON with qinbafrank and
  aleabitoreddit, `/api/quote?q=SOXL` and `/api/kline?code=usSOXL&limit=5` return live market JSON, and
  `POST /api/chat` for qinbafrank + SOXL streams SSE with meta + `[Tn]` citation in the answer. `npm run
  preflight` can show transient local ECONNRESET on some robindex.ai requests, but direct retry passes.
  The remaining blocker is unchanged and external: Cloudflare API returns 401 `Invalid API Token` for the
  token in `account.guard.json`, so deploy/secret ops and production cron verification cannot be completed
  from this environment until a valid token is supplied or dashboard fallback is explicitly approved.

- **2026-06-16 (session 4, live core verified)** — Production core path is now live. Verified via Node HTTPS
  and browser: `robindex.ai` root shows Trader Desk, `/api/kols` returns 2 KOLs JSON, `/api/quote?q=SOXL`
  returns live Tencent quote, `/api/kline?code=usSOXL&limit=5` returns 5 daily candles, and `POST /api/chat`
  with qinbafrank + SOXL streams an in-character answer with citations `[T1..]` and chart meta
  `{ code: "usSOXL", symbol: "SOXL", market: "us" }`. Added `scripts/preflight.mjs` and `npm run preflight`
  for repeatable launch checks. Remaining ops gap: Cloudflare API token in `account.guard.json` is still not
  usable for wrangler deploy/secret management, so `GETXAPI_KEY` secret and scheduled ingest cannot be
  externally verified from this environment.

- **2026-06-16 (session 3, deployment path audit)** — External/browser verification now shows
  `robindex.ai` root serving the Trader Desk frontend, but `/api/kols` still returns SPA HTML, proving the
  local `run_worker_first` fix has not reached production. Diagnosed the Cloudflare API issue: DNS resolves
  Cloudflare hosts to `198.18.*`; direct `curl --resolve` to Cloudflare Anycast works. Added
  `app/scripts/cloudflare-dns-patch.cjs` plus `npm run whoami:cf` / `npm run deploy:cf` to preload a DNS
  override for wrangler. New hard blocker: the `CLOUDFLARE_API_TOKEN` in `account.guard.json` is rejected
  by Cloudflare as `Invalid API Token`, so deployment and `GETXAPI_KEY` secret write cannot proceed until a
  valid token is supplied or Chrome/dashboard fallback is explicitly approved.

- **2026-06-16 (session 2, launch audit)** — Audited the repo against the previous handoff and found the
  launch record was too optimistic: `robindex.ai` still serves the old stablecoin-private-bank page. Local
  TypeScript check passes. Fixed two launch blockers in code/config: (1) Static Assets SPA fallback was
  intercepting `/api/*`; added `run_worker_first: ["/api/*"]`. (2) `/api/kline` could 500 when Yahoo/Tencent
  history fetch failed; added graceful HTTP 200 degradation. Implemented GetXAPI-first daily cron ingest with
  strict author validation and Apify fallback. Local verification: `wrangler dev --local`, seeded local D1
  schema/minimal KOL rows, `/api/kols` returns JSON, `/api/quote?q=SOXL` returns a live Tencent quote, and
  `/api/kline` degrades safely during network failure. Deployment is blocked by local Cloudflare API TLS
  resets; `GETXAPI_KEY` secret and `wrangler deploy` did **not** complete.

- **2026-06-15 (session 1, qinbafrank LIVE)** — Got a working tweet source: **GetXAPI** (user provided, $10).
  Scraped 721 clean qinbafrank tweets (strict author-guard, curl backend to dodge urllib connection resets),
  loaded + partial-embedded. **Both KOLs now fully live with citations.** Browser-verified: qinbafrank →
  in-character macro answer + HOOD candlestick chart + 原文支持 panel showing 3 real cited tweets (CFTC/
  Rothera/world-cup), exactly matching the reference product. Bug lesson: never use env var name `USERNAME`
  (shell-reserved) — it silently overrode the author guard. Embeddings throttled by Workers AI daily quota
  (70/720) → lexical retrieval covers it; backfill when quota resets.
- **2026-06-15 (session 1, qinbafrank pass)** — Added qinbafrank as a 2nd KOL. Wrote his persona pack and
  loaded his research room (persona-only) — **live and verified answering in-character**. Tweet-corpus
  backfill blocked: ScrapeBadger returns the wrong account (@aaron) intermittently (~800 credits wasted
  before an author-guard caught it; ~10 left), and Apify's apidojo actor returns noResults. Need a working
  tweet source to add his 原文支持 citations. Lesson: always validate scraped `author==target` on page 1
  before bulk-pulling. NOTE: daily cron uses Apify (apidojo) which currently returns noResults → incremental
  sync is effectively a no-op until a working source is wired.
- **2026-06-15 (session 1, UI pass)** — User supplied real reference screenshots + confirmed OpenRouter
  gateway call. Rebuilt the frontend to 1:1 match: research-room landing + full /research workspace
  (sidebar / chat / 原文支持 panel, persona switcher, prompt cards, quota, markdown, charts). Fixed a KV
  TTL bug (45→60s) that 500'd repeat ticker queries. Verified live in-browser end to end. Earlier note said
  apex/www domains were live, but 2026-06-16 launch audit disproved this. Next: build KOL #2 qinbafrank
  (Apify scrape + persona) — UI already wired with a
  graceful "preparing" state until his corpus loads.
- **2026-06-15 (session 1, cont.)** — Shipped a working v1. Deployed Worker (D1+KV+Workers AI+Gateway+cron).
  Built finance service (Tencent quotes/A-HK kline + Yahoo US kline), hybrid RAG, persona injection, SSE
  streaming chat, citations, mobile-first UI with candlestick charts. Loaded aleabitoreddit: 5,857 tweets +
  201 knowledge chunks, all embedded. Resolved gateway auth via OpenRouter route (deepseek-v4-flash/pro).
  Verified in-character chat end-to-end. Attached custom domains — **www.robindex.ai live**, apex provisioning.
  Remaining: confirm apex; add KOL #2 qinbafrank (needs Apify spend); verify cron run; optional polish.
- **2026-06-15** — Phase 0 complete. Verified CF token/zones, financial endpoints (quote/kline/minute),
  and aleabitoreddit corpus + schema. Wrote this plan. Starting Phase 1 scaffold.

---

## 8. Open questions / notes for the human

- Exact 1:1 visual clone of themarketbrew.com/kol isn't possible from here (site TLS/bot-blocks our
  fetches). Building a faithful equivalent in the same spirit; can refine once screenshots are provided.
- `account.guard.json` secrets are committed to git — recommend rotating + gitignoring after launch.
