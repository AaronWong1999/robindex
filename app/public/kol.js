"use strict";

const KOLS = {
  qinbafrank: {
    id: "qinbafrank",
    name: "Qinbafrank",
    title: "Qinbafrank 研究室",
    handle: "qinbafrank",
    avatar: "https://unavatar.io/x/qinbafrank",
    subtitle: "Qinbafrank 资料包、专属 AI 研究助手，以及 Robindex Ultra 的全部投研服务",
    tagline: "AI 大趋势 / 宏观传导 / 公司推荐档案",
    library: [
      ["highlights", "过往精华", "7 个主题", "把公开内容按大主线和关键判断归档。", "accent-amber"],
      ["sectors", "板块观点", "5 个板块", "AI、半导体、加密金融、能源电力和流动性。", "accent-sky"],
      ["stocks", "个股档案", "82 支股票", "按公司与产业链位置整理的观点入口。", "accent-green"],
      ["latest", "全量库", "13,750 条原文", "完整历史推文，每日增量更新。", ""],
    ],
    asks: [
      "AI 基建板块现在核心机会是什么？",
      "如何看待近期的市场波动？",
      "CRCL、COIN、HOOD 这条产业链里，哪只更符合他的框架？",
      "我手里的 MU、AVGO、AMD，哪个更值得关注？",
      "SpaceX 上市对后续市场有什么影响？",
    ],
    fit: ["想学习完整框架和历史判断的人", "想把公司放回宏观与产业主线复盘的人", "需要用资料库追踪旧观点验证的人"],
    notFit: ["希望得到确定买卖点的人", "不愿意自行核验实时数据和风险的人", "把 AI 回复当作本人发言的人"],
  },
  aleabitoreddit: {
    id: "aleabitoreddit",
    name: "Serenity",
    title: "Serenity 研究室",
    handle: "aleabitoreddit",
    avatar: "https://pbs.twimg.com/profile_images/1996176688414367744/LXfA_lIx_400x400.jpg",
    subtitle: "Serenity 供应链资料包、专属 AI 研究助手，以及 Robindex Ultra 的全部投研服务",
    tagline: "AI 半导体供应链 / 光通信 CPO / small-cap 高确信清单",
    library: [
      ["sectors", "供应链地图", "AI 硬件链", "沿 capex、光通信、CPO 和衬底材料拆链。", "accent-sky"],
      ["stocks", "个股档案", "重点公司", "按 chokepoint、客户、产能和验证信号组织。", "accent-green"],
      ["latest", "内容库", "5,930 条原文", "GitHub 历史库 + 每日增量推文。", ""],
      ["research", "研究助手", "专属智能体", "用原文证据和实时行情追问。", "accent-amber"],
    ],
    asks: [
      "AI 硬件瓶颈现在从哪里迁移到哪里？",
      "CPO 和光通信链条最该盯哪些验证指标？",
      "你怎么看 AVGO、MRVL、COHR 的位置差异？",
      "哪些小盘供应链公司更像绕不过去的 chokepoint？",
    ],
    fit: ["想拆 AI 硬件瓶颈如何轮动的人", "想理解冷门供应链和小盘标的的人", "需要用原文证据校准 thesis 的人"],
    notFit: ["只想看宏观大盘择时的人", "希望 AI 直接给仓位指令的人", "不愿区分公开观点和本人实时观点的人"],
  },
};

const SECTION_LABELS = {
  highlights: "精华",
  sectors: "板块观点",
  stocks: "个股档案",
  latest: "全量库",
};

let app = document.querySelector("#kolApp");
if (!app && location.pathname.startsWith("/kol/")) {
  document.title = "KOL 研究室 — Robindex";
  document.body.innerHTML = `
    <header class="nav"></header>
    <main id="kolApp"></main>
    <footer class="foot">
      <div class="wrap">
        <div class="row">
          <a class="brand" href="/"><span class="mark">R</span><span class="bt"><b>Robindex</b></span></a>
          <a href="/morning">早报</a><a href="/today">晚报</a><a href="/for-you">专属</a><a href="/stock">个股</a><a href="/macro">宏观</a><a href="/pricing">联系</a>
          <span class="sp">AI 驱动的市场洞察</span>
        </div>
        <p class="disc">本平台所有内容（包括 AI 生成的分析与报告）仅供参考，不构成任何投资建议。研究助手基于公开内容整理，不代表博主本人观点。</p>
      </div>
    </footer>`;
  app = document.querySelector("#kolApp");
  if (window.RobindexNav) window.RobindexNav.mount();
}
if (!app) {
  app = null;
}
const path = location.pathname.split("/").filter(Boolean);
const personaId = KOLS[path[1]] ? path[1] : "qinbafrank";
const section = path[2] || "";
const kol = KOLS[personaId];
if (app) document.title = `${kol.title} — Robindex`;

