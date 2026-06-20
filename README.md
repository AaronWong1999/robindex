# Robindex

Robindex is a Cloudflare-native AI trader desk. A user picks a finance KOL persona and asks questions — the model answers **as** that KOL, grounded in the KOL's real historical tweets, a distilled persona pack, and live market data, with clickable source-tweet citations.

There is no fine-tuning. The system is retrieval + persona distillation + tools, so model upgrades improve the product without retraining.

## Production

| URL | Purpose |
| --- | --- |
| https://robindex.ai | Marketing site (static landing page, SEO) |
| https://www.robindex.ai | Same as above |
| https://app.robindex.ai | **Robindex Desk** — the product (React SPA) |

API routes (`/api/*`) work on all three hosts. Visiting `/research`, `/desk`, or `/kol/*` on the marketing domain redirects to `app.robindex.ai`.

## Current State

- Live KOLs:
  - `qinbafrank` — persona `v2-mapreduce-2026-06-18`, ~13.7k tweets
  - `aleabitoreddit` — persona `v2-mapreduce-2026-06-19`, ~5.9k tweets
- Both KOLs have full-corpus `persona_facts:merged`; weekly updates use incremental map-reduce.
- Tweet corpora and FTS5 search indexes live in D1; raw paid tweet pulls archived in R2.

## Architecture

One Cloudflare Worker (`app/src/index.ts`) serves static assets and JSON/SSE APIs.

| Concern | Implementation |
| --- | --- |
| Marketing site | Static HTML at `app/public/index.html` + `landing-static.js` + `app/public/app/landing.css` |
| Desk SPA | `app/public/desk.html` → React 18 (CDN + Babel) in `app/public/app/` |
| API / SSE chat | Hono Worker in `app/src/index.ts` |
| Chat history | D1 `chat_history` + localStorage sync |
| Database | D1 `robindex-db` |
| Raw archive | R2 `robindex-raw` |
| Cache | KV `CACHE` |
| LLM | Cloudflare AI Gateway → `deepseek/deepseek-v4-flash` / `deepseek/deepseek-v4-pro` |
| Market data | Tencent quote/kline, Eastmoney A-share/global |
| Cron | daily ingest, weekly persona refresh, per-minute distill job driver |

Retrieval uses **FTS5**, not vectors. Finance tweets are short, bilingual, and jargon-dense; sparse retrieval plus LLM query expansion has been more controllable than embeddings.

### Domain routing (Worker)

Host-based routing in `app/src/index.ts`:

- `robindex.ai` / `www.robindex.ai` → `/` serves static landing; app paths redirect to `app.robindex.ai`
- `app.robindex.ai` → `/` and unmatched non-API paths serve `desk.html` (SPA shell)

Custom domains are declared in `app/wrangler.jsonc`.

## Frontend

### Marketing site (static)

`app/public/index.html` is a single static page for SEO:

- Full Chinese body content in HTML (crawlable without JS)
- Open Graph, Twitter Card, canonical, hreflang, JSON-LD
- `landing-static.js` — theme toggle, 中/EN copy swap, nav scroll, reveal animations
- Styles: `app/public/app/themes.css` (design tokens) + `app/public/app/landing.css`

All CTAs point to `https://app.robindex.ai/`.

### Robindex Desk (SPA)

Entry: `app/public/desk.html` (served at `https://app.robindex.ai/`).

| File | Purpose |
| --- | --- |
| `themes.css` | 4-theme design system (Terminal / Aurora / Matrix / Codex) + layout |
| `landing.css` | Marketing page only |
| `i18n.js` | Bilingual UI strings (中/EN) |
| `data.js` | KOL enrichment, `/api/kols` init, SSE `/api/chat`, `/api/suggest`, cloud history |
| `components.jsx` | Icons, Avatar, ModelPicker (incl. reasoning effort), citations, rail |
| `auth.jsx` | Login screen (mock — email/social/wallet → localStorage) |
| `settings.jsx` | Settings overlay |
| `mobile.jsx` | Mobile top bar + bottom nav |
| `app.jsx` | App shell: auth gate, chat state, SSE, resizable sources rail, cloud sync |

Desk features: three-column desktop (sidebar · thread · rail), mobile bottom nav, 4 themes, model + reasoning-effort picker, bilingual UI, PWA manifest.

