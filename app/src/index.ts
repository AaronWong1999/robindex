import { Hono } from "hono";
import type { Env, KolRow } from "./env";
import { getQuotesCached, getKlineCached, resolveSymbolCached } from "./finance";
import { retrieve } from "./rag";
import { planQuery, type QueryPlan } from "./query-plan";
import { indexTweets, indexRawTweets } from "./tagger";
import { gatherMarketData, buildMessages, maybeUpdateSummary, resolveToolPhase, type MarketData } from "./chat";
import { completeSystemChat, officialSystemModel } from "./system-llm";
import { getStockNews, getMarketNews } from "./marketdata";
import { runDailyIngest, runWeeklyPersonaRefresh } from "./ingest";
import { generatePersonaPack, evolvePersona, diagnosePersonaGeneration, logPersonaExperiment, type PersonaJson } from "./persona-gen";
import { buildEvalSet, runEval, runEvalPreview, autoRollback, evalAndMaybeRollback } from "./eval";
import { distillPersonaFull, distillPersonaIncremental, distillPersonaSample, mapStage, reduceStage, reduceGroup, reduceGroupLevel, reduceFinal, reduceFinalDraft, finalizeMerged, renderMergedPack, refineVoice, personaCoverageGate } from "./persona-distill";
import {
  getSectorBlocks, getFundFlowMinute, getDragonTiger, getLockupExpiry,
  getIndustryRanking, getMarginTrading, getStockInfo, getResearchReports,
} from "./eastmoney-astock";
import {
  getFinancialStatements, getKeyIndicators, getAnalystData,
  getMarketRanking, getSecFilings, getSinaKline,
} from "./eastmoney-global";
import { authFromRequest } from "./auth";
import {
  getState, grantTopup, activateSubscription, setSubscriptionStatus, eventSeen,
  PACKS, getKolPlan, subCents, ensureAccount, FREE,
} from "./billing";
import { createCheckoutSession, verifyWebhook } from "./stripe";
import { createPaymentIntent, createBillingCheckout, verifyAirwallexWebhook, awEnv, provisionKolSubscription } from "./airwallex";
import {
  backfillOnboardingFromApify, buildPublicKolProfile, getOnboardingJob, listRunnableOnboardingJobs,
  processOnboardingBatch, processOnboardingReconciliation, startOnboarding,
  type PublicKolProfile,
} from "./onboarding";
import { APPLE_PAY_DOMAIN_ASSOCIATION } from "./applepay";
import { getByokConfigByModelId, listByokModels, saveByokModel, deleteByokModel, BYOK_PROVIDERS } from "./byok";
import { getEtfHoldings } from "./etf";
import {
  issueInviteSession, normalizeTwitterHandle, onboardingSecurityHeaders, readInviteSession,
  timingSafeEqual, validSameOrigin, type InviteSession,
} from "./onboarding-access";

/** True iff the user has either a non-zero credit balance or an active subscription. */
async function hasCreditBalance(env: Env, userId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT credits, free_used FROM billing_accounts WHERE user_id=?`
  ).bind(userId).first<{ credits: number; free_used: number }>();
  if (row && row.credits > 0) return true;
  // Also count as "has credit" if the free daily cap hasn't been used.
  if (row && row.free_used < FREE.cap) return true;
  return false;
}

const app = new Hono<{ Bindings: Env }>();

const APP_HOST = "app.robindex.ai";

// Apple Pay domain verification (Airwallex merchant domain registration). Must be served verbatim with
// Content-Type application/octet-stream. The worker runs first, so this beats the SPA asset fallback.
app.get("/.well-known/apple-developer-merchantid-domain-association", (c) =>
  new Response(APPLE_PAY_DOMAIN_ASSOCIATION, {
    headers: { "Content-Type": "application/octet-stream", "Cache-Control": "public, max-age=3600" },
  }),
);

const NEWS_OR_EVENT_INTENT = /(news|headline|happening|新闻|消息|资讯|事件|最近|发生|利好|利空|政策|财报)/i;
const PROFILE_INTENT = /(估值|财务|基本面|pe|pb|peg|roe|margin|revenue|profit|earnings|valuation|fundamental|financial)/i;
const INTRADAY_OR_TECH_INTENT = /(盘中|分钟|分时|日内|技术位|支撑|压力|k线|k-line|intraday|minute|technical|support|resistance)/i;
const CURRENT_MARKET_INTENT = /(现在|今天|今日|当前|能不能买|可以买|该不该买|要不要买|买入|卖出|加仓|减仓|仓位|now|today|buy|sell|position)/i;

function sqliteDateFromOffset(offsetSeconds: number): string {
  return new Date(Date.now() + offsetSeconds * 1000).toISOString().slice(0, 19).replace("T", " ");
}

function frontendMessageContent(m: any): string {
  if (!m || typeof m !== "object") return "";
  if (m.role === "u") return String(m.text || "").trim();
  if (m.role === "k") {
    if (m.error) return "";
    return String(m.resp?.answerMd || m.streamText || m.text || "").trim();
  }
  return "";
}

async function bootstrapConversationFromChatHistory(env: Env, convId: string, userId: string, kolId: string): Promise<number> {
  const count = await env.DB.prepare(`SELECT COUNT(*) c FROM messages WHERE conversation_id=?`)
    .bind(convId)
    .first<{ c: number }>();
  if ((count?.c ?? 0) > 0) return 0;

  const row = await env.DB.prepare(
    `SELECT kol_id, messages_json FROM chat_history WHERE id=? AND user_id=?`
  )
    .bind(convId, userId)
    .first<{ kol_id: string; messages_json: string }>();
  if (!row || row.kol_id !== kolId) return 0;

  let parsed: any[] = [];
  try {
    const v = JSON.parse(row.messages_json || "[]");
    if (Array.isArray(v)) parsed = v;
  } catch {
    return 0;
  }

  const converted = parsed
    .map((m) => ({
      role: m?.role === "u" ? "user" : m?.role === "k" ? "assistant" : "",
      content: frontendMessageContent(m),
    }))
    .filter((m) => (m.role === "user" || m.role === "assistant") && m.content)
    .slice(-20);
  if (!converted.length) return 0;

  for (let i = 0; i < converted.length; i++) {
    const m = converted[i];
    const createdAt = sqliteDateFromOffset(-(converted.length - i + 2));
    await env.DB.prepare(
      `INSERT INTO messages (id,conversation_id,role,content,created_at) VALUES (?,?,?,?,?)`
    )
      .bind(crypto.randomUUID(), convId, m.role, m.content, createdAt)
      .run();
  }
  return converted.length;
}

export function shouldRunToolPhase(plan: QueryPlan, market: MarketData, message: string, plannedInstruments: string[]): boolean {
  if (!plan.needs_tools) return false;

  const hasPlannedInstrument = plannedInstruments.some(Boolean) || plan.instruments.length > 0;
  const hasQuote = market.quotes.length > 0 && !!market.primary;
  const hasDailyKline = !!market.klineText.trim();
  const hasProfile = !!market.extraContext.trim();
  const asksNews = NEWS_OR_EVENT_INTENT.test(message);
  const asksProfile = PROFILE_INTENT.test(message);
  const asksIntradayOrTech = INTRADAY_OR_TECH_INTENT.test(message);
  const asksCurrentMarket = CURRENT_MARKET_INTENT.test(message);

  if (hasPlannedInstrument && !hasQuote) return true;
  if (asksNews && market.news.length === 0) return true;
  if (asksProfile && !hasProfile) return true;
  if (asksIntradayOrTech && !hasDailyKline) return true;
  if (!market.primary && asksCurrentMarket) return true;

  const prefetchCoversDeepStockQuestion =
    hasQuote &&
    hasDailyKline &&
    hasProfile &&
    (!asksNews || market.news.length > 0);
  if (prefetchCoversDeepStockQuestion) return false;

  return !market.primary;
}

function requestHost(req: Request): string {
  return new URL(req.url).hostname.toLowerCase();
}

function isAppHost(host: string): boolean {
  return host === APP_HOST;
}

function isOnboardingHost(host: string): boolean {
  return isAppHost(host) || host === "127.0.0.1" || host === "localhost";
}

function isMarketingHost(host: string): boolean {
  return host === "robindex.ai" || host === "www.robindex.ai";
}

function serveDesk(c: { req: { url: string; raw: Request }; env: Env }): Response | Promise<Response> {
  const url = new URL(c.req.url);
  url.pathname = "/desk.html";
  return c.env.ASSETS.fetch(new Request(url, c.req.raw));
}

async function inviteSessionOrNull(env: Env, req: Request): Promise<InviteSession | null> {
  if (!isOnboardingHost(requestHost(req))) return null;
  return readInviteSession(env, req);
}

async function serveProtectedOnboardingAsset(c: any, pathname: string): Promise<Response> {
  const session = await inviteSessionOrNull(c.env, c.req.raw);
  if (!session) return new Response("Not found", { status: 404, headers: onboardingSecurityHeaders() });
  const url = new URL(c.req.url);
  url.pathname = pathname;
  const asset = await c.env.ASSETS.fetch(new Request(url, c.req.raw));
  const headers = new Headers(asset.headers);
  for (const [key, value] of Object.entries(onboardingSecurityHeaders())) headers.set(key, value);
  return new Response(asset.body, { status: asset.status, headers });
}

type OnboardingRequestRow = {
  id: string;
  session_hash: string;
  ip_hash: string;
  source_input: string;
  handle: string;
  kol_id: string | null;
  state: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

function publicOnboardingState(job: any, kol: any, requestState: string): string {
  if (kol?.is_public && kol?.onboarding_status === "ready" && Number(kol?.persona_length || 0) >= 500) return "ready";
  if (requestState === "failed" || job?.phase === "failed" || kol?.onboarding_status === "failed") return "failed";
  if (!job) return requestState || "validating";
  if (job.phase === "ingesting" || job.phase === "ingesting_running") return "ingesting";
  if (job.phase === "reconciling" || job.phase === "reconciling_running") return "reconciling";
  if (job.phase === "distilling" || job.phase === "evaluating") {
    const phase = String(job.distill_phase || "map");
    if (phase === "map") return "mapping";
    if (/^group/.test(phase) || ["final", "finalize"].includes(phase)) return "reducing";
    if (phase === "profile") return "profiling";
    if (["build_eval", "eval_candidate"].includes(phase)) return "evaluating";
    if (phase === "provisioning") return "provisioning";
  }
  if (job.phase === "ready") return "ready";
  return requestState || "queued";
}

async function serializeOnboardingRequest(env: Env, row: OnboardingRequestRow): Promise<any> {
  const job = row.kol_id ? await getOnboardingJob(env, row.kol_id) : null;
  const kol = row.kol_id
    ? await env.DB.prepare(
        `SELECT id,display_name,handle,avatar_url,onboarding_status,is_public,persona_version,
                length(persona_pack) persona_length,airwallex_price_id
         FROM kols WHERE id=?`
      ).bind(row.kol_id).first<any>()
    : null;
  const corpus = row.kol_id
    ? await env.DB.prepare(
        `SELECT COUNT(*) total,SUM(CASE WHEN is_retweet=0 THEN 1 ELSE 0 END) originals,
                MIN(created_at_iso) oldest,MAX(created_at_iso) newest
         FROM tweets WHERE kol_id=?`
      ).bind(row.kol_id).first<any>()
    : null;
  const indexed = row.kol_id
    ? await env.DB.prepare(`SELECT COUNT(DISTINCT tweet_id) n FROM tweet_search WHERE kol_id=?`).bind(row.kol_id).first<{ n: number }>()
    : null;
  const state = publicOnboardingState(job, kol, row.state);
  if (state !== row.state) {
    await env.DB.prepare(
      `UPDATE kol_onboarding_requests SET state=?,last_error=?,updated_at=datetime('now'),
         completed_at=CASE WHEN ? IN ('ready','failed') THEN COALESCE(completed_at,datetime('now')) ELSE NULL END
       WHERE id=?`
    ).bind(state, job?.last_error || row.last_error, state, row.id).run();
  }
  const phaseBase: Record<string, number> = {
    queued: 2, validating: 6, ingesting: 20, reconciling: 38, indexing: 44,
    mapping: 54, reducing: 70, profiling: 79, evaluating: 86, provisioning: 97, ready: 100, failed: 100,
  };
  let progress = phaseBase[state] ?? 0;
  if (state === "ingesting" && job?.pages_fetched) progress = Math.min(37, 15 + Math.log2(Number(job.pages_fetched) + 1) * 3);
  return {
    id: row.id,
    handle: row.handle,
    kol_id: row.kol_id,
    state,
    progress_percent: Math.round(progress),
    pages_fetched: Number(job?.pages_fetched || 0),
    distill_steps: Number(job?.distill_steps || 0),
    indexed: Number(indexed?.n || 0),
    last_error: job?.last_error || row.last_error,
    status_text: state === "ready"
      ? "质量门禁通过，已加入全站 KOL 列表"
      : state === "failed"
        ? "任务保持私有，可在修正问题后重试"
        : "Cloudflare 将自动继续，无需保持页面打开",
    corpus: {
      total: Number(corpus?.total || 0),
      originals: Number(corpus?.originals || 0),
      oldest: corpus?.oldest || null,
      newest: corpus?.newest || null,
    },
    profile: kol ? {
      display_name: kol.display_name,
      avatar_url: kol.avatar_url,
      persona_version: kol.persona_version,
      has_price: !!kol.airwallex_price_id,
    } : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function redirectToApp(req: Request): Response {
  const src = new URL(req.url);
  const dest = new URL(req.url);
  dest.hostname = APP_HOST;
  if (src.pathname === "/desk") dest.pathname = "/";
  return Response.redirect(dest.toString(), 302);
}

/** True when the path should be served as a static file, not the Desk SPA shell. */
function isStaticAssetPath(pathname: string): boolean {
  if (pathname.startsWith("/app/")) return true;
  if (pathname === "/landing-static.js") return true;
  if (/\.(html|css|js|jsx|mjs|json|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|txt|map)$/i.test(pathname)) return true;
  return false;
}

function isDeskSpaPath(pathname: string): boolean {
  if (pathname.startsWith("/api/")) return false;
  return !isStaticAssetPath(pathname);
}

const DEFAULT_PERSONA = (k: KolRow) =>
  `Identity: ${k.display_name} (@${k.handle}).\nTone: direct, data-driven finance commentator.\n` +
  `Methodology: reason from price action, fundamentals, and macro context.\nTaboos: no fabricated numbers; no guarantees.`;

function stripToolCallDSL(text: string): string {
  return text
    .replace(/<\s*[｜|]?\s*DSML\s*[｜|]?\s*tool_calls\s*>\s*[\s\S]*?<\s*\/\s*[｜|]?\s*DSML\s*[｜|]?\s*tool_calls\s*>/gi, "")
    .replace(/<\s*[｜|]?\s*DSML\s*[｜|]?\s*\/?\s*tool_calls?\s*>\s*/gi, "")
    .replace(/<\s*\/?\s*(?:invoke|function|parameter|tool_calls?)\b[^>]*>\s*/gi, "")
    .replace(/^\s*[<＜]\s*[｜|]?\s*DSML\s*[｜|]?\s*(?:tool_calls?|invoke|parameter|function).*$/gim, "")
    .replace(/^\s*[<＜]\s*\/\s*[｜|]?\s*DSML\s*[｜|]?.*$/gim, "");
}

function normalizeCitationBrackets(text: string): string {
  return text
    .replace(/【\s*T?(\d+)\s*】/gi, "[$1]")
    .replace(/\[\s*T(\d+)\s*\]/gi, "[$1]")
    .replace(/[（(]\s*T(\d+)\s*[）)]/gi, "[$1]")
    .replace(/(^|[^\[\w])\bT(\d+)\b(?!\s*[\]\w])/gi, "$1[$2]");
}

type ChatCitation = {
  ref: string;
  tweet_id?: string;
  url?: string;
  [key: string]: any;
};

function citationKey(citation: ChatCitation): string {
  return String(citation.tweet_id || citation.url || citation.ref || "");
}

function orderedNumericRefs(content: string): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const match of String(content || "").matchAll(/(?:\[|【)\s*T?(\d+)\s*(?:\]|】)/gi)) {
    const ref = `T${match[1]}`;
    if (!seen.has(ref)) {
      seen.add(ref);
      refs.push(ref);
    }
  }
  return refs;
}

async function loadConversationCitationState(env: Env, conversationId: string): Promise<{
  citations: ChatCitation[];
  numberByKey: Map<string, number>;
}> {
  const rows = await env.DB.prepare(
    `SELECT content,citations FROM messages
     WHERE conversation_id=? AND role='assistant' AND citations IS NOT NULL
     ORDER BY created_at ASC,rowid ASC`
  ).bind(conversationId).all();
  const citations: ChatCitation[] = [];
  const numberByKey = new Map<string, number>();
  for (const row of (rows.results || []) as any[]) {
    let saved: ChatCitation[] = [];
    try {
      const parsed = JSON.parse(row.citations || "[]");
      if (Array.isArray(parsed)) saved = parsed;
    } catch {}
    const byRef = new Map(saved.map((citation) => [String(citation.ref || ""), citation]));
    for (const oldRef of orderedNumericRefs(row.content)) {
      const citation = byRef.get(oldRef);
      if (!citation) continue;
      const key = citationKey(citation);
      if (!key || numberByKey.has(key)) continue;
      const number = citations.length + 1;
      numberByKey.set(key, number);
      citations.push({ ...citation, ref: `T${number}` });
    }
  }
  return { citations, numberByKey };
}

function renumberAnswerCitations(
  answer: string,
  candidates: ChatCitation[],
  state: { citations: ChatCitation[]; numberByKey: Map<string, number> },
): { answer: string; messageCitations: ChatCitation[]; cumulativeCitations: ChatCitation[] } {
  const byLocalRef = new Map(candidates.map((citation) => [String(citation.ref || ""), citation]));
  const messageCitations: ChatCitation[] = [];
  const seenMessage = new Set<string>();
  const rewritten = answer.replace(/(?:\[|【)\s*T?(\d+)\s*(?:\]|】)/gi, (marker, number) => {
    const citation = byLocalRef.get(`T${number}`);
    if (!citation) return "";
    const key = citationKey(citation);
    if (!key) return "";
    let globalNumber = state.numberByKey.get(key);
    if (!globalNumber) {
      globalNumber = state.citations.length + 1;
      state.numberByKey.set(key, globalNumber);
      state.citations.push({ ...citation, ref: `T${globalNumber}` });
    }
    if (!seenMessage.has(key)) {
      seenMessage.add(key);
      messageCitations.push({ ...citation, ref: `T${globalNumber}` });
    }
    return `[${globalNumber}]`;
  });
  return {
    answer: rewritten.replace(/[ \t]+([，。；：,.!?])/g, "$1").trim(),
    messageCitations,
    cumulativeCitations: state.citations,
  };
}

function createDSLStreamCleaner() {
  let pending = "";
  let inDslBlock = false;
  const MAX_PENDING = 512;

  const cleanComplete = (input: string): string => {
    let text = input;
    let out = "";
    while (text) {
      if (inDslBlock) {
        const close = text.search(/<\s*\/\s*[｜|]?\s*DSML\s*[｜|]?\s*tool_calls\s*>/i);
        if (close < 0) return out;
        const rest = text.slice(close);
        const closeMatch = rest.match(/^<\s*\/\s*[｜|]?\s*DSML\s*[｜|]?\s*tool_calls\s*>/i);
        text = rest.slice(closeMatch?.[0].length || 0);
        inDslBlock = false;
        continue;
      }

      const open = text.search(/<\s*[｜|]?\s*DSML\s*[｜|]?\s*tool_calls\s*>/i);
      if (open < 0) {
        out += stripToolCallDSL(text);
        break;
      }
      out += stripToolCallDSL(text.slice(0, open));
      const rest = text.slice(open);
      const openMatch = rest.match(/^<\s*[｜|]?\s*DSML\s*[｜|]?\s*tool_calls\s*>/i);
      text = rest.slice(openMatch?.[0].length || 0);
      inDslBlock = true;
    }
    return out;
  };

  return {
    push(chunk: string): string {
      pending += chunk;
      const keepFrom = Math.max(
        pending.lastIndexOf("<"),
        pending.lastIndexOf("＜"),
        pending.lastIndexOf("<｜DSML"),
        pending.lastIndexOf("<|DSML")
      );
      const keep = keepFrom >= 0 && pending.length - keepFrom < MAX_PENDING ? pending.slice(keepFrom) : "";
      const complete = keep ? pending.slice(0, -keep.length) : pending;
      pending = keep;
      return cleanComplete(complete);
    },
    flush(): string {
      const out = cleanComplete(pending);
      pending = "";
      return out;
    },
    cleanAll(text: string): string {
      pending = "";
      inDslBlock = false;
      return cleanComplete(text);
    },
  };
}

// ---- Hidden invite-based KOL onboarding ----
app.get("/api/onboarding/invite", async (c) => {
  if (!isOnboardingHost(requestHost(c.req.raw))) return c.notFound();
  const configured = c.env.KOL_ONBOARD_INVITE_SECRET || "";
  const supplied = String(c.req.query("token") || "");
  if (configured.length < 32 || !timingSafeEqual(configured, supplied)) {
    return new Response("Not found", { status: 404, headers: onboardingSecurityHeaders() });
  }
  const { cookie } = await issueInviteSession(c.env, c.req.raw);
  return new Response(null, {
    status: 302,
    headers: {
      ...onboardingSecurityHeaders(),
      "Set-Cookie": cookie,
      Location: "/add-kol",
    },
  });
});

app.get("/api/onboarding/page", (c) => serveProtectedOnboardingAsset(c, "/onboard.html"));
app.get("/onboard.html", (c) => new Response("Not found", { status: 404, headers: onboardingSecurityHeaders() }));
app.get("/onboard.css", (c) => serveProtectedOnboardingAsset(c, "/onboard.css"));
app.get("/onboard.js", (c) => serveProtectedOnboardingAsset(c, "/onboard.js"));

app.get("/api/onboarding/requests", async (c) => {
  const session = await inviteSessionOrNull(c.env, c.req.raw);
  if (!session) return c.json({ error: "not_found" }, 404);
  const rows = await c.env.DB.prepare(
    `SELECT * FROM kol_onboarding_requests WHERE session_hash=? ORDER BY created_at DESC LIMIT 50`
  ).bind(session.sessionHash).all<OnboardingRequestRow>();
  const requests = [];
  for (const row of rows.results || []) requests.push(await serializeOnboardingRequest(c.env, row));
  return c.json({ requests }, 200, onboardingSecurityHeaders());
});

app.get("/api/onboarding/requests/:id", async (c) => {
  const session = await inviteSessionOrNull(c.env, c.req.raw);
  if (!session) return c.json({ error: "not_found" }, 404);
  const row = await c.env.DB.prepare(
    `SELECT * FROM kol_onboarding_requests WHERE id=? AND session_hash=?`
  ).bind(c.req.param("id"), session.sessionHash).first<OnboardingRequestRow>();
  if (!row) return c.json({ error: "not_found" }, 404);
  return c.json({ request: await serializeOnboardingRequest(c.env, row) }, 200, onboardingSecurityHeaders());
});

app.post("/api/onboarding/submit", async (c) => {
  const session = await inviteSessionOrNull(c.env, c.req.raw);
  if (!session) return c.json({ error: "not_found" }, 404);
  if (!validSameOrigin(c.req.raw)) return c.json({ error: "bad_origin", message: "请求来源无效" }, 403);
  const body = await c.req.json<{ url?: string; handle?: string }>()
    .catch(() => ({} as { url?: string; handle?: string }));
  let handle: string;
  try {
    handle = normalizeTwitterHandle(body.url || body.handle || "");
  } catch (error: any) {
    return c.json({ error: "invalid_handle", message: error.message || String(error) }, 400);
  }

  const duplicate = await c.env.DB.prepare(
    `SELECT * FROM kol_onboarding_requests WHERE session_hash=? AND handle=?`
  ).bind(session.sessionHash, handle).first<OnboardingRequestRow>();
  if (duplicate) return c.json({ ok: true, request: await serializeOnboardingRequest(c.env, duplicate), duplicate: true });

  const active = await c.env.DB.prepare(
    `SELECT COUNT(*) n FROM kol_onboarding_requests
     WHERE (session_hash=? OR ip_hash=?) AND state NOT IN ('ready','failed')`
  ).bind(session.sessionHash, session.ipHash).first<{ n: number }>();
  if (Number(active?.n || 0) >= 1) {
    return c.json({ error: "active_limit", message: "当前已有一个创建任务，请等待完成后再提交" }, 429);
  }
  const daily = await c.env.DB.prepare(
    `SELECT COUNT(*) n FROM kol_onboarding_requests
     WHERE (session_hash=? OR ip_hash=?) AND created_at >= datetime('now','-24 hours')`
  ).bind(session.sessionHash, session.ipHash).first<{ n: number }>();
  if (Number(daily?.n || 0) >= 3) {
    return c.json({ error: "daily_limit", message: "24 小时内最多创建 3 个 KOL" }, 429);
  }

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO kol_onboarding_requests
       (id,session_hash,ip_hash,source_input,handle,state,updated_at)
     VALUES (?,?,?,?,?,'validating',datetime('now'))`
  ).bind(id, session.sessionHash, session.ipHash, String(body.url || body.handle || ""), handle).run();
  try {
    const started = await startOnboarding(c.env, { handle });
    const ready = started.job.phase === "ready";
    await c.env.DB.prepare(
      `UPDATE kol_onboarding_requests SET kol_id=?,state=?,last_error=NULL,updated_at=datetime('now'),
         completed_at=CASE WHEN ?='ready' THEN datetime('now') ELSE NULL END WHERE id=?`
    ).bind(started.kol_id, ready ? "ready" : "ingesting", ready ? "ready" : "ingesting", id).run();
  } catch (error: any) {
    await c.env.DB.prepare(
      `UPDATE kol_onboarding_requests SET state='failed',last_error=?,completed_at=datetime('now'),updated_at=datetime('now') WHERE id=?`
    ).bind(String(error?.message || error).slice(0, 500), id).run();
  }
  const row = await c.env.DB.prepare(`SELECT * FROM kol_onboarding_requests WHERE id=?`).bind(id).first<OnboardingRequestRow>();
  return c.json({ ok: true, request: row ? await serializeOnboardingRequest(c.env, row) : null }, 202);
});

