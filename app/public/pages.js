"use strict";
/* Logic for the top-nav destination pages: 个股研究 / 宏观研究 / 我的自选股 / 每日简报.
   Each HTML shell sets <body data-page="stock|macro|for-you|briefings"> and includes this file. */

const PG = document.body.dataset.page;
const $ = (s, r = document) => r.querySelector(s);

function fmtPrice(p) {
  if (p == null || isNaN(p)) return "—";
  const n = Number(p);
  return n >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : n.toFixed(2);
}
function pctClass(p) { return p > 0 ? "up" : p < 0 ? "down" : ""; }
function sign(p) { return p > 0 ? "+" : ""; }

// Render a single live quote card. `q` is a quote from /api/quote.
function quoteCard(q, opts = {}) {
  const chg = Number(q.changePct ?? q.change_pct ?? 0);
  const name = q.name ? `<span class="qname">${q.name}</span>` : "";
  const rm = opts.removable ? `<button class="qrm" data-rm="${q.symbol}" aria-label="移除">✕</button>` : "";
  const persona = opts.persona || "qinbafrank";
  const ask = encodeURIComponent(`他怎么看 ${q.symbol} 现在的位置？`);
  return `<a class="qcard" href="/research?agent=kol&persona=${persona}&q=${ask}">
    ${rm}
    <div class="qsym">${q.symbol} ${name}</div>
    <div class="qprice">${fmtPrice(q.price)}</div>
    <div class="qchg ${pctClass(chg)}">${sign(chg)}${chg.toFixed(2)}% <span style="color:var(--muted)">${q.change != null ? sign(chg) + fmtPrice(Math.abs(q.change)) : ""}</span></div>
    <div class="qask">用 KOL 框架追问 →</div>
  </a>`;
}

async function fetchQuotes(symbols) {
  const codes = symbols.map((s) => (s.includes("us") || s.includes("sh") || s.includes("sz") || s.includes("hk") ? s : "us" + s)).join(",");
  try {
    const r = await fetch(`/api/quote?codes=${encodeURIComponent(codes)}`);
    const j = await r.json();
    return j.quotes || [];
  } catch (e) { return []; }
}

