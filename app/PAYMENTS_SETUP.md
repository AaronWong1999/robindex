# Robindex 支付接入指南（Stripe，香港公司）

这套代码已经把"假的"前端计费换成了**真实可收款**的系统。剩下的是你在 Stripe 后台和命令行里要做的几步。按顺序做即可。

## 已经写好的代码（无需你动）

| 文件 | 作用 |
|---|---|
| `migrations/0009_billing.sql` | D1 账单表：余额、订阅、流水、消费、支付、Webhook 去重 |
| `src/auth.ts` | 验证 Privy 登录 token（ES256），后端只信任验证过的用户身份 |
| `src/billing.ts` | 服务端权威定价 + 余额/订阅逻辑（积分只能由 Webhook 发放） |
| `src/stripe.ts` | Stripe REST 下单 + Webhook 签名验证 |
| `src/index.ts` | 路由：`/api/billing/state`、`/api/billing/checkout`、`/api/billing/consume`、`/api/billing/autorenew`、`/api/stripe/webhook` |
| `public/app/billing.js` / `billing.jsx` / `app.jsx` | 前端：登录后从服务端同步真实余额，下单跳转 Stripe |

**安全要点**：金额一律由服务端从价目表计算，绝不信任浏览器传来的数字；积分只在 Webhook 验签通过后发放（Stripe 与 Airwallex 同理）。

**法律主体**：页脚已注明"由 SYNHEART GROUP LIMITED（心合集團有限公司）运营"。

**当前状态（2026-06）**：Stripe 注册中、未通过审核 → 暂不可用。Airwallex 已审核通过 → **先用 Airwallex 收一次性积分包**。订阅（每月自动续费）走 Stripe，等审核通过再开。

---

# A. Airwallex 接入（积分充值包，现在就能收真钱）

> ⚠️ 你在对话里贴出过 Scoped API 密钥明文。**请先去 Airwallex 后台 → Developer → API keys 重新生成一把新的**，把旧的作废。下面用新密钥。

**积分包 + 订阅都已接通。** 订阅需要 **Admin key**（Billing API 强制），而 Admin key 同时也能用于积分包，所以 worker 只需配这**一把** Admin key。

已替你在账户里建好（USD 19.90/月，via API）：
- Qinbafrank：product `prd_sgpd8cx8ghjpze80k60` / price `pri_sgpdbtvwkhjpzeoldpt`
- Serenity：product `prd_sgpdtsnpnhjpzf49ug9` / price `pri_sgpdtsnpnhjpzf4j1gy`

## A1. 设置密钥（命令行，`app/` 目录下）

```bash
npx wrangler secret put AIRWALLEX_API_KEY      # 粘贴 Admin API key
npx wrangler secret put AIRWALLEX_CLIENT_ID    # 粘贴 Admin Client ID：DI0p9TxkRDa7m0EhFZo5Sg
```

> ⚠️ 你在对话里贴过这把 Admin key（全账户权限）。**整套配好、测通后，去 Airwallex 后台作废它、重新生成一把，再 `wrangler secret put` 覆盖。** 生产环境默认 `prod`，无需额外设置。

## A2. 建账单表（线上库，只需一次；Stripe/Airwallex 共用同一套表）

```bash
npx wrangler d1 execute robindex-db --remote --file=./migrations/0009_billing.sql
```

## A3. 配置 Webhook

1. Airwallex 后台 → **Developer → Webhooks → Add webhook**。
2. URL 填：`https://app.robindex.ai/api/airwallex/webhook`
3. 订阅事件：
   - **`payment_intent.succeeded`**（积分包一次性付款）
   - **Billing 类**：发票支付成功（invoice paid / payment succeeded）、订阅取消（subscription cancelled）。在事件列表里勾选 Billing 分组的相关事件即可——我们的处理器按名字模糊匹配，勾全 Billing 事件最稳。
   - ⚠️ Billing 事件要求账户/Webhook 的 **API 版本 ≥ 2025-06-16**，否则订阅事件不会推送。后台创建 Webhook 时如有版本选项，选最新。
4. 创建后复制该 webhook 的 **Secret key**（签名密钥），写入：

```bash
npx wrangler secret put AIRWALLEX_WEBHOOK_SECRET
```

## A4.（可选但推荐）先用 Demo 环境测试

生产密钥直接测订阅会真实扣款。要无风险端到端测试，可在 https://demo.airwallex.com 生成一套 Demo Admin key + webhook，并在 `wrangler.jsonc` 的 `vars` 临时加 `"AIRWALLEX_ENV": "demo"`，用 Demo 测试卡跑通后删掉、切回生产。（注意：Demo 与生产是两套独立的 product/price id，Demo 测试需在 Demo 账户另建一遍，或我帮你建。）

## A5. 部署 + 验证

```bash
npm run deploy
```