function nav() {
  const items = [
    ["主页", `/kol/${kol.id}`, ""],
    ["精华", `/kol/${kol.id}/highlights`, "7 个主题"],
    ["板块观点", `/kol/${kol.id}/sectors`, "5 个板块"],
    ["个股", `/kol/${kol.id}/stocks`, "82 票"],
    ["全量库", `/kol/${kol.id}/latest`, `${kol.id === "qinbafrank" ? "13,750" : "5,930"} 条`],
    ["追问", `/research?agent=kol&persona=${kol.id}`, "专属 AI"],
  ];
  return `<aside class="kol-side">${items.map(([label, href, note]) => `<a class="${href === location.pathname || (!section && label === "主页") ? "active" : ""}" href="${href}"><span>${label}</span><small>${note}</small></a>`).join("")}</aside>`;
}

function home() {
  const library = kol.library.map(([slug, title, meta, desc, accent]) => {
    const href = slug === "research" ? `/research?agent=kol&persona=${kol.id}` : `/kol/${kol.id}/${slug}`;
    return `<a class="library-card ${accent || ''}" href="${href}"><span>${meta}</span><h3>${title}</h3><p>${desc}</p></a>`;
  }).join("");
  const asks = kol.asks.map((q, i) => `<a class="ask-row" href="/research?agent=kol&persona=${kol.id}&q=${encodeURIComponent(q)}"><b>${String(i + 1).padStart(2, "0")}</b><span>${q}</span></a>`).join("");
  return `
    <section class="kol-hero">
      <div class="wrap kol-grid">
        ${nav()}
        <div class="kol-main">
          <a class="backlink" href="/">所有博主研究室</a>
          <div class="kol-hero-head">
            <img src="${kol.avatar}" alt="${kol.name} 头像" />
            <div><p class="eyebrow">@${kol.handle}</p><h1 class="h1">${kol.title}</h1><p class="lead">${kol.subtitle}</p></div>
          </div>
          <div class="hero-actions"><a class="btn" href="/pricing">立即解锁 Ultra</a><a class="btn ghost" href="#library-nav">查看资料库入口</a></div>
          <div class="hero-badges"><span>✓ 基于公开内容整理</span><span>✓ 研究助手不代表本人观点</span><span>✓ 非投资建议</span></div>
          <section class="kol-block" id="library-nav"><p class="eyebrow">资料库入口</p><div class="library-grid">${library}</div></section>
          ${kol.id === "aleabitoreddit" ? `
          <section class="kol-block"><p class="eyebrow">Serenity 的供应链漏斗</p>
            <div class="chain-flow">
              <span class="chain-pill">Capex 周期</span><span class="chain-arrow">→</span>
              <span class="chain-pill">光通信 CPO</span><span class="chain-arrow">→</span>
              <span class="chain-pill">衬底材料</span><span class="chain-arrow">→</span>
              <span class="chain-pill">封装测试</span><span class="chain-arrow">→</span>
              <span class="chain-pill">Small-cap Chokepoint</span>
            </div>
            <p style="margin-top:12px;color:var(--text-2);font-size:14px">沿 AI 硬件供应链拆解，每个节点对应个股档案和原文证据。</p>
          </section>` : ''}
          <section class="kol-block"><p class="eyebrow">${kol.name} 的公开学习资料和投研框架</p><div class="feature-grid">
            <div class="green-accent"><h3>${kol.name} 观点库</h3><p>把历史公开内容按主题、公司、板块和时间线整理，追问时只引用命中的原文。</p></div>
            <div class="amber-accent"><h3>每日更新</h3><p>后台按增量抓取公开 X 内容，写入 Cloudflare D1，并保留完整原文。</p></div>
            <div class="sky-accent"><h3>AI 个股投研</h3><p>识别股票/ETF 后获取实时行情和 K 线，再结合对应 KOL 的框架回答。</p></div>
            <div><h3>专属 AI 研究助手</h3><p>每个会话固定绑定一个 KOL，persona pack 每轮注入，避免串台。</p></div>
          </div></section>
          <section class="boundary-section">
            <div class="split compact">
              <div><p class="eyebrow">你会得到什么</p>${kol.fit.map((x) => `<div class="check"><span class="ic">✓</span>${x}</div>`).join("")}</div>
              <div><p class="eyebrow">不适合谁</p>${kol.notFit.map((x) => `<div class="check muted-check"><span class="ic">×</span>${x}</div>`).join("")}</div>
            </div>
          </section>
          <section class="kol-block"><p class="eyebrow">直接问真实问题</p><div class="ask-list">${asks}</div></section>
        </div>
        <aside class="pricing-card">
          <h3>${kol.title}</h3><p>包含于 Robindex Ultra</p><div class="price">$20 <span>/月</span></div>
          <div class="check"><span class="ic">✓</span>${kol.name} 全量观点库和资料包</div>
          <div class="check"><span class="ic">✓</span>${kol.name} 专属 AI 研究助手</div>
          <div class="check"><span class="ic">✓</span>原文证据、行情图和个股投研</div>
          <div class="check"><span class="ic">✓</span>每日简报与后续 KOL 扩展</div>
          <a class="btn" href="/pricing">解锁 Ultra</a>
        </aside>
      </div>
    </section>`;
}

