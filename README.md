# Robindex

Robindex is a Cloudflare-native AI finance persona desk. A user signs in, picks a finance KOL persona, asks a market question, and gets a sourced answer written through that KOL's framework. Every cited claim links back to real tweets in the right-side source rail.

There is no fine-tuning. The product is retrieval, persona distillation, live market tools, and prompt assembly. Model upgrades and better retrieval improve the product without retraining.

## Production

| URL | Purpose |
| --- | --- |
| https://robindex.ai | SEO marketing site |
| https://www.robindex.ai | SEO marketing site |
| https://app.robindex.ai | Robindex Desk product SPA |

The Worker serves both static assets and APIs. API routes are under `/api/*`. App deep links such as `/chat/:id` are served by the Desk SPA on `app.robindex.ai`.

Latest verified production deploy: Cloudflare Worker version `af782781-47b6-4cab-9b12-fb1e9d2d9864` on 2026-06-22.

## Current Product

- Privy login with email and Google.
- Two live personas:
  - `qinbafrank` — macro transmission, AI trend, US stocks, crypto x TradFi.
  - `aleabitoreddit` / Serenity — AI semiconductor supply chain, photonics/CPO.
- Chat answers stream over SSE.
- The answer renderer supports clickable numeric citations.
- Right rail has two tabs: persona profile and cited source tweets.
- Source cards hydrate historical citations back into full tweet text, dates, media, quoted tweets, and X links.
- Desktop layout: sidebar, conversation thread, resizable source rail.
- Mobile layout: top bar, bottom nav, chat/source/persona views.
- Bilingual UI: Chinese and English.
- Themes: Aurora, Terminal, Matrix, Codex.
- Billing/subscription UI, credits, BYOK custom model config, model picker, and reasoning effort controls are present in the frontend.
- Code tab is still a placeholder marked SOON.

## Architecture

One Cloudflare Worker in `app/src/index.ts` serves:

- host routing and SPA fallback
- static marketing and Desk assets through `ASSETS`
- JSON APIs
- SSE chat streaming
- admin endpoints
- scheduled ingest, persona refresh, distill, and eval drivers

| Concern | Implementation |
| --- | --- |
| Marketing site | `app/public/index.html`, `app/public/landing-static.js`, `app/public/app/landing.css` |
| Desk SPA | `app/public/desk.html` with React 18 CDN + Babel JSX files under `app/public/app/` |
| Worker/API | Hono in `app/src/index.ts` |
| Auth | Privy React SDK bundled into `app/public/app/privy-bundle.js` |
| Chat state | localStorage for instant UI, D1 `chat_history` for cloud sync |
| Database | D1 `robindex-db` |
| Raw tweet archive | R2 `robindex-raw` |
| Cache/job state | KV `CACHE` |
| LLM | Cloudflare AI Gateway, mostly DeepSeek V4 Flash/Pro via OpenRouter gateway |
| Retrieval | D1 FTS5 trigram search plus LLM rerank |
| Market data | Tencent quotes/kline, Eastmoney A-share/global data |
| Deploy | Wrangler, `app/wrangler.jsonc` |

## Frontend Map

| File | Role |
| --- | --- |
| `app/public/desk.html` | Product SPA shell |
| `app/public/index.html` | Marketing page HTML |
| `app/public/app/app.jsx` | Main Desk app shell, Privy state, chat state, routing, SSE handling |
| `app/public/app/components.jsx` | Icons, avatar, model picker, answer renderer, source cards |
| `app/public/app/themes.css` | Design tokens, themes, Desk layout, source rail, billing/settings styles |
| `app/public/app/data.js` | KOL data enrichment, API calls, SSE client, history sync helpers |
| `app/public/app/auth.jsx` | Privy login gate |
| `app/public/app/settings.jsx` | Settings and custom model/API key UI |
| `app/public/app/billing.jsx` | Wallet, subscription, checkout, usage, paywall UI |
| `app/public/app/mobile.jsx` | Mobile top bar and bottom nav |
| `app/public/app/i18n.js` | Chinese/English strings |
| `app/public/app/privy-bundle.js` | Browser bundle built from `app/src/privy-entry.js` |

This frontend intentionally has no app build step. JSX is loaded by Babel in the browser. The Privy SDK is the only bundled frontend dependency.

## Backend Map

| File | Role |
| --- | --- |
| `app/src/index.ts` | Worker routes, host routing, SSE chat endpoint, history APIs, admin APIs, cron |
| `app/src/chat.ts` | Prompt assembly, market context, tool phase, model streaming helpers |
| `app/src/rag.ts` | Query-side retrieval, FTS search, LLM rerank, citation construction |
| `app/src/query-plan.ts` | LLM query planning and instrument detection |
| `app/src/source-format.ts` | Citation prompt formatting |
| `app/src/finance.ts` | Quotes and kline helpers |
| `app/src/eastmoney-astock.ts` | A-share fundamentals, fund flow, sectors, reports |
| `app/src/eastmoney-global.ts` | Global equity fundamentals and filings |
| `app/src/marketdata.ts` | Stock and market news |
| `app/src/ingest.ts` | GetXAPI/Apify ingest and raw archive |
| `app/src/persona-distill.ts` | Map/reduce persona distillation |
| `app/src/persona-gen.ts` | Persona generation/evolution/diagnostics |
| `app/src/eval.ts` | Eval cases, scoring, rollback |
| `app/schema.sql` | Baseline D1 schema |
| `app/migrations/` | D1 migrations |

## Request Flow