打开 https://app.robindex.ai → 登录：
- **积分包**：钱包买一个包 → 跳 Airwallex 收银台 → 付款 → 回 App 几秒内积分到账。
- **订阅**：订阅某个博主 → 跳 Airwallex 托管订阅收银台 → 付款 → 订阅激活 + 赠送积分到账，之后每月自动续费。

排查：Airwallex 后台 → Webhooks 看事件是否 200；或 `npx wrangler tail` 看实时日志。第一次真实付款后，可在 Airwallex Webhook 事件日志里看到**确切的事件名**——如与我们的模糊匹配有出入，告诉我，我精确对一下。

---

# B. Stripe 接入（订阅 + 积分包，等审核通过后开）

你贴的 `pk_live_...` 是**可公开的 Publishable key**，我们不用它（我们用的是 `sk_...` Secret key）。等 Stripe 审核通过再做下面几步。

## 第 1 步：激活 Stripe 香港账户（有审核期，最先做）

1. 登录 https://dashboard.stripe.com ，确认右上角国家是 **Hong Kong**。
2. 点 **Activate account / 激活账户**，填：公司类型、商业登记证(BR)号、公司地址、董事身份证、收款银行账户。
3. 提交等审核（1–3 天）。**审核期间用测试模式(Test mode)即可开发测试，不影响。**

## 第 2 步：拿测试密钥（Test keys）

1. Dashboard 左上角把开关切到 **Test mode**（测试模式）。
2. 左侧 **Developers → API keys**。
3. 复制 **Secret key**，形如 `sk_test_...`（**不要**用 Publishable key，我们用的是 secret key）。

## 第 3 步：把密钥写进 Worker（命令行）

在 `app/` 目录下运行（会提示你粘贴上一步的 `sk_test_...`）：

```bash
npx wrangler secret put STRIPE_SECRET_KEY
```

Webhook secret 要等第 5 步建好 Webhook 才有，先放着。

## 第 4 步：把账单表建到线上数据库

```bash
npx wrangler d1 execute robindex-db --remote --file=./migrations/0009_billing.sql
```

## 第 5 步：配置 Webhook（积分到账的关键）

1. Dashboard（仍在 Test mode）→ **Developers → Webhooks → Add endpoint**。
2. **Endpoint URL** 填：`https://app.robindex.ai/api/stripe/webhook`
3. **Select events** 勾选这 4 个：
   - `checkout.session.completed`
   - `invoice.paid`
   - `customer.subscription.deleted`
   - `customer.subscription.updated`
4. 创建后，在该 endpoint 页面点 **Signing secret → Reveal**，复制 `whsec_...`。
5. 写进 Worker：

```bash
npx wrangler secret put STRIPE_WEBHOOK_SECRET
```

## 第 6 步：部署

```bash
npm run deploy
```

## 第 7 步：用测试卡跑通

1. 打开 https://app.robindex.ai ，登录。
2. 进 Wallet（钱包）买一个积分包，或订阅某个博主 → 会跳到 Stripe 收银台。
3. 用测试卡：
   - 卡号 `4242 4242 4242 4242`
   - 有效期：任意未来日期（如 `12/34`）
   - CVC：任意 3 位
   - 姓名/邮编：随便填
4. 支付成功后会跳回 App，**几秒内余额/订阅自动到账**（Webhook 发放）。
5. 在 Stripe Dashboard → Payments 能看到这笔测试付款；→ Webhooks 能看到事件 200 成功。

如果余额没到账：看 Dashboard → Webhooks → 你的 endpoint → 最近事件，是不是 200。若 400 多半是 `STRIPE_WEBHOOK_SECRET` 没设对；若 401/404 检查 URL。也可以 `npx wrangler tail` 看实时日志。

## 第 8 步：上线收真钱

1. Stripe 审核通过后，把 Dashboard 切到 **Live mode**。
2. 重复第 2、5 步拿 **live** 的 `sk_live_...` 和 live 的 `whsec_...`（live 和 test 是两套，互不通用），分别 `wrangler secret put` 覆盖。
3. `npm run deploy`。
4. 用真卡小额试一笔，确认到账后即正式收费。

> 注意：积分包是一次性付款；博主订阅是每月自动续费。退款在 Stripe Dashboard 操作；自动续费用户可在 Wallet/订阅页关闭。

---

## 之后：接入 Airwallex 做费率对比（第二家）

代码已按"支付商无关"设计（`billing_*` 表都有 `provider` 列，余额发放逻辑与 Stripe 解耦）。接 Airwallex 时只需新增 `src/airwallex.ts`（建 Payment Intent + 验 Webhook）和一条 `/api/airwallex/webhook` 路由，复用 `grantTopup` / `activateSubscription`。等 Stripe 跑通、你拿到两边真实费率后再做，我可以接着加。

**费率参考**（以官网为准，会变）：Stripe 香港约 3.4% + HK$2.35（境外卡更高）；Airwallex 通常更低且跨境/外币更省。两边都先用测试模式跑通，再按真实结算对比。
