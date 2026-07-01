import { readFileSync } from "node:fs";
import { request } from "node:https";
import { createHash } from "node:crypto";

const API_IPS = (process.env.CLOUDFLARE_API_IPS || process.env.CLOUDFLARE_API_IP || "104.18.22.21,104.19.193.29,172.64.154.211")
  .split(",")
  .map((ip) => ip.trim())
  .filter(Boolean);

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function httpsGet(url, { token, apiKey, email, apiIp, timeout = 15000, extraHeaders = {} } = {}) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const headers = { "user-agent": "robindex-preflight/1.0" };
    if (token) headers.authorization = `Bearer ${token}`;
    if (apiKey && email) {
      headers["X-Auth-Email"] = email;
      headers["X-Auth-Key"] = apiKey;
    }
    const options = {
      hostname: apiIp && u.hostname === "api.cloudflare.com" ? apiIp : u.hostname,
      servername: u.hostname,
      path: `${u.pathname}${u.search}`,
      method: "GET",
      headers: { ...headers, ...extraHeaders, host: u.hostname },
      timeout,
    };
    const req = request(options, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ ok: true, status: res.statusCode, headers: res.headers, body }));
    });
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", (error) => resolve({ ok: false, error: String(error) }));
    req.end();
  });
}

function readEnv(path) {
  try {
    return Object.fromEntries(readFileSync(path, "utf8").split(/\r?\n/).flatMap((line) => {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      return match ? [[match[1], match[2].replace(/^['"]|['"]$/g, "")]] : [];
    }));
  } catch {
    return {};
  }
}

async function cloudflareGet(url, opts = {}) {
  let last;
  for (const apiIp of API_IPS) {
    last = await httpsGet(url, { ...opts, apiIp });
    if (last.ok) return { ...last, apiIp };
  }
  return { ...last, apiIp: API_IPS[API_IPS.length - 1] };
}

function summarizeTokenVerify(result) {
  if (!result.ok) return { ok: false, error: result.error };
  try {
    const json = JSON.parse(result.body);
    return {
      ok: Boolean(json.success),
      status: result.status,
      errors: (json.errors || []).map((e) => ({ code: e.code, message: e.message })),
      tokenStatus: json.result?.status,
    };
  } catch {
    return { ok: false, status: result.status, error: "non_json_response" };
  }
}

const root = new URL("..", import.meta.url).pathname;
const account = readJson(`${root}../account.guard.json`);
const localEnv = readEnv(`${root}.env`);
const tokenCandidate = process.env.CLOUDFLARE_API_TOKEN || account.CLOUDFLARE_API_TOKEN || "";
const token = tokenCandidate.startsWith("cfat_") ? tokenCandidate : "";
const apiKey =
  process.env.CLOUDFLARE_API_KEY ||
  account.CLOUDFLARE_API_KEY ||
  (tokenCandidate.startsWith("cfk_") ? tokenCandidate : "");
const email = process.env.CLOUDFLARE_EMAIL || account.expectedEmail || "";

const checks = {};
if (token) {
  checks.cloudflareAuth = {
    mode: "api_token",
    ...summarizeTokenVerify(await cloudflareGet("https://api.cloudflare.com/client/v4/user/tokens/verify", { token })),
  };
} else {
  const user = await cloudflareGet("https://api.cloudflare.com/client/v4/user", { apiKey, email });
  let json = null;
  try {
    json = JSON.parse(user.body || "");
  } catch {}
  checks.cloudflareAuth = {
    mode: "global_api_key",
    ok: user.ok && user.status === 200 && Boolean(json?.success),
    status: user.status,
    errors: (json?.errors || []).map((e) => ({ code: e.code, message: e.message })),
    email: json?.result?.email || null,
  };
}

const home = await httpsGet("https://robindex.ai/");
checks.home = {
  ok: home.ok && home.status === 200 && (home.body || "").includes("金融 KOL 的 AI 分身"),
  status: home.status,
  error: home.error || null,
  title: (home.body || "").match(/<title>(.*?)<\/title>/i)?.[1] || null,
};

const kols = await httpsGet("https://robindex.ai/api/kols");
let kolsJson = null;
try {
  kolsJson = JSON.parse(kols.body || "");
} catch {}
checks.apiKols = {
  ok: kols.ok && kols.status === 200 && Array.isArray(kolsJson?.kols),
  status: kols.status,
  error: kols.error || null,
  contentType: kols.headers?.["content-type"] || null,
  returnedHtml: typeof kols.body === "string" && (kols.body || "").includes("<!DOCTYPE html>"),
  kolCount: kolsJson?.kols?.length || 0,
};

const appDesk = await httpsGet("https://app.robindex.ai/");
checks.appDesk = {
  ok: appDesk.ok && appDesk.status === 200 && (appDesk.body || "").includes("Robindex Desk"),
  status: appDesk.status,
  error: appDesk.error || null,
  title: (appDesk.body || "").match(/<title>(.*?)<\/title>/i)?.[1] || null,
  hasDeskShell: (appDesk.body || "").includes("/app/app.jsx"),
};

const quote = await httpsGet("https://robindex.ai/api/quote?q=SOXL");
let quoteJson = null;
try {
  quoteJson = JSON.parse(quote.body || "");
} catch {}
checks.apiQuote = {
  ok: quote.ok && quote.status === 200 && quoteJson?.quotes?.[0]?.symbol === "SOXL",
  status: quote.status,
  error: quote.error || null,
  symbol: quoteJson?.quotes?.[0]?.symbol || null,
  price: quoteJson?.quotes?.[0]?.price || null,
};

const kline = await httpsGet("https://robindex.ai/api/kline?code=usSOXL&limit=5");
let klineJson = null;
try {
  klineJson = JSON.parse(kline.body || "");
} catch {}
checks.apiKline = {
  ok: kline.ok && kline.status === 200 && Array.isArray(klineJson?.candles),
  status: kline.status,
  error: kline.error || null,
  candleCount: klineJson?.candles?.length || 0,
  degraded: Boolean(klineJson?.error),
};

const euvHoldings = await httpsGet("https://robindex.ai/api/etf-holdings?symbol=EUV");
let euvHoldingsJson = null;
try {
  euvHoldingsJson = JSON.parse(euvHoldings.body || "");
} catch {}
checks.apiEtfHoldings = {
  ok:
    euvHoldings.ok &&
    euvHoldings.status === 200 &&
    euvHoldingsJson?.symbol === "EUV" &&
    Number(euvHoldingsJson?.count || 0) > 0 &&
    Array.isArray(euvHoldingsJson?.holdings) &&
    euvHoldingsJson.holdings.length > 0,
  status: euvHoldings.status,
  error: euvHoldings.error || null,
  symbol: euvHoldingsJson?.symbol || null,
  holdingsCount: euvHoldingsJson?.count || 0,
  topHolding: euvHoldingsJson?.holdings?.[0]?.symbol || null,
  asOf: euvHoldingsJson?.asOf || null,
};

const inviteSeed = process.env.KOL_ONBOARD_INVITE_SECRET || localEnv.KOL_ONBOARD_INVITE_SECRET ||
  (localEnv.ADMIN_KEY ? createHash("sha256").update(`robindex-kol-invite-v1:${localEnv.ADMIN_KEY}`).digest("hex") : "");
const hiddenWithoutCookie = await httpsGet("https://app.robindex.ai/api/onboarding/page");
checks.onboardingHidden = {
  ok: hiddenWithoutCookie.ok && hiddenWithoutCookie.status === 404,
  status: hiddenWithoutCookie.status,
};
if (inviteSeed) {
  const bootstrap = await httpsGet(`https://app.robindex.ai/api/onboarding/invite?token=${inviteSeed}`);
  const cookie = String(bootstrap.headers?.["set-cookie"]?.[0] || "").split(";")[0];
  const page = cookie
    ? await httpsGet("https://app.robindex.ai/api/onboarding/page", { extraHeaders: { cookie } })
    : { ok: false, status: 0, body: "" };
  checks.onboardingInvite = {
    ok:
      bootstrap.ok && bootstrap.status === 302 &&
      Boolean(cookie) && page.ok && page.status === 200 && page.body.includes("新增一个 KOL"),
    bootstrapStatus: bootstrap.status,
    pageStatus: page.status,
    hasCookie: Boolean(cookie),
  };
}

console.log(JSON.stringify(checks, null, 2));
const failed = Object.values(checks).some((check) => !check.ok);
process.exit(failed ? 1 : 0);