### Chat history sync

1. **Init**: localStorage → merge cloud (`GET /api/chat/history`) → dedupe by id and `kol_id::title`
2. **On change**: localStorage (instant) → debounced 2s cloud save (`PUT /api/chat/history/:id`)
3. **URL**: active chat tracked via `?chat=<id>`, auto-opens on load
4. **User id**: random UUID in localStorage (`rx.userId`)

| Endpoint | Method | Description |
| --- | --- | --- |
| `/api/chat/history?user_id=` | GET | List conversations |
| `/api/chat/history/:id?user_id=` | GET | Single conversation |
| `/api/chat/history/:id` | PUT | Upsert conversation |
| `/api/chat/history/:id?user_id=` | DELETE | Delete conversation |

## How A Reply Is Built

1. Chat endpoint loads KOL row and `persona_pack`.
2. `planQuery()` expands the question into instruments and bilingual search terms.
3. `retrieve()` searches that KOL's corpus in `tweet_search`, then `llmRerank()` picks source tweets.
4. `gatherMarketData()` injects quotes, K-lines, news, fundamentals, benchmark context.
5. `buildMessages()` assembles system prompt with persona pack, citations, live data.
6. Bounded tool phase fetches missing data; answer streams over SSE.

## Persona Pipeline

Full-corpus generation: `POST /api/admin/distill-auto?kol_id=<id>&reset=1`

1. `mapStage` — flash partial persona over corpus chunks
2. `reduceGroup` — pro group merge
3. `reduceFinalDraft` — pro final draft
4. `finalizeMerged` — quote verification, exemplars, publish `persona_pack`
5. Eval scores new persona; rollback only on regression

## Scheduled Jobs

| Cron | Job |
| --- | --- |
| `0 9 * * *` | Daily GetXAPI ingest |
| `30 9 * * 1` | Weekly stance chunk + incremental persona refresh |
| `* * * * *` | Drive in-progress distill-auto / eval jobs from KV |

## Data Model

See `app/schema.sql` and `app/migrations/`.

| Table | Role |
| --- | --- |
| `kols` | KOL metadata, `persona_pack` |
| `tweets` | Canonical tweet corpus |
| `tweet_search` | FTS5 index (trigram) |
| `chat_history` | User-scoped conversations (full message JSON) |
| `persona_facts` | Map/reduce partials and merged persona JSON |
| `eval_cases`, `eval_results` | Golden eval set and version scores |

## Operations

Secrets live in `account.guard.json` at repo root (gitignored). Never commit it.

```bash
cd app
export CLOUDFLARE_API_KEY=$(node -p "require('../account.guard.json').CLOUDFLARE_API_KEY")
export CLOUDFLARE_EMAIL=$(node -p "require('../account.guard.json').expectedEmail")
unset CLOUDFLARE_API_TOKEN   # use Global API Key + email, not a token
export NODE_OPTIONS='--require ./scripts/cloudflare-dns-patch.cjs'

npx tsc --noEmit
npm run deploy
```

Admin endpoints require header `x-admin-key: $ADMIN_KEY`:

- `GET /api/admin/stats`
- `POST /api/admin/ingest`
- `POST /api/admin/distill-auto?kol_id=<id>&reset=1`
- `POST /api/admin/eval-run?kol_id=<id>&limit=2`

Smoke checks:

```bash
curl -s https://robindex.ai/ | head -5                    # static landing
curl -s https://app.robindex.ai/ | head -5                # desk SPA
curl -s https://robindex.ai/api/kols
curl -s "https://robindex.ai/api/tweets?kol_id=qinbafrank&limit=1"
```

## Repository Layout

```
app/
  src/index.ts          Worker: routes, host routing, SSE chat, admin, cron
  src/chat.ts           Prompt assembly, market context, tools, streaming
  src/rag.ts            FTS retrieval, rerank, quote attachment
  src/persona-distill.ts  Map-reduce persona generation
  src/eval.ts           Eval set, scoring, rollback
  public/
    index.html          Marketing site (static, SEO)
    desk.html           Desk SPA shell
    landing-static.js   Landing page JS (theme, i18n, nav)
    app/                Desk + shared design system (React JSX, CSS, data)
  migrations/           D1 migrations
  wrangler.jsonc        Worker config + custom domains
  schema.sql            D1 baseline schema
```