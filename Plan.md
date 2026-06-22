# Robindex Plan

Last updated: 2026-06-22.

Use `README.md` as the handoff source of truth for architecture, files, deploys, and operational notes. This file is only the current product status, recent changes, and next work.

## Live Status

| Area | Status |
| --- | --- |
| Marketing | Live at https://robindex.ai and https://www.robindex.ai |
| Product | Live at https://app.robindex.ai |
| Auth | Privy email + Google |
| Personas | `qinbafrank`, `aleabitoreddit` / Serenity |
| Chat | SSE streaming, sourced answer renderer, D1/localStorage history sync |
| Deep links | `/chat/:id` direct load and refresh |
| Source rail | Persona/source tabs, full tweet hydration, media and quoted tweet cards |
| Deploy | `cd app && npm run deploy:cf` |

Latest verified deploy: `af782781-47b6-4cab-9b12-fb1e9d2d9864`.

## Recently Shipped

### Product UI

- Three-column Desk with resizable right source rail.
- Mobile top bar and bottom nav.
- Four themes: Aurora, Terminal, Matrix, Codex.
- Chinese/English UI.
- Model picker with platform models, BYOK custom models, and reasoning effort.
- Billing, subscription, usage, wallet, checkout, and paywall UI surfaces.
- Code tab placeholder remains marked SOON.

### Auth And History

- Replaced mock login with Privy native login modal.
- Cloud history persists full frontend message payloads in D1 `chat_history`.
- Logged-in users sync under `privy.user.id`.
- Deep links use `/chat/:id`.
- Direct refresh of `/chat/:id` no longer races back to `/`.

### Source Rail Hardening

- Fixed flex shrink bug that compressed 18 source cards into one viewport.
- Hydrate endpoint now restores full tweet text, date, X URL, media, quoted tweet, likes, and views for historical citations.
- Source cards render stable fallback states when old citation payloads are incomplete.
- Cards with media now keep the same footer spacing as cards without media.

### Ops

- `npm run preflight` verifies Cloudflare auth and production smoke paths.
- `npm run deploy:cf` is the preferred deploy path because it loads `scripts/cloudflare-dns-patch.cjs`.

## Known Constraints

- The frontend still uses browser-loaded Babel JSX rather than a normal app build.
- `privy-bundle.js` is checked in and must be rebuilt with `npm run build:privy` when Privy dependency/entry changes.
- Code generation/backtest tab is product placeholder only.
- Billing/subscription UI exists, but payment/business logic should be audited before depending on it for revenue enforcement.
- Worker CPU/time limits shape chat, distill, and eval job design.
- Very old quoted tweet context can still be missing if the corpus does not contain it and short-link expansion fails.
- Secrets live locally in `account.guard.json`; never commit.

## Next Work

1. Code tab: turn persona theses into runnable strategy/backtest code instead of placeholder UI.
2. Auth hardening: ensure every history, subscription, and billing endpoint derives user identity server-side rather than trusting client `user_id`.
3. Billing enforcement: connect subscription/credits state to backend model access and usage accounting.
4. More personas: add a repeatable onboarding/admin path for new KOLs.
5. Evaluation quality: add pairwise answer comparison, citation relevance checks, and more real user questions.
6. Frontend build: consider replacing in-browser Babel with a small Vite/esbuild pipeline once product surface stabilizes.
7. Observability: add targeted logs/metrics for chat latency, retrieval quality, citation hydration misses, and source rail errors.

## Handoff Checklist

Before shipping frontend changes:

- Run `cd app && npm run preflight`.
- Check `https://app.robindex.ai/chat/<id>` direct refresh when touching history/routing.
- Check a source rail with many citations and one card with media.
- Confirm mobile still has bottom navigation and source view.
- Deploy with `npm run deploy:cf`.

Before shipping backend/chat changes:

- Run `npm run test:dsl` if streaming cleaner or tool DSL changed.
- Run `npm run test:prompt` if prompt formatting changed.
- Smoke `/api/kols`, `/api/tweets`, and one chat path.
- Do not commit local secrets or raw paid data.
