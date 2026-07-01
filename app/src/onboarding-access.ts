import type { Env } from "./env";

export interface InviteSession {
  id: string;
  sessionHash: string;
  ipHash: string;
  expiresAt: number;
}

const COOKIE = "robindex_kol_invite";
const THIRTY_DAYS = 30 * 24 * 60 * 60;

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

async function digest(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function cookieValue(req: Request, name: string): string {
  const raw = req.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return "";
}

function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

export function onboardingSecurityHeaders(): Record<string, string> {
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
  };
}

export async function issueInviteSession(env: Env, req: Request): Promise<{ cookie: string; session: InviteSession }> {
  const secret = env.KOL_ONBOARD_INVITE_SECRET;
  if (!secret || secret.length < 32) throw new Error("onboarding invite secret is not configured");
  const id = crypto.randomUUID();
  const expiresAt = Math.floor(Date.now() / 1000) + THIRTY_DAYS;
  const payload = `${id}.${expiresAt}`;
  const signature = await hmac(secret, payload);
  const sessionHash = await digest(`${secret}:session:${id}`);
  const ipHash = await digest(`${secret}:ip:${clientIp(req)}`);
  return {
    session: { id, sessionHash, ipHash, expiresAt },
    cookie: `${COOKIE}=${payload}.${signature}; Max-Age=${THIRTY_DAYS}; Path=/; HttpOnly; Secure; SameSite=Strict`,
  };
}

export async function readInviteSession(env: Env, req: Request): Promise<InviteSession | null> {
  const secret = env.KOL_ONBOARD_INVITE_SECRET;
  if (!secret || secret.length < 32) return null;
  const raw = cookieValue(req, COOKIE);
  const [id, expiresRaw, signature] = raw.split(".");
  const expiresAt = Number(expiresRaw);
  if (!id || !signature || !Number.isFinite(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) return null;
  const expected = await hmac(secret, `${id}.${expiresAt}`);
  if (!timingSafeEqual(expected, signature)) return null;
  return {
    id,
    expiresAt,
    sessionHash: await digest(`${secret}:session:${id}`),
    ipHash: await digest(`${secret}:ip:${clientIp(req)}`),
  };
}

export function validSameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(req.url).origin;
  } catch {
    return false;
  }
}

export function normalizeTwitterHandle(input: string): string {
  const raw = String(input || "").trim();
  if (!raw) throw new Error("请输入 X/Twitter 主页地址或 handle");
  let handle = raw;
  if (/^https?:\/\//i.test(raw)) {
    let url: URL;
    try { url = new URL(raw); } catch { throw new Error("无效的 URL"); }
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (!["x.com", "twitter.com"].includes(host)) throw new Error("只支持 x.com 或 twitter.com");
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 1) throw new Error("请输入账号主页，而不是帖子或其他页面");
    handle = parts[0];
  }
  handle = handle.replace(/^@/, "").trim().toLowerCase();
  if (new Set(["home", "explore", "search", "notifications", "messages", "settings", "compose", "intent", "share", "i"]).has(handle)) {
    throw new Error("请输入账号主页，而不是 X/Twitter 功能页面");
  }
  if (!/^[a-z0-9_]{1,15}$/.test(handle)) throw new Error("无效的 X/Twitter handle");
  return handle;
}
