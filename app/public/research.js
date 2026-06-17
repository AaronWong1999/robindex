"use strict";

// Static fallback metadata (used before /api/kols resolves, and for not-yet-loaded KOLs).
const PERSONA_META = {
  aleabitoreddit: {
    id: "aleabitoreddit",
    display_name: "Serenity",
    handle: "aleabitoreddit",
    avatar_url: "https://pbs.twimg.com/profile_images/1996176688414367744/LXfA_lIx_400x400.jpg",
    desc: "Serenity 的框架偏向 AI 半导体供应链、光子/CPO 和底层瓶颈迁移。适合从 hyperscaler capex 往下拆，寻找少数公司绕不过去的 chokepoint。",
  },
  qinbafrank: {
    id: "qinbafrank",
    display_name: "Qinbafrank",
    handle: "qinbafrank",
    avatar_url: "https://unavatar.io/x/qinbafrank",
    desc: "Qinbafrank 的框架偏向 AI 大趋势、宏观传导与行情规律。适合把公司放回宏观与产业主线里复盘，按权重排序判断链。",
  },
  "qinbafrank-tag": {
    id: "qinbafrank-tag",
    display_name: "Qinbafrank（打标签对照）",
    handle: "qinbafrank",
    avatar_url: "https://unavatar.io/x/qinbafrank",
    desc: "A/B 对照组：与 Qinbafrank 同一语料，但检索走「打标签」模式，用于对比纯 query-side 的召回差异。",
  },
};
const ORDER = ["aleabitoreddit", "qinbafrank", "qinbafrank-tag"];

const state = { persona: "aleabitoreddit", model: "flash", convId: null, busy: false, kols: {}, lastCitations: [], allCitations: [], toolCalls: [], lastQuestion: "", promptMode: null };

const $ = (s) => document.querySelector(s);
const el = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

function meta(id) { return state.kols[id] || PERSONA_META[id] || PERSONA_META.aleabitoreddit; }