app.post("/api/onboarding/requests/:id/retry", async (c) => {
  const session = await inviteSessionOrNull(c.env, c.req.raw);
  if (!session) return c.json({ error: "not_found" }, 404);
  if (!validSameOrigin(c.req.raw)) return c.json({ error: "bad_origin", message: "请求来源无效" }, 403);
  const row = await c.env.DB.prepare(
    `SELECT * FROM kol_onboarding_requests WHERE id=? AND session_hash=?`
  ).bind(c.req.param("id"), session.sessionHash).first<OnboardingRequestRow>();
  if (!row) return c.json({ error: "not_found" }, 404);
  const current = await serializeOnboardingRequest(c.env, row);
  if (current.state !== "failed") return c.json({ error: "not_failed", message: "只有失败任务可以重试" }, 409);
  try {
    if (!row.kol_id) {
      const started = await startOnboarding(c.env, { handle: row.handle });
      row.kol_id = started.kol_id;
    } else {
      const job = await getOnboardingJob(c.env, row.kol_id);
      const nextJobPhase = job?.has_more ? "ingesting" : "distilling";
      const nextDistill = job?.has_more ? job?.distill_phase : "map";
      await c.env.DB.prepare(
        `UPDATE kol_onboarding_jobs SET phase=?,distill_phase=?,retries=0,phase_retries=0,
           candidate_attempts=0,coverage_attempts=0,next_retry_at=NULL,last_error=NULL,lease_owner=NULL,lease_until=NULL,
           updated_at=datetime('now') WHERE kol_id=?`
      ).bind(nextJobPhase, nextDistill || "map", row.kol_id).run();
      await c.env.DB.prepare(
        `UPDATE kols SET onboarding_status=?,is_public=0,updated_at=datetime('now') WHERE id=?`
      ).bind(nextJobPhase === "ingesting" ? "ingesting" : "distilling", row.kol_id).run();
    }
    await c.env.DB.prepare(
      `UPDATE kol_onboarding_requests SET kol_id=?,state=?,last_error=NULL,completed_at=NULL,updated_at=datetime('now') WHERE id=?`
    ).bind(row.kol_id, row.kol_id ? "ingesting" : "validating", row.id).run();
  } catch (error: any) {
    return c.json({ error: "retry_failed", message: String(error?.message || error) }, 500);
  }
  const updated = await c.env.DB.prepare(`SELECT * FROM kol_onboarding_requests WHERE id=?`).bind(row.id).first<OnboardingRequestRow>();
  return c.json({ ok: true, request: updated ? await serializeOnboardingRequest(c.env, updated) : null });
});

app.get("/api/kols", async (c) => {
  const r = await c.env.DB.prepare(
    `SELECT id,display_name,handle,avatar_url,tagline,profile_json,followers_count,statuses_count,
            subscription_enabled,subscription_price_cents,subscription_promo_cents,subscription_gift
     FROM kols
     WHERE is_public=1 AND onboarding_status='ready' AND persona_pack IS NOT NULL AND length(persona_pack)>=500
     ORDER BY display_name`
  ).all();
  const kols = ((r.results || []) as any[]).map((row) => {
    let profile: any = {};
    try { profile = row.profile_json ? JSON.parse(row.profile_json) : {}; } catch {}
    return {
      id: row.id,
      display_name: row.display_name,
      handle: row.handle,
      avatar_url: row.avatar_url,
      tagline: row.tagline,
      ...profile,
      followers_count: Number(row.followers_count || 0),
      statuses_count: Number(row.statuses_count || 0),
      subscription: {
        enabled: !!row.subscription_enabled,
        priceMonthly: Number(row.subscription_price_cents || 3990) / 100,
        promoMonthly: Number(row.subscription_promo_cents || 1990) / 100,
        gift: Number(row.subscription_gift || 2000),
      },
    };
  });
  return c.json({ kols });
});

app.get("/api/config", async (c) => {
  return c.json({
    privyAppId: c.env.PRIVY_APP_ID || "client-clxxyzdummyappidforlocaldev"
  });
});

app.get("/api/quote", async (c) => {
  const q = c.req.query("q");
  const codes = c.req.query("codes");
  if (codes) return c.json({ quotes: await getQuotesCached(c.env.CACHE, codes.split(",")) });
  if (q) {
    const hit = await resolveSymbolCached(c.env.CACHE, q);
    return c.json({ quotes: hit ? [hit] : [] });
  }
  return c.json({ error: "provide ?q= or ?codes=" }, 400);
});

// Public: recent tweets for a KOL — powers the 全量库/内容库 corpus views and the KOL 日报.
app.get("/api/tweets", async (c) => {
  const kolId = c.req.query("kol_id");
  if (!kolId) return c.json({ error: "provide ?kol_id=" }, 400);
  const limit = Math.min(parseInt(c.req.query("limit") || "30", 10), 100);
  const offset = Math.max(parseInt(c.req.query("offset") || "0", 10), 0);
  const k = await c.env.DB.prepare(`SELECT handle FROM kols WHERE id=?`).bind(kolId).first<{ handle: string }>();
  const total = await c.env.DB.prepare(
    `SELECT COUNT(*) c FROM tweets WHERE kol_id=? AND is_retweet=0`
  ).bind(kolId).first<{ c: number }>();
  const r = await c.env.DB.prepare(
    `SELECT id,text,created_at_iso,likes,retweets,replies,quotes,views,urls,quoted
     FROM tweets WHERE kol_id=? AND is_retweet=0 ORDER BY created_at_ts DESC LIMIT ? OFFSET ?`
  ).bind(kolId, limit, offset).all();
  return c.json({
    handle: k?.handle || kolId,
    total: total?.c ?? 0,
    tweets: (r.results || []).map((t: any) => ({
      ...t,
      urls: t.urls ? JSON.parse(t.urls) : [],
      quoted: t.quoted ? (() => { try { return JSON.parse(t.quoted); } catch { return null; } })() : null,
    })),
  });
});

// News for a symbol (?q=/?code=) and/or market/macro fast-news (?market=1).
app.get("/api/news", async (c) => {
  const q = c.req.query("q") || c.req.query("code");
  const n = Math.min(parseInt(c.req.query("limit") || "8", 10), 20);
  const out: any = { stock: [], market: [] };
  if (q) {
    const hit = await resolveSymbolCached(c.env.CACHE, q);
    if (hit) out.stock = await getStockNews(c.env, hit, n);
  }
  if (!q || c.req.query("market")) out.market = await getMarketNews(c.env, n);
  return c.json(out);
});

app.get("/api/macro", async (c) => {
  const n = Math.min(parseInt(c.req.query("limit") || "12", 10), 30);
  return c.json({ news: await getMarketNews(c.env, n) });
});

app.get("/api/kline", async (c) => {
  const code = c.req.query("code");
  if (!code) return c.json({ error: "provide ?code=" }, 400);
  const period = c.req.query("period") || "day";
  const limit = parseInt(c.req.query("limit") || "60", 10);
  try {
    return c.json(await getKlineCached(c.env.CACHE, code, period, limit));
  } catch (e) {
    return c.json({ code, period, candles: [], error: "kline_unavailable" }, 200);
  }
});

// ---- Extended data endpoints (from a-stock-data + global-stock-data) ----

app.get("/api/sectors", async (c) => {
  const code = c.req.query("code");
  if (!code) return c.json({ error: "provide ?code= (e.g. sh600519)" }, 400);
  return c.json(await getSectorBlocks(c.env.CACHE, code));
});

app.get("/api/fund-flow", async (c) => {
  const code = c.req.query("code");
  if (!code) return c.json({ error: "provide ?code= (e.g. sh600519)" }, 400);
  return c.json({ code, flow: await getFundFlowMinute(c.env.CACHE, code) });
});

app.get("/api/dragon-tiger", async (c) => {
  const code = c.req.query("code");
  if (!code) return c.json({ error: "provide ?code= (e.g. sz002475)" }, 400);
  return c.json(await getDragonTiger(c.env.CACHE, code, c.req.query("date") || undefined));
});

app.get("/api/lockup", async (c) => {
  const code = c.req.query("code");
  if (!code) return c.json({ error: "provide ?code=" }, 400);
  return c.json(await getLockupExpiry(c.env.CACHE, code));
});

app.get("/api/industry", async (c) => {
  const top = Math.min(parseInt(c.req.query("top") || "20", 10), 50);
  return c.json(await getIndustryRanking(c.env.CACHE, top));
});

app.get("/api/margin", async (c) => {
  const code = c.req.query("code");
  if (!code) return c.json({ error: "provide ?code=" }, 400);
  const limit = Math.min(parseInt(c.req.query("limit") || "30", 10), 100);
  return c.json({ code, margin: await getMarginTrading(c.env.CACHE, code, limit) });
});

app.get("/api/stock-info", async (c) => {
  const code = c.req.query("code");
  if (!code) return c.json({ error: "provide ?code=" }, 400);
  return c.json(await getStockInfo(c.env.CACHE, code));
});

app.get("/api/reports", async (c) => {
  const code = c.req.query("code");
  if (!code) return c.json({ error: "provide ?code=" }, 400);
  const limit = Math.min(parseInt(c.req.query("limit") || "20", 10), 100);
  return c.json({ code, reports: await getResearchReports(c.env.CACHE, code, limit) });
});

app.get("/api/financials", async (c) => {
  const code = c.req.query("code");
  if (!code) return c.json({ error: "provide ?code= (e.g. usAAPL)" }, 400);
  const stmt = (c.req.query("type") || "income") as "balance" | "income" | "cashflow";
  const periods = Math.min(parseInt(c.req.query("periods") || "4", 10), 12);
  return c.json({ code, statement: stmt, data: await getFinancialStatements(c.env.CACHE, code, stmt, periods) });
});

app.get("/api/key-indicators", async (c) => {
  const code = c.req.query("code");
  if (!code) return c.json({ error: "provide ?code= (e.g. usAAPL)" }, 400);
  return c.json({ code, indicators: await getKeyIndicators(c.env.CACHE, code) });
});

app.get("/api/analyst", async (c) => {
  const code = c.req.query("code");
  if (!code) return c.json({ error: "provide ?code= (e.g. usAAPL)" }, 400);
  return c.json(await getAnalystData(c.env.CACHE, code));
});

app.get("/api/market-ranking", async (c) => {
  const market = c.req.query("market") || "us_nasdaq";
  const sortMap: Record<string, string> = { change_pct: "f3", volume: "f5", amount: "f6" };
  const sort = sortMap[c.req.query("sort") || "change_pct"] || "f3";
  const limit = Math.min(parseInt(c.req.query("limit") || "20", 10), 50);
  return c.json(await getMarketRanking(c.env.CACHE, market, sort, limit));
});

app.get("/api/sec-filings", async (c) => {
  const symbol = c.req.query("symbol");
  if (!symbol) return c.json({ error: "provide ?symbol= (e.g. AAPL)" }, 400);
  return c.json(await getSecFilings(c.env.CACHE, symbol, c.req.query("form") || undefined));
});

app.get("/api/kline-sina", async (c) => {
  const symbol = c.req.query("symbol");
  if (!symbol) return c.json({ error: "provide ?symbol= (e.g. AAPL)" }, 400);
  const num = Math.min(parseInt(c.req.query("num") || "120", 10), 500);
  return c.json({ symbol, kline: await getSinaKline(c.env.CACHE, symbol, num) });
});

