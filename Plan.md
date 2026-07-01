# Robindex Plan

Last updated: 2026-07-01.

Use `README.md` as the handoff source of truth for architecture, files, deploys, and operational notes. This file is only the current product status, recent changes, and next work.

## Live Status

| Area | Status |
| --- | --- |
| Marketing | Live at https://robindex.ai and https://www.robindex.ai |
| Product | Live at https://app.robindex.ai |
| Auth | Privy email + Google |
| Personas | `qinbafrank`, `aleabitoreddit` / Serenity, `shufen46250836` / shu fen |
| Chat | SSE streaming, sourced answer renderer, D1/localStorage history sync |
| Deep links | `/chat/:id` direct load and refresh |
| Source rail | Persona/source tabs, full tweet hydration, media and quoted tweet cards |
| Deploy | `cd app && npm run deploy:cf` |

Latest verified deploy: `0374984b-4ad5-4af3-8f8f-e48077719ec1`.

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
- New KOL onboarding is targeted, resumable, publish-gated, and backed by durable D1 job state.
- Hidden self-serve onboarding uses a rotatable bearer invite, signed session cookie, D1 request
  queue, IP/session quotas, multi-level reduce, automatic public metadata, and deferred billing.
- Distill/eval continuation state is stored in D1 and resumed by the minute cron; Worker termination,
  self-fetch loss, KV expiry, and orphaned eval reservations no longer require a local operator.
- Persona updates are candidate-first across onboarding, weekly updates, and monthly full audits;
  topic coverage plus citation relevance/entailment are publish gates.
- Market context carries canonical instrument names and asset types; the source rail contains only
  references actually used by the final answer.
- ETF questions load current holdings/weights before answering; ticker evidence gates reject generic
  same-word matches, and citations use one cumulative sequence across the conversation.
- KOL presentation and subscription metadata are API-driven; the Desk and marketing roster no longer need a release for each new public KOL.

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
4. Self-service personas: replace the current hidden bearer invite with authenticated ownership,
   moderation, per-user billing and cross-device recovery when the feature becomes public.
5. Evaluation quality: add pairwise answer comparison and more real user questions.
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
# 2026-07-01 Persona 评测与成本修复

- [x] 禁止自动周更/月更调用模型
- [x] 禁止失败任务和孤立 KV cursor 自动复活
- [x] 排除 Persona backup RAG 污染并限制上下文
- [x] 关闭后台模型 reasoning
- [x] 将评测缩为金融相关 8+4 题、确定性检索和单一联合裁判
- [x] 保存回答、引用和裁判原文
- [x] 发布门禁加入 65% 单题通过率和 stance/专项检查
- [x] 质量失败不再自动重做
- [x] 增加任务、步骤和 map chunk 成本上限
- [x] 用户模型流量走 OpenRouter，系统 Persona/蒸馏/评测走 DeepSeek 官方 API
- [ ] 以受控全新账号执行一次生产 canary
