import { readFileSync } from "node:fs";
import { request } from "node:https";

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

function httpsGet(url, { token, apiKey, email, apiIp, timeout = 15000 } = {}) {
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
      headers: { ...headers, host: u.hostname },
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
  ok: home.ok && home.status === 200 && (home.body || "").includes("选择一个研究视角"),
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
  returnedHtml: typeof kols.body === "string" && (kols.body || "").includes("选择一个研究视角"),
  kolCount: kolsJson?.kols?.length || 0,
};

const kolRoom = await httpsGet("https://robindex.ai/kol/qinbafrank/");
checks.kolRoom = {
  ok: kolRoom.ok && kolRoom.status === 200 && (kolRoom.body || "").includes("/kol.js"),
  status: kolRoom.status,
  error: kolRoom.error || null,
  title: (kolRoom.body || "").match(/<title>(.*?)<\/title>/i)?.[1] || null,
  hasKolRouter: (kolRoom.body || "").includes("/kol.js"),
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

console.log(JSON.stringify(checks, null, 2));
const failed = Object.values(checks).some((check) => !check.ok);
process.exit(failed ? 1 : 0);