// ---------------- 个股研究 ----------------
const STOCK_SECTORS = [
  { title: "MAG 7 科技巨头", en: "Magnificent 7", desc: "占 S&P 500 近 30% 权重，美股风向标", syms: ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"] },
  { title: "AI 芯片 & 基础设施", en: "AI Infrastructure", desc: "追踪 AI capex 周期健康度", syms: ["NVDA", "AMD", "AVGO", "MU", "TSM", "MRVL", "ASML"] },
  { title: "加密金融", en: "Crypto & Fintech", desc: "稳定币、交易所与加密敞口", syms: ["COIN", "HOOD", "CRCL", "MSTR"] },
  { title: "光通信 / 供应链", en: "Optical & Supply Chain", desc: "CPO、光模块与衬底链", syms: ["COHR", "LITE", "ANET", "CRDO"] },
  { title: "宽基 ETF / 杠杆", en: "Index & Leveraged ETF", desc: "大盘与高 beta 工具", syms: ["SPY", "QQQ", "SOXL", "TQQQ"] },
];

// ---------------- 宏观研究 ----------------
const MACRO_GROUPS = [
  { title: "美股大盘", en: "US Equity", desc: "三大指数 ETF 代理", syms: ["SPY", "QQQ", "DIA", "IWM"] },
  { title: "利率 & 避险", en: "Rates & Safe Haven", desc: "长债、黄金与波动率", syms: ["TLT", "GLD", "VIXY"] },
  { title: "美元 & 商品", en: "Dollar & Commodities", desc: "美元、原油与铜", syms: ["UUP", "USO", "CPER"] },
  { title: "风险资产", en: "Risk Assets", desc: "比特币与高 beta 科技", syms: ["BITO", "ARKK", "SOXX"] },
];

async function renderSectorPage(groups, mountSel) {
  const mount = $(mountSel);
  mount.innerHTML = groups.map((g, i) => `
    <div class="sector-block">
      <div class="shead"><h3>${g.title}</h3><span class="en">${g.en}</span><span class="sdesc">${g.desc}</span></div>
      <div class="quote-grid" id="sg${i}"><span class="loading-dot">加载实时行情…</span></div>
    </div>`).join("");
  // Fetch all groups in parallel.
  await Promise.all(groups.map(async (g, i) => {
    const quotes = await fetchQuotes(g.syms);
    const grid = $(`#sg${i}`);
    grid.innerHTML = quotes.length ? quotes.map((q) => quoteCard(q)).join("") : `<span class="empty-note">行情暂不可用</span>`;
  }));
}

// ---------------- 我的自选股 ----------------
const WL_KEY = "robindex_watchlist";
function wlGet() {
  try { return JSON.parse(localStorage.getItem(WL_KEY) || "null") || ["NVDA", "HOOD", "COIN", "AVGO"]; }
  catch (e) { return ["NVDA", "HOOD", "COIN", "AVGO"]; }
}
function wlSet(arr) { try { localStorage.setItem(WL_KEY, JSON.stringify(arr)); } catch (e) {} }

async function renderWatchlist() {
  const grid = $("#wlGrid");
  const syms = wlGet();
  if (!syms.length) { grid.innerHTML = `<p class="empty-note">还没有自选股。在上方输入代码（如 NVDA）添加。</p>`; return; }
  grid.innerHTML = `<span class="loading-dot">加载实时行情…</span>`;
  const quotes = await fetchQuotes(syms);
  const bySym = {}; quotes.forEach((q) => (bySym[q.symbol] = q));
  grid.innerHTML = syms.map((s) => {
    const q = bySym[s] || { symbol: s, price: null, changePct: 0 };
    return quoteCard(q, { removable: true });
  }).join("");
  grid.querySelectorAll("[data-rm]").forEach((b) => b.addEventListener("click", (e) => {
    e.preventDefault();
    wlSet(wlGet().filter((x) => x !== b.dataset.rm));
    renderWatchlist();
  }));
}

// ---------------- 每日简报 ----------------
const BRIEF_COPY = {
  morning: { eyebrow: "盘前早报", title: "盘前早报", lead: "开盘前的市场快照：大盘 ETF、利率与风险资产位置，配合两位博主最新公开动态。" },
  evening: { eyebrow: "盘后晚报", title: "盘后晚报", lead: "收盘后的市场快照与当日博主公开内容回顾。" },
  kol: { eyebrow: "KOL 日报", title: "推特 KOL 日报", lead: "两位博主最新的公开推文，按时间汇总（每日后台增量抓取，完整保留原文）。" },
};

function tweetCard(t, handle) {
  const date = (t.created_at_iso || "").slice(0, 10);
  const url = `https://x.com/${handle}/status/${t.id}`;
  const metrics = [["♥", t.likes], ["↻", t.retweets], ["💬", t.replies], ["👁", t.views]]
    .filter(([, v]) => v).map(([ic, v]) => `<span>${ic} ${Number(v).toLocaleString()}</span>`).join("");
  return `<div class="tweet">
    <div class="thead"><span class="thandle">@${handle}</span><span>·</span><span>${date}</span></div>
    <div class="ttext">${escapeHtml(t.text)}</div>
    <div class="tmetrics">${metrics}<a class="tlink" href="${url}" target="_blank" rel="noopener" style="margin-left:auto">查看原文 ↗</a></div>
  </div>`;
}
function escapeHtml(s) { return (s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }

async function renderBriefings() {
  const type = new URLSearchParams(location.search).get("type") || (location.pathname === "/morning" ? "morning" : location.pathname === "/today" ? "evening" : "kol");
  const copy = BRIEF_COPY[type] || BRIEF_COPY.kol;
  $("#brEyebrow").textContent = copy.eyebrow;
  $("#brTitle").textContent = copy.title;
  $("#brLead").textContent = copy.lead;
  // Tabs active state.
  document.querySelectorAll(".tab[data-type]").forEach((tb) => tb.classList.toggle("active", tb.dataset.type === type));

  const body = $("#brBody");
  if (type === "kol") {
    body.innerHTML = `<div id="kolFeed"><span class="loading-dot">加载博主最新动态…</span></div>`;
    const feeds = await Promise.all([
      fetch("/api/tweets?kol_id=qinbafrank&limit=8").then((r) => r.json()).catch(() => null),
      fetch("/api/tweets?kol_id=aleabitoreddit&limit=8").then((r) => r.json()).catch(() => null),
    ]);
    const blocks = [["Qinbafrank", feeds[0]], ["Serenity", feeds[1]]].map(([name, f]) => {
      if (!f || !f.tweets || !f.tweets.length) return "";
      return `<div class="sector-block"><div class="shead"><h3>${name}</h3><span class="en">@${f.handle}</span><span class="sdesc">共 ${f.total} 条入库原文</span></div>
        <div class="tweet-list">${f.tweets.map((t) => tweetCard(t, f.handle)).join("")}</div></div>`;
    }).join("");
    $("#kolFeed").outerHTML = blocks || `<p class="empty-note">暂无博主动态。</p>`;
  } else {
    body.innerHTML = `<div class="sector-block"><div class="shead"><h3>市场快照</h3><span class="en">Live Snapshot</span><span class="sdesc">实时大盘与风险资产</span></div>
      <div class="quote-grid" id="brBoard"><span class="loading-dot">加载实时行情…</span></div></div>
      <div class="macro-note">本快照为实时行情聚合，便于在 ${copy.title} 视角下快速定位市场环境；完整的盘前/盘后 AI 解读为 Ultra 能力。可进入<a href="/kol" style="color:var(--green)"> 博主研究室 </a>用对应 KOL 框架追问任意标的。</div>`;
    const quotes = await fetchQuotes(["SPY", "QQQ", "DIA", "IWM", "TLT", "GLD", "VIXY", "BITO"]);
    $("#brBoard").innerHTML = quotes.length ? quotes.map((q) => quoteCard(q)).join("") : `<span class="empty-note">行情暂不可用</span>`;
  }
}

// ---------------- dispatch ----------------
if (PG === "stock") renderSectorPage(STOCK_SECTORS, "#stockMount");
else if (PG === "macro") renderSectorPage(MACRO_GROUPS, "#macroMount");
else if (PG === "for-you") {
  const form = $("#wlForm");
  if (form) form.addEventListener("submit", (e) => {
    e.preventDefault();
    const v = ($("#wlInput").value || "").trim().toUpperCase();
    if (!v) return;
    const cur = wlGet();
    if (!cur.includes(v)) { wlSet([v, ...cur]); }
    $("#wlInput").value = "";
    renderWatchlist();
  });
  renderWatchlist();
}
else if (PG === "briefings") renderBriefings();