app.get("/api/etf-holdings", async (c) => {
  const symbol = c.req.query("symbol");
  if (!symbol) return c.json({ error: "provide ?symbol=EUV" }, 400);
  const holdings = await getEtfHoldings(c.env, symbol);
  return holdings ? c.json(holdings) : c.json({ error: "holdings unavailable", symbol }, 404);
});

app.post("/api/chat", async (c) => {
  const body = await c.req.json<{
    kol_id: string;
    model?: string;
    conversation_id?: string;
    message: string;
  }>();
  if (!body.kol_id || !body.message) return c.json({ error: "kol_id and message required" }, 400);

  const kol = await c.env.DB.prepare(`SELECT * FROM kols WHERE id=?`).bind(body.kol_id).first<KolRow>();
  if (!kol) return c.json({ error: "unknown kol_id" }, 404);
  if (!kol.is_public || kol.onboarding_status !== "ready" || !kol.persona_pack || kol.persona_pack.length < 500) {
    return c.json({ error: "kol_not_ready", message: "该 KOL 的完整语料与分身仍在构建中" }, 409);
  }

  // Resolve model: BYOK models (cm_xxx) route through the user's own API; system models
  // ("pro", "flash") go through the Cloudflare AI Gateway. These two paths are mutually exclusive.
  let model: string;
  let byokCfg: ReturnType<typeof getByokConfigByModelId> extends Promise<infer T> ? T : never = null;
  const auth = await authFromRequest(c.env, c.req.header("Authorization"));
  if (auth && body.model && body.model.startsWith("cm_")) {
    const cfg = await getByokConfigByModelId(c.env, auth.userId, body.model);
    if (cfg && cfg.baseUrl) {
      byokCfg = cfg as any;
      model = cfg.modelName;
    } else {
      return c.json({ error: "invalid_byok", message: "自有 API 未配置或已失效，请检查设置" }, 400);
    }
  } else {
    // System model path: resolve model name + check credits/quota.
    model = body.model === "pro" ? c.env.MODEL_PRO : c.env.MODEL_FLASH;
    if (auth) {
      const state = await getState(c.env, auth.userId);
      await ensureAccount(c.env, auth.userId);
      const rolled = await getState(c.env, auth.userId); // re-read after rollFree
      if (rolled.freeUsed >= FREE.cap && rolled.credits <= 0) {
        return c.json({
          error: "no_credits",
          message: "今日免费次数已用完，积分余额为 0。请前往积分中心购买积分，或配置自有 API（设置 → 添加模型）。",
        }, 402);
      }
    }
  }

  // Conversation (bound to one KOL and, when authenticated, one user).
  const requestedConvId = String(body.conversation_id || "").trim();
  let convId = requestedConvId || crypto.randomUUID();
  let convRow = requestedConvId
    ? await c.env.DB.prepare(`SELECT id,kol_id,user_id FROM conversations WHERE id=?`)
        .bind(requestedConvId)
        .first<{ id: string; kol_id: string; user_id: string | null }>()
    : null;

  const ownerMismatch = convRow?.user_id && (!auth || convRow.user_id !== auth.userId);
  if (convRow && (convRow.kol_id !== kol.id || ownerMismatch)) {
    convId = crypto.randomUUID();
    convRow = null;
  }

  if (!convRow) {
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO conversations (id,kol_id,user_id,model,title) VALUES (?,?,?,?,?)`
    )
      .bind(convId, kol.id, auth?.userId || null, model, body.message.slice(0, 60))
      .run();
  } else if (auth && !convRow.user_id) {
    await c.env.DB.prepare(`UPDATE conversations SET user_id=?, updated_at=datetime('now') WHERE id=?`)
      .bind(auth.userId, convId)
      .run();
  }

  if (requestedConvId && auth && convId === requestedConvId) {
    await bootstrapConversationFromChatHistory(c.env, convId, auth.userId, kol.id);
  }

  // History (bounded) — take recent raw turns + check for tool call memory.
  const hist = await c.env.DB.prepare(
    `SELECT role,content,tool_calls FROM messages WHERE conversation_id=? ORDER BY created_at DESC LIMIT 20`
  )
    .bind(convId)
    .all();
  const allMsgs = ((hist.results || []) as any[]).reverse();
  const history = allMsgs.map((m) => ({ role: m.role as string, content: m.content as string }));

  // Tool call memory: collect recent tool call summaries for context injection
  const prevToolCalls: string[] = [];
  for (const m of allMsgs) {
    if (m.tool_calls) {
      try {
        const tc = JSON.parse(m.tool_calls);
        if (Array.isArray(tc)) {
          for (const call of tc) {
            if (call.result_summary) prevToolCalls.push(`[${call.tool}] ${call.result_summary.slice(0, 100)}`);
          }
        }
      } catch {}
    }
  }

  // Rolling long-term memory: inject the summary of earlier (truncated) turns, if any.
  const conv = await c.env.DB.prepare(`SELECT summary FROM conversations WHERE id=?`)
    .bind(convId)
    .first<{ summary: string | null }>();

  // Save user message.
  await c.env.DB.prepare(
    `INSERT INTO messages (id,conversation_id,role,content) VALUES (?,?,?,?)`
  )
    .bind(crypto.randomUUID(), convId, "user", body.message)
    .run();

  // ---- True streaming: start SSE immediately, do preprocessing inside the stream ----
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (evt: string, data: any) =>
        controller.enqueue(encoder.encode(`event: ${evt}\ndata: ${JSON.stringify(data)}\n\n`));

      try {
        // Step 1: LLM query planning — one flash call that ALSO identifies tradable instruments
        // (name + ticker) AND classifies the route (quick = corpus-only, deep = needs live data/tools).
        send("progress", { phase: "plan", text: "正在理解问题、识别标的并规划检索…" });
        const plan = await planQuery(c.env, c.env.MODEL_FLASH, body.message, []);
        // Candidates to price-check: the planner's explicit instruments FIRST, then its exact_entities as
        // fallback. flash is often unsure whether a name is tradable (e.g. a just-IPO'd SpaceX→SPCX), so
        // we let the LIVE FEED decide — gatherMarketData keeps only those that return a real quote.
        const rawTickerCandidates = Array.from(
          body.message.matchAll(/(?:\$|\b)([A-Z]{2,6})(?=\b)/g),
          (m) => m[1],
        ).filter((ticker) => !["ETF", "FOMC", "PE", "PB", "EPS", "AI"].includes(ticker));
        const plannedInstruments = Array.from(new Set([
          ...rawTickerCandidates,
          ...plan.instruments.map((i) => i.ticker || i.name).filter(Boolean),
          ...plan.exact_entities,
        ]));

        // Step 2 + 3 run CONCURRENTLY: market-data fetch and tweet retrieval+rerank are independent once we
        // have the planner's instruments. (Previously serial, which cost ~15-20s.) They share no state.
        send("progress", { phase: "market", text: "正在并行获取行情与检索原文…" });
        const [market, retrieved] = await Promise.all([
          gatherMarketData(c.env, body.message, { extraInstruments: plannedInstruments }),
          (async () => {
            const mode = (kol.retrieval_mode === "tagged" ? "tagged" : "query_side") as "tagged" | "query_side";
            // Pass the planner's instrument guesses (validated tickers aren't resolved yet — market-data
            // runs concurrently); retrieve also tokenizes the raw query for ticker-ish terms. The planner's
            // exact_entities (which already contain these guesses) drive the FTS routes.
            return retrieve(
              c.env, kol.id, kol.handle, body.message, plannedInstruments, plan, c.env.MODEL_FLASH, mode, kol.corpus_id || kol.id
            );
          })(),
        ]);
        const tickers = market.quotes.map((q) => q.symbol);
        // Fold the validated tickers back into the plan so any downstream consumer matches them too.
        for (const t of tickers) if (t && !plan.exact_entities.includes(t)) plan.exact_entities.push(t);
        const { citations, knowledge } = retrieved;

        // Observability: when persona_pack is NULL the KOL silently runs on the 3-line generic
        // DEFAULT_PERSONA. Record it (once per conversation, on the first turn) so we can see how
        // often and for which KOLs distillation never produced a usable pack. Non-blocking.
        if (!kol.persona_pack && history.length === 0) {
          c.executionCtx.waitUntil(
            logPersonaExperiment(c.env, kol.id, {
              content: "", finish_reason: "fallback",
              content_len: 0, duration_ms: 0, parse_ok: false,
              error_type: null, note: `chat used DEFAULT_PERSONA (no persona_pack); conv=${convId}`,
            }, 0, "chat_fallback"),
          );
        }

        const messages = buildMessages({
          kol,
          persona: kol.persona_pack || DEFAULT_PERSONA(kol),
          knowledge,
          citations,
          market,
          history,
          userMessage: body.message,
          summary: conv?.summary || undefined,
          toolMemory: prevToolCalls.length ? prevToolCalls.slice(0, 8).join("\n") : undefined,
        });

        // Retrieval candidates are private working context, not citations. The source rail is populated
        // only after the final answer exists and we can deterministically keep refs actually used.
        send("meta", {
          citations: [],
          candidate_count: citations.length,
          chart: market.primary ? { code: market.primary.code, symbol: market.primary.symbol, market: market.primary.market } : null,
        });

        // Step 4: Tool phase — run the LLM tool chooser only when the planner needs live data AND the
        // deterministic prefetch did not already cover the requested quote/news/profile/kline context.
        // The common stock case is answered from SOURCE TWEETS + LIVE MARKET DATA with no extra tool LLM.
        let toolMsgs: any[] = messages;
        let toolCalls: { tool: string; args: Record<string, any>; result_summary: string }[] = [];
        if (shouldRunToolPhase(plan, market, body.message, plannedInstruments)) {
          send("progress", { phase: "tools", text: "正在调用工具获取深度数据…" });
          const toolRounds = plan.route === "quick" ? 1 : market.primary ? 1 : 2;
          const toolPhase = await resolveToolPhase(c.env, model, messages, (evt) => {
            if (evt.type === "progress") send("progress", { phase: "tools", text: evt.text || "正在分析数据…" });
            if (evt.type === "tool_call") {
              send("progress", { phase: "tools", text: `工具: ${evt.name || "unknown"}` });
              send("tool_call", { name: evt.name || "unknown", args: evt.args || "" });
            }
          }, toolRounds, byokCfg || undefined);
          toolMsgs = toolPhase.messages;
          toolCalls = toolPhase.toolCalls;
        }

        const latestQuestionLanguage = /[\u3400-\u9fff]/.test(body.message) ? "Chinese" : "English";
        const finalMessages = [
          ...toolMsgs,
          {
            role: "user",
            content:
              "现在直接输出给用户看的最终分析。严禁输出任何工具调用或 DSL 标签；不要说你要调用工具。\n" +
              `The latest user question language is ${latestQuestionLanguage}. Answer in ${latestQuestionLanguage}; do not follow the corpus/persona language for output language. 保持你（博主）一贯的语气、分析框架和表达风格，像在回复读者的提问一样自然地写。\n` +
              "Use prior conversation only to understand follow-ups; the latest USER QUESTION is the task you must answer.\n" +
              "Only claim to remember or see earlier details if they are actually present in the provided conversation history or summary; otherwise say you cannot see them.\n" +
              "If the latest question is about whether you can see/remember prior conversation, answer only that memory/access question; do not infer or add a new investment analysis from tickers mentioned in that question.\n" +
              "If the user explicitly asks to answer only, confirm only, not expand, or not re-analyze, keep the answer concise; do not add market data, citations, headings, or unrelated analysis.\n" +
              "If the user asks for price/action levels, answer the requested action first in the persona's natural style.\n" +
              "The answer must include, when applicable: current decision, conditional buy/add range, conditional sell/trim range, and invalidation/risk condition.\n" +
              "Do not use a rigid template unless it fits the persona's style.\n" +
              "Do not stop at principles or say only that the persona avoids exact points.\n" +
              "引用写成 [1]、[2] 这种纯数字格式。自然地融入原文引用，不要刻意分段或加小标题。\n" +
              "不要在文末追加参考资料列表、引文摘抄或编号说明；来源栏会单独展示原文。\n" +
              "缺数据明说，不要编。",
          },
        ];

        // Step 4: Stream final LLM response — route through BYOK or system gateway.
        send("progress", { phase: "thinking", text: "正在生成回复…" });
        const effectiveModel = byokCfg && byokCfg.modelName !== "Auto" ? byokCfg.modelName : model;
        const upstream = await (byokCfg
          ? fetch(byokCfg.baseUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${byokCfg.apiKey}`,
                "HTTP-Referer": "https://robindex.ai",
                "X-Title": "Robindex",
              },
              body: JSON.stringify({ model: effectiveModel, messages: finalMessages, stream: true, temperature: 0.6 }),
            })
          : fetch(c.env.GATEWAY_URL, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "cf-aig-authorization": `Bearer ${c.env.CFGATEWAYKEY}`,
                ...(c.env.OPENROUTER_KEY ? { Authorization: `Bearer ${c.env.OPENROUTER_KEY}` } : {}),
                "HTTP-Referer": "https://robindex.ai",
                "X-Title": "Robindex",
              },
              body: JSON.stringify({ model, messages: finalMessages, stream: true, temperature: 0.6 }),
            })
        );

        if (!upstream.ok || !upstream.body) {
          send("error", { status: upstream.status });
          controller.close();
          return;
        }

        const reader = upstream.body!.getReader();
        let buf = "";
        let full = "";
        const dslCleaner = createDSLStreamCleaner();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop() || "";
            for (const line of lines) {
              const s = line.trim();
              if (!s.startsWith("data:")) continue;
              const payload = s.slice(5).trim();
              if (payload === "[DONE]") continue;
              try {
                const pj = JSON.parse(payload);
                const delta = pj.choices?.[0]?.delta?.content || "";
                if (delta) {
                  const clean = normalizeCitationBrackets(dslCleaner.push(delta));
                  if (clean) {
                    full += clean;
                    controller.enqueue(encoder.encode(`event: delta\ndata: ${JSON.stringify(clean)}\n\n`));
                  }
                }
              } catch {}
            }
          }
          const tail = dslCleaner.flush();
          if (tail) {
            full += tail;
            controller.enqueue(encoder.encode(`event: delta\ndata: ${JSON.stringify(tail)}\n\n`));
          }
        } catch (e) {
          send("error", { message: String(e) });
        }

        full = normalizeCitationBrackets(stripToolCallDSL(full)).trim();
        const validCitationRefs = new Set(citations.map((cc) => cc.ref));
        // The model occasionally invents numeric markers for live data/news. Remove markers that do
        // not map to a supplied source tweet, then replace the streamed draft with this canonical text.
        full = full.replace(/(?:\[|【)\s*T?(\d+)\s*(?:\]|】)/gi, (marker, n) =>
          validCitationRefs.has(`T${n}`) ? `[${n}]` : ""
        ).replace(/[ \t]+([，。；：,.!?])/g, "$1").trim();
        const usedRefs = new Set(Array.from(full.matchAll(/(?:\[|【)\s*T?(\d+)\s*(?:\]|】)/gi)).map((m) => `T${m[1]}`));
        const locallyUsed = usedRefs.size ? citations.filter((cc) => usedRefs.has(cc.ref)) : [];
        const citationState = await loadConversationCitationState(c.env, convId!);
        const renumbered = renumberAnswerCitations(full, locallyUsed, citationState);
        full = renumbered.answer;
        const usedCitations = renumbered.messageCitations;
        const cumulativeCitations = renumbered.cumulativeCitations;

        // Persist before closing the stream. Cloudflare may stop work after controller.close(), which
        // would leave follow-up turns with only user messages and no memory of the assistant answer.
        if (full) {
          await c.env.DB.prepare(
            `INSERT INTO messages (id,conversation_id,role,content,citations,tool_calls) VALUES (?,?,?,?,?,?)`
          )
            .bind(crypto.randomUUID(), convId!, "assistant", full, JSON.stringify(usedCitations), toolCalls.length ? JSON.stringify(toolCalls) : null)
            .run();
          await c.env.DB.prepare(`UPDATE conversations SET updated_at=datetime('now') WHERE id=?`)
            .bind(convId!)
            .run();
          // Skip summary generation for BYOK models — background tasks shouldn't spend user's API credits.
          if (!byokCfg) {
            c.executionCtx.waitUntil(maybeUpdateSummary(c.env, convId!, model).catch((e) => console.error("summary update failed", e)));
          }
        }
        send("meta", {
          citations: cumulativeCitations,
          message_citations: usedCitations,
          candidate_count: citations.length,
          final: true,
          chart: market.primary ? {
            code: market.primary.code,
            symbol: market.primary.symbol,
            market: market.primary.market,
            name: market.primary.canonicalName || market.primary.name,
            asset_type: market.primary.assetType,
          } : null,
        });
        send("final_answer", full);

        // Record a billing consumption row so /api/billing/state surfaces it (with byok flag
        // set when the user used their own key). Token counts are best-effort estimated.
        if (auth) {
          const approxIn = body.message.length * 1.7 + 2600;
          const approxOut = full.length / 2.2;
          const isFree = !byokCfg && body.model === "flash" && !(await hasCreditBalance(c.env, auth.userId));
          const points = byokCfg || isFree ? 0 : Math.round(((approxIn * 0.20) + (approxOut * 0.90)) / 1000 * 100) / 100;
          await c.env.DB.prepare(
            `INSERT INTO billing_consumption (id,user_id,kol_id,model,tok_in,tok_out,points,free,byok,q,ts) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
          ).bind(
            crypto.randomUUID(),
            auth.userId,
            kol.id,
            body.model || null,
            Math.round(approxIn),
            Math.round(approxOut),
            points,
            isFree ? 1 : 0,
            byokCfg ? 1 : 0,
            String(body.message).slice(0, 280),
            Date.now(),
          ).run();
          // Mirror to localStorage so the page instantly reflects the new row.
          send("consumption", { byok: !!byokCfg, free: isFree, points, model: body.model });
        }
        send("done", { citation_count: usedCitations.length });
        controller.close();
      } catch (e) {
        send("error", { message: String(e) });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Conversation-Id": convId!,
    },
  });
});

// ---- Chat history (Desk frontend cloud sync) ----
app.get("/api/chat/history", async (c) => {
  const userId = c.req.query("user_id");
  if (!userId) return c.json({ error: "user_id required" }, 400);
  const rows = await c.env.DB.prepare(
    `SELECT id, kol_id, title, messages_json, created_at, updated_at FROM chat_history WHERE user_id=? ORDER BY updated_at DESC LIMIT 100`
  ).bind(userId).all();
  return c.json({ chats: rows.results || [] });
});

app.get("/api/chat/history/:id", async (c) => {
  const userId = c.req.query("user_id");
  const id = c.req.param("id");
  if (!userId) return c.json({ error: "user_id required" }, 400);
  const row = await c.env.DB.prepare(
    `SELECT id, kol_id, title, messages_json, created_at, updated_at FROM chat_history WHERE id=? AND user_id=?`
  ).bind(id, userId).first();
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json(row);
});

app.post("/api/citations/hydrate", async (c) => {
  const body: { kol_id?: string; handle?: string; citations?: any[] } =
    await c.req.json<{ kol_id?: string; handle?: string; citations?: any[] }>().catch(() => ({}));
  const kolId = body.kol_id || "";
  const handle = body.handle || kolId;
  const citations = Array.isArray(body.citations) ? body.citations : [];
  if (!kolId || !citations.length) return c.json({ citations });

  const citationTweetId = (x: any) => {
    const direct = String(x.tweet_id || x.id || "");
    if (direct) return direct;
    const m = String(x.url || "").match(/\/status\/(\d+)/);
    return m ? m[1] : "";
  };
  const ids = Array.from(new Set(citations.map(citationTweetId).filter(Boolean))).slice(0, 80);
  if (!ids.length) return c.json({ citations });

  const rows = await c.env.DB.prepare(
    `SELECT id,text,created_at_iso,likes,views,quoted,media FROM tweets WHERE kol_id=? AND id IN (${ids.map(() => "?").join(",")})`
  ).bind(kolId, ...ids).all().then((r) => (r.results || []) as any[]);
  const byId = new Map(rows.map((r) => [String(r.id), r]));

  const needLookup = new Map<string, any[]>();
  for (const cite of citations) {
    const cid = citationTweetId(cite);
    if (cid && !cite.tweet_id) cite.tweet_id = cid;
    const row = byId.get(cid);
    if (row) {
      cite.ref = cite.ref || cite.cite || "";
      cite.tweet_id = String(row.id);
      cite.snippet = String(cite.snippet || cite.text || row.text || "");
      cite.text = cite.text || cite.snippet;
      cite.date = cite.date || String(row.created_at_iso || "").slice(0, 10);
      cite.url = cite.url || `https://x.com/${handle}/status/${row.id}`;
      cite.likes = cite.likes ?? row.likes ?? 0;
      cite.views = cite.views || row.views || "";
    }
    if (row?.media && !cite.media) {
      try {
        const media = JSON.parse(row.media);
        if (Array.isArray(media) && media.length) cite.media = media;
      } catch {}
    }
    if (cite.quoted?.text) continue;
    if (row?.quoted) {
      try {
        const quoted = JSON.parse(row.quoted);
        if (quoted?.text) {
          cite.quoted = quoted;
          continue;
        }
      } catch {}
    }
    const text = String(cite.snippet || cite.text || row?.text || "");
    let match = text.match(/(?:x|twitter)\.com\/([A-Za-z0-9_]+)\/status\/(\d+)/i);
    if (!match) {
      const short = text.match(/https?:\/\/t\.co\/[A-Za-z0-9_%-]+/i)?.[0];
      if (short) {
        const res = await fetch(short, { redirect: "manual" }).catch(() => null);
        const dest = res?.headers.get("location") || "";
        match = dest.match(/(?:x|twitter)\.com\/([A-Za-z0-9_]+)\/status\/(\d+)/i);
      }
    }
    if (!match || match[1].toLowerCase() !== String(handle).toLowerCase()) continue;
    const arr = needLookup.get(match[2]) || [];
    arr.push(cite);
    needLookup.set(match[2], arr);
  }

  const qids = Array.from(needLookup.keys()).slice(0, 80);
  if (qids.length) {
    const qrows = await c.env.DB.prepare(
      `SELECT id,text,created_at_iso FROM tweets WHERE kol_id=? AND id IN (${qids.map(() => "?").join(",")})`
    ).bind(kolId, ...qids).all().then((r) => (r.results || []) as any[]).catch(() => []);
    for (const r of qrows) {
      const arr = needLookup.get(String(r.id)) || [];
      for (const cite of arr) {
        cite.quoted = {
          id: String(r.id),
          text: r.text || "",
          handle,
          name: handle === "qinbafrank" ? "Qinbafrank" : "",
          url: `https://x.com/${handle}/status/${r.id}`,
          date: (r.created_at_iso || "").slice(0, 10),
        };
      }
    }
  }

  return c.json({ citations });
});