1. User asks in the Desk composer.
2. Frontend posts to `/api/chat` and reads SSE events.
3. Worker loads the KOL row and persona pack.
4. `planQuery()` expands the question into instruments and search terms.
5. `retrieve()` searches `tweet_search`, reranks candidates, and returns source citations.
6. `gatherMarketData()` fetches relevant quotes, kline, news, and fundamentals.
7. Worker sends citation metadata early so the right rail can populate before the final answer finishes.
8. `buildMessages()` assembles persona, source tweets, live data, history summary, and tool memory.
9. Model output streams back as deltas.
10. Final answer, citations, and tool calls are persisted.

## Chat History And Deep Links

Current URL format is `/chat/:id`, for example `https://app.robindex.ai/chat/m2`.

History sync works like this:

1. localStorage loads first for instant UI.
2. `GET /api/chat/history?user_id=<id>` merges D1 history.
3. Message changes save to localStorage immediately.
4. Cloud save is debounced with `PUT /api/chat/history/:id`.
5. Deep links wait for history loading before rewriting the URL, so direct refresh of `/chat/:id` stays on that chat.

History identity:

- Logged-in users use `privy.user.id`.
- Before login, the app uses local `rx.userId`.
- On login transition, in-memory chats are persisted under the real Privy user id.

History endpoints:

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/api/chat/history?user_id=` | GET | List conversations |
| `/api/chat/history/:id?user_id=` | GET | Fetch one conversation |
| `/api/chat/history/:id` | PUT | Upsert full frontend message payload |
| `/api/chat/history/:id?user_id=` | DELETE | Delete one conversation |

## Source Rail Notes

The source rail is central to the product. Recent fixes to preserve:

- `.rail-scroll>* { flex: 0 0 auto; }` prevents many source cards from being squeezed into one viewport.
- `/api/citations/hydrate` backfills `snippet`, `date`, `url`, `likes`, `views`, media, and quoted tweets for historical citations.
- Source media uses `margin: 10px 0` so the "View on X" footer has the same spacing with or without images.
- Source cards gracefully render when a historical citation is missing text or URL.

If the rail looks wrong, inspect rendered `.src` card height, `.rail-scroll.scrollHeight`, and citation hydration output before changing the design.

## Data Model

Important tables:

| Table | Role |
| --- | --- |
| `kols` | Persona metadata and `persona_pack` |
| `tweets` | Canonical tweet corpus |
| `tweet_tags` | Machine-generated retrieval fields |
| `tweet_search` | FTS5 trigram index |
| `chat_history` | User-scoped full frontend conversation payloads |
| `conversations`, `messages` | Backend chat/message persistence |
| `knowledge_chunks` | Distilled long-form knowledge |
| `persona_facts` | Persona distillation map/reduce state |
| `eval_cases`, `eval_results` | Eval set and scores |
| `sync_state` | Ingest progress |

## Scheduled Jobs

| Cron | Job |
| --- | --- |
| `0 9 * * *` | Daily ingest |
| `30 9 * * 1` | Weekly stance chunk and incremental persona refresh |
| `* * * * *` | Drive in-progress distill/eval jobs |

Cron definitions live in `app/wrangler.jsonc`.

## Local Setup

```bash
cd app
npm install
npm run preflight
```

Useful scripts:

| Command | Purpose |
| --- | --- |
| `npm run preflight` | Verify Cloudflare auth and key production smoke paths |
| `npm run deploy:cf` | Deploy with the Cloudflare DNS patch required for this environment |
| `npm run whoami:cf` | Verify Cloudflare auth |
| `npm run tail` | Tail Worker logs |
| `npm run test:dsl` | Test DSL stream cleaners |
| `npm run test:prompt` | Test prompt formatting |
| `npm run build:privy` | Rebuild `privy-bundle.js` after SDK entry/dependency changes |

## Deploy

Secrets are local and must never be committed. The expected local file is `account.guard.json` at repo root.

Preferred deploy path:

```bash
cd app
npm run preflight
npm run deploy:cf
```

`deploy:cf` sets `NODE_OPTIONS='--require ./scripts/cloudflare-dns-patch.cjs'` before running Wrangler. Use it instead of raw `wrangler deploy` on this machine.

Admin endpoints require `x-admin-key: $ADMIN_KEY`.

Common admin endpoints:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/admin/stats` | Corpus and persona stats |
| `POST /api/admin/ingest` | Trigger ingest |
| `POST /api/admin/distill-auto?kol_id=<id>&reset=1` | Full persona distill |
| `POST /api/admin/eval-run?kol_id=<id>&limit=2` | Eval run |

## Smoke Checks

```bash
curl -s https://robindex.ai/ | head -5
curl -s https://app.robindex.ai/ | head -5
curl -s https://app.robindex.ai/api/kols
curl -s "https://app.robindex.ai/api/tweets?kol_id=qinbafrank&limit=1"
```

For source rail regressions, use Chrome or the in-app browser on a historical chat with many citations and verify:

- URL remains `/chat/:id` after refresh.
- `.src` cards have natural heights, not ~20-30px.
- `.rail-scroll.scrollHeight` is larger than its viewport when there are many citations.
- cards with media have normal spacing above "View on X".

## Repository Layout

```text
.
├── README.md
├── Plan.md
└── app
    ├── package.json
    ├── wrangler.jsonc
    ├── schema.sql
    ├── migrations/
    ├── scripts/
    ├── src/
    └── public/
        ├── index.html
        ├── desk.html
        └── app/
```

## Do Not Commit

- `account.guard.json`
- API keys, Privy secrets, AI Gateway keys, Cloudflare tokens
- raw paid tweet exports unless intentionally archived to R2
- local browser/session data
