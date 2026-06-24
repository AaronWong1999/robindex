/* Robindex — billing / credits / subscription engine (mock, localStorage-backed).
   Mirrors the intended backend: free daily quota, per-model credit cost,
   per-KOL monthly subscriptions, credit packs, gifted-credit + consumption ledgers.
   Exposes window.RXB. Stripe is the intended PSP (HK entity). */
(function () {
  const DAY = 86400000;
  const pick = (o, lang) => (o && typeof o === "object" && ("zh" in o || "en" in o)) ? (o[lang] || o.zh) : o;

  // ---- Free plan ----
  const FREE = { cap: 2, model: "flash" }; // 2 questions / 24h, locked to DeepSeek V4 Flash

  // ---- Token → points pricing ----
  // 实际扣点严格按 token 用量结算：每次提问统计 输入/输出 token，
  // 扣点 = (输入token × IN + 输出token × OUT) / 1000 × 模型倍率(mult)。
  const RATE = { in: 0.20, out: 0.90 }; // 基准价：每 1K token 的点数（倍率 1.00x 时）
  function pointsFor(tokIn, tokOut, mult) {
    const base = (tokIn * RATE.in + tokOut * RATE.out) / 1000;
    return Math.round(base * (mult || 0) * 100) / 100;
  }
  // 估算一次提问的 token 量（mock）：系统+检索上下文 + 问题长度，输出按回答长度折算。
  function genTokens(qText, ansLen, attCount) {
    const q = (qText || "").length;
    const vis = (attCount || 0) * (900 + Math.round(Math.random() * 500)); // 附件/图片的视觉 token
    const tokIn = Math.round(2600 + q * 1.7 + 1200 + vis + Math.random() * 2800);
    const tokOut = Math.round(ansLen ? ansLen / 2.2 + 120 : 640 + Math.random() * 760);
    return { tokIn, tokOut };
  }
  function reqId() { const h = "0123456789abcdef"; let s = ""; for (let i = 0; i < 10; i++) s += h[Math.floor(Math.random() * 16)]; return s; }

  // ---- Subscription economics ----
  // default 39.9/mo; current launch promo 19.9/mo (recurring). Each sub gifts ~150 Flash questions.
  const SUB_DEFAULT = 39.9, SUB_PROMO = 19.9, SUB_GIFT = 2000; // ≈ Flash ×5/day ×30d
  const KOL_PLANS = {
    qinbafrank:     { id: "qinbafrank", name: "Qinbafrank", priceMonthly: 39.9, promoMonthly: 19.9, gift: 2000, accent: "#3DDC97" },
    aleabitoreddit: { id: "aleabitoreddit", name: "Serenity", priceMonthly: 39.9, promoMonthly: 19.9, gift: 2000, accent: "#5B9DFF" },
  };
  const planFor = (id) => KOL_PLANS[id] || { id, name: id, priceMonthly: SUB_DEFAULT, promoMonthly: SUB_PROMO, gift: SUB_GIFT, accent: "#5B9DFF" };

  // ---- Credit packs (USD → credits, bonus on larger packs) ----
  const PACKS = [
    { id: "starter", usd: 9.9,  credits: 5000,  bonus: 0,    label: { zh: "入门", en: "Starter" } },
    { id: "plus",    usd: 19.9, credits: 11000, bonus: 0.10, label: { zh: "进阶", en: "Plus" } },
    { id: "pro",     usd: 49.9, credits: 30000, bonus: 0.20, label: { zh: "专业", en: "Pro" }, popular: true },
    { id: "max",     usd: 99.9, credits: 65000, bonus: 0.30, label: { zh: "旗舰", en: "Max" }, best: true },
  ];

  // ---- BYOK: 自有 API 提供商预设（仅支持 OpenAI 兼容协议）----
  // 用户填入自己的 API Key 后，推理费由提供商直接向用户结算，平台扣 0 积分。
  const PROVIDERS = [
    { id: "openrouter", group: "OpenRouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1/chat/completions", color: "#71717A", badge: "OR", models: ["openai/gpt-4o", "openai/gpt-4.1", "anthropic/claude-sonnet-4", "anthropic/claude-3.5-sonnet", "google/gemini-2.5-pro", "google/gemini-2.5-flash", "deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-flash", "deepseek/deepseek-chat", "meta-llama/llama-4-maverick", "qwen/qwen3-235b-a22b", "mistralai/mistral-large", "x-ai/grok-4.1"] },
    { id: "deepseek", group: "DeepSeek", name: "DeepSeek API", baseUrl: "https://api.deepseek.com/v1/chat/completions", color: "#4D6BFE", badge: "DS", dflt: true, models: ["deepseek-chat", "deepseek-reasoner"] },
    { id: "custom", group: "Custom", name: "自定义 API", baseUrl: "", color: "#6B7280", badge: "API", models: ["Auto"] },
  ];
  function provider(id) { return PROVIDERS.find((p) => p.id === id) || null; }
  function maskKey(k) { if (!k) return ""; const s = String(k).trim(); return s.length <= 8 ? "••••••••" : s.slice(0, 3) + "••••••" + s.slice(-4); }

  // ---- Account store ----
  const KEY = "rx.account.v2";
  function now() { return Date.now(); }
  function seed() {
    const t = now();
    return {
      credits: 0,
      freeUsed: 0,
      freeResetAt: t + DAY,
      customModels: [],
      subs: {},
      ledger: [],
      consumption: [],
    };
  }
  function load() {
    try { const v = localStorage.getItem(KEY); if (v) return migrate(JSON.parse(v)); } catch (e) {}
    const s = seed(); save(s); return s;
  }
  function migrate(a) {
    if (!a || typeof a !== "object") return seed();
    if (a.credits == null) a.credits = 0;
    if (!a.subs) a.subs = {};
    if (!Array.isArray(a.ledger)) a.ledger = [];
    if (!Array.isArray(a.consumption)) a.consumption = [];
    if (!Array.isArray(a.customModels)) a.customModels = [];
    if (a.freeUsed == null) a.freeUsed = 0;
    if (a.freeResetAt == null) a.freeResetAt = now() + DAY;
    return a;
  }
  function save(a) { try { localStorage.setItem(KEY, JSON.stringify(a)); } catch (e) {} }

  // pub/sub so React can re-render on changes
  const subscribers = new Set();
  function emit() { subscribers.forEach((fn) => { try { fn(); } catch (e) {} }); }
  function onChange(fn) { subscribers.add(fn); return () => subscribers.delete(fn); }

  let A = load();
  function get() { return A; }
  function commit() { save(A); emit(); }
  function reset() { A = seed(); commit(); }

  // ---- model helpers ----
  function model(id) {
    const b = (window.RX && window.RX.MODELS || []).find((m) => m.id === id);
    if (b) return b;
    return ((A && A.customModels) || []).find((m) => m.id === id) || null;
  }
  function isByok(id) { const m = model(id); return !!(m && m.byok); }
  function modelMult(id) { const m = model(id); return m ? (m.mult || 0) : 0; }
  function isFreeModel(id) { const m = model(id); return !!(m && m.free); }
  // 典型一次提问的预估扣点（用于付费墙/估算展示）
  function typicalCost(id) { return pointsFor(5200, 980, modelMult(id)); }

  // ---- BYOK custom-model CRUD ----
  function customModels() { return ((A && A.customModels) || []).slice(); }
  function providers() { return PROVIDERS; }
  function addCustomModel(cfg) {
    cfg = cfg || {};
    const prov = provider(cfg.providerId) || {};
    const m = {
      id: "cm_" + Math.random().toString(36).slice(2, 8), byok: true, group: "自有 API · BYOK", addedAt: now(),
      modelName: cfg.modelName || "Auto",
      name: cfg.name || ((cfg.modelName && cfg.modelName !== "Auto") ? cfg.modelName + " · 自有" : (prov.name || "自定义") + " · Auto"),
      providerId: cfg.providerId, providerName: cfg.providerName || prov.name || "自定义 API",
      baseUrl: cfg.baseUrl || prov.baseUrl || "",
      apiKey: cfg.apiKey ? maskKey(cfg.apiKey) : "",
      color: prov.color || "#6B7280", badge: prov.badge || "API",
      note: { zh: "自有 API · " + (cfg.providerName || prov.name || ""), en: "Your API · " + (cfg.providerName || prov.name || "") },
    };
    A.customModels = [m, ...((A && A.customModels) || [])];
    commit();

    // Sync to backend so the BYOK routing works on the server.
    if (serverReady() && cfg.apiKey) {
      authHeaders().then((h) => fetch("/api/byok/models", {
        method: "POST", headers: h,
        body: JSON.stringify({ id: m.id, providerId: m.providerId, modelName: m.modelName, displayName: m.name, baseUrl: m.baseUrl, apiKey: cfg.apiKey, color: m.color, badge: m.badge }),
      }).catch(() => {}));
    }
    return m;
  }
  function removeCustomModel(id) {
    A.customModels = ((A && A.customModels) || []).filter((m) => m.id !== id); commit();
    // Sync delete to backend.
    if (serverReady()) {
      authHeaders().then((h) => fetch("/api/byok/models/" + encodeURIComponent(id), {
        method: "DELETE", headers: h,
      }).catch(() => {}));
    }
  }

  // ---- free quota ----
  function rollFree() {
    if (now() >= A.freeResetAt) { A.freeUsed = 0; A.freeResetAt = now() + DAY; save(A); }
  }
  function freeLeft() { rollFree(); return Math.max(0, FREE.cap - A.freeUsed); }
  function freeResetIn() { rollFree(); return Math.max(0, A.freeResetAt - now()); }

  // ---- subscriptions ----
  function isSubscribed(kolId) { const s = A.subs[kolId]; return !!(s && s.expiresAt > now()); }
  function sub(kolId) { return A.subs[kolId] || null; }
  function subDaysLeft(kolId) { const s = A.subs[kolId]; if (!s) return 0; return Math.max(0, Math.ceil((s.expiresAt - now()) / DAY)); }

  // ---- can-ask verdict ----
  // returns { ok, reason, free, byok }
  //   reason: "model-locked" | "quota" | "credits" | null
  //   逻辑：订阅 = 解锁分身无限提问（平台利润）；计算源二选一：
  //   平台内置模型按 token×倍率扣积分；自有 API(BYOK)走用户自己的 key，扣 0 积分。
  function canAsk(kolId, modelId) {
    const subbed = isSubscribed(kolId);
    const byok = isByok(modelId);
    if (subbed) {
      if (byok) return { ok: true, reason: null, free: false, byok: true };
      if (A.credits > 0) return { ok: true, reason: null, free: false };
      return { ok: false, reason: "credits", free: false };
    }
    // not subscribed → persona gate: only the free Flash trial; everything else (incl. BYOK) needs a subscription
    if (byok || !isFreeModel(modelId)) return { ok: false, reason: "model-locked", free: false, byok };
    if (freeLeft() <= 0) return { ok: false, reason: "quota", free: true };
    return { ok: true, reason: null, free: true };
  }

  // record a consumed question (call after canAsk passes).
  // 平台内置：按 token×倍率扣积分；自有 API：扣 0 积分。返回 { ok, free, byok, points, tokIn, tokOut, id }
  function recordAsk(kolId, modelId, qText, ansLen, attCount) {
    const v = canAsk(kolId, modelId);
    if (!v.ok) return v;
    const { tokIn, tokOut } = genTokens(qText, ansLen, attCount);
    const id = reqId();
    const byok = !!v.byok;
    let points = 0;
    if (byok) { /* 自有 API，平台不扣积分 */ }
    else if (v.free) { A.freeUsed += 1; }
    else { points = pointsFor(tokIn, tokOut, modelMult(modelId)); A.credits = Math.max(0, Math.round((A.credits - points) * 100) / 100); }
    A.consumption.unshift({ id, kol: kolId, model: modelId, tokIn, tokOut, points, byok, ts: now(), free: v.free, q: qText ? { zh: qText, en: qText } : null });
    if (A.consumption.length > 80) A.consumption.length = 80;
    commit();
    return { ok: true, free: v.free, byok, points, tokIn, tokOut, id };
  }

  // ---- purchases ----
  function subscribe(kolId, planKey /* "promo" | "default" */) {
    const p = planFor(kolId);
    const promo = planKey !== "default";
    const price = promo ? p.promoMonthly : p.priceMonthly;
    const existing = A.subs[kolId];
    const base = existing && existing.expiresAt > now() ? existing.expiresAt : now();
    A.subs[kolId] = { plan: promo ? "promo" : "default", priceMonthly: price, autoRenew: true, startedAt: existing ? existing.startedAt : now(), expiresAt: base + 30 * DAY };
    A.credits += p.gift;
    A.ledger.unshift({ type: "subscription", credits: p.gift, ts: now(), kol: kolId, label: { zh: `订阅赠送 · ${p.name}`, en: `Subscription gift · ${p.name}` } });
    commit();
    return A.subs[kolId];
  }
  function renew(kolId) { return subscribe(kolId, sub(kolId) && sub(kolId).plan === "default" ? "default" : "promo"); }
  function setAutoRenew(kolId, on) {
    if (A.subs[kolId]) { A.subs[kolId].autoRenew = !!on; commit(); }
    if (serverReady()) {
      authHeaders().then((h) => fetch("/api/billing/autorenew", { method: "POST", headers: h, body: JSON.stringify({ kolId, on: !!on }) })
        .then((r) => r.ok && r.json()).then((st) => st && applyState(st)).catch(() => {}));
    }
  }
  function cancelSub(kolId) { if (A.subs[kolId]) { A.subs[kolId].autoRenew = false; commit(); } }

  function topup(packId) {
    const p = PACKS.find((x) => x.id === packId); if (!p) return;
    A.credits += p.credits;
    A.ledger.unshift({ type: "topup", credits: p.credits, ts: now(), usd: p.usd, pack: p.id, label: { zh: `充值 · ${pick(p.label, "zh")}包`, en: `Top-up · ${pick(p.label, "en")}` } });
    commit();
    return p;
  }

  // ---- formatting ----
  function fmt(n) { return Math.round(n || 0).toLocaleString("en-US"); }
  function fmtPts(n) { return (n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function fmtMult(n) { return (n || 0).toFixed(2) + "x"; }
  function fmtTok(n) { n = n || 0; return n >= 1000 ? (Math.round(n / 100) / 10) + "K" : String(n); }
  function fmtUsd(n) { return "$" + (Math.round(n * 100) / 100).toFixed(2).replace(/\.00$/, ""); }
  function timeAgo(ts, lang) {
    const d = now() - ts; const en = lang === "en";
    if (d < 3600000) { const m = Math.max(1, Math.round(d / 60000)); return en ? `${m}m ago` : `${m} 分钟前`; }
    if (d < DAY) { const h = Math.round(d / 3600000); return en ? `${h}h ago` : `${h} 小时前`; }
    const dd = Math.round(d / DAY); return en ? `${dd}d ago` : `${dd} 天前`; }
  function hoursMins(ms, lang) {
    const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
    if (lang === "en") return h > 0 ? `${h}h ${m}m` : `${m}m`;
    return h > 0 ? `${h} 小时 ${m} 分` : `${m} 分`;
  }

  // ---- Server sync (real money) ----
  // When signed in, the browser store becomes a cache of the server's authoritative billing state.
  // Purchases never grant credits locally — they go through Stripe Checkout and are granted by the
  // server webhook. setAuth() is called by the app once Privy is ready.
  let _tokenGetter = null;   // () => Promise<string>  (Privy access token)
  let _email = null;
  function setAuth(tokenGetter, email) { _tokenGetter = tokenGetter; _email = email || null; }
  function serverReady() { return typeof _tokenGetter === "function"; }
  async function authHeaders() {
    const tok = _tokenGetter ? await _tokenGetter() : null;
    return tok ? { Authorization: "Bearer " + tok, "Content-Type": "application/json" } : { "Content-Type": "application/json" };
  }
  function labelFor(e) {
    const en = window.RXI && window.RXI.lang === "en";
    if (e.type === "topup") return { zh: "充值", en: "Top-up" };
    if (e.type === "subscription") { const p = planFor(e.kol); return { zh: `订阅赠送 · ${p.name}`, en: `Subscription gift · ${p.name}` }; }
    if (e.type === "signup") return { zh: "注册赠送", en: "Welcome gift" };
    return en ? "" : "";
  }
  function applyState(st) {
    if (!st || typeof st !== "object") return;
    A.credits = st.credits != null ? st.credits : A.credits;
    if (st.freeUsed != null) A.freeUsed = st.freeUsed;
    if (st.freeResetAt != null) A.freeResetAt = st.freeResetAt;
    if (st.subs) A.subs = st.subs;
    if (Array.isArray(st.ledger)) A.ledger = st.ledger.map((e) => ({ ...e, label: e.label || labelFor(e) }));
    if (Array.isArray(st.consumption)) A.consumption = st.consumption;
    commit();
  }
  async function syncFromServer() {
    if (!serverReady()) return null;
    try {
      const url = "/api/billing/state" + (_email ? "?email=" + encodeURIComponent(_email) : "");
      const r = await fetch(url, { headers: await authHeaders() });
      if (!r.ok) return null;
      const st = await r.json();
      applyState(st);
      // Also sync BYOK models from the server (they drive actual LLM routing).
      syncByokModels();
      return st;
    } catch (e) { return null; }
  }
  async function syncByokModels() {
    try {
      const r = await fetch("/api/byok/models", { headers: await authHeaders() });
      if (!r.ok) return;
      const j = await r.json();
      if (j.models && Array.isArray(j.models)) {
        // Merge server models with local; server is authoritative for cm_ prefix.
        const serverIds = new Set(j.models.map((m) => m.id));
        const localOnly = (A.customModels || []).filter((m) => !serverIds.has(m.id));
        const serverMapped = j.models.map((sm) => ({
          id: sm.id, byok: true, group: "自有 API · BYOK",
          modelName: sm.modelName, name: sm.displayName,
          providerId: sm.providerId, providerName: sm.providerName,
          baseUrl: sm.baseUrl,
          apiKey: maskKey(sm.apiKey || ""),
          color: sm.color || "#6B7280", badge: sm.badge || "API",
          note: { zh: "自有 API · " + sm.providerName, en: "Your API · " + sm.providerName },
        }));
        A.customModels = [...serverMapped, ...localOnly];
        save(A);
      }
    } catch (e) {}
  }
  // Lazy-load the Airwallex.js SDK (only when an Airwallex checkout is actually started).
  let _awSdkPromise = null;
  function loadAirwallexSDK() {
    if (window.AirwallexComponentsSDK) return Promise.resolve();
    if (_awSdkPromise) return _awSdkPromise;
    _awSdkPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://static.airwallex.com/components/sdk/v1/index.js";
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("airwallex_sdk_load_failed"));
      document.head.appendChild(s);
    });
    return _awSdkPromise;
  }
  async function airwallexRedirect(j) {
    await loadAirwallexSDK();
    const env = j.env || "prod";
    const { payments } = await window.AirwallexComponentsSDK.init({ env, enabledElements: ["payments"] });
    await payments.redirectToCheckout({
      env, mode: "payment",
      intent_id: j.intentId, client_secret: j.clientSecret,
      currency: j.currency || "USD", country_code: "HK",
      successUrl: window.location.origin + "/?billing=success&provider=airwallex",
      failUrl: window.location.origin + "/?billing=cancel",
    });
  }
  // Start a real checkout for { type:"pack", packId } or { type:"sub", kolId, plan }. Stripe returns a
  // hosted URL we navigate to; Airwallex returns intent details we hand to its SDK. Optional item.provider
  // forces a PSP ("stripe" | "airwallex"); otherwise the server auto-selects.
  async function checkout(item) {
    if (!serverReady()) return { ok: false, error: "not_signed_in" };
    try {
      const body = item.type === "sub"
        ? { type: "sub", kolId: item.kolId, plan: item.plan || "promo", email: _email }
        : { type: "pack", packId: item.packId, email: _email };
      if (item.provider) body.provider = item.provider;
      const r = await fetch("/api/billing/checkout", { method: "POST", headers: await authHeaders(), body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return { ok: false, error: j.error || ("http_" + r.status) };
      // Hosted-URL flow: Stripe (packs+subs) and Airwallex subscriptions all return a redirect URL.
      if (j.url) { window.location.href = j.url; return { ok: true }; }
      // Airwallex one-time packs come back as a Payment Intent → redirect via their JS SDK.
      if (j.provider === "airwallex" && j.intentId) { await airwallexRedirect(j); return { ok: true }; }
      return { ok: false, error: j.error || "no_redirect" };
    } catch (e) { return { ok: false, error: String(e) }; }
  }

  window.RXB = {
    FREE, PACKS, KOL_PLANS, planFor, RATE, PROVIDERS,
    get, commit, reset, onChange, pick,
    setAuth, serverReady, syncFromServer, checkout, applyState, authHeaders,
    model, modelMult, isFreeModel, isByok, pointsFor, typicalCost,
    providers, provider, customModels, addCustomModel, removeCustomModel, maskKey,
    freeLeft, freeResetIn, freeCap: FREE.cap,
    isSubscribed, sub, subDaysLeft,
    canAsk, recordAsk,
    subscribe, renew, setAutoRenew, cancelSub, topup,
    fmt, fmtPts, fmtMult, fmtTok, fmtUsd, timeAgo, hoursMins,
  };
})();