app.put("/api/chat/history/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ user_id: string; kol_id: string; title: string; messages_json: string }>();
  if (!body.user_id || !body.kol_id) return c.json({ error: "user_id and kol_id required" }, 400);
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO chat_history (id, user_id, kol_id, title, messages_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET title=excluded.title, messages_json=excluded.messages_json, updated_at=excluded.updated_at`
  ).bind(id, body.user_id, body.kol_id, body.title || "", body.messages_json || "[]", now, now).run();
  return c.json({ ok: true, id });
});

app.delete("/api/chat/history/:id", async (c) => {
  const userId = c.req.query("user_id");
  const id = c.req.param("id");
  if (!userId) return c.json({ error: "user_id required" }, 400);
  await c.env.DB.prepare(`DELETE FROM chat_history WHERE id=? AND user_id=?`).bind(id, userId).run();
  return c.json({ ok: true });
});

// ---- Follow-up question suggestions (lightweight, fast) ----
app.post("/api/suggest", async (c) => {
  const body = await c.req.json<{ kol_id: string; question: string; answer: string }>();
  if (!body.kol_id || !body.answer) return c.json({ suggestions: [] });
  const kol = await c.env.DB.prepare(`SELECT display_name,handle FROM kols WHERE id=?`).bind(body.kol_id).first<any>();
  const model = c.env.MODEL_FLASH;
  const sys = `You generate exactly 4 concise Chinese follow-up questions for a finance research assistant. Each question should dig deeper into a different angle of the analysis. Format: return ONLY a JSON array of 4 strings, no markdown. Example: ["如何量化判断毛利率出现结构性挤压？","在大厂CAPEX变动中看哪个财务指标？","怎么对比RubIn平台和之前的芯片逻辑？","为什么说H200交付是安全垫？"]`;
  const usr = `KOL: ${kol?.display_name || body.kol_id}\nUser question: ${body.question}\n\nAssistant answer (first 2000 chars):\n${body.answer.slice(0, 2000)}`;
  try {
    const res = await fetch(c.env.GATEWAY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "cf-aig-authorization": `Bearer ${c.env.CFGATEWAYKEY}`,
        ...(c.env.OPENROUTER_KEY ? { Authorization: `Bearer ${c.env.OPENROUTER_KEY}` } : {}),
        "HTTP-Referer": "https://robindex.ai",
        "X-Title": "Robindex",
      },
      body: JSON.stringify({ model, messages: [{ role: "system", content: sys }, { role: "user", content: usr }], temperature: 0.7, max_tokens: 300 }),
    });
    const j: any = await res.json();
    const text = j?.choices?.[0]?.message?.content || "";
    const arr = JSON.parse(text);
    return c.json({ suggestions: Array.isArray(arr) ? arr.slice(0, 4) : [] });
  } catch {
    return c.json({ suggestions: [] });
  }
});

// ---------------- Billing (real payments) ----------------
// All money-touching reads/writes verify the Privy access token; we trust only the verified DID.

// Current balance, subscriptions, ledger and consumption for the signed-in user.
app.get("/api/billing/state", async (c) => {
  const auth = await authFromRequest(c.env, c.req.header("authorization"));
  if (!auth) return c.json({ error: "unauthorized" }, 401);
  const email = c.req.query("email") || undefined;
  return c.json(await getState(c.env, auth.userId, email));
});

// Start a checkout for a credit pack or a KOL subscription. Amounts are computed server-side from
// the price tables — never from the request body. Provider is chosen by the client or auto-selected
// from whatever is configured. Stripe returns a hosted URL; Airwallex returns intent details that the
// browser hands to the Airwallex.js SDK to redirect.
app.post("/api/billing/checkout", async (c) => {
  const auth = await authFromRequest(c.env, c.req.header("authorization"));
  if (!auth) return c.json({ error: "unauthorized" }, 401);

  const body = await c.req.json<{ type: "pack" | "sub"; packId?: string; kolId?: string; plan?: string; email?: string; provider?: string }>().catch(() => ({} as any));
  const hasStripe = !!c.env.STRIPE_SECRET_KEY;
  const hasAirwallex = !!(c.env.AIRWALLEX_API_KEY && c.env.AIRWALLEX_CLIENT_ID);
  // Auto-select: prefer the explicitly requested provider, else whatever is configured.
  let provider = body.provider === "stripe" || body.provider === "airwallex" ? body.provider : (hasAirwallex ? "airwallex" : hasStripe ? "stripe" : "");
  if (provider === "stripe" && !hasStripe) return c.json({ error: "stripe_not_configured" }, 503);
  if (provider === "airwallex" && !hasAirwallex) return c.json({ error: "airwallex_not_configured" }, 503);
  if (!provider) return c.json({ error: "no_payment_provider" }, 503);

  const origin = new URL(c.req.url).origin;
  const successUrl = `${origin}/?billing=success`;
  const cancelUrl = `${origin}/?billing=cancel`;
  const now = Date.now();

  // Resolve the order (kind + ref + amount + display name) from the authoritative price tables.
  let kind: "pack" | "sub", ref: string, amountCents: number, name: string, plan = "promo";
  if (body.type === "pack") {
    const pack = body.packId ? PACKS[body.packId] : null;
    if (!pack) return c.json({ error: "unknown_pack" }, 400);
    kind = "pack"; ref = pack.id; amountCents = pack.cents;
    name = `Robindex · ${pack.label} (${pack.credits.toLocaleString()} credits)`;
  } else if (body.type === "sub") {
    const kolId = body.kolId || "";
    if (!kolId) return c.json({ error: "unknown_kol" }, 400);
    const kolPlan = await getKolPlan(c.env, kolId);
    if (!kolPlan || !kolPlan.enabled) return c.json({ error: "unknown_kol" }, 400);
    plan = body.plan === "default" ? "default" : "promo";
    kind = "sub"; ref = kolId; amountCents = subCents(kolPlan, plan);
    name = `Robindex · ${kolPlan.name} 订阅`;
  } else {
    return c.json({ error: "bad_type" }, 400);
  }

  // Airwallex subscriptions need a recurring Price set up in the account (see AIRWALLEX_PRICES).
  const checkoutPlan = kind === "sub" ? await getKolPlan(c.env, ref) : null;
  if (provider === "airwallex" && kind === "sub" && !checkoutPlan?.airwallexPriceId) {
    return c.json({ error: "no_airwallex_price_for_kol" }, 400);
  }

  const recordPayment = (id: string, prov: string) => c.env.DB.prepare(
    `INSERT OR IGNORE INTO billing_payments (id,user_id,provider,kind,ref,amount_cents,currency,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)`
  ).bind(id, auth.userId, prov, kind, ref, amountCents, "usd", "created", now).run();

  try {
    if (provider === "stripe") {
      const session = await createCheckoutSession(c.env, {
        kind, userId: auth.userId, email: body.email, ref, name, amountCents,
        recurring: kind === "sub", successUrl, cancelUrl, metadata: kind === "sub" ? { plan } : undefined,
      });
      await recordPayment(session.id, "stripe");
      return c.json({ provider: "stripe", url: session.url, id: session.id });
    }

    // Airwallex subscription: Hosted Billing Checkout returns a URL (no SDK), like Stripe.
    if (kind === "sub") {
      const co = await createBillingCheckout(c.env, {
        priceId: checkoutPlan!.airwallexPriceId!,
        successUrl: `${origin}/?billing=success&provider=airwallex`, cancelUrl,
        metadata: { user_id: auth.userId, kol_id: ref, kind: "sub", plan },
      });
      await recordPayment(co.id, "airwallex");
      return c.json({ provider: "airwallex", url: co.url, id: co.id });
    }

    // Airwallex pack: create a Payment Intent we own; the browser SDK redirects to the hosted page.
    const intent = await createPaymentIntent(c.env, {
      amountCents, currency: "USD",
      merchantOrderId: `${ref}:${now}`,
      returnUrl: `${origin}/?billing=success&provider=airwallex`,
      metadata: { userId: auth.userId, kind, ref },
    });
    await recordPayment(intent.id, "airwallex");
    return c.json({ provider: "airwallex", intentId: intent.id, clientSecret: intent.clientSecret, currency: intent.currency, amount: intent.amount, env: awEnv(c.env) });
  } catch (e) {
    return c.json({ error: "checkout_failed", detail: String(e) }, 500);
  }
});

// Server-authoritative spend: deduct points for a question the user just asked. The client mirrors
// this for instant UI, but the balance shown comes from the server.
app.post("/api/billing/consume", async (c) => {
  const auth = await authFromRequest(c.env, c.req.header("authorization"));
  if (!auth) return c.json({ error: "unauthorized" }, 401);
  const b = await c.req.json<{ kolId?: string; model?: string; tokIn?: number; tokOut?: number; points?: number; free?: boolean; byok?: boolean; q?: string }>().catch(() => ({} as any));
  const points = b.byok || b.free ? 0 : Math.max(0, Number(b.points) || 0);
  const now = Date.now();
  const stmts = [
    c.env.DB.prepare(`INSERT INTO billing_consumption (id,user_id,kol_id,model,tok_in,tok_out,points,free,byok,q,ts) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(crypto.randomUUID(), auth.userId, b.kolId || null, b.model || null, b.tokIn || 0, b.tokOut || 0, points, b.free ? 1 : 0, b.byok ? 1 : 0, b.q ? String(b.q).slice(0, 280) : null, now),
  ];
  if (b.free) stmts.push(c.env.DB.prepare(`UPDATE billing_accounts SET free_used=free_used+1, updated_at=? WHERE user_id=?`).bind(now, auth.userId));
  else if (points > 0) stmts.push(c.env.DB.prepare(`UPDATE billing_accounts SET credits=MAX(0,credits-?), updated_at=? WHERE user_id=?`).bind(points, now, auth.userId));
  await c.env.DB.batch(stmts);
  return c.json(await getState(c.env, auth.userId));
});

// Toggle auto-renew (cancel/uncancel at period end). Best-effort Stripe sync, always updates locally.
app.post("/api/billing/autorenew", async (c) => {
  const auth = await authFromRequest(c.env, c.req.header("authorization"));
  if (!auth) return c.json({ error: "unauthorized" }, 401);
  const b = await c.req.json<{ kolId?: string; on?: boolean }>().catch(() => ({} as any));
  if (!b.kolId) return c.json({ error: "kolId required" }, 400);
  await c.env.DB.prepare(`UPDATE billing_subscriptions SET auto_renew=?, updated_at=? WHERE user_id=? AND kol_id=?`)
    .bind(b.on ? 1 : 0, Date.now(), auth.userId, b.kolId).run();
  return c.json(await getState(c.env, auth.userId));
});

// ---- BYOK (Bring Your Own Key) model management ----
// Users manage their own LLM API keys and endpoints. These endpoints require authentication.

app.get("/api/byok/models", async (c) => {
  const auth = await authFromRequest(c.env, c.req.header("authorization"));
  if (!auth) return c.json({ error: "unauthorized" }, 401);
  const models = await listByokModels(c.env, auth.userId);
  return c.json({ models, providers: BYOK_PROVIDERS });
});

app.post("/api/byok/models", async (c) => {
  const auth = await authFromRequest(c.env, c.req.header("authorization"));
  if (!auth) return c.json({ error: "unauthorized" }, 401);
  const b = await c.req.json<{ id?: string; providerId: string; modelName: string; displayName?: string; baseUrl?: string; apiKey: string; color?: string; badge?: string }>().catch(() => ({} as any));
  if (!b.providerId || !b.apiKey) return c.json({ error: "providerId and apiKey required" }, 400);
  const saved = await saveByokModel(c.env, auth.userId, b);
  return c.json({ model: saved });
});

app.delete("/api/byok/models/:id", async (c) => {
  const auth = await authFromRequest(c.env, c.req.header("authorization"));
  if (!auth) return c.json({ error: "unauthorized" }, 401);
  const id = c.req.param("id");
  const ok = await deleteByokModel(c.env, auth.userId, id);
  if (!ok) return c.json({ error: "not_found" }, 404);
  return c.json({ deleted: true });
});

// Stripe webhook — the ONLY place credits/subscriptions are granted. Signature-verified, idempotent.
app.post("/api/stripe/webhook", async (c) => {
  const payload = await c.req.text();
  const sig = c.req.header("stripe-signature") || "";
  const event = await verifyWebhook(c.env, payload, sig);
  if (!event) return c.json({ error: "bad_signature" }, 400);
  if (await eventSeen(c.env, "stripe", event.id)) return c.json({ received: true, dedup: true });

  try {
    if (event.type === "checkout.session.completed") {
      const s = event.data.object;
      const md = s.metadata || {};
      if (s.payment_status === "paid" || s.mode === "subscription") {
        if (md.kind === "pack") {
          await grantTopup(c.env, md.userId, md.ref, s.id);
        } else if (md.kind === "sub") {
          await activateSubscription(c.env, md.userId, md.ref, md.plan || "promo", {
            provider: "stripe", providerSubId: s.subscription || undefined, ref: s.id,
          });
        }
        await c.env.DB.prepare(`UPDATE billing_payments SET status='paid' WHERE id=?`).bind(s.id).run();
      }
    } else if (event.type === "invoice.paid" || event.type === "invoice.payment_succeeded") {
      const inv = event.data.object;
      // Only renewals here — the first cycle is granted by checkout.session.completed.
      if (inv.billing_reason === "subscription_cycle" && inv.subscription) {
        const row = await c.env.DB.prepare(`SELECT user_id,kol_id,plan FROM billing_subscriptions WHERE provider_sub_id=?`).bind(inv.subscription).first<any>();
        if (row) {
          const periodEnd = inv.lines?.data?.[0]?.period?.end ? inv.lines.data[0].period.end * 1000 : undefined;
          await activateSubscription(c.env, row.user_id, row.kol_id, row.plan, {
            provider: "stripe", providerSubId: inv.subscription, periodEnd, ref: inv.id,
          });
        }
      }
    } else if (event.type === "customer.subscription.deleted") {
      await setSubscriptionStatus(c.env, event.data.object.id, "canceled", false);
    } else if (event.type === "customer.subscription.updated") {
      const sub = event.data.object;
      await setSubscriptionStatus(c.env, sub.id, sub.status, !sub.cancel_at_period_end);
    }
  } catch (e) {
    return c.json({ error: "handler_failed", detail: String(e) }, 500);
  }
  return c.json({ received: true });
});