// ---------- tiny markdown renderer (headings, bold, lists, hr, [Tn] cites) ----------
function inline(s) {
  let h = esc(s);
  h = h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  h = h.replace(/`([^`]+)`/g, "<code>$1</code>");
  h = h.replace(/\[(T\d+)\]/g, '<button class="cite" data-ref="$1">$1</button>');
  h = h.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">链接</a>');
  return h;
}
// Strip tool-call DSL artifacts from text (safety net)
function stripDSL(text) {
  return String(text || "")
    .replace(/<\s*[｜|]?\s*DSML\s*[｜|]?\s*tool_calls\s*>\s*[\s\S]*?<\s*\/\s*[｜|]?\s*DSML\s*[｜|]?\s*tool_calls\s*>/gi, "")
    .replace(/<\s*[｜|]?\s*DSML\s*[｜|]?\s*\/?\s*tool_calls?\s*>\s*/gi, "")
    .replace(/<\s*\/?\s*(?:invoke|function|parameter|tool_calls?)\b[^>]*>\s*/gi, "")
    .replace(/^\s*[<＜]\s*[｜|]?\s*DSML\s*[｜|]?\s*(?:tool_calls?|invoke|parameter|function).*$/gim, "")
    .replace(/^\s*[<＜]\s*\/\s*[｜|]?\s*DSML\s*[｜|]?.*$/gim, "")
    .replace(/^\s*[<＜]\s*[｜|]?\s*(?:invoke|parameter|function|tool_calls?).*$/gim, "");
}
function renderMarkdown(text) {
  text = stripDSL(text);
  const lines = text.split("\n");
  let html = "", para = [], list = null;
  const flushPara = () => { if (para.length) { html += `<p>${para.join("<br/>")}</p>`; para = []; } };
  const flushList = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    let m;
    if (/^\s*$/.test(line)) { flushPara(); flushList(); continue; }
    if (/^(---+|\*\*\*+)$/.test(line.trim())) { flushPara(); flushList(); html += "<hr/>"; continue; }
    if ((m = line.match(/^(#{2,4})\s+(.*)/))) {
      flushPara(); flushList();
      const lvl = Math.min(m[1].length, 4);
      html += `<h${lvl === 2 ? 2 : 3}>${inline(m[2])}</h${lvl === 2 ? 2 : 3}>`;
      continue;
    }
    if ((m = line.match(/^\s*[-*]\s+(.*)/))) {
      flushPara(); if (list !== "ul") { flushList(); html += "<ul>"; list = "ul"; }
      html += `<li>${inline(m[1])}</li>`; continue;
    }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) {
      flushPara(); if (list !== "ol") { flushList(); html += "<ol>"; list = "ol"; }
      html += `<li>${inline(m[1])}</li>`; continue;
    }
    flushList(); para.push(inline(line));
  }
  flushPara(); flushList();
  return html;
}

const PHASES = [
  { key: "plan", label: "理解问题" },
  { key: "market", label: "检索原文 / 行情" },
  { key: "tools", label: "深度数据" },
  { key: "thinking", label: "生成中" },
];
function phaseIndex(phase) {
  if (phase === "rag") return 1;
  const i = PHASES.findIndex((p) => p.key === phase);
  return i < 0 ? 0 : i;
}
function renderPhaseStepper(activeKey = "plan", text = "正在理解问题…") {
  const idx = phaseIndex(activeKey);
  return `<div class="stream-status" data-phase="${esc(activeKey)}">
    <div class="phase-steps">
      ${PHASES.map((p, i) => `<span class="phase-step ${i < idx ? "done" : i === idx ? "active" : ""}">${p.label}</span>`).join("")}
    </div>
    <div class="stream-line"><span class="stream-dot"></span><span class="stream-text">${esc(text)}</span></div>
  </div>`;
}
function updatePhaseStepper(md, phase, text) {
  const statusEl = md.querySelector(".stream-status");
  if (!statusEl) return;
  statusEl.outerHTML = renderPhaseStepper(phase || "plan", text || "处理中…");
}

// ---------- conversation persistence (local) ----------
const LS_KEY = "robindex_convs";
function loadConvs() { try { return JSON.parse(localStorage.getItem(LS_KEY) || "[]"); } catch { return []; } }
function saveConvs(c) { localStorage.setItem(LS_KEY, JSON.stringify(c.slice(0, 50))); }
function upsertConv(conv) {
  const all = loadConvs().filter((c) => c.id !== conv.id);
  all.unshift(conv);
  saveConvs(all);
  renderConvList();
}
function renderConvList() {
  const list = $("#convList");
  list.innerHTML = "";
  for (const c of loadConvs()) {
    const item = el("div", "conv" + (c.id === state.convId ? " active" : ""));
    const text = el("div", "conv-main");
    text.appendChild(el("div", "t", `@${c.persona} · ${c.title}`));
    text.appendChild(el("div", "d", timeAgo(c.ts)));
    item.appendChild(text);
    const actions = el("div", "conv-actions");
    const rename = el("button", null, "✎"); rename.title = "重命名";
    rename.onclick = (e) => { e.stopPropagation(); renameConv(c.id); };
    const del = el("button", null, "×"); del.title = "删除";
    del.onclick = (e) => { e.stopPropagation(); deleteConv(c.id); };
    actions.appendChild(rename); actions.appendChild(del); item.appendChild(actions);
    item.onclick = () => loadConv(c.id);
    list.appendChild(item);
  }
}
function renameConv(id) {
  const all = loadConvs();
  const c = all.find((x) => x.id === id);
  if (!c) return;
  const title = prompt("重命名对话", c.title || "");
  if (!title) return;
  c.title = title.slice(0, 40);
  saveConvs(all);
  renderConvList();
}
function deleteConv(id) {
  if (!confirm("删除这条本地对话？")) return;
  saveConvs(loadConvs().filter((x) => x.id !== id));
  if (state.convId === id) setPersona(state.persona);
  else renderConvList();
}
function timeAgo(ts) {
  const d = (Date.now() - ts) / 86400000;
  if (d < 1) return "今天";
  if (d < 2) return "昨天";
  if (d < 30) return `${Math.floor(d)}天前`;
  return new Date(ts).toLocaleDateString("zh-CN", { month: "long", day: "numeric" });
}
function loadConv(id) {
  const c = loadConvs().find((x) => x.id === id);
  if (!c) return;
  if (c.persona !== state.persona) setPersona(c.persona);
  state.convId = c.id;
  $("#thread").innerHTML = "";
  $("#thread").appendChild(threadInner());
  for (const m of c.messages) addMessage(m.role, m.content, m.citations || []);
  renderConvList();
  renderSources(c.messages.flatMap((m) => m.citations || []), { fallback: true });
}

// ---------- daily limit (disabled for testing) ----------
function remainingKey() { return "robindex_quota_" + new Date().toISOString().slice(0, 10); }
function getRemaining() { return 999; }
function setRemaining(n) { $("#remaining").textContent = `测试期间无限使用`; }

// ---------- persona ----------
function setPersona(id) {
  state.persona = id;
  state.convId = null;
  const m = meta(id);
  const u = new URL(location.href);
  u.searchParams.set("agent", "kol"); u.searchParams.set("persona", id);
  history.replaceState({}, "", u);
  // empty state
  $("#thread").innerHTML = "";
  const empty = buildEmpty(m);
  $("#thread").appendChild(empty);
  $("#agentTag").textContent = `● @${m.handle} 博主 Agent`;
  $("#input").placeholder = `按 @${m.display_name} 方法论提问…`;
  state.promptMode = null;
  closePanel();
  renderConvList();
}
function buildEmpty(m) {
  const wrap = el("div", "empty");
  wrap.id = "empty";
  const ava = el("img", "ava"); ava.src = m.avatar_url; ava.alt = m.display_name; ava.onerror = () => (ava.style.visibility = "hidden");
  wrap.appendChild(ava);
  const pnameEl = el("div", "pname", "@" + m.display_name); pnameEl.classList.add("font-editorial"); wrap.appendChild(pnameEl);
  wrap.appendChild(el("p", "pdesc", m.desc || ""));
  // switcher
  const sw = el("div", "switcher");
  const pill = el("button", "switch-pill");
  const other = ORDER.find((x) => x !== m.id) || m.id;
  const om = meta(other);
  const oimg = el("img"); oimg.src = om.avatar_url; oimg.alt = "";
  pill.appendChild(oimg); pill.appendChild(el("span", null, "@" + om.handle)); pill.append(" ▾");
  pill.onclick = () => setPersona(other);
  sw.appendChild(pill); sw.appendChild(el("span", "switch-note", "用这个切换分析框架"));
  wrap.appendChild(sw);
  const pc = el("div", "prompt-cards");
  const cards = [
    { mode: "stock", t: "他怎么看这只股票", meta: "输入代码 ▾", cls: "emerald", ic: "⚖" },
    { mode: "market", t: "他怎么看最近的市场", meta: "4 问题 ▾", cls: "amber", ic: "◴" },
    { mode: "sector", t: "他怎么看这个行业", meta: "选主题 ▾", cls: "sky", ic: "⛓" },
    { mode: "verify", t: "验证他的观点", meta: "快速问 ▾", cls: "rose", ic: "▤" },
  ];
  for (const c of cards) {
    const b = el("button", "pcard " + c.cls);
    b.dataset.mode = c.mode;
    b.appendChild(el("span", "pic", c.ic));
    b.appendChild(el("span", "pt", c.t));
    b.appendChild(el("span", "pmeta " + c.cls, c.meta));
    b.onclick = () => openPromptMode(c.mode);
    pc.appendChild(b);
  }
  wrap.appendChild(pc);
  const detail = el("div", "prompt-detail"); detail.id = "promptDetail"; detail.hidden = true; wrap.appendChild(detail);
  return wrap;
}

function openPromptMode(mode) {
  state.promptMode = mode;
  const detail = $("#promptDetail");
  if (!detail) return;
  const m = meta(state.persona);
  const cfg = promptConfig(mode, m);
  detail.hidden = false;
  detail.innerHTML = "";
  const head = el("div", "prompt-detail-head");
  head.appendChild(el("b", null, cfg.title));
  const close = el("button", null, "×"); close.onclick = () => { detail.hidden = true; state.promptMode = null; };
  head.appendChild(close);
  detail.appendChild(head);
  const form = el("form", "prompt-inline");
  const input = el("input"); input.placeholder = cfg.placeholder; input.value = cfg.value || "";
  const submit = el("button", null, "开始"); submit.type = "submit";
  form.appendChild(input); form.appendChild(submit);
  form.onsubmit = (e) => {
    e.preventDefault();
    const v = input.value.trim();
    if (v) send(cfg.make(v));
  };
  detail.appendChild(form);
  const chips = el("div", "prompt-chips");
  for (const item of cfg.items) {
    const chip = el("button", null, item.label);
    chip.type = "button";
    chip.title = item.hint || item.label;
    chip.onclick = () => send(cfg.make(item.value || item.label));
    chips.appendChild(chip);
  }
  detail.appendChild(chips);
}

function promptConfig(mode, m) {
  const who = m.display_name;
  if (mode === "stock") {
    return {
      title: "输入股票代码或公司名",
      placeholder: "如 NVDA / 英伟达 / SOXL",
      items: ["NVDA", "GOOGL", "MSFT", "AAPL", "META"].map((x) => ({ label: x })),
      make: (v) => `${who} 你怎么看 ${v}？请先识别它是什么资产，结合最近价格走势，再用你的框架分析机会和风险。`,
    };
  }
  if (mode === "sector") {
    return {
      title: "选择行业、产业链或主题",
      placeholder: "或者输入行业 / 产业链 / 主题...",
      items: [
        { label: "AI 算力", value: "AI 算力、GPU、电力、数据中心" },
        { label: "半导体周期", value: "半导体周期、先进制程、设备" },
        { label: "加密金融", value: "BTC、交易所、支付、稳定币" },
        { label: "能源与电力", value: "AI 负载、核电、电网" },
      ],
      make: (v) => `${who} 你怎么看 ${v} 这条行业主线？请结合你过去的原文逻辑、关键验证指标和当前市场位置。`,
    };
  }
  if (mode === "market") {
    return {
      title: "选择一个市场问题",
      placeholder: "或者输入 CPI / 降息 / VIX / 财报季...",
      items: [
        { label: "大盘风险", value: "大盘风险、调整级别、防守信号" },
        { label: "流动性", value: "流动性、利率、美债、风险资产" },
        { label: "行情主线", value: "AI、财报、宏观权重" },
        { label: "财报季", value: "业绩验证、估值重定价" },
      ],
      make: (v) => `${who} 你怎么看最近的市场？重点分析 ${v}，请给出主矛盾、打脸指标和风险边界。`,
    };
  }
  return {
    title: "验证一个观点",
    placeholder: "或者输入一个观点 / 主题...",
    items: [
      { label: "最新观点", value: "最近在强调什么" },
      { label: "有没有改口", value: "前后观点是否变化" },
      { label: "数据支持吗", value: "价格、财报、宏观是否支持" },
      { label: "风险提醒", value: "可能低估了什么风险" },
    ],
    make: (v) => `请用 ${who} 的公开原文验证：${v}。如果引用观点，请标出来自哪些发言，并说明哪些地方只是推断。`,
  };
}

function threadInner() { const d = el("div", "thread-inner"); d.id = "ti"; return d; }
function ensureThread() {
  let ti = document.querySelector("#ti");
  if (!ti) { $("#thread").innerHTML = ""; ti = threadInner(); $("#thread").appendChild(ti); }
  return ti;
}
function scrollDown() { const t = $("#thread"); t.scrollTop = t.scrollHeight; }

function addMessage(role, content, citations) {
  const ti = ensureThread();
  const m = meta(state.persona);
  const wrap = el("div", "msg " + role);
  if (role === "user") {
    const b = el("div", "bubble", content); wrap.appendChild(b);
  } else {
    const who = el("div", "who");
    const img = el("img"); img.src = m.avatar_url; img.alt = ""; who.appendChild(img);
    who.appendChild(el("span", null, m.display_name));
    wrap.appendChild(who);
    const md = el("div", "md"); md.innerHTML = renderMarkdown(content); wrap.appendChild(md);
    wireCites(md);
  }
  ti.appendChild(wrap);
  scrollDown();
  return wrap;
}
function wireCites(scope) {
  scope.querySelectorAll(".cite").forEach((b) => {
    b.onclick = () => {
      openPanel();
      const ref = b.dataset.ref;
      const card = document.querySelector(`.src[data-ref="${ref}"]`);
      if (card) {
        card.classList.add("hit");
        card.scrollIntoView({ behavior: "smooth", block: "center" });
        setTimeout(() => card.classList.remove("hit"), 900);
      }
    };
  });
}

// ---------- source panel ----------
function openPanel() { $("#app").classList.add("with-panel", "show-panel"); $("#srcpanel").hidden = false; }
function closePanel() { $("#app").classList.remove("with-panel", "show-panel"); $("#srcpanel").hidden = true; }
function renderSources(citations, opts = {}) {
  const m = meta(state.persona);
  const list = $("#srcList"); list.innerHTML = "";
  if (!citations.length) { closePanel(); return; }
  $("#srcCount").textContent = opts.fallback ? `${citations.length} 条相关原文候选` : `${citations.length} 条博主历史推文`;
  if (opts.fallback) list.appendChild(el("div", "src-hint", "模型这次没有显式引用编号，先展示检索到的高相关原文。"));
  for (const c of citations) {
    const card = el("div", "src"); card.dataset.ref = c.ref;
    const sh = el("div", "sh");
    const img = el("img"); img.src = m.avatar_url; img.alt = ""; sh.appendChild(img);
    const nm = el("div");
    nm.appendChild(el("b", null, m.display_name));
    nm.appendChild(el("div", "sd", `@${m.handle} · ${c.date}`));
    sh.appendChild(nm); card.appendChild(sh);
    const tx = el("div", "stext", c.snippet); card.appendChild(tx);
    if (c.quoted && c.quoted.text) {
      const qc = el("div", "squote");
      qc.appendChild(el("div", "sqh", `引用 @${c.quoted.handle || ""}${c.quoted.date ? " · " + c.quoted.date : ""}`));
      qc.appendChild(el("div", "sqtext", c.quoted.text));
      if (c.quoted.url) {
        const qa = el("a", "sqlink", "查看被引用原文"); qa.href = c.quoted.url; qa.target = "_blank"; qa.rel = "noopener";
        qc.appendChild(qa);
      }
      card.appendChild(qc);
    }
    const links = el("div", "slinks");
    const a = el("a", null, "𝕏 在 X 查看原文"); a.href = c.url; a.target = "_blank"; a.rel = "noopener";
    const exp = el("button", null, "▾ 展开全文"); exp.type = "button"; exp.onclick = () => { tx.classList.toggle("expanded"); exp.textContent = tx.classList.contains("expanded") ? "▴ 收起" : "▾ 展开全文"; };
    links.appendChild(a); links.appendChild(exp); card.appendChild(links);
    list.appendChild(card);
  }
  openPanel();
}

// ---------- send / stream ----------
async function send(text) {
  if (state.busy || !text.trim()) return;
  if (!state.kols[state.persona]) {
    const empty = document.querySelector("#empty"); if (empty) empty.remove();
    ensureThread();
    addMessage("user", text, []);
    addMessage("assistant", `**${meta(state.persona).display_name} 研究室正在准备中。**\n\n该博主的资料包（推文、原文证据与方法论）仍在抓取与蒸馏中，很快上线。你可以先切换到 **@aleabitoreddit（Serenity）** 研究室体验完整功能。`, []);
    return;
  }
  if (getRemaining() <= 0) { addMessage("assistant", "今日免费追问次数已用完。**解锁 Ultra** 后可无限使用。", []); return; }
  state.busy = true; $("#send").disabled = true;
  const empty = document.querySelector("#empty"); if (empty) empty.remove();
  ensureThread();
  addMessage("user", text, []);

  const wrap = addMessage("assistant", "", []);
  const md = wrap.querySelector(".md");
  md.innerHTML = renderPhaseStepper("plan", "正在准备…");

  let full = "", citeMap = {}, meta_ = null;
  state.toolCalls = [];
  state.allCitations = [];
  state.lastQuestion = text;
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kol_id: state.persona, model: state.model, conversation_id: state.convId, message: text }),
    });
    const cid = res.headers.get("X-Conversation-Id"); if (cid) state.convId = cid;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const events = buf.split("\n\n"); buf = events.pop() || "";
      for (const ev of events) {
        let type = "message", data = "";
        for (const ln of ev.split("\n")) {
          if (ln.startsWith("event:")) type = ln.slice(6).trim();
          else if (ln.startsWith("data:")) data += ln.slice(5).trim();
        }
        if (!data) continue;
        if (type === "progress") {
          const p = JSON.parse(data);
          updatePhaseStepper(md, p.phase, p.text);
        }
        else if (type === "meta") { meta_ = JSON.parse(data); for (const c of meta_.citations || []) citeMap[c.ref] = c; state.allCitations = meta_.citations || []; }
        else if (type === "tool_call") { const tc = JSON.parse(data); state.toolCalls.push(tc); updateWorkspaceTools(); }
        else if (type === "delta") {
          full = stripDSL(full + JSON.parse(data));
          md.innerHTML = renderMarkdown(full);
          scrollDown();
        }
        else if (type === "error") { md.innerHTML = '<p>⚠️ 服务暂时不可用，请稍后再试。</p>'; }
      }
    }
    full = stripDSL(full).trim();
    if (!full) md.innerHTML = "<p>⚠️ 未收到回复，请重试。</p>";
    else md.innerHTML = renderMarkdown(full);
    wireCites(md);

    // Only show source tweets the answer actually cited (matches reference behavior).
    const usedRefs = new Set((full.match(/\[(T\d+)\]/g) || []).map((s) => s.slice(1, -1)));
    const allSourceCandidates = meta_?.citations || [];
    const used = allSourceCandidates.filter((c) => usedRefs.has(c.ref));
    const panelCitations = used.length ? used : allSourceCandidates.slice(0, 8);
    state.lastCitations = panelCitations;
    renderSources(panelCitations, { fallback: !used.length && panelCitations.length > 0 });
    if (meta_?.chart) appendChart(wrap, meta_.chart);

    // actions row + persist
    addActions(wrap);
    addSuggestions(wrap, text, full);
    populateWorkspace(panelCitations);
    setRemaining(getRemaining() - 1);
    persist(text, full, panelCitations);
  } catch (e) {
    md.innerHTML = `<p>⚠️ 网络错误：${esc(e.message)}</p>`;
  } finally {
    state.busy = false; $("#send").disabled = false; scrollDown();
  }
}
function addActions(wrap) {
  const a = el("div", "msg-actions");
  const copy = el("button", null, "⧉ 复制"); copy.onclick = () => navigator.clipboard?.writeText(wrap.querySelector(".md").innerText);
  a.appendChild(copy); a.appendChild(el("span", null, "这条有帮助吗?"));
  const up = el("button", null, "👍"); const down = el("button", null, "👎");
  a.appendChild(up); a.appendChild(down);
  wrap.appendChild(a);
}
// ---- Follow-up suggestions ----
function addSuggestions(wrap, question, answer) {
  const box = el("div", "suggest-box");
  box.innerHTML = '<div class="suggest-loading"><span class="stream-dot"></span> 正在生成追问建议…</div>';
  wrap.appendChild(box);
  fetch("/api/suggest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kol_id: state.persona, question, answer }),
  })
    .then((r) => r.json())
    .then((j) => {
      const sugs = j.suggestions || [];
      if (!sugs.length) { box.remove(); return; }
      box.innerHTML = "";
      const label = el("div", "suggest-label", "继续探索 ▾");
      box.appendChild(label);
      sugs.forEach((s) => {
        const btn = el("button", "suggest-btn", s);
        btn.onclick = () => {
          const ta = $("#input");
          ta.value = s;
          ta.dispatchEvent(new Event("input"));
          $("#composer").dispatchEvent(new Event("submit", { cancelable: true }));
        };
        box.appendChild(btn);
      });
    })
    .catch(() => box.remove());
}
// ---- Workspace ----
function populateWorkspace(citations) {
  const list = $("#wsSrcList"); list.innerHTML = "";
  $("#wsSrcCount").textContent = `${citations.length} 条推文`;
  citations.forEach((c) => {
    const item = el("div", "ws-item");
    item.innerHTML = `<a href="${esc(c.url)}" target="_blank" class="ws-ref">[${esc(c.ref)}]</a><span class="ws-date">${esc(c.date || "")}</span><p class="ws-snippet">${esc(c.snippet)}</p>`;
    list.appendChild(item);
  });
  // market
  const mList = $("#wsMarketList"); mList.innerHTML = "";
  const meta = state.lastCitations; // from last render
  if (state.toolCalls.length === 0) mList.innerHTML = '<div class="ws-empty">暂无工具调用数据</div>';
}

function normalizePersonaParam(raw) {
  const text = String(raw || "").trim();
  if (!text) return "aleabitoreddit";
  if (PERSONA_META[text]) return text;
  const first = text.split(/[\s?&#/]+/).find((part) => PERSONA_META[part]);
  return first || "aleabitoreddit";
}
function updateWorkspaceTools() {
  const list = $("#wsToolList"); list.innerHTML = "";
  state.toolCalls.forEach((tc, i) => {
    const item = el("div", "ws-tool-item");
    item.innerHTML = `<span class="ws-tool-idx">${i + 1}</span><span class="ws-tool-name">${esc(tc.name)}</span><span class="ws-tool-args">${esc(tc.args)}</span>`;
    list.appendChild(item);
  });
}
// ---- Tab switching ----
function initTabs() {
  const bar = $("#tabBar");
  if (!bar) return;
  bar.addEventListener("click", (e) => {
    const btn = e.target.closest(".tab");
    if (!btn) return;
    const tab = btn.dataset.tab;
    bar.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
    $("#thread").hidden = tab !== "chat";
    $("#workspace").hidden = tab !== "workspace";
    if (tab === "workspace") { updateWorkspaceTools(); }
  });
}
function persist(userText, answer, citations) {
  const all = loadConvs();
  let c = all.find((x) => x.id === state.convId);
  if (!c) c = { id: state.convId, persona: state.persona, title: userText.slice(0, 24), ts: Date.now(), messages: [] };
  c.ts = Date.now(); c.title = c.title || userText.slice(0, 24);
  c.messages.push({ role: "user", content: userText });
  c.messages.push({ role: "assistant", content: answer, citations });
  upsertConv(c);
}

async function appendChart(wrap, chart) {
  const card = el("div", "chartcard");
  const head = el("div", "chart-head");
  head.appendChild(el("span", "chart-sym", chart.symbol + " · " + chart.market.toUpperCase()));
  const price = el("span", "chart-price"); head.appendChild(price); card.appendChild(head);
  const canvas = el("canvas", "chart-canvas"); canvas.width = 680; canvas.height = 110; card.appendChild(canvas);
  const note = el("div", "chart-note", "加载行情…"); card.appendChild(note);
  wrap.appendChild(card);
  try {
    const j = await (await fetch(`/api/kline?code=${encodeURIComponent(chart.code)}&period=day&limit=60`)).json();
    const candles = j.candles || [];
    if (!candles.length) { note.textContent = "暂无行情数据。"; return; }
    drawCandles(canvas, candles);
    const last = candles[candles.length - 1], first = candles[0];
    const chg = ((last.close - first.close) / first.close) * 100;
    price.textContent = `${last.close} (${chg >= 0 ? "+" : ""}${chg.toFixed(1)}% / ${candles.length}d)`;
    price.className = "chart-price " + (chg >= 0 ? "up" : "down");
    const hi = Math.max(...candles.map((c) => c.high)), lo = Math.min(...candles.map((c) => c.low));
    note.textContent = `${candles.length} 日K线 · 区间 ${lo}–${hi} · 最新收盘 ${last.close}（${chg >= 0 ? "上涨" : "下跌"} ${Math.abs(chg).toFixed(1)}%）`;
    canvas.setAttribute("role", "img"); canvas.setAttribute("aria-label", note.textContent);
  } catch { note.textContent = "行情暂不可用。"; }
}
function drawCandles(canvas, candles) {
  const ctx = canvas.getContext("2d"), W = canvas.width, H = canvas.height, pad = 6;
  ctx.clearRect(0, 0, W, H);
  const hi = Math.max(...candles.map((c) => c.high)), lo = Math.min(...candles.map((c) => c.low)), range = hi - lo || 1;
  const n = candles.length, cw = (W - pad * 2) / n, y = (v) => pad + (H - pad * 2) * (1 - (v - lo) / range);
  for (let i = 0; i < n; i++) {
    const c = candles[i], x = pad + cw * i + cw / 2, up = c.close >= c.open;
    ctx.strokeStyle = ctx.fillStyle = up ? "#10b981" : "#ef4444";
    ctx.beginPath(); ctx.moveTo(x, y(c.high)); ctx.lineTo(x, y(c.low)); ctx.stroke();
    const bw = Math.max(1, cw * 0.6), yo = y(c.open), yc = y(c.close);
    ctx.fillRect(x - bw / 2, Math.min(yo, yc), bw, Math.max(1, Math.abs(yc - yo)));
  }
}

// ---------- init ----------
async function init() {
  // model toggle injected into agent bar
  const bar = $(".agent-bar");
  const tog = el("span", "agent-tag"); tog.style.cursor = "pointer";
  const setTog = () => (tog.textContent = state.model === "pro" ? "◆ Pro 模型" : "◆ Flash 模型");
  setTog(); tog.onclick = () => { state.model = state.model === "pro" ? "flash" : "pro"; setTog(); };
  bar.insertBefore(tog, $(".agent-unlock"));

  try {
    const j = await (await fetch("/api/kols")).json();
    for (const k of j.kols || []) state.kols[k.id] = { ...PERSONA_META[k.id], ...k, desc: (PERSONA_META[k.id] || {}).desc };
  } catch {}

  const u = new URL(location.href);
  const p = normalizePersonaParam(u.searchParams.get("persona"));
  state.persona = p;
  if (u.searchParams.get("persona") !== p) {
    u.searchParams.set("persona", p);
    history.replaceState({}, "", u);
  }
  setPersona(state.persona);
  setRemaining(getRemaining());
  const preset = u.searchParams.get("q");
  if (preset) $("#input").value = preset;

  $("#composer").addEventListener("submit", (e) => { e.preventDefault(); const v = $("#input").value; $("#input").value = ""; autoGrow(); send(v); });
  $("#input").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#composer").requestSubmit(); } });
  $("#input").addEventListener("input", autoGrow);
  $("#newChat").onclick = () => setPersona(state.persona);
  $("#hideHistory").onclick = () => document.body.classList.toggle("history-collapsed");
  $("#srcClose").onclick = closePanel;
  initTabs();
}
function autoGrow() { const t = $("#input"); t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 160) + "px"; }
init();
