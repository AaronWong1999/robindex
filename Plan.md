# Robindex Plan

Last updated: 2026-06-20.

Read `README.md` for architecture, deploy steps, and repo layout. This file tracks live status, recent changes, and next work.

## Live Status

| What | Where |
| --- | --- |
| Marketing site | https://robindex.ai , https://www.robindex.ai |
| Product (Desk) | https://app.robindex.ai |
| Worker version | Deployed via `npm run deploy` in `app/` |

Live personas:

- `qinbafrank` — `v2-mapreduce-2026-06-18`
- `aleabitoreddit` — `v2-mapreduce-2026-06-19`

## What Shipped (2026-06-20)

### Design system + domain split

- Applied Claude Code design (Antigravity-style landing + WorkBuddy/Codex Desk UI).
- **Marketing**: static `index.html` (SEO-first — content in HTML, OG/hreflang/JSON-LD).
- **Product**: React 18 SPA via `desk.html` + `app/public/app/`, no build step.
- **Domains**: `robindex.ai` / `www` → landing; `app.robindex.ai` → Desk. Main-domain `/research`, `/desk`, `/kol/*` redirect to app subdomain.

### Robindex Desk

- Stack: React 18 CDN + Babel standalone
- Layout: sidebar · thread · resizable sources rail (desktop); bottom nav (mobile)
- 4 themes: Terminal, Aurora, Matrix, Codex
- Model picker + reasoning effort (Low / Med / High / Max)
- Bilingual 中/EN
- Mock auth (localStorage); settings overlay
- Code tab placeholder (SOON — Step 2)

### Cloud chat history (D1)

- Migration `0008_user_chat_history.sql` — `chat_history` table
- APIs: `GET/PUT/DELETE /api/chat/history`
- Frontend: localStorage + 2s debounced D1 sync + merge on init
- URL `?chat=<id>` restores active conversation

## Current Pipeline

### Full backfill

`POST /api/admin/distill-auto?kol_id=<id>&reset=1`

1. `map` — flash partial persona over corpus chunks
2. `group` — pro group reduce
3. `final` — pro final draft
4. `finalize` — quote verification, exemplars, publish
5. `eval` — flash answer/judge; rollback only if full eval regresses

### Weekly update

`runWeeklyPersonaRefresh()`:

1. Weekly stance chunk when enough new tweets exist
2. `distillPersonaIncremental()` if `persona_facts:merged` exists
3. 12-case smoke eval
4. Suspicious smoke → full eval via `distill_job:<kol>` KV queue

## Known Constraints

- Cloudflare Worker CPU/time limits bound chat and distill jobs.
- Auth is mock (localStorage UUID). Real auth needed for reliable cross-device sync.
- Citation persistence on refresh has been improved but may need more hardening.
- GetXAPI timeline depth is finite; very old quoted context may be missing.
- `account.guard.json` holds live secrets locally — never commit.

## Next Work

1. **Step 2 — KOL writes code**: Persona turns thesis into backtestable strategy code (UI marked SOON).
2. **Real auth**: Cloudflare Access or JWT; replace mock UUID with email-based identity.
3. **Citation hardening**: Source tweets reliably survive refresh and history restore.
4. **More KOLs**: Self-serve onboarding path.
5. **Eval quality**: Pairwise comparison, citation relevance scoring, real user questions.