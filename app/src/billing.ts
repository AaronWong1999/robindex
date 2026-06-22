// Server-authoritative billing core. The pricing here is the SOURCE OF TRUTH — checkout amounts are
// computed from these constants, never from numbers the client sends. Mirrors public/app/billing.js
// so the UI and the server agree on packs/plans/rates.
import type { Env } from "./env";

const DAY = 86400000;

export const FREE = { cap: 2, model: "flash" };
export const RATE = { in: 0.20, out: 0.90 }; // points per 1K tokens at mult 1.00x

// Credit packs: USD price (cents) → credits. Bonus already folded into `credits`.
export const PACKS: Record<string, { id: string; cents: number; credits: number; label: string }> = {
  starter: { id: "starter", cents: 990,  credits: 5000,  label: "Starter" },
  plus:    { id: "plus",    cents: 1990, credits: 11000, label: "Plus" },
  pro:     { id: "pro",     cents: 4990, credits: 30000, label: "Pro" },
  max:     { id: "max",     cents: 9990, credits: 65000, label: "Max" },
};

// Per-KOL monthly subscription. promoCents is the live launch price; gift = credits granted per period.
export const KOL_PLANS: Record<string, { id: string; name: string; cents: number; promoCents: number; gift: number }> = {
  qinbafrank:     { id: "qinbafrank",     name: "Qinbafrank", cents: 3990, promoCents: 1990, gift: 2000 },
  aleabitoreddit: { id: "aleabitoreddit", name: "Serenity",   cents: 3990, promoCents: 1990, gift: 2000 },
};

// Airwallex recurring Price ids (created once via API in the SYNHEART GROUP LIMITED account,
// USD 19.90/month). Used by the Hosted Billing Checkout. If you recreate the prices, update these.
export const AIRWALLEX_PRICES: Record<string, string> = {
  qinbafrank: "pri_sgpdbtvwkhjpzeoldpt",
  aleabitoreddit: "pri_sgpdtsnpnhjpzf4j1gy",
};

export function planFor(kolId: string) {
  return KOL_PLANS[kolId] || { id: kolId, name: kolId, cents: 3990, promoCents: 1990, gift: 2000 };
}
export function subCents(kolId: string, plan: string): number {
  const p = planFor(kolId);
  return plan === "default" ? p.cents : p.promoCents;
}

export interface AccountRow {
  user_id: string;
  email: string | null;
  credits: number;
  free_used: number;
  free_reset_at: number;
  stripe_customer_id: string | null;
  airwallex_customer_id: string | null;
  created_at: number;
  updated_at: number;
}

export async function ensureAccount(env: Env, userId: string, email?: string): Promise<AccountRow> {
  const now = Date.now();
  const existing = await env.DB.prepare(`SELECT * FROM billing_accounts WHERE user_id=?`)
    .bind(userId).first<AccountRow>();
  if (existing) {
    if (email && !existing.email) {
      await env.DB.prepare(`UPDATE billing_accounts SET email=?, updated_at=? WHERE user_id=?`)
        .bind(email, now, userId).run();
      existing.email = email;
    }
    return existing;
  }
  await env.DB.prepare(
    `INSERT INTO billing_accounts (user_id,email,credits,free_used,free_reset_at,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?)`
  ).bind(userId, email || null, 0, 0, now + DAY, now, now).run();
  return {
    user_id: userId, email: email || null, credits: 0, free_used: 0, free_reset_at: now + DAY,
    stripe_customer_id: null, airwallex_customer_id: null, created_at: now, updated_at: now,
  };
}

/** Roll the free quota window forward if it lapsed. Returns the up-to-date account. */
async function rollFree(env: Env, acct: AccountRow): Promise<AccountRow> {
  const now = Date.now();
  if (now >= acct.free_reset_at) {
    acct.free_used = 0;
    acct.free_reset_at = now + DAY;
    await env.DB.prepare(`UPDATE billing_accounts SET free_used=0, free_reset_at=?, updated_at=? WHERE user_id=?`)
      .bind(acct.free_reset_at, now, acct.user_id).run();
  }
  return acct;
}

/** Full billing snapshot the client renders (balance, subs, ledger, consumption). */
export async function getState(env: Env, userId: string, email?: string) {
  let acct = await ensureAccount(env, userId, email);
  acct = await rollFree(env, acct);
  const now = Date.now();

  const subRows = await env.DB.prepare(
    `SELECT kol_id,status,plan,price_cents,currency,auto_renew,current_period_end FROM billing_subscriptions WHERE user_id=?`
  ).bind(userId).all().then((r) => (r.results || []) as any[]);
  const subs: Record<string, any> = {};
  for (const s of subRows) {
    if (s.status !== "active" || !s.current_period_end || s.current_period_end <= now) continue;
    subs[s.kol_id] = {
      plan: s.plan, priceMonthly: s.price_cents / 100, autoRenew: !!s.auto_renew,
      expiresAt: s.current_period_end,
    };
  }

  const ledger = await env.DB.prepare(
    `SELECT type,credits,usd_cents,kol_id,ref,ts FROM billing_ledger WHERE user_id=? ORDER BY ts DESC LIMIT 100`
  ).bind(userId).all().then((r) => (r.results || []) as any[]);

  const consumption = await env.DB.prepare(
    `SELECT id,kol_id,model,tok_in,tok_out,points,free,byok,q,ts FROM billing_consumption WHERE user_id=? ORDER BY ts DESC LIMIT 80`
  ).bind(userId).all().then((r) => (r.results || []) as any[]);

  return {
    credits: acct.credits,
    freeUsed: acct.free_used,
    freeResetAt: acct.free_reset_at,
    subs,
    ledger: ledger.map((e) => ({ type: e.type, credits: e.credits, usd: e.usd_cents != null ? e.usd_cents / 100 : undefined, kol: e.kol_id, ref: e.ref, ts: e.ts })),
    consumption: consumption.map((e) => ({ id: e.id, kol: e.kol_id, model: e.model, tokIn: e.tok_in, tokOut: e.tok_out, points: e.points, free: !!e.free, byok: !!e.byok, q: e.q ? { zh: e.q, en: e.q } : null, ts: e.ts })),
  };
}

