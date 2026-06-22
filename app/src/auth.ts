// Privy access-token verification for the Worker.
//
// The frontend already logs users in with Privy. For anything touching money we cannot trust a
// plaintext user_id query param (the old chat-history pattern) — we verify the Privy access token
// (an ES256 JWT) on the server and trust only its `sub` claim (the user's DID).
//
// Verification uses Privy's public JWKS (no secret needed). We cache the keys in KV for an hour.
import type { Env } from "./env";

const JWKS_TTL_SECONDS = 3600;

interface PrivyClaims {
  sub: string;          // did:privy:...
  iss: string;          // "privy.io"
  aud: string;          // your Privy app id
  exp: number;          // seconds
  iat?: number;
}

export interface AuthedUser {
  userId: string;       // Privy DID — our billing primary key
}

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 ? 4 - (s.length % 4) : 0;
  const b64 = (s + "=".repeat(pad)).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function getJwks(env: Env): Promise<any[]> {
  const appId = env.PRIVY_APP_ID;
  if (!appId) throw new Error("PRIVY_APP_ID not set");
  const cacheKey = `privy:jwks:${appId}`;
  const cached = await env.CACHE.get(cacheKey);
  if (cached) {
    try { return JSON.parse(cached).keys || []; } catch {}
  }
  const res = await fetch(`https://auth.privy.io/api/v1/apps/${appId}/jwks.json`);
  if (!res.ok) throw new Error(`privy jwks ${res.status}`);
  const json: any = await res.json();
  await env.CACHE.put(cacheKey, JSON.stringify(json), { expirationTtl: JWKS_TTL_SECONDS });
  return json.keys || [];
}

/** Verify a Privy access token. Returns the user DID, or null if invalid/expired. */
export async function verifyPrivyToken(env: Env, token: string): Promise<AuthedUser | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, sigB64] = parts;
    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(headerB64)));
    if (header.alg !== "ES256") return null;

    const keys = await getJwks(env);
    const jwk = keys.find((k: any) => k.kid === header.kid) || keys[0];
    if (!jwk) return null;

    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );

    const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const sig = b64urlToBytes(sigB64);
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, data);
    if (!ok) return null;

    const claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(payloadB64))) as PrivyClaims;
    const now = Math.floor(Date.now() / 1000);
    if (claims.exp && claims.exp < now) return null;
    if (claims.iss !== "privy.io") return null;
    if (claims.aud !== env.PRIVY_APP_ID) return null;
    if (!claims.sub) return null;

    return { userId: claims.sub };
  } catch {
    return null;
  }
}

/** Verify the bearer token from an Authorization header value. */
export async function authFromRequest(env: Env, authHeader: string | null | undefined): Promise<AuthedUser | null> {
  const m = (authHeader || "").match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  return verifyPrivyToken(env, m[1]);
}

export { bytesToB64url, b64urlToBytes };