// Airwallex webhook — grants credits for one-time packs. Signature-verified, idempotent. We map the
// succeeded Payment Intent id back to the billing_payments row we created at checkout (no metadata trust).
app.post("/api/airwallex/webhook", async (c) => {
  const payload = await c.req.text();
  const ts = c.req.header("x-timestamp") || "";
  const sig = c.req.header("x-signature") || "";
  const event = await verifyAirwallexWebhook(c.env, payload, ts, sig);
  if (!event) return c.json({ error: "bad_signature" }, 400);
  const eventId = event.id || `${event.name}:${event.data?.object?.id}`;
  if (await eventSeen(c.env, "airwallex", eventId)) return c.json({ received: true, dedup: true });

  const evt = String(event.name || event.type || "");
  const obj = event.data?.object || event.data || {};
  const toMs = (v: any): number | undefined => {
    if (v == null) return undefined;
    if (typeof v === "number") return v > 1e12 ? v : v * 1000;
    const t = Date.parse(String(v));
    return isNaN(t) ? undefined : t;
  };

  try {
    // One-time packs: map the succeeded Payment Intent id back to our row (no metadata trust).
    if (evt === "payment_intent.succeeded") {
      const row = await c.env.DB.prepare(`SELECT user_id,kind,ref,status FROM billing_payments WHERE id=?`).bind(obj.id).first<any>();
      if (row && row.status !== "paid" && row.kind === "pack") {
        await grantTopup(c.env, row.user_id, row.ref, obj.id);
        await c.env.DB.prepare(`UPDATE billing_payments SET status='paid' WHERE id=?`).bind(obj.id).run();
      }
    }
    // Subscriptions: a paid invoice both activates the first cycle and renews later ones.
    else if (/invoice/i.test(evt) && /(paid|succeeded|payment_succeeded|payment_attempt\.succeeded)/i.test(evt)) {
      const md = obj.metadata || obj.subscription?.metadata || {};
      const subId = obj.subscription_id || obj.subscription?.id || (/(^|\.)subscription/i.test(evt) ? obj.id : undefined);
      let userId = md.user_id, kolId = md.kol_id, plan = md.plan || "promo";
      if ((!userId || !kolId) && subId) {
        const row = await c.env.DB.prepare(`SELECT user_id,kol_id,plan FROM billing_subscriptions WHERE provider_sub_id=?`).bind(subId).first<any>();
        if (row) { userId = userId || row.user_id; kolId = kolId || row.kol_id; plan = row.plan || plan; }
      }
      if (userId && kolId) {
        const periodEnd = toMs(obj.period_end ?? obj.current_period_end ?? obj.next_billing_at ?? obj.subscription?.current_period_end);
        await activateSubscription(c.env, userId, kolId, plan, {
          provider: "airwallex", providerSubId: subId || undefined, periodEnd, ref: obj.id || eventId,
        });
      }
    }
    // Subscription cancelled/expired → stop access at period end.
    else if (/subscription/i.test(evt) && /(cancel|delet|expir|ended)/i.test(evt)) {
      if (obj.id) await setSubscriptionStatus(c.env, obj.id, "canceled", false);
    }
  } catch (e) {
    return c.json({ error: "handler_failed", detail: String(e) }, 500);
  }
  return c.json({ received: true });
});

// ---------------- Admin bulk import (protected) ----------------
function adminOk(c: any): boolean {
  return !!c.env.ADMIN_KEY && c.req.header("x-admin-key") === c.env.ADMIN_KEY;
}

app.post("/api/admin/kol", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const k = await c.req.json<any>();
  await c.env.DB.prepare(
    `INSERT INTO kols (id,display_name,handle,twitter_uid,avatar_url,tagline,persona_pack,persona_version,updated_at)
     VALUES (?,?,?,?,?,?,?,?,datetime('now'))
     ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name, handle=excluded.handle,
       twitter_uid=excluded.twitter_uid, avatar_url=excluded.avatar_url, tagline=excluded.tagline,
       persona_pack=excluded.persona_pack, persona_version=excluded.persona_version, updated_at=datetime('now')`
  )
    .bind(k.id, k.display_name, k.handle, k.twitter_uid || null, k.avatar_url || null, k.tagline || null, k.persona_pack || null, k.persona_version || null)
    .run();
  if (k.last_tweet_id) {
    await c.env.DB.prepare(
      `INSERT INTO sync_state (kol_id,last_tweet_id,last_run_at,note) VALUES (?,?,datetime('now'),?)
       ON CONFLICT(kol_id) DO UPDATE SET last_tweet_id=excluded.last_tweet_id`
    )
      .bind(k.id, k.last_tweet_id, "seed")
      .run();
  }
  return c.json({ ok: true });
});

app.post("/api/admin/tweets", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.json<{ kol_id: string; tweets: any[] }>();
  const tweets = body.tweets || [];
  const stmt = c.env.DB.prepare(
    `INSERT OR IGNORE INTO tweets
     (id,kol_id,text,created_at_iso,created_at_ts,is_retweet,lang,likes,retweets,replies,quotes,views,urls,media)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const batch: D1PreparedStatement[] = [];
  tweets.forEach((t) => {
    batch.push(
      stmt.bind(
        String(t.id),
        body.kol_id,
        t.text || "",
        t.created_at_iso || "",
        t.created_at_ts || 0,
        t.is_retweet ? 1 : 0,
        t.lang || "",
        t.likes || 0,
        t.retweets || 0,
        t.replies || 0,
        t.quotes || 0,
        t.views || 0,
        JSON.stringify(t.urls || []),
        JSON.stringify(t.media || [])
      )
    );
  });
  if (batch.length) await c.env.DB.batch(batch);
  return c.json({ ok: true, inserted: batch.length });
});

app.post("/api/admin/knowledge", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.json<{ kol_id: string; chunks: any[] }>();
  const chunks = body.chunks || [];
  const stmt = c.env.DB.prepare(
    `INSERT OR REPLACE INTO knowledge_chunks (id,kol_id,source,title,text)
     VALUES (?,?,?,?,?)`
  );
  const batch: D1PreparedStatement[] = [];
  chunks.forEach((k) => {
    batch.push(stmt.bind(k.id, body.kol_id, k.source, k.title || null, k.text || ""));
  });
  if (batch.length) await c.env.DB.batch(batch);
  return c.json({ ok: true, inserted: batch.length });
});

app.get("/api/admin/stats", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const t = await c.env.DB.prepare(
    `SELECT kol_id, COUNT(*) n,
            SUM(CASE WHEN is_retweet=0 THEN 1 ELSE 0 END) non_retweets,
            MIN(created_at_iso) oldest,
            MAX(created_at_iso) newest
     FROM tweets GROUP BY kol_id`
  ).all();
  const k = await c.env.DB.prepare(`SELECT kol_id, COUNT(*) n FROM knowledge_chunks GROUP BY kol_id`).all();
  const s = await c.env.DB.prepare(`SELECT * FROM sync_state`).all();
  return c.json({ tweets: t.results, knowledge: k.results, sync_state: s.results });
});

// ---- FTS5 search index ----
// Two passes, both driven by scripts/build_search_index.mjs in a loop until remaining=0:
//   mode=raw  → write original text into tweet_search with empty tags (NO LLM). Fast; makes a KOL
//               searchable/citable in minutes. Selection key: not yet in tweet_search.
//   (default) → LLM-tag untagged tweets and fill the tag columns. Slow; the quality/recall layer.
//               Selection key: no tweet_tags row yet. ?full=1 wipes + rebuilds this KOL once.
app.post("/api/admin/reindex", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const kolId = c.req.query("kol_id");
  if (!kolId) return c.json({ error: "kol_id required" }, 400);
  const mode = c.req.query("mode") === "raw" ? "raw" : "tag";
  const batch = Math.min(parseInt(c.req.query("batch") || "60", 10), 200);
  const full = c.req.query("full") === "1";
  // Sharding: run N parallel drivers with shards=N & shard=0..N-1. Each shard owns a disjoint set of
  // tweet ids (id % N == shard), so parallel backfill never double-tags or races the FTS writes.
  const shards = Math.max(1, Math.min(parseInt(c.req.query("shards") || "1", 10), 16));
  const shard = Math.max(0, Math.min(parseInt(c.req.query("shard") || "0", 10), shards - 1));
  // full=1 clears this KOL once (only shard 0 clears, to avoid wiping peers' just-written rows).
  if (full && shard === 0 && mode === "tag") {
    await c.env.DB.prepare(`DELETE FROM tweet_search WHERE kol_id=?`).bind(kolId).run();
    await c.env.DB.prepare(`DELETE FROM tweet_tags WHERE kol_id=?`).bind(kolId).run();
  }
  const shardClause = shards > 1 ? `AND (abs(CAST(t.id AS INTEGER) % ?) = ?)` : "";
  // raw pass keys off tweet_search membership; tag pass keys off tweet_tags membership.
  // IMPORTANT: bind kol_id as a CONSTANT in the subquery (not correlated to t.kol_id). A correlated
  // subquery against the FTS5 virtual table re-scans it per outer row → D1 500s at scale.
  const missingClause =
    mode === "raw"
      ? `AND t.id NOT IN (SELECT tweet_id FROM tweet_search WHERE kol_id=?)`
      : `AND t.id NOT IN (SELECT tweet_id FROM tweet_tags WHERE kol_id=?)`;
  // bind order: t.kol_id, subquery kol_id, [shards, shard], LIMIT
  const sel: any[] = [kolId, kolId];
  if (shards > 1) sel.push(shards, shard);
  sel.push(batch);
  const rows = await c.env.DB.prepare(
    `SELECT t.id, t.text FROM tweets t
     WHERE t.kol_id=? AND t.is_retweet=0 ${missingClause} ${shardClause}
     ORDER BY t.created_at_ts DESC LIMIT ?`
  ).bind(...sel).all();
  const items = ((rows.results || []) as any[]).map((r) => ({ id: String(r.id), text: String(r.text || "") }));
  const indexed = items.length
    ? mode === "raw"
      ? await indexRawTweets(c.env, kolId, items)
      : await indexTweets(c.env, kolId, c.env.MODEL_FLASH, items)
    : 0;
  const rem: any[] = [kolId, kolId];
  if (shards > 1) rem.push(shards, shard);
  const remaining = await c.env.DB.prepare(
    `SELECT COUNT(*) c FROM tweets t
     WHERE t.kol_id=? AND t.is_retweet=0 ${missingClause} ${shardClause}`
  ).bind(...rem).first<{ c: number }>();
  return c.json({ ok: true, kol_id: kolId, mode, shard, shards, indexed, remaining: remaining?.c ?? 0 });
});

// ---- Paid re-fetch of quoted-tweet content (GetXAPI) for EXISTING history ----
// Budget-controlled: each call pages `pages` times from `cursor`, only UPDATEs rows we already have
// (never inserts), and returns next_cursor so a driver can paginate + stop. Drive from a script and
// watch the GetXAPI balance. New tweets already capture quoted natively via ingest.
app.post("/api/admin/refetch-quotes", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const kolId = c.req.query("kol_id");
  if (!kolId) return c.json({ error: "kol_id required" }, 400);
  if (!c.env.GETXAPI_KEY) return c.json({ error: "GETXAPI_KEY not set" }, 400);
  const kol = await c.env.DB.prepare(`SELECT twitter_uid, handle FROM kols WHERE id=?`).bind(kolId).first<any>();
  if (!kol?.twitter_uid) return c.json({ error: "kol has no twitter_uid" }, 400);
  const pages = Math.min(parseInt(c.req.query("pages") || "5", 10), 15);
  let cursor = c.req.query("cursor") || "";
  let scanned = 0, withQuote = 0, updated = 0, hasMore = false;
  for (let p = 0; p < pages; p++) {
    const url = new URL("https://api.getxapi.com/twitter/user/tweets");
    url.searchParams.set("userId", String(kol.twitter_uid));
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${c.env.GETXAPI_KEY}` } });
    if (!res.ok) return c.json({ ok: false, error: `getxapi ${res.status}`, updated, scanned, withQuote, next_cursor: cursor, has_more: false });
    const json: any = await res.json().catch(() => null);
    const tweets: any[] = json?.tweets || [];
    const stmts: D1PreparedStatement[] = [];
    for (const t of tweets) {
      if (String(t.author?.userName || "").toLowerCase() !== String(kol.handle).toLowerCase()) continue;
      scanned++;
      const q = t.quoted_tweet;
      if (!q || !(q.text || q.full_text)) continue;
      withQuote++;
      const u = q.user || {};
      const handle = u.screen_name || u.userName || "";
      const qid = String(q.id || "");
      const quoted = JSON.stringify({
        id: qid, text: q.text || q.full_text || "", handle, name: u.name || "",
        url: handle && qid ? `https://x.com/${handle}/status/${qid}` : "",
      });
      stmts.push(c.env.DB.prepare(`UPDATE tweets SET quoted=? WHERE id=? AND kol_id=?`).bind(quoted, String(t.id), kolId));
    }
    if (stmts.length) { await c.env.DB.batch(stmts); updated += stmts.length; }
    hasMore = !!json?.has_more;
    cursor = json?.next_cursor || "";
    if (!hasMore || !cursor || !tweets.length) break;
  }
  return c.json({ ok: true, kol_id: kolId, scanned, withQuote, updated, next_cursor: cursor, has_more: hasMore });
});