/** Grant top-up credits. Idempotent via billing_payments PK upstream; ledger.ref dedupes here too. */
export async function grantTopup(env: Env, userId: string, packId: string, ref: string) {
  const pack = PACKS[packId];
  if (!pack) throw new Error(`unknown pack ${packId}`);
  const dup = await env.DB.prepare(`SELECT id FROM billing_ledger WHERE ref=? AND type='topup'`).bind(ref).first();
  if (dup) return;
  const now = Date.now();
  await ensureAccount(env, userId);
  await env.DB.batch([
    env.DB.prepare(`UPDATE billing_accounts SET credits=credits+?, updated_at=? WHERE user_id=?`).bind(pack.credits, now, userId),
    env.DB.prepare(`INSERT INTO billing_ledger (id,user_id,type,credits,usd_cents,ref,ts) VALUES (?,?,?,?,?,?,?)`)
      .bind(crypto.randomUUID(), userId, "topup", pack.credits, pack.cents, ref, now),
  ]);
}

/** Activate or renew a KOL subscription and grant its gift credits. */
export async function activateSubscription(
  env: Env, userId: string, kolId: string, plan: string,
  opts: { provider: string; providerSubId?: string; periodEnd?: number; ref: string }
) {
  const p = planFor(kolId);
  const cents = subCents(kolId, plan);
  const now = Date.now();
  const periodEnd = opts.periodEnd || now + 30 * DAY;
  await ensureAccount(env, userId);

  // Idempotency: don't double-gift for the same provider event ref.
  const dup = await env.DB.prepare(`SELECT id FROM billing_ledger WHERE ref=? AND type='subscription'`).bind(opts.ref).first();

  const existing = await env.DB.prepare(`SELECT id FROM billing_subscriptions WHERE user_id=? AND kol_id=?`).bind(userId, kolId).first<{ id: string }>();
  const subId = existing?.id || crypto.randomUUID();
  const stmts = [
    existing
      ? env.DB.prepare(`UPDATE billing_subscriptions SET status='active', plan=?, price_cents=?, auto_renew=1, current_period_end=?, provider=?, provider_sub_id=?, updated_at=? WHERE id=?`)
          .bind(plan, cents, periodEnd, opts.provider, opts.providerSubId || null, now, subId)
      : env.DB.prepare(`INSERT INTO billing_subscriptions (id,user_id,kol_id,status,plan,price_cents,currency,auto_renew,current_period_end,provider,provider_sub_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .bind(subId, userId, kolId, "active", plan, cents, "usd", 1, periodEnd, opts.provider, opts.providerSubId || null, now, now),
  ];
  if (!dup) {
    stmts.push(env.DB.prepare(`UPDATE billing_accounts SET credits=credits+?, updated_at=? WHERE user_id=?`).bind(p.gift, now, userId));
    stmts.push(env.DB.prepare(`INSERT INTO billing_ledger (id,user_id,type,credits,kol_id,ref,ts) VALUES (?,?,?,?,?,?,?)`)
      .bind(crypto.randomUUID(), userId, "subscription", p.gift, kolId, opts.ref, now));
  }
  await env.DB.batch(stmts);
}

export async function setSubscriptionStatus(env: Env, providerSubId: string, status: string, autoRenew?: boolean) {
  const now = Date.now();
  if (autoRenew == null) {
    await env.DB.prepare(`UPDATE billing_subscriptions SET status=?, updated_at=? WHERE provider_sub_id=?`).bind(status, now, providerSubId).run();
  } else {
    await env.DB.prepare(`UPDATE billing_subscriptions SET status=?, auto_renew=?, updated_at=? WHERE provider_sub_id=?`).bind(status, autoRenew ? 1 : 0, now, providerSubId).run();
  }
}

/** Webhook idempotency guard: returns true if this event was already handled. */
export async function eventSeen(env: Env, provider: string, eventId: string): Promise<boolean> {
  const seen = await env.DB.prepare(`SELECT event_id FROM billing_events WHERE event_id=?`).bind(eventId).first();
  if (seen) return true;
  await env.DB.prepare(`INSERT OR IGNORE INTO billing_events (event_id,provider,ts) VALUES (?,?,?)`).bind(eventId, provider, Date.now()).run();
  return false;
}
