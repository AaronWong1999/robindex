// Minimal Stripe client for Cloudflare Workers. There is no Node SDK here, so we hit the REST API
// directly with fetch + form-encoded bodies, and verify webhook signatures with Web Crypto.
import type { Env } from "./env";

const STRIPE_API = "https://api.stripe.com/v1";

// Flatten a nested object into Stripe's bracketed form-encoding, e.g.
//   { line_items: [ { price_data: { currency: "usd" } } ] }
//   → line_items[0][price_data][currency]=usd
function encodeForm(obj: any, prefix = "", out: string[] = []): string {
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val == null) continue;
    const k = prefix ? `${prefix}[${key}]` : key;
    if (typeof val === "object") encodeForm(val, k, out);
    else out.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(val))}`);
  }
  return out.join("&");
}

async function stripe(env: Env, path: string, body: any): Promise<any> {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: encodeForm(body),
  });
  const json: any = await res.json();
  if (!res.ok) throw new Error(`stripe ${path} ${res.status}: ${json?.error?.message || "error"}`);
  return json;
}

export interface CheckoutInput {
  kind: "pack" | "sub";
  userId: string;
  email?: string;
  ref: string;          // packId or kolId
  name: string;         // line-item display name
  amountCents: number;
  recurring?: boolean;  // true for subscriptions
  successUrl: string;
  cancelUrl: string;
  metadata?: Record<string, string>;
}

/** Create a hosted Checkout Session and return { id, url }. */
export async function createCheckoutSession(env: Env, input: CheckoutInput): Promise<{ id: string; url: string }> {
  const priceData: any = {
    currency: "usd",
    unit_amount: input.amountCents,
    product_data: { name: input.name },
  };
  if (input.recurring) priceData.recurring = { interval: "month" };

  const body: any = {
    mode: input.recurring ? "subscription" : "payment",
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    client_reference_id: input.userId,
    line_items: [{ quantity: 1, price_data: priceData }],
    metadata: { userId: input.userId, kind: input.kind, ref: input.ref, ...(input.metadata || {}) },
  };
  if (input.email) body.customer_email = input.email;
  // Mirror metadata onto the subscription/payment_intent so renewal webhooks can see it.
  if (input.recurring) body.subscription_data = { metadata: body.metadata };
  else body.payment_intent_data = { metadata: body.metadata };

  const session = await stripe(env, "/checkout/sessions", body);
  return { id: session.id, url: session.url };
}

/** Verify a Stripe webhook signature (t=...,v1=...). Returns the parsed event or null. */
export async function verifyWebhook(env: Env, payload: string, sigHeader: string): Promise<any | null> {
  const secret = env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !sigHeader) return null;
  const parts = Object.fromEntries(sigHeader.split(",").map((p) => p.split("=")) as [string, string][]);
  const t = parts["t"];
  const v1 = parts["v1"];
  if (!t || !v1) return null;

  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");

  // Constant-time-ish compare + 5 minute tolerance.
  if (expected.length !== v1.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ v1.charCodeAt(i);
  if (diff !== 0) return null;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return null;

  try { return JSON.parse(payload); } catch { return null; }
}