// ---- Self-serve onboarding: cost estimate (step 1 of the KOL marketplace flow) ----
// Given a Twitter handle/uid, estimate tweet count and the one-time cost to clone the KOL, so we can
// quote the KOL a price before spending. Money figures use the RATES below — tune to real provider
// pricing. "go_live" = ingest + persona only (raw-index makes them searchable with NO LLM); the tag
// layer is async/optional, billed separately.
app.get("/api/admin/estimate", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const uid = c.req.query("uid") || "";
  const handle = c.req.query("handle") || "";
  let count = parseInt(c.req.query("count") || "0", 10);
  let countSource = count ? "param" : "unknown";
  // Best-effort: read the account's total tweet count cheaply (one GetXAPI page → author block).
  if (!count && uid && c.env.GETXAPI_KEY) {
    try {
      const url = new URL("https://api.getxapi.com/twitter/user/tweets");
      url.searchParams.set("userId", uid);
      const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${c.env.GETXAPI_KEY}` } });
      if (res.ok) {
        const j: any = await res.json();
        const a = j?.tweets?.[0]?.author || {};
        const cand = a.statusesCount ?? a.tweetsCount ?? a.statuses_count ?? a.tweet_count;
        if (cand) { count = Number(cand); countSource = "getxapi_author"; }
      }
    } catch {}
  }
  // USD rates — placeholders, tune to actual provider pricing (X scrape per 1k, DeepSeek per 1M tokens).
  const RATES = { X_PER_1K: 0.20, FLASH_IN_PER_M: 0.10, FLASH_OUT_PER_M: 0.30, PRO_IN_PER_M: 0.40, PRO_OUT_PER_M: 1.20 };
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const tagCalls = Math.ceil(count / 16);
  const ingest_usd = (count / 1000) * RATES.X_PER_1K;
  const persona_usd = (13000 / 1e6) * RATES.PRO_IN_PER_M + (4800 / 1e6) * RATES.PRO_OUT_PER_M;
  const tag_usd = (tagCalls * 1840 / 1e6) * RATES.FLASH_IN_PER_M + (tagCalls * 1600 / 1e6) * RATES.FLASH_OUT_PER_M;
  return c.json({
    handle, uid, estimated_tweets: count, count_source: countSource, rates: RATES,
    breakdown_usd: { ingest: r2(ingest_usd), persona: r2(persona_usd), tagging: r2(tag_usd) },
    go_live_usd: r2(ingest_usd + persona_usd),         // searchable + persona, NO tag LLM in the path
    full_index_usd: r2(ingest_usd + persona_usd + tag_usd),
    note: count ? "estimate" : "pass ?count=N or ?uid= (GetXAPI) to compute",
  });
});

app.get("/api/admin/search-stats", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const tweets = await c.env.DB.prepare(
    `SELECT kol_id, COUNT(*) n FROM tweets WHERE is_retweet=0 GROUP BY kol_id`
  ).all();
  const tagged = await c.env.DB.prepare(`SELECT kol_id, COUNT(*) n FROM tweet_tags GROUP BY kol_id`).all();
  const indexed = await c.env.DB.prepare(`SELECT kol_id, COUNT(*) n FROM tweet_search GROUP BY kol_id`).all();
  return c.json({ tweets: tweets.results, tagged: tagged.results, indexed: indexed.results });
});

async function triggerOnboardingDrive(env: Env, origin: string, kolId: string): Promise<void> {
  const url = `${origin}/api/admin/onboard-drive?kol_id=${encodeURIComponent(kolId)}`;
  const init = { method: "POST", headers: { "x-admin-key": env.ADMIN_KEY || "" } };
  await (env.SELF ? env.SELF.fetch(url, init) : fetch(url, init));
}

// ---- Auto-onboard: resumable full-history KOL clone pipeline ----
app.post("/api/admin/onboard", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.json<{
    handle: string;
    display_name?: string;
    twitter_uid?: string;
    profile?: PublicKolProfile;
    reset?: boolean;
  }>();
  if (!body.handle) return c.json({ error: "handle required" }, 400);
  try {
    const started = await startOnboarding(c.env, body);
    const origin = new URL(c.req.url).origin;
    c.executionCtx.waitUntil(triggerOnboardingDrive(c.env, origin, started.kol_id).catch(() => {}));
    return c.json({ ok: true, kol_id: started.kol_id, job: started.job, scheduled: true });
  } catch (e: any) {
    return c.json({ error: e.message || String(e) }, 500);
  }
});

app.post("/api/admin/onboard-drive", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const kolId = c.req.query("kol_id");
  if (!kolId) return c.json({ error: "kol_id required" }, 400);
  try {
    const result = await processOnboardingBatch(c.env, kolId, 5);
    const origin = new URL(c.req.url).origin;
    if (result.job.phase === "ingesting") {
      c.executionCtx.waitUntil(triggerOnboardingDrive(c.env, origin, kolId).catch(() => {}));
    } else if (result.start_distill) {
      await c.env.DB.prepare(`UPDATE kol_onboarding_jobs SET phase='distilling',updated_at=datetime('now') WHERE kol_id=?`)
        .bind(kolId).run();
      const url = `${origin}/api/admin/distill-auto?kol_id=${encodeURIComponent(kolId)}&reset=1`;
      const init = { method: "POST", headers: { "x-admin-key": c.env.ADMIN_KEY || "" } };
      c.executionCtx.waitUntil(Promise.resolve(c.env.SELF ? c.env.SELF.fetch(url, init) : fetch(url, init)).then(() => {}).catch(() => {}));
    }
    return c.json({ ok: true, job: result.job, start_distill: result.start_distill });
  } catch (e: any) {
    return c.json({ error: e.message || String(e) }, 500);
  }
});

app.get("/api/admin/onboard-status", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const kolId = c.req.query("kol_id");
  if (!kolId) return c.json({ error: "kol_id required" }, 400);
  const job = await getOnboardingJob(c.env, kolId);
  if (!job) return c.json({ error: "not found" }, 404);
  const stats = await c.env.DB.prepare(
    `SELECT COUNT(*) total,
            SUM(CASE WHEN is_retweet=0 THEN 1 ELSE 0 END) originals,
            MIN(created_at_iso) oldest,MAX(created_at_iso) newest
     FROM tweets WHERE kol_id=?`
  ).bind(kolId).first<any>();
  const indexed = await c.env.DB.prepare(`SELECT COUNT(*) n FROM tweet_search WHERE kol_id=?`).bind(kolId).first<any>();
  const kol = await c.env.DB.prepare(
    `SELECT onboarding_status,is_public,persona_version,length(persona_pack) persona_length,
            airwallex_product_id,airwallex_price_id FROM kols WHERE id=?`
  ).bind(kolId).first<any>();
  return c.json({ job, kol, corpus: stats, indexed: indexed?.n || 0 });
});

app.post("/api/admin/onboard-apify-backfill", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const kolId = c.req.query("kol_id");
  const since = c.req.query("since") || "2010-01-01";
  const until = c.req.query("until") || new Date().toISOString().slice(0, 10);
  if (!kolId) return c.json({ error: "kol_id required" }, 400);
  try {
    const result = await backfillOnboardingFromApify(c.env, kolId, { since, until });
    const origin = new URL(c.req.url).origin;
    const url = `${origin}/api/admin/distill-auto?kol_id=${encodeURIComponent(kolId)}&reset=1`;
    const init = { method: "POST", headers: { "x-admin-key": c.env.ADMIN_KEY || "" } };
    c.executionCtx.waitUntil(Promise.resolve(c.env.SELF ? c.env.SELF.fetch(url, init) : fetch(url, init)).then(() => {}).catch(() => {}));
    return c.json({ ok: true, ...result, distill_scheduled: true });
  } catch (e: any) {
    return c.json({ error: e.message || String(e) }, 500);
  }
});

app.get("/research", (c) => serveDesk(c));

app.get("/desk", (c) => serveDesk(c));

app.get("/", (c) => {
  if (isAppHost(requestHost(c.req.raw))) return serveDesk(c);
  return c.env.ASSETS.fetch(c.req.raw);
});

app.post("/api/admin/ingest", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  c.executionCtx.waitUntil(runDailyIngest(c.env));
  return c.json({ ok: true, scheduled: true });
});

app.post("/api/admin/persona-refresh", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const updated = await runWeeklyPersonaRefresh(c.env);
  return c.json({ ok: true, updated });
});

app.post("/api/admin/persona-update", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.json<{ kol_id?: string; kind?: "weekly" | "monthly" | "full" | "rerender" }>()
    .catch(() => ({} as { kol_id?: string; kind?: "weekly" | "monthly" | "full" | "rerender" }));
  const kolId = String(body.kol_id || "").trim();
  if (!kolId) return c.json({ error: "kol_id required" }, 400);
  const kol = await c.env.DB.prepare(`SELECT id FROM kols WHERE id=?`).bind(kolId).first();
  if (!kol) return c.json({ error: "unknown kol_id" }, 404);
  const kind = body.kind || "full";
  if (kind === "rerender") {
    const result = await finalizeMerged(c.env, kolId);
    if (!result.persona_json || result.persona_pack.length < 500) {
      return c.json({ error: "rerender produced invalid candidate" }, 500);
    }
    const version = `v2-mapreduce-rerender-${new Date().toISOString().slice(0, 10)}-candidate-${Date.now()}`;
    await stagePersonaCandidate(c.env, kolId, version, result.persona_pack, result.persona_json);
    await c.env.DB.prepare(`UPDATE persona_candidates SET status='evaluating',updated_at=datetime('now') WHERE kol_id=?`)
      .bind(kolId).run();
    await c.env.DB.prepare(
      `INSERT INTO persona_update_jobs
         (kol_id,kind,phase,distill_phase,distill_group_index,distill_steps,retries,last_error,updated_at)
       VALUES (?,'rerender','evaluating','eval_candidate',0,0,0,NULL,datetime('now'))
       ON CONFLICT(kol_id) DO UPDATE SET
         kind='rerender',phase='evaluating',distill_phase='eval_candidate',distill_group_index=0,
         distill_steps=0,retries=0,last_error=NULL,completed_at=NULL,updated_at=datetime('now')`
    ).bind(kolId).run();
    return c.json({ ok: true, kol_id: kolId, kind, staged: true, version, pack_length: result.persona_pack.length });
  }
  const firstPhase = "map";
  await c.env.DB.prepare(
    `INSERT INTO persona_update_jobs
       (kol_id,kind,phase,distill_phase,distill_group_index,distill_steps,retries,last_error,updated_at)
     VALUES (?,?,'distilling',?,0,0,0,NULL,datetime('now'))
     ON CONFLICT(kol_id) DO UPDATE SET
       kind=excluded.kind,phase='distilling',distill_phase=excluded.distill_phase,distill_group_index=0,
       distill_steps=0,retries=0,last_error=NULL,completed_at=NULL,updated_at=datetime('now')`
  ).bind(kolId, kind, firstPhase).run();
  return c.json({ ok: true, kol_id: kolId, kind, scheduled: true });
});

app.get("/api/admin/retrieval-debug", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const kolId = String(c.req.query("kol_id") || "").trim();
  const query = String(c.req.query("q") || "").trim();
  if (!kolId || !query) return c.json({ error: "kol_id and q required" }, 400);
  const kol = await c.env.DB.prepare(
    `SELECT id,handle,retrieval_mode,corpus_id FROM kols WHERE id=?`
  ).bind(kolId).first<any>();
  if (!kol) return c.json({ error: "unknown kol_id" }, 404);
  const result = await retrieve(
    c.env,
    kolId,
    kol.handle,
    query,
    [],
    undefined,
    c.env.MODEL_FLASH,
    kol.retrieval_mode === "tagged" ? "tagged" : "query_side",
    kol.corpus_id || kol.id,
  );
  return c.json({
    ok: true,
    kol_id: kolId,
    query,
    citations: result.citations,
    knowledge: result.knowledge.map((item) => ({
      source: item.source,
      title: item.title,
      relevance_score: item.relevance_score,
    })),
  });
});

// ---- Persona Pack generation & evolution ----

app.post("/api/persona-generate", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const kolId = c.req.query("kol_id");
  if (!kolId) return c.json({ error: "kol_id required" }, 400);
  try {
    const { persona_pack, validation } = await generatePersonaPack(c.env, kolId);
    if (persona_pack.length < 500) {
      return c.json({ ok: false, validation, pack_length: persona_pack.length, error: "Generated pack too short — existing pack preserved" });
    }
    const current = await c.env.DB.prepare(`SELECT persona_pack, persona_version FROM kols WHERE id=?`).bind(kolId).first<any>();
    if (current?.persona_pack && current.persona_pack.length > 100) {
      const backupId = `${kolId}:persona_backup:${new Date().toISOString().slice(0, 10)}:${Date.now()}`;
      await c.env.DB.prepare(
        `INSERT OR REPLACE INTO knowledge_chunks (id,kol_id,source,title,text) VALUES (?,?,?,?,?)`
      ).bind(backupId, kolId, `persona_backup:${current.persona_version || "unknown"}`, `Persona backup ${new Date().toISOString().slice(0, 10)}`, current.persona_pack).run();
    }
    await c.env.DB.prepare(`UPDATE kols SET persona_pack=?, persona_version='v1-auto', updated_at=datetime('now') WHERE id=?`)
      .bind(persona_pack, kolId).run();
    // Self-healing: if a golden eval set exists, score the fresh pack in the background and roll back
    // to the last good pack if it regressed vs the previous version. No-op when no eval set exists.
    c.executionCtx.waitUntil(
      evalAndMaybeRollback(c.env, kolId).catch((e) =>
        logPersonaExperiment(c.env, kolId, {
          content: "", finish_reason: "error", content_len: 0, duration_ms: 0,
          parse_ok: false, error_type: null, note: `post-generate eval failed: ${String(e).slice(0, 300)}`,
        }, 0, "eval"),
      ),
    );
    return c.json({ ok: true, validation, pack_length: persona_pack.length });
  } catch (e: any) {
    return c.json({ error: e.message || String(e) }, 500);
  }
});

// ---- Eval / auto-rollback (Phase 2) ----

// Build (or rebuild) the golden eval set for a KOL by mining Q&A from their own tweets + synthesizing
// follower questions. Idempotent. Query: ?kol_id=X
app.post("/api/admin/eval-build", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const kolId = c.req.query("kol_id");
  if (!kolId) return c.json({ error: "kol_id required" }, 400);
  try {
    const r = await buildEvalSet(c.env, kolId);
    return c.json({ ok: true, kol_id: kolId, ...r });
  } catch (e: any) {
    return c.json({ error: e.message || String(e) }, 500);
  }
});

// Run the golden eval set against the current persona, write per-case results, and auto-rollback if the
// run regressed vs the previous persona version. Query: ?kol_id=X&limit=12&rollback=1 (rollback on by
// default; pass rollback=0 to score only, no self-healing).
app.post("/api/admin/eval-run", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const kolId = c.req.query("kol_id");
  if (!kolId) return c.json({ error: "kol_id required" }, 400);
  const limit = parseInt(c.req.query("limit") || "12", 10);
  const rollback = c.req.query("rollback") !== "0";
  try {
    if (rollback) {
      const r = await evalAndMaybeRollback(c.env, kolId, { limit });
      return c.json({ ok: true, kol_id: kolId, ...r });
    }
    const summary = await runEval(c.env, kolId, { limit });
    return c.json({ ok: true, kol_id: kolId, summary, rolled_back: false });
  } catch (e: any) {
    return c.json({ error: e.message || String(e) }, 500);
  }
});

app.get("/api/admin/eval-results", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const kolId = String(c.req.query("kol_id") || "").trim();
  if (!kolId) return c.json({ error: "kol_id required" }, 400);
  const version = String(c.req.query("version") || "").trim();
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") || "50", 10), 1), 100);
  const sql = version
    ? `SELECT r.*,ec.ground_truth_type,ec.expected_stance,ec.source_tweet_id
       FROM eval_results r LEFT JOIN eval_cases ec ON ec.id=r.case_id
       WHERE r.kol_id=? AND r.persona_version=? ORDER BY r.created_at DESC LIMIT ?`
    : `SELECT r.*,ec.ground_truth_type,ec.expected_stance,ec.source_tweet_id
       FROM eval_results r LEFT JOIN eval_cases ec ON ec.id=r.case_id
       WHERE r.kol_id=? ORDER BY r.created_at DESC LIMIT ?`;
  const result = version
    ? await c.env.DB.prepare(sql).bind(kolId, version, limit).all()
    : await c.env.DB.prepare(sql).bind(kolId, limit).all();
  return c.json({ results: result.results || [] });
});

app.get("/api/admin/eval-preview", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const kolId = c.req.query("kol_id");
  if (!kolId) return c.json({ error: "kol_id required" }, 400);
  const limit = parseInt(c.req.query("limit") || "2", 10);
  const candidate = c.req.query("candidate") || "merged";
  try {
    let candidatePack: string | undefined;
    if (candidate === "merged") {
      const rendered = await renderMergedPack(c.env, kolId);
      candidatePack = rendered.persona_pack;
    }
    const summary = await runEvalPreview(c.env, kolId, { limit, candidatePack });
    return c.json({ ok: true, ...summary });
  } catch (e: any) {
    return c.json({ error: e.message || String(e) }, 500);
  }
});

app.post("/api/admin/eval-preview", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.json<{ kol_id?: string; limit?: number; candidate?: string; questions?: string[] }>().catch(() => ({} as any));
  const kolId = body.kol_id || c.req.query("kol_id");
  if (!kolId) return c.json({ error: "kol_id required" }, 400);
  const limit = body.limit || parseInt(c.req.query("limit") || "3", 10);
  const candidate = body.candidate || c.req.query("candidate") || "merged";
  try {
    let candidatePack: string | undefined;
    if (candidate === "merged") {
      const rendered = await renderMergedPack(c.env, kolId);
      candidatePack = rendered.persona_pack;
    }
    const summary = await runEvalPreview(c.env, kolId, { limit, candidatePack, questions: body.questions || [] });
    return c.json({ ok: true, ...summary });
  } catch (e: any) {
    return c.json({ error: e.message || String(e) }, 500);
  }
});

// Manually roll a KOL's persona back to its last backup/snapshot. Query: ?kol_id=X
app.post("/api/admin/eval-rollback", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const kolId = c.req.query("kol_id");
  if (!kolId) return c.json({ error: "kol_id required" }, 400);
  try {
    const r = await autoRollback(c.env, kolId, "manual rollback via admin endpoint");
    return c.json({ ok: r.rolled_back, kol_id: kolId, ...r });
  } catch (e: any) {
    return c.json({ error: e.message || String(e) }, 500);
  }
});

// Back up the current pack (so eval auto-rollback has a target), then write the new one. Shared by the
// synchronous and background distill paths.
async function publishDistilledPack(env: Env, kolId: string, pack: string, version: string): Promise<void> {
  const current = await env.DB.prepare(`SELECT persona_pack, persona_version FROM kols WHERE id=?`).bind(kolId).first<any>();
  if (current?.persona_pack && current.persona_pack.length > 100) {
    const backupId = `${kolId}:persona_backup:${new Date().toISOString().slice(0, 10)}:${Date.now()}`;
    await env.DB.prepare(
      `INSERT OR REPLACE INTO knowledge_chunks (id,kol_id,source,title,text) VALUES (?,?,?,?,?)`
    ).bind(backupId, kolId, `persona_backup:${current.persona_version || "unknown"}`, `Persona backup ${new Date().toISOString().slice(0, 10)}`, current.persona_pack).run();
  }
  await env.DB.prepare(`UPDATE kols SET persona_pack=?, persona_version=?, updated_at=datetime('now') WHERE id=?`)
    .bind(pack, version, kolId).run();
}

async function stagePersonaCandidate(
  env: Env,
  kolId: string,
  version: string,
  pack: string,
  personaJson: PersonaJson,
): Promise<void> {
  const coverage = personaCoverageGate(personaJson, pack);
  if (!coverage.ok) {
    throw new Error(`persona coverage gate failed: missing=${coverage.missing.join(",") || "none"} identity_ok=${coverage.identity_ok}`);
  }
  await env.DB.prepare(
    `INSERT INTO persona_candidates
       (kol_id,version,persona_pack,persona_json,coverage_json,profile_json,status,last_error,updated_at)
     VALUES (?,?,?,?,?,NULL,'staged',NULL,datetime('now'))
     ON CONFLICT(kol_id) DO UPDATE SET
       version=excluded.version,persona_pack=excluded.persona_pack,persona_json=excluded.persona_json,
       coverage_json=excluded.coverage_json,profile_json=NULL,status='staged',last_error=NULL,updated_at=datetime('now')`
  ).bind(kolId, version, pack, JSON.stringify(personaJson), JSON.stringify(coverage)).run();
}

async function publishPersonaCandidate(
  env: Env,
  kolId: string,
  billing: { productId: string; priceId: string },
): Promise<void> {
  const candidate = await env.DB.prepare(
    `SELECT version,persona_pack,persona_json,profile_json FROM persona_candidates
     WHERE kol_id=? AND status IN ('evaluating','passed')`
  ).bind(kolId).first<any>();
  if (!candidate) throw new Error(`persona candidate missing for ${kolId}`);
  if (!candidate.profile_json) throw new Error(`public profile missing for ${kolId}`);
  const candidateJson = JSON.parse(candidate.persona_json || "{}") as PersonaJson;
  const coverage = personaCoverageGate(candidateJson, candidate.persona_pack);
  if (!coverage.ok) throw new Error(`candidate coverage changed before publish: ${coverage.missing.join(",") || "identity"}`);
  const current = await env.DB.prepare(`SELECT persona_pack,persona_version FROM kols WHERE id=?`).bind(kolId).first<any>();
  if (current?.persona_pack && current.persona_pack.length > 100) {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO knowledge_chunks (id,kol_id,source,title,text) VALUES (?,?,?,?,?)`
    ).bind(
      `${kolId}:persona_backup:${new Date().toISOString().slice(0, 10)}:${Date.now()}`,
      kolId,
      `persona_backup:${current.persona_version || "unknown"}`,
      `Persona backup ${new Date().toISOString().slice(0, 10)}`,
      current.persona_pack,
    ).run();
  }
  const profile = JSON.parse(candidate.profile_json);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE kols SET persona_pack=?,persona_version=?,profile_json=?,tagline=?,
         airwallex_product_id=?,airwallex_price_id=?,onboarding_status='ready',is_public=1,
         updated_at=datetime('now') WHERE id=?`
    ).bind(
      candidate.persona_pack,
      candidate.version,
      candidate.profile_json,
      profile?.tagline?.zh || profile?.tagline?.en || null,
      billing.productId,
      billing.priceId,
      kolId,
    ),
    env.DB.prepare(
    `INSERT INTO persona_facts
       (id,kol_id,kind,chunk_idx,corpus_hash,json,tweets_covered,date_min,date_max,updated_at)
     VALUES (?,?,'merged',NULL,'published',?,NULL,NULL,NULL,datetime('now'))
     ON CONFLICT(id) DO UPDATE SET json=excluded.json,updated_at=datetime('now')`
    ).bind(`${kolId}:merged`, kolId, candidate.persona_json || "{}"),
    env.DB.prepare(
      `UPDATE persona_candidates SET status='published',last_error=NULL,updated_at=datetime('now') WHERE kol_id=?`
    ).bind(kolId),
  ]);
}

// Full-corpus map-reduce persona distillation. Reads 100% of the corpus (chunk → flash map → pro
// reduce), verifies quotes verbatim, and writes the resulting pack (backing up the current one).
// Query: ?kol_id=X&mode=full|incremental&days=7  (full = whole history; incremental = last `days`).
// This can take several minutes (many LLM calls) — call with a long client timeout.
app.post("/api/admin/persona-distill", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const kolId = c.req.query("kol_id");
  if (!kolId) return c.json({ error: "kol_id required" }, 400);
  const mode = c.req.query("mode") || "full";
  const days = Math.max(1, parseInt(c.req.query("days") || "7", 10));
  try {
    if (mode === "sample") {
      const maxTweets = parseInt(c.req.query("max_tweets") || "360", 10);
      const maxChunks = parseInt(c.req.query("max_chunks") || "4", 10);
      const result = await distillPersonaSample(c.env, kolId, { maxTweets, maxChunks });
      let evalSummary: any = null;
      if (c.req.query("eval") === "1") {
        evalSummary = await runEval(c.env, kolId, {
          limit: Math.min(Math.max(parseInt(c.req.query("eval_limit") || "2", 10), 1), 6),
          personaPack: result.persona_pack,
          personaVersion: `sample-${Date.now()}`,
        });
      }
      return c.json({
        ok: true,
        mode,
        published: false,
        validation: result.validation,
        pack_length: result.persona_pack.length,
        stats: result.stats,
        eval: evalSummary,
        persona_json: c.req.query("json") === "1" ? result.persona_json : undefined,
      });
    }
    // Resumable map stage: call repeatedly until remaining===0 (stays under the edge timeout). Does not
    // touch the live pack — only fills the chunk fact store.
    if (mode === "map") {
      const batch = Math.max(1, parseInt(c.req.query("batch") || "8", 10));
      const prog = await mapStage(c.env, kolId, { batch });
      return c.json({ ok: true, mode, ...prog });
    }
    // Staged reduce (resumable, one pro call each) for large corpora — neither stage writes the pack:
    //   reduce_group?group=i  → merge chunk partials [i] into an intermediate (call 0..groups-1)
    //   reduce_final          → merge intermediates → final (falls through to the write block)
    if (mode === "reduce_group") {
      const group = parseInt(c.req.query("group") || "0", 10);
      // bg=1 runs the (one) pro merge detached so the client edge timeout can't kill it mid-call.
      if (c.req.query("bg") === "1") {
        c.executionCtx.waitUntil(
          reduceGroup(c.env, kolId, group).then((p) =>
            logPersonaExperiment(c.env, kolId, {
              content: "", finish_reason: p.ok ? "stop" : "empty", content_len: 0, duration_ms: 0,
              parse_ok: p.ok, error_type: null, note: `reduce_group_bg ${group}/${p.groups} ok=${p.ok}`,
            }, 0, "distill"),
          ).catch((e) =>
            logPersonaExperiment(c.env, kolId, {
              content: "", finish_reason: "error", content_len: 0, duration_ms: 0,
              parse_ok: false, error_type: null, note: `reduce_group_bg ${group} failed: ${String(e).slice(0, 200)}`,
            }, 0, "distill"),
          ),
        );
        return c.json({ ok: true, mode, group, bg: true, note: "group reduce running in background" });
      }
      const prog = await reduceGroup(c.env, kolId, group);
      return c.json({ mode, ...prog });
    }
    // Final reduce in the BACKGROUND: a single pro merge of the intermediates needs ~100-130s (a full
    // persona JSON), which exceeds the client edge timeout. waitUntil runs for minutes here, so we do it
    // detached, publish the pack, and log completion to persona_experiments (poll that to confirm).
    if (mode === "reduce_final_bg") {
      c.executionCtx.waitUntil((async () => {
        try {
          const result = await reduceFinal(c.env, kolId);
          if (result.persona_pack.length >= 500) {
            await publishDistilledPack(c.env, kolId, result.persona_pack, "v2-mapreduce");
            await logPersonaExperiment(c.env, kolId, {
              content: "", finish_reason: "stop", content_len: result.persona_pack.length, duration_ms: 0,
              parse_ok: true, error_type: null, note: `reduce_final_bg published: models=${result.stats.models} exemplars=${result.stats.exemplars} tweets=${result.stats.tweets}`,
            }, 0, "distill");
            await evalAndMaybeRollback(c.env, kolId).catch(() => {});
          } else {
            await logPersonaExperiment(c.env, kolId, {
              content: "", finish_reason: "empty", content_len: result.persona_pack.length, duration_ms: 0,
              parse_ok: false, error_type: null, note: "reduce_final_bg: pack too short, not published",
            }, 0, "distill");
          }
        } catch (e: any) {
          await logPersonaExperiment(c.env, kolId, {
            content: "", finish_reason: "error", content_len: 0, duration_ms: 0,
            parse_ok: false, error_type: null, note: `reduce_final_bg failed: ${String(e).slice(0, 300)}`,
          }, 0, "distill");
        }
      })());
      return c.json({ ok: true, mode, note: "final reduce running in background; poll persona-experiments (trigger=distill) + persona_version" });
    }
    // Reduce stage: merge stored chunks → write the pack (with backup) + trigger eval. Run after map
    // reports remaining===0. Falls through to the shared write block below.
    const out = mode === "incremental"
      ? await distillPersonaIncremental(c.env, kolId, Math.floor(Date.now() / 1000) - days * 86400)
      : mode === "voice_refine"
        ? { changed: true, result: await refineVoice(c.env, kolId), note: "voice_refine" }
        : mode === "publish_merged"
        ? { changed: true, result: await renderMergedPack(c.env, kolId), note: "publish_merged" }
        : mode === "reduce_final"
          ? { changed: true, result: await reduceFinal(c.env, kolId), note: "reduce_final" }
          : mode === "reduce"
            ? { changed: true, result: await reduceStage(c.env, kolId), note: "reduce" }
            : { changed: true, result: await distillPersonaFull(c.env, kolId), note: "full" };

    if (!out.changed || !out.result) {
      return c.json({ ok: false, mode, changed: false, note: out.note });
    }
    const { persona_pack, validation, stats } = out.result;
    if (persona_pack.length < 500) {
      return c.json({ ok: false, mode, validation, pack_length: persona_pack.length, error: "Generated pack too short — existing pack preserved" });
    }
    const version = mode === "incremental" ? `v2-mapreduce-inc-${new Date().toISOString().slice(0, 10)}`
      : mode === "voice_refine" ? "v3-voice"
      : "v2-mapreduce";
    await publishDistilledPack(c.env, kolId, persona_pack, version);
    // Score the fresh pack + self-heal in the background (no-op without an eval set).
    c.executionCtx.waitUntil(
      evalAndMaybeRollback(c.env, kolId).catch((e) =>
        logPersonaExperiment(c.env, kolId, {
          content: "", finish_reason: "error", content_len: 0, duration_ms: 0,
          parse_ok: false, error_type: null, note: `post-distill eval failed: ${String(e).slice(0, 300)}`,
        }, 0, "eval"),
      ),
    );
    return c.json({ ok: true, mode, version, validation, pack_length: persona_pack.length, stats });
  } catch (e: any) {
    return c.json({ error: e.message || String(e) }, 500);
  }
});

// Run ONE pipeline step (the work happens IN-REQUEST — the response is held until it finishes; deferring
// it to waitUntil does NOT keep the worker alive here, the work just never runs). Returns the next phase
// to chain to (or null when the pipeline is done / should stop), so the caller can advance it via whatever
// driver. Steps skip work already persisted (idempotent/resumable).
async function runDistillStep(
  env: Env, kolId: string, phase: string, groupIdx: number, steps: number, stepKey: string,
): Promise<{ next: string | null; extra: string }> {
  const log = (note: string) => logPersonaExperiment(env, kolId, {
    content: "", finish_reason: "step", content_len: 0, duration_ms: 0, parse_ok: true, error_type: null,
    note: `[${steps}] ${note}`,
  }, 0, "distill_auto");
  try {
    if (phase === "map") {
      const prog = await mapStage(env, kolId, { batch: 6 });
      await log(`map ${prog.cached}/${prog.total} (rem ${prog.remaining})`);
      return prog.remaining > 0 ? { next: "map", extra: "" } : { next: "group", extra: "&i=0" };
    }
    if (phase === "group" || /^group_l\d+$/.test(phase)) {
      const targetLevel = phase === "group" ? 1 : Number(phase.match(/^group_l(\d+)$/)?.[1] || 1);
      const prog = await reduceGroupLevel(env, kolId, targetLevel, groupIdx);
      await log(`reduce_l${targetLevel} ${groupIdx + 1}/${prog.groups} ok=${prog.ok}`);
      if (!prog.ok) return { next: phase, extra: `&i=${groupIdx}` };
      if (groupIdx + 1 < prog.groups) return { next: phase, extra: `&i=${groupIdx + 1}` };
      return prog.groups > 4
        ? { next: `group_l${targetLevel + 1}`, extra: "&i=0" }
        : { next: "final", extra: "" };
    }
    if (phase === "final") {
      // Final reduce, step 1/2: the pro merge ONLY (no full-corpus load) → 'merged_draft' fact. LLM-only
      // so this single pro call stays under the ~100s limit (the combined verify-too version got killed).
      const d = await reduceFinalDraft(env, kolId);
      await log(`final draft: groups=${d.groups} draft_len=${d.len}`);
      return { next: "finalize", extra: "" };
    }
    if (phase === "finalize") {
      // Final reduce, step 2/2: LLM-free verify + exemplars + publish (fast). Date-stamp the version so
      // eval scores THIS pack fresh — runEval keys results by persona_version and skips already-scored
      // cases, so reusing a bare "v2-mapreduce" would make eval a stale no-op and disable the regression
      // check; a unique version also makes the prior run the comparison baseline.
      const result = await finalizeMerged(env, kolId);
      if (result.persona_pack.length >= 500) {
        const version = `v2-mapreduce-${new Date().toISOString().slice(0, 10)}`;
        if (!result.persona_json) throw new Error(`final persona JSON missing for ${kolId}`);
        // Quality failures are terminal and remain private. Do not spend another full final-reduce
        // cycle hoping a stochastic retry happens to pass the same gate.
        await stagePersonaCandidate(env, kolId, `${version}-candidate-${Date.now()}`, result.persona_pack, result.persona_json);
        await env.DB.prepare(`UPDATE persona_candidates SET status='evaluating',updated_at=datetime('now') WHERE kol_id=?`)
          .bind(kolId).run();
        await env.DB.prepare(`UPDATE kols SET onboarding_status='evaluating',updated_at=datetime('now') WHERE id=? AND is_public=0`)
          .bind(kolId).run();
        await env.DB.prepare(`UPDATE kol_onboarding_jobs SET phase='evaluating',updated_at=datetime('now') WHERE kol_id=?`)
          .bind(kolId).run();
        await env.DB.prepare(
          `UPDATE persona_update_jobs SET phase='evaluating',distill_phase='eval_candidate',updated_at=datetime('now')
           WHERE kol_id=? AND phase='distilling'`
        ).bind(kolId).run();
        await log(`finalize staged candidate: models=${result.stats.models} exemplars=${result.stats.exemplars} len=${result.persona_pack.length}`);
        return { next: "build_eval", extra: "" };
      }
      await log(`finalize: pack too short (${result.persona_pack.length}), not published`);
      return { next: null, extra: "" };
    }
    if (phase === "profile") {
      const candidate = await env.DB.prepare(
        `SELECT persona_json FROM persona_candidates WHERE kol_id=? AND status='evaluating'`
      ).bind(kolId).first<any>();
      if (!candidate?.persona_json) throw new Error(`persona candidate JSON missing for ${kolId}`);
      const profile = await buildPublicKolProfile(env, kolId, JSON.parse(candidate.persona_json));
      await env.DB.prepare(
        `UPDATE persona_candidates SET profile_json=?,updated_at=datetime('now') WHERE kol_id=?`
      ).bind(JSON.stringify(profile), kolId).run();
      await log(`public profile generated: suggested=${profile.suggested.zh.length}/${profile.suggested.en.length}`);
      return { next: "provisioning", extra: "" };
    }
    if (phase === "build_eval") {
      const built = await buildEvalSet(env, kolId);
      await log(`eval set rebuilt: total=${built.built} real=${built.real_qa} synth=${built.synth_follower}`);
      return { next: "eval_candidate", extra: "" };
    }
    if (phase === "eval_candidate") {
      const candidate = await env.DB.prepare(
        `SELECT version,persona_pack FROM persona_candidates WHERE kol_id=? AND status='evaluating'`
      ).bind(kolId).first<any>();
      if (!candidate) throw new Error(`no evaluating persona candidate for ${kolId}`);
      const cnt = await env.DB.prepare(`SELECT COUNT(*) n FROM eval_cases WHERE kol_id=?`).bind(kolId).first<{ n: number }>();
      if (!cnt?.n) return { next: "build_eval", extra: "" };
      const s = await runEval(env, kolId, {
        limit: 2,
        personaPack: candidate.persona_pack,
        personaVersion: candidate.version,
      });
      await log(`candidate eval rem=${s.remaining} composite=${s.composite.toFixed(3)} cite=${s.avg_citation.toFixed(3)} regressed=${s.regressed}`);
      if (s.remaining > 0) return { next: "eval_candidate", extra: "" };
      const targeted = await env.DB.prepare(
        `SELECT r.score_citation c,r.score_voice v,r.score_relevance rel,r.score_entailment ent
         FROM eval_results r JOIN eval_cases ec ON ec.id=r.case_id
         WHERE r.kol_id=? AND r.persona_version=? AND lower(ec.question) LIKE '%dram%'
         ORDER BY r.created_at DESC LIMIT 1`
      ).bind(kolId, candidate.version).first<any>();
      const targetedPassed = !targeted || (
        Number(targeted.c || 0) >= 0.7 &&
        Number(targeted.v || 0) >= 0.5 &&
        Number(targeted.rel || 0) >= 0.6 &&
        Number(targeted.ent || 0) >= 0.6
      );
      const passRate = s.cases > 0 ? s.passed / s.cases : 0;
      const passed = !s.regressed && s.avg_citation >= 0.55 && s.avg_voice >= 0.4 &&
        s.avg_relevance >= 0.6 && s.avg_entailment >= 0.6 &&
        (s.avg_stance === null || s.avg_stance >= 0.6) &&
        passRate >= 0.65 && targetedPassed;
      if (!passed) {
        await env.DB.prepare(
          `UPDATE persona_candidates SET status='rejected',last_error=?,updated_at=datetime('now') WHERE kol_id=?`
        ).bind(
          `eval rejected pass_rate=${passRate.toFixed(3)} composite=${s.composite.toFixed(3)} ` +
          `citation=${s.avg_citation.toFixed(3)} voice=${s.avg_voice.toFixed(3)} ` +
          `relevance=${s.avg_relevance.toFixed(3)} entailment=${s.avg_entailment.toFixed(3)}`,
          kolId,
        ).run();
        throw new Error(`candidate eval gate failed for ${kolId}`);
      }
      await env.DB.prepare(
        `UPDATE persona_candidates SET status='passed',last_error=NULL,updated_at=datetime('now') WHERE kol_id=?`
      ).bind(kolId).run();
      return { next: "profile", extra: "" };
    }
    if (phase === "provisioning") {
      const kol = await env.DB.prepare(
        `SELECT display_name,airwallex_product_id,airwallex_price_id FROM kols WHERE id=?`
      ).bind(kolId).first<any>();
      if (!kol) throw new Error(`KOL not found: ${kolId}`);
      let productId = String(kol.airwallex_product_id || "");
      let priceId = String(kol.airwallex_price_id || "");
      if (!productId || !priceId) {
        const plan = await getKolPlan(env, kolId);
        if (!plan) throw new Error(`subscription plan missing for ${kolId}`);
        const provisioned = await provisionKolSubscription(env, {
          kolId,
          displayName: kol.display_name || kolId,
          promoCents: 1990,
        });
        productId = provisioned.productId;
        priceId = provisioned.priceId;
      }
      await publishPersonaCandidate(env, kolId, { productId, priceId });
      await env.CACHE.delete(stepKey);
      await env.DB.prepare(
        `UPDATE kol_onboarding_jobs SET phase='ready',last_error=NULL,completed_at=datetime('now'),updated_at=datetime('now') WHERE kol_id=?`
      ).bind(kolId).run();
      await env.DB.prepare(
        `UPDATE persona_update_jobs SET phase='ready',completed_at=datetime('now'),updated_at=datetime('now') WHERE kol_id=? AND phase IN ('distilling','evaluating')`
      ).bind(kolId).run();
      await log(`DONE candidate published with Airwallex price ${priceId}`);
      return { next: null, extra: "" };
    }
    if (phase === "eval") {
      const cnt = await env.DB.prepare(`SELECT COUNT(*) n FROM eval_cases WHERE kol_id=?`).bind(kolId).first<{ n: number }>();
      if (!cnt?.n) { await buildEvalSet(env, kolId); await log(`eval set built`); }
      // limit=2 per invocation: each case (retrieve + flash answer + 3 flash judges) runs ~25-30s, so a
      // batch of 2 (~55s) fits the ~100s worker budget; limit=4 (~110s) would be killed mid-step.
      const s = await runEval(env, kolId, { limit: 2 });
      await log(`eval rem=${s.remaining} composite=${s.composite.toFixed(3)} regressed=${s.regressed}`);
      if (s.remaining > 0) return { next: "eval", extra: "" };
      // Full set scored: self-heal if regressed, then finish.
      let rolled = false;
      if (s.regressed) { const rb = await autoRollback(env, kolId, "distill-auto eval regression"); rolled = rb.rolled_back; }
      await env.CACHE.delete(stepKey);
      await log(`DONE composite=${s.composite.toFixed(3)} regressed=${s.regressed} rolled_back=${rolled}`);
      const onboarding = await env.DB.prepare(`SELECT kol_id FROM kol_onboarding_jobs WHERE kol_id=?`).bind(kolId).first();
      if (onboarding) {
        if (s.regressed && !rolled) {
          await env.DB.prepare(
            `UPDATE kol_onboarding_jobs SET phase='failed',last_error=?,updated_at=datetime('now') WHERE kol_id=?`
          ).bind(`eval regression composite=${s.composite.toFixed(3)}`, kolId).run();
          await env.DB.prepare(`UPDATE kols SET onboarding_status='failed',is_public=0,updated_at=datetime('now') WHERE id=?`)
            .bind(kolId).run();
        } else {
          await env.DB.prepare(
            `UPDATE kol_onboarding_jobs SET phase='ready',last_error=NULL,completed_at=datetime('now'),updated_at=datetime('now') WHERE kol_id=?`
          ).bind(kolId).run();
          await env.DB.prepare(`UPDATE kols SET onboarding_status='ready',is_public=1,updated_at=datetime('now') WHERE id=?`)
            .bind(kolId).run();
        }
      }
      return { next: null, extra: "" };
    }
    await log(`ERROR unknown phase ${phase}`);
    return { next: null, extra: "" };
  } catch (e: any) {
    await log(`ERROR phase=${phase}: ${String(e).slice(0, 200)}`);
    const lifecycle = await env.DB.prepare(
      `SELECT is_public,length(persona_pack) pack_len FROM kols WHERE id=?`
    ).bind(kolId).first<any>();
    const keepLive = Number(lifecycle?.is_public || 0) === 1 && Number(lifecycle?.pack_len || 0) >= 500;
    const onboarding = await env.DB.prepare(`SELECT phase FROM kol_onboarding_jobs WHERE kol_id=?`).bind(kolId).first<any>();
    if (onboarding && !["ready", "failed"].includes(String(onboarding.phase))) {
      if (keepLive) {
        await env.DB.prepare(
          `UPDATE kol_onboarding_jobs SET phase='ready',last_error=?,updated_at=datetime('now') WHERE kol_id=?`
        ).bind(`candidate retained old live persona: ${String(e).slice(0, 300)}`, kolId).run();
      } else {
        await env.DB.prepare(
          `UPDATE kol_onboarding_jobs SET phase='failed',last_error=?,updated_at=datetime('now') WHERE kol_id=?`
        ).bind(`distill ${phase}: ${String(e).slice(0, 400)}`, kolId).run();
        await env.DB.prepare(`UPDATE kols SET onboarding_status='failed',is_public=0,updated_at=datetime('now') WHERE id=?`)
          .bind(kolId).run();
      }
    }
    const rejected = await env.DB.prepare(
      `SELECT status FROM persona_candidates WHERE kol_id=?`
    ).bind(kolId).first<any>();
    await env.DB.prepare(
      `UPDATE persona_update_jobs SET phase='failed',
         retries=CASE WHEN ?=1 THEN 8 ELSE retries+1 END,last_error=?,updated_at=datetime('now')
       WHERE kol_id=? AND phase NOT IN ('ready','failed')`
    ).bind(rejected?.status === "rejected" ? 1 : 0, `distill ${phase}: ${String(e).slice(0, 400)}`, kolId).run();
    return { next: null, extra: "" };
  }
}

async function acquireDistillStepLock(env: Env, kolId: string): Promise<string | null> {
  const owner = crypto.randomUUID();
  const now = Date.now();
  // Pro reduce calls can legitimately take 3-6 minutes. Keep the lease longer than one call so a
  // later cron tick cannot start the same group while the provider response is still in flight.
  const leaseUntil = now + 10 * 60 * 1000;
  await env.DB.prepare(
    `INSERT INTO distill_step_locks (kol_id,owner,lease_until,updated_at)
     VALUES (?,?,?,datetime('now'))
     ON CONFLICT(kol_id) DO UPDATE SET
       owner=excluded.owner,lease_until=excluded.lease_until,updated_at=datetime('now')
     WHERE distill_step_locks.lease_until < ?`
  ).bind(kolId, owner, leaseUntil, now).run();
  const row = await env.DB.prepare(`SELECT owner FROM distill_step_locks WHERE kol_id=?`).bind(kolId).first<any>();
  return row?.owner === owner ? owner : null;
}

async function releaseDistillStepLock(env: Env, kolId: string, owner: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM distill_step_locks WHERE kol_id=? AND owner=?`).bind(kolId, owner).run();
}