function gate() {
  const label = SECTION_LABELS[section] || "资料库";
  return `
    <section class="kol-hero">
      <div class="wrap kol-grid">
        ${nav()}
        <div class="kol-main">
          <a class="backlink" href="/kol/${kol.id}">${kol.title}</a>
          <div class="gate">
            <p class="eyebrow">ROBINDEX ULTRA</p>
            <h1 class="h1">解锁 ${kol.name} 研究室 ${label}</h1>
            <p class="lead">完整资料库、每日更新、个股投研、原文证据、AI 追问和 Robindex Ultra 全部能力。</p>
            <div class="hero-actions"><a class="btn" href="/pricing">解锁 Ultra</a><a class="btn ghost" href="/research?agent=kol&persona=${kol.id}">先去追问</a></div>
            <div class="gate-note"><h3>一次解锁所有内容</h3><p>包含：推特 KOL 日报 · AI 投研引擎 · AI 深度个股分析 · 原文证据库 · 后续 KOL 扩展。</p></div>
          </div>
        </div>
      </div>
    </section>`;
}

// 全量库 / 内容库 — render the real ingested corpus (the tweets we paid to scrape).
function corpusShell() {
  const title = kol.id === "aleabitoreddit" ? "内容库" : "全量库";
  return `
    <section class="kol-hero">
      <div class="wrap kol-grid">
        ${nav()}
        <div class="kol-main">
          <a class="backlink" href="/kol/${kol.id}">${kol.title}</a>
          <p class="eyebrow">${kol.name} · ${title}</p>
          <h1 class="h1">公开原文库</h1>
          <p class="lead" id="corpusMeta">后台每日增量抓取 ${kol.name} 的公开 X 内容，完整保留原文、时间与互动数据。</p>
          <div class="tweet-list" id="corpusList" style="margin-top:24px"><span class="loading-dot">加载原文…</span></div>
          <button class="load-more" id="corpusMore" hidden>加载更多</button>
        </div>
      </div>
    </section>`;
}

function tweetHtml(t, handle) {
  const date = (t.created_at_iso || "").slice(0, 10);
  const url = `https://x.com/${handle}/status/${t.id}`;
  const esc = (s) => (s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const metrics = [["♥", t.likes], ["↻", t.retweets], ["💬", t.replies], ["👁", t.views]]
    .filter(([, v]) => v).map(([ic, v]) => `<span>${ic} ${Number(v).toLocaleString()}</span>`).join("");
  return `<div class="tweet">
    <div class="thead"><span class="thandle">@${handle}</span><span>·</span><span>${date}</span></div>
    <div class="ttext">${esc(t.text)}</div>
    <div class="tmetrics">${metrics}<a class="tlink" href="${url}" target="_blank" rel="noopener" style="margin-left:auto">查看原文 ↗</a></div>
  </div>`;
}

async function loadCorpus() {
  const list = document.querySelector("#corpusList");
  const more = document.querySelector("#corpusMore");
  const meta = document.querySelector("#corpusMeta");
  let offset = 0; const LIMIT = 20; let handle = kol.handle; let total = 0;
  async function page() {
    try {
      const r = await fetch(`/api/tweets?kol_id=${kol.id}&limit=${LIMIT}&offset=${offset}`);
      const j = await r.json();
      handle = j.handle || handle; total = j.total || 0;
      if (offset === 0) {
        list.innerHTML = "";
        meta.textContent = `已入库 ${total.toLocaleString()} 条公开原文，按时间倒序展示。后台每日增量抓取，完整保留原文。`;
      }
      (j.tweets || []).forEach((t) => list.insertAdjacentHTML("beforeend", tweetHtml(t, handle)));
      offset += (j.tweets || []).length;
      if (!list.children.length) list.innerHTML = `<p class="empty-note">原文库正在准备中。</p>`;
      more.hidden = offset >= total || !(j.tweets || []).length;
    } catch (e) {
      if (offset === 0) list.innerHTML = `<p class="empty-note">原文库暂不可用。</p>`;
    }
  }
  more.addEventListener("click", page);
  page();
}

if (app) {
  if (section === "latest") { app.innerHTML = corpusShell(); loadCorpus(); }
  else app.innerHTML = section ? gate() : home();
}
