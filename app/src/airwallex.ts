// Airwallex client for Cloudflare Workers. Second PSP alongside Stripe (src/stripe.ts).
//
// Flow for one-time credit packs (Hosted Payment Page):
//   1. server obtains a 30-min bearer token (login),
//   2. server creates a Payment Intent (we own its id) → { id, client_secret },
//   3. the browser loads Airwallex.js and calls redirectToCheckout(intent_id, client_secret),
//   4. webhook `payment_intent.succeeded` arrives → we map the intent id back to the buyer and grant.
//
// IMPORTANT: Airwallex amounts are in MAJOR units (9.99 = $9.99), unlike Stripe (cents).
import type { Env } from "./env";

function baseApi(env: Env): string {
  return env.AIRWALLEX_ENV === "demo" ? "https://api-demo.airwallex.com" : "https://api.airwallex.com";
}
export function awEnv(env: Env): "demo" | "prod" {
  return env.AIRWALLEX_ENV === "demo" ? "demo" : "prod";
}

// Bearer token is valid 30 min; cache for 25 in KV and reuse.
async function awToken(env: Env): Promise<string> {
  if (!env.AIRWALLEX_API_KEY || !env.AIRWALLEX_CLIENT_ID) throw new Error("airwallex_not_configured");
  const cacheKey = `aw:token:${env.AIRWALLEX_CLIENT_ID}`;
  const cached = await env.CACHE.get(cacheKey);
  if (cached) return cached;
  const res = await fetch(`${baseApi(env)}/api/v1/authentication/login`, {
    method: "POST",
    headers: {
      "x-client-id": env.AIRWALLEX_CLIENT_ID,
      "x-api-key": env.AIRWALLEX_API_KEY,
      "Content-Type": "application/json",
    },
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json.token) throw new Error(`airwallex login ${res.status}: ${json?.message || "error"}`);
  await env.CACHE.put(cacheKey, json.token, { expirationTtl: 1500 });
  return json.token;
}

async function stableRequestId(seed: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed)));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function awPost(env: Env, path: string, body: Record<string, any>): Promise<any> {
  const token = await awToken(env);
  const res = await fetch(`${baseApi(env)}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`airwallex ${path} ${res.status}: ${json?.message || json?.code || "error"}`);
  return json;
}

/** Idempotently create the live recurring product/price used by a KOL subscription. */
export async function provisionKolSubscription(
  env: Env,
  opts: { kolId: string; displayName: string; promoCents: number },
): Promise<{ productId: string; priceId: string }> {
  const product = await awPost(env, "/api/v1/products/create", {
    request_id: await stableRequestId(`robindex:kol-product:${opts.kolId}:${awEnv(env)}`),
    active: true,
    name: `Robindex · ${opts.displayName}`,
    description: `Monthly access to the ${opts.displayName} AI persona on Robindex`,
    unit: "persona",
    metadata: { kol_id: opts.kolId, product: "robindex_persona" },
  });
  if (!product?.id) throw new Error("airwallex product response missing id");
  const price = await awPost(env, "/api/v1/prices/create", {
    request_id: await stableRequestId(`robindex:kol-price:${opts.kolId}:${opts.promoCents}:${awEnv(env)}`),
    active: true,
    billing_type: "IN_ADVANCE",
    currency: "USD",
    pricing_model: "FLAT",
    flat_amount: Math.round(opts.promoCents) / 100,
    recurring: { period: 1, period_unit: "MONTH" },
    description: `${opts.displayName} monthly subscription`,
    product_id: product.id,
    metadata: { kol_id: opts.kolId, product: "robindex_persona" },
  });
  if (!price?.id) throw new Error("airwallex price response missing id");
  return { productId: product.id, priceId: price.id };
}

export interface AwIntent {
  id: string;
  clientSecret: string;
  amount: number;     // major units
  currency: string;
}

/** Create a Payment Intent. amountCents is converted to major units for Airwallex. */
export async function createPaymentIntent(
  env: Env,
  opts: { amountCents: number; currency: string; merchantOrderId: string; returnUrl: string; metadata?: Record<string, string> }
): Promise<AwIntent> {
  const token = await awToken(env);
  const amount = Math.round(opts.amountCents) / 100;
  const res = await fetch(`${baseApi(env)}/api/v1/pa/payment_intents/create`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      request_id: crypto.randomUUID(),
      amount,
      currency: opts.currency.toUpperCase(),
      merchant_order_id: opts.merchantOrderId,
      return_url: opts.returnUrl,
      metadata: opts.metadata || {},
    }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json.id || !json.client_secret) throw new Error(`airwallex intent ${res.status}: ${json?.message || "error"}`);
  return { id: json.id, clientSecret: json.client_secret, amount, currency: opts.currency.toUpperCase() };
}

/** Create a Hosted Billing Checkout for a subscription. Returns { id (bco_…), url } — redirect to url.
 * Unlike packs, subscriptions are fully server-side: Airwallex returns a hosted URL (no JS SDK), the
 * hosted page collects+saves the card, creates the subscription, and AUTO_CHARGEs each month. */
export async function createBillingCheckout(
  env: Env,
  opts: { priceId: string; successUrl: string; cancelUrl: string; metadata: Record<string, string> }
): Promise<{ id: string; url: string }> {
  const token = await awToken(env);
  const res = await fetch(`${baseApi(env)}/api/v1/billing_checkouts/create`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      request_id: crypto.randomUUID(),
      mode: "SUBSCRIPTION",
      success_url: opts.successUrl,
      cancel_url: opts.cancelUrl,
      line_items: [{ price_id: opts.priceId, quantity: 1 }],
      subscription_data: { metadata: opts.metadata },
      metadata: opts.metadata,
    }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json.id || !json.url) throw new Error(`airwallex checkout ${res.status}: ${json?.message || "error"}`);
  return { id: json.id, url: json.url };
}

async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Verify an Airwallex webhook: HMAC-SHA256 over (x-timestamp + raw body) == x-signature (hex).
 * The signing key is the webhook secret; we accept it both as displayed and with the `whsec_` prefix
 * stripped, since Airwallex's prefix convention varies. */
export async function verifyAirwallexWebhook(env: Env, payload: string, timestamp: string, signature: string): Promise<any | null> {
  const secret = env.AIRWALLEX_WEBHOOK_SECRET;
  if (!secret || !timestamp || !signature) return null;
  const candidates = Array.from(new Set([secret, secret.replace(/^whsec_/, "")]));
  const msg = `${timestamp}${payload}`;
  let ok = false;
  for (const cand of candidates) {
    if (timingSafeEq(await hmacHex(cand, msg), signature)) { ok = true; break; }
  }
  if (!ok) return null;
  // 5-minute replay tolerance (timestamp is epoch ms or s; tolerate non-numeric formats).
  const ts = Number(timestamp);
  if (!isNaN(ts)) {
    const ageMs = Math.abs(Date.now() - (ts > 1e12 ? ts : ts * 1000));
    if (ageMs > 5 * 60 * 1000) return null;
  }
  try { return JSON.parse(payload); } catch { return null; }
}