async function persistDistillCursor(
  env: Env,
  kolId: string,
  next: string | null,
  extra: string,
  steps: number,
): Promise<void> {
  const onboarding = await env.DB.prepare(
    `SELECT phase FROM kol_onboarding_jobs WHERE kol_id=?`
  ).bind(kolId).first<any>();
  if (next) {
    const nextI = extra.includes("i=") ? parseInt(extra.split("i=")[1], 10) : 0;
    const reduceLevel = next === "group" ? 1 : Number(next.match(/^group_l(\d+)$/)?.[1] || 0);
    if (onboarding) await env.DB.prepare(
      `UPDATE kol_onboarding_jobs
       SET distill_phase=?,distill_group_index=?,distill_steps=?,reduce_level=?,distill_updated_at=datetime('now'),
           updated_at=datetime('now')
       WHERE kol_id=? AND phase IN ('distilling','evaluating')`
    ).bind(next, Number.isFinite(nextI) ? nextI : 0, steps, reduceLevel, kolId).run();
    await env.DB.prepare(
      `UPDATE persona_update_jobs
       SET distill_phase=?,distill_group_index=?,distill_steps=?,reduce_level=?,updated_at=datetime('now')
       WHERE kol_id=? AND phase IN ('distilling','evaluating')`
    ).bind(next, Number.isFinite(nextI) ? nextI : 0, steps, reduceLevel, kolId).run();
    return;
  }
  // A successful eval step changes the lifecycle to ready before returning null. Any other terminal
  // null means the candidate gate/pack generation stopped and must remain private.
  const lifecycle = await env.DB.prepare(
    `SELECT is_public,length(persona_pack) pack_len FROM kols WHERE id=?`
  ).bind(kolId).first<any>();
  const keepLive = Number(lifecycle?.is_public || 0) === 1 && Number(lifecycle?.pack_len || 0) >= 500;
  if (onboarding && onboarding.phase !== "ready" && onboarding.phase !== "failed" && !keepLive) {
    await env.DB.prepare(
      `UPDATE kol_onboarding_jobs
       SET phase='failed',last_error=?,distill_steps=?,distill_updated_at=datetime('now'),updated_at=datetime('now')
       WHERE kol_id=?`
    ).bind(`distill stopped before ready`, steps, kolId).run();
    await env.DB.prepare(
      `UPDATE kols SET onboarding_status='failed',is_public=0,updated_at=datetime('now') WHERE id=?`
    ).bind(kolId).run();
  }
  await env.DB.prepare(
    `UPDATE persona_update_jobs SET phase='failed',last_error='distill stopped before ready',
       distill_steps=?,updated_at=datetime('now')
     WHERE kol_id=? AND phase NOT IN ('ready','failed')`
  ).bind(steps, kolId).run();
}

// Automated backfill orchestrator. Runs the current step IN-REQUEST, then self-triggers the next via a
// waitUntil(SELF.fetch). This reliably chains the fast + single-heavy steps (map → group* → final →
// finalize → first eval batch). A long *sequence* of slow steps (the many eval batches) can't fully
// self-chain on CF — each parent must waitUntil the child's response, and a ~55s parent has too little
// budget left to await a ~55s child — so it also records the in-progress job in KV (`distill_job:<kol>`)
// for an external/cron driver to resume. Start: POST /api/admin/distill-auto?kol_id=X&reset=1, then poll
// persona-experiments (trigger=distill_auto) for the DONE row.
app.post("/api/admin/distill-auto", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const kolId = c.req.query("kol_id");
  if (!kolId) return c.json({ error: "kol_id required" }, 400);
  const phase = c.req.query("phase") || "map";
  const groupIdx = parseInt(c.req.query("i") || "0", 10);

  // Progress is bounded by durable cursors, not a global step cap: very large accounts may
  // legitimately require hundreds of context-safe map/reduce steps.
  const stepKey = `distill_steps:${kolId}`;
  let steps = c.req.query("reset") === "1" ? 0 : parseInt((await c.env.CACHE.get(stepKey)) || "0", 10);
  steps++;
  await c.env.CACHE.put(stepKey, String(steps), { expirationTtl: 7200 });

  const lockOwner = await acquireDistillStepLock(c.env, kolId);
  if (!lockOwner) return c.json({ ok: true, busy: true, phase, steps });
  let result: { next: string | null; extra: string };
  try {
    result = await runDistillStep(c.env, kolId, phase, groupIdx, steps, stepKey);
  } finally {
    await releaseDistillStepLock(c.env, kolId, lockOwner);
  }
  await persistDistillCursor(c.env, kolId, result.next, result.extra, steps);
  if (result.next) {
    const nextI = result.extra.includes("i=") ? parseInt(result.extra.split("i=")[1], 10) : 0;
    await c.env.CACHE.put(`distill_job:${kolId}`, JSON.stringify({ phase: result.next, i: nextI }), { expirationTtl: 7200 });
    const origin = new URL(c.req.url).origin;
    const url = `${origin}/api/admin/distill-auto?kol_id=${encodeURIComponent(kolId)}&phase=${result.next}${result.extra}`;
    const init = { method: "POST", headers: { "x-admin-key": c.env.ADMIN_KEY || "" } };
    const fire = c.env.SELF ? c.env.SELF.fetch(url, init) : fetch(url, init);
    c.executionCtx.waitUntil(Promise.resolve(fire).then(() => {}).catch(() => {}));
  } else {
    await c.env.CACHE.delete(`distill_job:${kolId}`); // pipeline finished/stopped
  }
  return c.json({ ok: true, phase, next: result.next, steps });
});

// Diagnose WHY persona generation fails for a KOL: probes several max_tokens budgets and reports
// finish_reason / content length / parse outcome for each, WITHOUT writing anything to kols. The
// outcome is logged to persona_experiments so it's auditable. Use this to pick the production
// budget instead of guessing. Query: ?kol_id=X&budgets=8192,16384,32768 (defaults to a small ladder).
app.post("/api/admin/persona-diagnose", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const kolId = c.req.query("kol_id");
  if (!kolId) return c.json({ error: "kol_id required" }, 400);
  const budgetsParam = c.req.query("budgets");
  const budgets = budgetsParam
    ? budgetsParam.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => n > 0)
    : [8192, 16384, 32768];
  try {
    const result = await diagnosePersonaGeneration(c.env, kolId, budgets);
    return c.json({ ok: true, kol_id: kolId, probes: result.probes, best_budget: result.best });
  } catch (e: any) {
    return c.json({ error: e.message || String(e) }, 500);
  }
});

// Cron-driven step driver. Advances every in-progress distill job (`distill_job:<kol>` in KV) by ONE step
// per tick, running entirely on the worker. This is what completes the parts of the pipeline the
// self-chain can't (the long sequence of slow eval batches): each cron tick is an independent invocation
// with a fresh ~100s budget, so it never hits the await-the-slow-child wall. One step/min → a full eval
// (~13 batches) finishes in ~13 min, hands-off. Idempotent steps mean overlap with the self-chain is safe.
async function driveDistillJobs(env: Env, limit = 3): Promise<void> {
  // Failed jobs stay failed until an explicit retry request. A previous blanket UPDATE revived every
  // old shadow failure on each monthly run and silently spent model credits for hours.
  // D1 is the durable source of truth for onboarding. It survives KV expiry and a Worker being
  // terminated between finishing a provider request and scheduling its self-fetch continuation.
  const durableRows = await env.DB.prepare(
    `SELECT kol_id,distill_phase,distill_group_index,distill_steps,
            COALESCE(distill_updated_at,updated_at) AS sort_at
     FROM kol_onboarding_jobs
     WHERE phase IN ('distilling','evaluating') AND distill_phase IS NOT NULL
     UNION ALL
     SELECT kol_id,distill_phase,distill_group_index,distill_steps,updated_at AS sort_at
     FROM persona_update_jobs
     WHERE phase IN ('distilling','evaluating') AND distill_phase IS NOT NULL
     ORDER BY sort_at ASC
     LIMIT ?`
  ).bind(Math.max(1, Math.min(3, limit))).all();
  const durableIds = new Set<string>();
  for (const row of (durableRows.results || []) as any[]) {
    const kolId = String(row.kol_id);
    if (durableIds.has(kolId)) continue;
    durableIds.add(kolId);
    const steps = Number(row.distill_steps || 0) + 1;
    if (steps > 120) {
      const reason = "distill budget exceeded: 120 Worker steps";
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE persona_update_jobs SET phase='failed',retries=8,last_error=?,updated_at=datetime('now')
           WHERE kol_id=? AND phase IN ('distilling','evaluating')`
        ).bind(reason, kolId),
        env.DB.prepare(
          `UPDATE kol_onboarding_jobs SET phase='failed',last_error=?,updated_at=datetime('now')
           WHERE kol_id=? AND phase IN ('distilling','evaluating')`
        ).bind(reason, kolId),
      ]);
      await env.CACHE.delete(`distill_job:${kolId}`);
      continue;
    }
    const lockOwner = await acquireDistillStepLock(env, kolId);
    if (!lockOwner) continue;
    let result: { next: string | null; extra: string };
    try {
      result = await runDistillStep(
        env,
        kolId,
        String(row.distill_phase),
        Number(row.distill_group_index || 0),
        steps,
        `distill_steps:${kolId}`,
      );
    } finally {
      await releaseDistillStepLock(env, kolId, lockOwner);
    }
    await persistDistillCursor(env, kolId, result.next, result.extra, steps);
    if (result.next) {
      const nextI = result.extra.includes("i=") ? parseInt(result.extra.split("i=")[1], 10) : 0;
      await env.CACHE.put(
        `distill_job:${kolId}`,
        JSON.stringify({ phase: result.next, i: Number.isFinite(nextI) ? nextI : 0 }),
        { expirationTtl: 7200 },
      );
    } else {
      await env.CACHE.delete(`distill_job:${kolId}`);
    }
  }

  // Remove pre-D1 orphan cursors instead of executing them. Durable rows are now the sole authority;
  // otherwise a stale KV key can start an unobservable, unbudgeted model loop.
  const list = await env.CACHE.list({ prefix: "distill_job:" });
  for (const key of list.keys) {
    const kolId = key.name.slice("distill_job:".length);
    if (durableIds.has(kolId)) continue;
    await env.CACHE.delete(key.name);
    await env.CACHE.delete(`distill_steps:${kolId}`);
  }
}

async function driveOnboardingJobs(env: Env, limit = 3): Promise<void> {
  const jobs = await listRunnableOnboardingJobs(env, limit);
  for (const job of jobs) {
    const result = job.phase === "reconciling"
      ? await processOnboardingReconciliation(env, job.kol_id)
      : await processOnboardingBatch(env, job.kol_id, 5);
    if (result.start_distill) {
      // No self-fetch is required here. processOnboardingBatch persisted map/0 in D1 and the independent
      // distill cron driver will pick it up with a fresh invocation budget.
      await env.CACHE.delete(`distill_job:${job.kol_id}`);
    }
  }
}

// Inspect persona generation history for a KOL (from persona_experiments) — shows the trail of
// attempts, their finish_reasons, and parse outcomes. Useful for post-mortems on failed onboarding.
app.get("/api/admin/persona-experiments", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const kolId = c.req.query("kol_id");
  const limit = Math.min(parseInt(c.req.query("limit") || "50", 10), 200);
  const stmt = kolId
    ? c.env.DB.prepare(`SELECT * FROM persona_experiments WHERE kol_id=? ORDER BY started_at DESC LIMIT ?`).bind(kolId, limit)
    : c.env.DB.prepare(`SELECT * FROM persona_experiments ORDER BY started_at DESC LIMIT ?`).bind(limit);
  const r = await stmt.all();
  return c.json({ experiments: r.results });
});

app.get("/api/persona/:kol_id", async (c) => {
  const kol = await c.env.DB.prepare(`SELECT id,display_name,handle,persona_pack,persona_version FROM kols WHERE id=?`)
    .bind(c.req.param("kol_id")).first<any>();
  if (!kol) return c.json({ error: "not found" }, 404);
  return c.json(kol);
});

app.post("/api/persona/:kol_id", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.json<{ persona_pack?: string; persona_version?: string }>();
  if (!body.persona_pack) return c.json({ error: "persona_pack required" }, 400);
  // Backup current pack before overwriting
  const current = await c.env.DB.prepare(`SELECT persona_pack, persona_version FROM kols WHERE id=?`).bind(c.req.param("kol_id")).first<any>();
  if (current?.persona_pack && current.persona_pack.length > 100) {
    const backupId = `${c.req.param("kol_id")}:persona_backup:${new Date().toISOString().slice(0, 10)}:${Date.now()}`;
    await c.env.DB.prepare(
      `INSERT OR REPLACE INTO knowledge_chunks (id,kol_id,source,title,text) VALUES (?,?,?,?,?)`
    ).bind(backupId, c.req.param("kol_id"), `persona_backup:${current.persona_version || "unknown"}`, `Persona backup ${new Date().toISOString().slice(0, 10)}`, current.persona_pack).run();
  }
  await c.env.DB.prepare(`UPDATE kols SET persona_pack=?, persona_version=?, updated_at=datetime('now') WHERE id=?`)
    .bind(body.persona_pack, body.persona_version || "manual", c.req.param("kol_id")).run();
  return c.json({ ok: true });
});

app.post("/api/persona-evolve", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const kolId = c.req.query("kol_id");
  if (!kolId) return c.json({ error: "kol_id required" }, 400);
  try {
    const result = await evolvePersona(c.env, kolId);
    return c.json(result);
  } catch (e: any) {
    return c.json({ error: e.message || String(e) }, 500);
  }
});

// Human-facing KOL research-room routes. Static Assets' SPA fallback would otherwise
// return the landing page for these deep links.
app.get("/kol/:persona", (c) => serveDesk(c));

app.get("/kol/:persona/:section", (c) => serveDesk(c));

// ---- Diagnostic: test pro model connectivity ----
app.get("/api/admin/model-test", async (c) => {
  if (!adminOk(c)) return c.json({ error: "unauthorized" }, 401);
  const kolId = c.req.query("kol_id") || "aleabitoreddit";
  const debug = await c.env.CACHE.get(`persona_debug:${kolId}`);
  const start = Date.now();
  try {
    const response = await completeSystemChat(
      c.env,
      "pro",
      [{ role: "user", content: "Say hello in exactly 3 words." }],
      { temperature: 0.1, maxTokens: 20 },
    );
    const elapsed = Date.now() - start;
    return c.json({ ok: true, elapsed, model: officialSystemModel(c.env, "pro"), response, persona_debug: debug });
  } catch (e: any) {
    return c.json({ error: String(e), elapsed: Date.now() - start });
  }
});

// Static assets fallback — app subdomain uses desk.html only for client-side routes.
app.get("*", (c) => {
  const url = new URL(c.req.url);
  if (isAppHost(url.hostname) && isDeskSpaPath(url.pathname)) {
    url.pathname = "/desk.html";
    return c.env.ASSETS.fetch(new Request(url, c.req.raw));
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const host = requestHost(req);
    const url = new URL(req.url);
    // Static Assets may short-circuit extensionless SPA paths in local/production asset routing.
    // Rewrite the two hidden human-facing routes into API space before handing off to Hono.
    if (isOnboardingHost(host)) {
      const invite = url.pathname.match(/^\/add-kol\/([^/]+)\/?$/);
      if (invite) {
        url.pathname = "/api/onboarding/invite";
        url.searchParams.set("token", invite[1]);
        return app.fetch(new Request(url, req), env, ctx);
      }
      if (url.pathname === "/add-kol" || url.pathname === "/add-kol/") {
        url.pathname = "/api/onboarding/page";
        return app.fetch(new Request(url, req), env, ctx);
      }
    }
    if (isMarketingHost(host)) {
      if (
        url.pathname.startsWith("/kol/") ||
        url.pathname === "/research" ||
        url.pathname === "/desk" ||
        url.pathname.startsWith("/research/")
      ) {
        return redirectToApp(req);
      }
    }
    if (url.pathname.startsWith("/kol/")) {
      url.pathname = "/desk.html";
      return env.ASSETS.fetch(new Request(url, req));
    }
    return app.fetch(req, env, ctx);
  },
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (event.cron === "* * * * *") {
      // Every minute: at most three expensive job steps globally. Reserve one slot for ingestion /
      // reconciliation and two for distill/eval so one prolific account cannot starve every other job.
      ctx.waitUntil(Promise.all([
        driveOnboardingJobs(env, 1),
        driveDistillJobs(env, 2),
      ]).then(() => {}));
      return;
    }
    // Persona refreshes are explicit jobs only. The daily cron below fetches/indexes new tweets
    // without any LLM calls; it never rewrites a live persona automatically.
    ctx.waitUntil(runDailyIngest(env));
  },
};
