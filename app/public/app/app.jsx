/* Robindex Desk — app shell: auth gate, i18n, responsive desktop/mobile, real SSE chat flow */
const { useState: uS, useRef: uR, useEffect: uE, useCallback: uC } = React;
const { Icon, Avatar, ModelPicker, ThemeMenu, THEMES, ToolGroup, AnswerBlocks, Conviction, SourceCard, citeKey } = window.RXC;
const RX = window.RX;
const T = (k) => window.RXI.t(k);

let _id = 1;
const uid = () => "m" + _id++;
const chatId = () => "c_" + crypto.randomUUID();
const LS = {
  get: (k, d) => { try { const v = localStorage.getItem("rx." + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set: (k, v) => { try { localStorage.setItem("rx." + k, JSON.stringify(v)); } catch (e) {} },
};
function useMedia(q) {
  const [m, setM] = uS(() => window.matchMedia(q).matches);
  uE(() => { const mq = window.matchMedia(q); const h = () => setM(mq.matches); mq.addEventListener("change", h); return () => mq.removeEventListener("change", h); }, [q]);
  return m;
}
function localizeModels(lang) { return RX.MODELS.map((m) => ({ ...m, note: (m.note && typeof m.note === "object") ? (m.note[lang] || m.note.zh) : m.note })); }
function localizeOne(m, lang) { return { ...m, note: (m.note && typeof m.note === "object") ? (m.note[lang] || m.note.zh) : m.note }; }

/* ---- multimodal attachments ---- */
function useAttach() {
  const [atts, setAtts] = uS([]);
  const add = (files) => {
    const arr = Array.from(files || []).slice(0, 6);
    arr.forEach((f) => {
      if (!f) return;
      const isImg = (f.type || "").startsWith("image/");
      const url = isImg ? URL.createObjectURL(f) : null;
      setAtts((a) => [...a, { id: uid(), kind: isImg ? "image" : "file", name: f.name || (isImg ? "\u7c98\u8d34\u56fe\u7247.png" : "file"), url, ext: (f.name || "").split(".").pop().toLowerCase() }].slice(0, 6));
    });
  };
  const remove = (id) => setAtts((a) => a.filter((x) => x.id !== id));
  const clear = () => setAtts([]);
  const onPaste = (e) => {
    const items = (e.clipboardData && e.clipboardData.items) || [];
    const imgs = [];
    for (const it of items) { if (it.kind === "file" && (it.type || "").startsWith("image/")) { const f = it.getAsFile(); if (f) imgs.push(f); } }
    if (imgs.length) { e.preventDefault(); add(imgs); }
  };
  return { atts, add, remove, clear, onPaste };
}
function AttachBtn({ onAdd, compact }) {
  const inp = uR(null);
  return React.createElement("label", { className: "tool-toggle attach-tool", title: T("attach") },
    React.createElement("input", { ref: inp, type: "file", multiple: true, accept: "image/*,.pdf,.csv,.txt,.xlsx,.png,.jpg,.jpeg", style: { display: "none" }, onChange: (e) => { onAdd(e.target.files); e.target.value = ""; } }),
    React.createElement(Icon, { name: "paperclip", size: 13 }), !compact && T("attachShort"));
}
function AttachRow({ atts, onRemove }) {
  if (!atts.length) return null;
  return React.createElement("div", { className: "att-row" }, atts.map((a) =>
    React.createElement("div", { className: "att-chip" + (a.kind === "image" ? " img" : ""), key: a.id },
      a.kind === "image"
        ? React.createElement("img", { src: a.url, alt: a.name })
        : React.createElement("span", { className: "att-ic" }, React.createElement(Icon, { name: "fileText", size: 16, color: "var(--dim)" })),
      React.createElement("span", { className: "att-nm" }, a.name),
      React.createElement("button", { className: "att-x", onClick: () => onRemove(a.id) }, React.createElement(Icon, { name: "x", size: 11 })))));
}

/* ============================ Sidebar (desktop) ============================ */
function defaultChatTitle(kol, lang) {
  return kol.display_name + (lang === "en" ? " \u00b7 new chat" : " \u00b7 \u65b0\u4f1a\u8bdd");
}
function isEmptyChat(c) { return !c.messages || c.messages.length === 0; }

function Sidebar({ kols, chats, activeChat, onPick, onOpenChat, onHome, onSettings, user, loggedIn, onLogin, onWallet, onSubs, onUsage }) {
  const a = window.useBilling ? window.useBilling() : { credits: 0 };
  const B = window.RXB;
  const nSubs = B ? Object.keys(B.KOL_PLANS || {}).filter((id) => B.isSubscribed(id)).length : 0;
  const planLabel = nSubs > 0 ? T("planMember") : T("planFree");
  const recent = chats.filter((c) => !isEmptyChat(c));
  return React.createElement("aside", { className: "side" },
    React.createElement("button", { className: "brand", onClick: onHome },
      React.createElement("div", { className: "brand-mark" }, React.createElement(Icon, { name: "candlestick", size: 17, color: "var(--on-accent)" })),
      React.createElement("div", null,
        React.createElement("div", { className: "brand-name" }, "Robindex ", React.createElement("span", null, "Desk")),
        React.createElement("div", { className: "brand-tag" }, T("brandTag")))),
    React.createElement("button", { className: "new-btn", onClick: onHome },
      React.createElement(Icon, { name: "plus", size: 15 }), " ", T("newChat"), " ", React.createElement("kbd", null, "\u2318N")),
    React.createElement("div", { className: "side-sec" }, T("personas")),
    React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 3 } },
      kols.map((k) => React.createElement("button", {
        key: k.id, className: "hist" + (activeChat && activeChat.kol.id === k.id ? " on" : ""), onClick: () => onPick(k) },
        React.createElement(Avatar, { kol: k, size: 18, radius: 5, className: "hist-av" }),
        React.createElement("span", { className: "hist-t" }, k.display_name),
        B && B.isSubscribed(k.id) ? React.createElement("span", { className: "hist-sub", title: T("subActive") }, React.createElement(Icon, { name: "crown", size: 11 })) : React.createElement("span", { className: "live-dot" })))),
    React.createElement("div", { className: "side-sec", style: { marginTop: 8 } }, T("recent")),
    React.createElement("div", { className: "side-scroll" },
      recent.length === 0
        ? React.createElement("div", { className: "side-empty" }, T("noChats"))
        : recent.map((c) => React.createElement("button", {
            key: c.id, className: "hist" + (activeChat && activeChat.id === c.id ? " on" : ""), onClick: () => onOpenChat(c) },
            React.createElement(Avatar, { kol: c.kol, size: 18, radius: 5, className: "hist-av" }),
            React.createElement("span", { className: "hist-t" }, c.title)))),
    loggedIn && B ? React.createElement("div", { className: "side-bill" },
      React.createElement("button", { className: "sb-item", onClick: onWallet },
        React.createElement(Icon, { name: "wallet", size: 15, color: "var(--accent)" }),
        React.createElement("span", { className: "sb-t" }, T("wallet")),
        React.createElement("span", { className: "sb-cr" }, React.createElement(Icon, { name: "zap", size: 10 }), B.fmt(a.credits))),
      React.createElement("button", { className: "sb-item", onClick: onSubs },
        React.createElement(Icon, { name: "crown", size: 15, color: "var(--accent)" }),
        React.createElement("span", { className: "sb-t" }, T("mySubs")),
        React.createElement("span", { className: "sb-n" }, nSubs)),
      React.createElement("button", { className: "sb-item", onClick: onUsage },
        React.createElement(Icon, { name: "gauge", size: 15, color: "var(--accent)" }),
        React.createElement("span", { className: "sb-t" }, T("usageTitle")),
        React.createElement(Icon, { name: "chevronRight", size: 13, color: "var(--faint)" }))) : null,
    loggedIn
      ? React.createElement("button", { className: "side-foot", onClick: onSettings },
          React.createElement("div", { className: "av" }, (user && user.email ? user.email[0] : "U").toUpperCase()),
          React.createElement("div", { style: { minWidth: 0, textAlign: "left" } },
            React.createElement("div", { className: "nm" }, user && user.email ? user.email.split("@")[0] : "Trader"),
            React.createElement("div", { className: "sub" }, planLabel)),
          React.createElement("div", { className: "credits", title: T("credits") }, React.createElement(Icon, { name: "zap", size: 11 }), B ? B.fmt(a.credits) : "0"))
      : React.createElement("button", { className: "side-foot", onClick: onLogin },
          React.createElement("div", { className: "av av-anon" }, React.createElement(Icon, { name: "user", size: 14, color: "var(--dim)" })),
          React.createElement("div", { style: { minWidth: 0, textAlign: "left" } },
            React.createElement("div", { className: "nm" }, T("authSignIn") + " Robindex"),
            React.createElement("div", { className: "sub" }, T("authSub")))));
}

/* ============================ Home ============================ */
function Home({ kols, target, setTarget, onAsk, models, model, setModel, effort, setEffort, loggedIn, onLogin, onLocked, onSubscribe, onAddModel }) {
  const [text, setText] = uS("");
  const tk = kols.find((k) => k.id === target) || kols[0];
  if (!tk) return React.createElement("div", { className: "home" },
    React.createElement("div", { className: "home-inner", style: { textAlign: "center" } },
      React.createElement("div", { className: "thinking" },
        React.createElement("span", null, "Loading personas"),
        React.createElement("span", { className: "tdots" }, React.createElement("i"), React.createElement("i"), React.createElement("i")))));
  const submit = () => { if (!loggedIn) { onLogin(); return; } if (text.trim()) { onAsk(tk, text.trim()); setText(""); } };
  return React.createElement("div", { className: "home" },
    React.createElement("div", { className: "home-inner" },
      React.createElement("div", { className: "home-badge" }, React.createElement("span", { className: "dot" }), T("homeBadge")),
      React.createElement("h1", null, T("h1a"), React.createElement("em", null, T("h1b"))),
      React.createElement("p", { className: "lede" }, T("ledeA"), React.createElement("b", null, T("ledeBold")), T("ledeB")),
      React.createElement("div", { className: "home-ask" },
        React.createElement("div", { className: "ask-to" },
          React.createElement("span", { className: "ask-to-lab" }, T("ask")),
          kols.map((k) => React.createElement("button", {
            key: k.id, className: "to-pill" + (k.id === tk.id ? " on" : ""), onClick: () => setTarget(k.id) },
            React.createElement(Avatar, { kol: k, size: 20, radius: 6 }),
            React.createElement("span", null, k.display_name)))),
        React.createElement("div", { className: "box" },
          React.createElement("textarea", {
            value: text, rows: 1, placeholder: T("askPlaceholder")(tk.display_name, tk.role),
            onChange: (e) => setText(e.target.value),
            onKeyDown: (e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } } }),
          React.createElement("div", { className: "box-bar" },
            React.createElement("span", { className: "tool-toggle on" }, React.createElement(Icon, { name: "search", size: 13 }), T("toolSearch")),
            React.createElement("span", { className: "tool-toggle" }, React.createElement(Icon, { name: "barChart", size: 13 }), T("toolMarket")),
            React.createElement("div", { className: "spacer" }),
            React.createElement(ModelPicker, { models, value: model, onChange: setModel, up: true, compact: true, effort, setEffort, subscribed: window.RXB ? window.RXB.isSubscribed(tk.id) : true, onLocked: onLocked ? (mid) => onLocked(tk, mid) : undefined, onAddModel }),
            React.createElement("button", { className: "send", disabled: !text.trim(), onClick: submit }, React.createElement(Icon, { name: "send", size: 17 }))))),
      loggedIn && window.RXB ? React.createElement(window.FreeQuotaBar, { kol: tk, onSubscribe }) : null,
      React.createElement("div", { className: "home-grid-lab" }, T("chooseP")),
      React.createElement("div", { className: "kgrid" }, kols.map((k) =>
        React.createElement("button", { key: k.id, className: "kcard", style: { "--glow": k.accent + "22" }, onClick: () => { if (!loggedIn) { onLogin(); return; } onAsk(k, null); } },
          React.createElement("div", { className: "kcard-top" },
            React.createElement(Avatar, { kol: k, size: 38, radius: 10 }),
            React.createElement("div", { style: { minWidth: 0 } },
              React.createElement("div", { className: "kcard-nm" }, k.display_name),
              React.createElement("div", { className: "kcard-role" }, k.role))),
          React.createElement("div", { className: "kcard-tag" }, k.tagline),
          React.createElement("div", { className: "tagrow", style: { marginBottom: 12 } }, (k.style || []).slice(0, 4).map((s) => React.createElement("span", { className: "ptag", key: s }, s))),
          React.createElement("div", { className: "kcard-foot" },
            React.createElement("span", { className: "st" }, React.createElement("b", null, k.stats.followers), " ", T("followers")),
            React.createElement("span", { className: "st" }, React.createElement("b", null, k.corpus.tweets), " ", T("tweetsLabel")),
            React.createElement("span", { className: "go" }, T("askBtn"), React.createElement(Icon, { name: "arrowRight", size: 14 })))))) ));
}

function processText(lang, kol, phase, fallback) {
  const role = kol.role ? `：${kol.role}` : "";
  const zh = {
    plan: "正在理解问题，识别主题和可能相关的标的",
    market: "正在并行核对行情数据和原文线索",
    rag: "正在检索历史观点",
    tools: "正在调用工具补齐实时数据",
    thinking: "正在整理证据，生成回答",
    write: "正在生成回答",
    meta: "已经拿到原文依据和行情线索",
  };
  const en = {
    plan: "I am reading the question and identifying the relevant theme",
    market: "I am checking market data and source material in parallel",
    rag: "I am searching my historical views",
    tools: "I am using tools to fill in live data",
    thinking: "I am organizing the evidence into my answer",
    write: "I am generating my answer",
    meta: "I have source evidence and market context ready",
  };
  if (phase === "style") return lang === "en" ? `I am aligning the answer with my voice${role}` : `正在对齐表达方式${role}`;
  const fallbackText = lang === "en" ? fallback : scrubStatusText(fallback);
  return (lang === "en" ? en : zh)[phase] || fallbackText || (lang === "en" ? "I am working through this question" : "正在处理这个问题");
}

function scrubStatusText(text) {
  if (typeof text !== "string") return text;
  return text
    .replace(/我的/g, "")
    .replace(/我正在/g, "正在")
    .replace(/我已经/g, "已经")
    .replace(/我已/g, "已")
    .replace(/生成回答/g, "生成回答")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function toolProcessText(name, args, lang) {
  const obj = args && typeof args === "object" ? args : {};
  const symbol = obj.symbol || obj.symbols || obj.ticker || obj.code || "";
  const suffix = Array.isArray(symbol) ? symbol.filter(Boolean).join(", ") : String(symbol || "").trim();
  const tail = suffix ? (lang === "en" ? `: ${suffix}` : `：${suffix}`) : "";
  const zh = {
    get_quote: `正在确认实时价格、估值和成交状态${tail}`,
    get_news: `正在检索最新新闻和事件${tail}`,
    get_stock_profile: `正在补齐公司画像、估值和基本面${tail}`,
    get_kline: `正在查看近期走势和关键位置${tail}`,
    get_financials: `正在核对财务数据${tail}`,
  };
  const en = {
    get_quote: `I am checking live price, valuation, and trading status${tail}`,
    get_news: `I am scanning recent news and events${tail}`,
    get_stock_profile: `I am filling in company profile, valuation, and fundamentals${tail}`,
    get_kline: `I am checking recent price action${tail}`,
    get_financials: `I am checking financial data${tail}`,
  };
  return (lang === "en" ? en : zh)[name] || (lang === "en" ? `I am using ${name || "a tool"}${tail}` : `正在使用 ${name || "工具"}${tail}`);
}

function upsertProcessStep(steps, next) {
  const arr = Array.isArray(steps) ? [...steps] : [];
  const idx = arr.findIndex((s) => s.id === next.id);
  if (idx >= 0) arr[idx] = { ...arr[idx], ...next };
  else arr.push(next);
  return arr;
}

function historyProcessSteps(resp) {
  if (Array.isArray(resp && resp.processSteps) && resp.processSteps.length) {
    return resp.processSteps.map((s) => ({ ...s, text: scrubStatusText(s.text), state: "done" }));
  }
  const steps = [
    { id: "history:plan", text: window.RXI.lang === "en" ? "I understood the question" : "已理解问题", kind: "plan", state: "done" },
  ];
  const cites = resp && Array.isArray(resp.citations) ? resp.citations : [];
  if (cites.length) {
    steps.push({
      id: "history:meta",
      text: window.RXI.lang === "en" ? `I used ${cites.length} source${cites.length === 1 ? "" : "s"} to ground the answer` : `已筛选 ${cites.length} 条可引用原文`,
      kind: "meta",
      state: "done",
    });
  } else {
    steps.push({ id: "history:rag", text: window.RXI.lang === "en" ? "I searched my historical views" : "已检索历史观点", kind: "rag", state: "done" });
  }
  const toolCalls = Array.isArray(resp && resp.toolCalls) ? resp.toolCalls : [];
  toolCalls.forEach((tc, i) => steps.push({
    id: `history:tool:${i}:${tc.name || tc.tool || "tool"}`,
    text: toolProcessText(tc.name || tc.tool || "tool", tc.args || {}, window.RXI.lang),
    detail: tc.name || tc.tool || "tool",
    kind: "tool",
    state: "done",
  }));
  steps.push({ id: "history:write", text: window.RXI.lang === "en" ? "I generated my answer" : "已生成回答", kind: "write", state: "done" });
  return steps;
}

function normalizeHistoryMsg(m, kolId) {
  if (m.role === "u" && m.text != null) return m;
  if (m.role === "user" || (m.role === "u" && m.content)) return { id: m.id || uid(), role: "u", text: m.content || m.text || "" };
  if (m.role === "k" && m.resp) {
    const resp = { ...m.resp };
    return { ...m, done: m.done !== false, resp: { ...resp, processSteps: historyProcessSteps(resp), toolCalls: resp.toolCalls || [] } };
  }
  if (m.role === "assistant" || m.role === "k") {
    const resp = {
      phases: RX.phases(window.RXI.lang),
      answerMd: m.content || (m.resp && m.resp.answerMd) || "",
      conviction: null,
      toolCalls: (m.resp && m.resp.toolCalls) || [],
      citations: (m.resp && m.resp.citations) || [],
    };
    return {
      id: m.id || uid(),
      role: "k",
      done: true,
      kol: { id: kolId, display_name: kolId === "qinbafrank" ? "Qinbafrank" : "Serenity", handle: kolId },
      resp: { ...resp, processSteps: historyProcessSteps(resp) },
      streamText: "",
      error: null,
    };
  }
  return m;
}

function BootScreen({ label, detail }) {
  return React.createElement("div", { className: "auth boot" },
    React.createElement("div", { className: "auth-bg" }),
    React.createElement("div", { className: "auth-card boot-card" },
      React.createElement("div", { className: "auth-logo boot-logo" }, React.createElement(Icon, { name: "candlestick", size: 23, color: "var(--on-accent)" })),
      React.createElement("div", { className: "boot-brand" }, "Robindex"),
      React.createElement("div", { className: "boot-sub" }, detail || (window.RXI.lang === "en" ? "AI finance persona terminal" : "AI 金融分身 · 交易研究终端")),
      React.createElement("div", { className: "thinking boot-status" },
        React.createElement("span", null, label || (window.RXI.lang === "en" ? "Loading workspace" : "正在加载工作台")),
        React.createElement("span", { className: "tdots" }, React.createElement("i"), React.createElement("i"), React.createElement("i")))));
}

/* ============================ Assistant message ============================ */
function KMessage({ msg, model, onCite, onWriteCode }) {
  const r = msg.resp;
  if (!r) return null;
  return React.createElement("div", { className: "msg msg-k" },
    React.createElement(Avatar, { kol: msg.kol, size: 30, radius: 8 }),
    React.createElement("div", { className: "stream" },
      React.createElement("div", { className: "k-name" },
        React.createElement("b", null, msg.kol.display_name),
        React.createElement("span", { className: "via" },
          React.createElement("span", { className: "mp-badge", style: { background: model.color, width: 15, height: 15, fontSize: 7 } }, model.badge),
          model.name)),
      React.createElement(ToolGroup, { steps: r.processSteps || [], done: msg.done }),
      msg.done
        ? React.createElement(React.Fragment, null,
            React.createElement(AnswerBlocks, { md: r.answerMd, onCite }),
            r.conviction != null && React.createElement(Conviction, { value: r.conviction }),
            msg.bill && window.RXB ? React.createElement("div", { className: "msg-meter" },
              React.createElement(Icon, { name: "gauge", size: 12, color: "var(--faint)" }),
              msg.bill.free
                ? React.createElement("span", { className: "mm-free" }, T("mpFree"))
                : React.createElement("span", { className: "mm-pts" }, "\u2212", window.RXB.fmtPts(msg.bill.points), " ", T("creditsWord")),
              React.createElement("span", { className: "mm-tok" }, "\u2193 ", window.RXB.fmtTok(msg.bill.tokIn), " \u00b7 \u2191 ", window.RXB.fmtTok(msg.bill.tokOut), " Token"),
              React.createElement("span", { className: "mm-id" }, msg.bill.id, "\u2026")) : null,
            React.createElement("div", { className: "aacts" },
              React.createElement("button", { className: "aact" }, React.createElement(Icon, { name: "copy", size: 14 }), T("actCopy")),
              React.createElement("button", { className: "aact" }, React.createElement(Icon, { name: "refresh", size: 14 }), T("actRetry")),
              React.createElement("button", { className: "aact" }, React.createElement(Icon, { name: "thumbsUp", size: 14 }), T("actUseful")),
              React.createElement("button", { className: "aact accent", onClick: () => onWriteCode(msg) }, React.createElement(Icon, { name: "code", size: 14 }), T("actCode"))))
        : msg.error
          ? React.createElement("div", { className: "thinking", style: { color: "var(--down)" } },
              React.createElement("span", null, msg.error))
          : msg.streamText
            ? React.createElement(React.Fragment, null,
                React.createElement(AnswerBlocks, { md: msg.streamText, onCite }),
                React.createElement("div", { className: "thinking" },
                  React.createElement("span", null, r.phases[msg.phase] ? r.phases[msg.phase].verb : "\u2026"),
                  React.createElement("span", { className: "tdots" }, React.createElement("i"), React.createElement("i"), React.createElement("i"))))
            : React.createElement("div", { className: "thinking" },
                React.createElement("span", null, r.phases[msg.phase] ? r.phases[msg.phase].verb : "\u2026"),
                React.createElement("span", { className: "tdots" }, React.createElement("i"), React.createElement("i"), React.createElement("i")))));
}

/* ============================ Right rail ============================ */
function Rail({ kol, sources, railTab, setRailTab, highlight, citeTick, mobile }) {
  const scrollRef = uR(null);
  uE(() => {
    if (highlight && railTab === "sources" && scrollRef.current) {
      const scrollToCitation = (behavior) => {
        const scroller = scrollRef.current;
        if (!scroller) return;
        const el = scroller.querySelector("#cite-" + citeKey(highlight));
        if (!el) return;
        const pad = 22;
        const scrollerRect = scroller.getBoundingClientRect();
        const elRect = el.getBoundingClientRect();
        const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        const fits = el.offsetHeight + pad * 2 <= scroller.clientHeight;
        const currentTop = scroller.scrollTop + (elRect.top - scrollerRect.top);
        const top = fits
          ? currentTop - Math.max(pad, Math.floor((scroller.clientHeight - el.offsetHeight) / 2))
          : currentTop - pad;
        scroller.scrollTo({ top: Math.max(0, Math.min(maxTop, top)), behavior });
      };
      requestAnimationFrame(() => scrollToCitation("smooth"));
      const t = setTimeout(() => scrollToCitation("smooth"), 160);
      return () => clearTimeout(t);
    }
  }, [highlight, citeTick, railTab]);
  return React.createElement("div", { className: "rail" + (mobile ? " rail-mobile" : "") },
    React.createElement("div", { className: "rail-tabs" },
      React.createElement("button", { className: "rt" + (railTab === "persona" ? " on" : ""), onClick: () => setRailTab("persona") },
        React.createElement(Icon, { name: "user", size: 13 }), T("railPersona")),
      React.createElement("button", { className: "rt" + (railTab === "sources" ? " on" : ""), onClick: () => setRailTab("sources") },
        React.createElement(Icon, { name: "quote", size: 13 }), T("railSources"),
        sources.length > 0 && React.createElement("span", { className: "rt-badge" }, sources.length))),
    React.createElement("div", { className: "rail-scroll", ref: scrollRef },
      railTab === "persona"
        ? React.createElement(PersonaCard, { kol })
        : sources.length === 0
          ? React.createElement("div", { className: "empty-rail" }, React.createElement(Icon, { name: "quote", size: 22, color: "var(--ghost)", style: { margin: "0 auto 10px" } }), T("emptyRailA"), React.createElement("b", { style: { color: "var(--dim)" } }, T("emptyRailMark")), T("emptyRailB"))
          : React.createElement(React.Fragment, null,
              React.createElement("div", { className: "src-note" }, T("srcNoteA"), React.createElement("b", null, sources.length), T("srcNoteB")(kol.handle)),
              sources.map((tw) => React.createElement(SourceCard, { key: tw.ref, kol, tw, active: citeKey(highlight) === citeKey(tw.ref) })))));
}
function PersonaCard({ kol }) {
  return React.createElement(React.Fragment, null,
    React.createElement("div", { className: "rcard" },
      React.createElement("div", { className: "persona" },
        React.createElement("div", { className: "persona-top" },
          React.createElement(Avatar, { kol, size: 46, radius: 12 }),
          React.createElement("div", { style: { minWidth: 0 } },
            React.createElement("div", { className: "persona-nm" }, kol.display_name),
            React.createElement("a", { className: "persona-h", href: "https://x.com/" + kol.handle, target: "_blank", rel: "noreferrer" },
              React.createElement(Icon, { name: "xLogo", size: 11 }), "@" + kol.handle))),
        React.createElement("div", { className: "persona-bio" }, kol.bio),
        React.createElement("div", { className: "persona-stats" },
          React.createElement("div", { className: "pstat" }, React.createElement("div", { className: "v" }, kol.stats.followers), React.createElement("div", { className: "k" }, T("followers"))),
          React.createElement("div", { className: "pstat" }, React.createElement("div", { className: "v" }, kol.corpus.tweets), React.createElement("div", { className: "k" }, T("tweetsLabel"))),
          React.createElement("div", { className: "pstat" }, React.createElement("div", { className: "v win" }, T("personaOnline")), React.createElement("div", { className: "k" }, T("personaSlot")))),
        React.createElement("div", { className: "tagrow" }, (kol.style || []).map((s) => React.createElement("span", { className: "ptag", key: s }, s))))),
    React.createElement("div", { className: "rcard" },
      React.createElement("div", { className: "rcard-h" }, React.createElement(Icon, { name: "lightbulb", size: 13, color: "var(--accent)" }), T("thesisTitle")),
      React.createElement("div", { className: "thesis-body" }, kol.thesis)),
    React.createElement("div", { className: "rcard" },
      React.createElement("div", { className: "rcard-h" }, React.createElement(Icon, { name: "layers", size: 13, color: "var(--accent)" }), T("cloudTitle")),
      React.createElement("div", { className: "meta-rows" },
        React.createElement("div", { className: "meta-row" }, React.createElement("span", { className: "mk" }, T("mIndexed")), React.createElement("span", { className: "mv mono" }, kol.corpus.tweets)),
        React.createElement("div", { className: "meta-row" }, React.createElement("span", { className: "mk" }, T("mSince")), React.createElement("span", { className: "mv mono" }, kol.corpus.since)),
        React.createElement("div", { className: "meta-row" }, React.createElement("span", { className: "mk" }, T("mVersion")), React.createElement("span", { className: "mv mono" }, kol.corpus.persona)),
        React.createElement("div", { className: "meta-row" }, React.createElement("span", { className: "mk" }, T("mRetrieval")), React.createElement("span", { className: "mv mono" }, T("mRetrievalV"))))));
}

/* ============================ Code tab ============================ */
function CodePanel({ kol }) {
  const s = RX.strategyFor(kol, window.RXI.lang);
  return React.createElement("div", { className: "codewrap" },
    React.createElement("div", { className: "codepanel" },
      React.createElement("div", { className: "code-main" },
        React.createElement("div", { className: "code-head" },
          React.createElement("div", { className: "code-dots" }, React.createElement("i", { style: { background: "#FF5F57" } }), React.createElement("i", { style: { background: "#FEBC2E" } }), React.createElement("i", { style: { background: "#28C840" } })),
          React.createElement(Icon, { name: "code", size: 13, color: "var(--faint)" }), s.filename,
          React.createElement("span", { style: { marginLeft: "auto", color: "var(--faint)" } }, s.title)),
        React.createElement("div", { className: "code-body" }, s.lines.map((ln, i) =>
          React.createElement("div", { className: "ln", key: i },
            React.createElement("span", { className: "lno" }, i + 1),
            React.createElement("span", null, renderCode(ln)))))),
      React.createElement("div", { className: "code-side" },
        React.createElement("div", { className: "soon-banner" },
          React.createElement(Icon, { name: "branch", size: 15, color: "var(--accent)" }),
          React.createElement("div", null, React.createElement("b", null, T("codeSoonTitle")), T("codeSoonBody"))),
        React.createElement("div", { className: "rcard-h", style: { padding: "4px 2px" } }, React.createElement(Icon, { name: "barChart", size: 13, color: "var(--accent)" }), T("btPreview"), " \u00b7 ", s.symbol),
        React.createElement("div", { className: "bt-stat" }, s.backtest.map((b) =>
          React.createElement("div", { className: "bt-cell", key: b.k },
            React.createElement("div", { className: "v", style: { color: b.up === true ? "var(--up)" : b.up === false ? "var(--down)" : "var(--text)" } }, b.v),
            React.createElement("div", { className: "k" }, b.k)))),
        React.createElement("button", { className: "run-btn", disabled: true }, React.createElement(Icon, { name: "play", size: 14 }), T("runBacktest"), React.createElement("span", { className: "soon-tag" }, "SOON")))));
}
function renderCode(ln) {
  const out = [];
  for (let i = 0; i < ln.length; i += 2) {
    const cls = ln[i], txt = ln[i + 1];
    if (txt === "") continue;
    out.push(React.createElement("span", { key: i, className: cls || "var2" }, txt));
  }
  return out.length ? out : "\u00A0";
}

function EmptyThread({ kol, onAsk }) {
  const suggs = kol.suggested || [];
  return React.createElement("div", { className: "empty-thread" },
    React.createElement(Avatar, { kol, size: 56, radius: 16 }),
    React.createElement("h2", null, T("emptyAsk")(kol.display_name)),
    React.createElement("p", null, kol.tagline),
    React.createElement("div", { className: "sugg-grid" }, suggs.map((s) =>
      React.createElement("button", { key: s, className: "sugg", onClick: () => onAsk(s) },
        React.createElement(Icon, { name: "sparkles", size: 14, color: "var(--accent)" }),
        React.createElement("span", null, s),
        React.createElement(Icon, { name: "arrowRight", size: 14, color: "var(--faint)", style: { marginLeft: "auto" } })))));
}
function Composer({ kol, onAsk, models, model, setModel, effort, setEffort, dynamicSuggestions, onSubscribe, onAddModel, subscribed, onLocked }) {
  const [text, setText] = uS("");
  const [tools, setTools] = uS(true);
  const ta = uR(null);
  const attach = useAttach();
  const suggs = (dynamicSuggestions && dynamicSuggestions.length ? dynamicSuggestions : (kol.suggested || [])).slice(0, 3);
  const submit = () => { if (text.trim()) { onAsk(text.trim(), attach.atts.length ? attach.atts : null); setText(""); attach.clear(); if (ta.current) ta.current.style.height = "auto"; } };
  return React.createElement("div", { className: "composer-wrap" },
    React.createElement("div", { className: "composer" },
      suggs.length > 0 && React.createElement("div", { className: "chips" }, suggs.map((s) =>
        React.createElement("button", { key: s, className: "chip", onClick: () => onAsk(s) }, s))),
      window.RXB ? React.createElement(window.FreeQuotaBar, { kol, onSubscribe }) : null,
      React.createElement("div", { className: "box" },
        React.createElement("textarea", {
          ref: ta, value: text, rows: 1, placeholder: T("composerPlaceholder")(kol.display_name),
          onChange: (e) => { setText(e.target.value); e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px"; },
          onKeyDown: (e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } },
          onPaste: attach.onPaste }),
        React.createElement(AttachRow, { atts: attach.atts, onRemove: attach.remove }),
        React.createElement("div", { className: "box-bar" },
          React.createElement(AttachBtn, { onAdd: attach.add }),
          React.createElement("button", { className: "tool-toggle" + (tools ? " on" : ""), onClick: () => setTools((t) => !t) }, React.createElement(Icon, { name: "search", size: 13 }), T("toolSearch")),
          React.createElement("span", { className: "tool-toggle" }, React.createElement(Icon, { name: "barChart", size: 13 }), T("toolMarket")),
          React.createElement("div", { className: "spacer" }),
          React.createElement(ModelPicker, { models, value: model, onChange: setModel, up: true, compact: true, effort, setEffort, subscribed, onLocked, onAddModel }),
          React.createElement("button", { className: "send", disabled: !text.trim(), onClick: submit }, React.createElement(Icon, { name: "send", size: 17 })))),
      React.createElement("div", { className: "composer-foot" }, React.createElement("b", null, kol.display_name), " ", T("composerFootB"), " ", T("composerFoot"))));
}

/* ============================ Thread + tabs (shared) ============================ */
function ChatArea({ kol, messages, model, tab, setTab, onCite, onWriteCode, onAsk, threadRef, models, modelId, setModel, effort, setEffort, loggedIn, onLogin, onSubscribe, onAddModel, onLocked }) {
  const lastK = messages.filter((m) => m.role === "k" && m.done && m.resp && m.resp.suggestions);
  const dynSuggs = lastK.length ? lastK[lastK.length - 1].resp.suggestions : null;
  return React.createElement(React.Fragment, null,
    tab === "ask"
      ? React.createElement("div", { className: "thread-col" },
          React.createElement("div", { className: "thread", ref: threadRef },
            React.createElement("div", { className: "thread-inner" },
              messages.length === 0
                ? React.createElement(EmptyThread, { kol, onAsk })
                : messages.map((m) => m.role === "u"
                    ? React.createElement("div", { className: "msg msg-u", key: m.id }, React.createElement("div", { className: "bub" }, m.text))
                    : React.createElement(KMessage, { key: m.id, msg: m, model, onCite, onWriteCode })))),
          loggedIn
            ? React.createElement(Composer, { kol, onAsk, models, model: modelId, setModel, effort, setEffort, dynamicSuggestions: dynSuggs, onSubscribe, onAddModel, subscribed: window.RXB ? window.RXB.isSubscribed(kol.id) : true, onLocked: onLocked ? (mid) => onLocked(kol, mid) : undefined })
            : React.createElement("div", { className: "composer-wrap" },
                React.createElement("div", { className: "composer" },
                  React.createElement("button", { className: "auth-primary", style: { margin: "12px 0" }, onClick: onLogin },
                    T("authSignInToAsk"), React.createElement(Icon, { name: "arrowRight", size: 16 })))))
      : React.createElement(CodePanel, { kol }));
}

/* ============================ App ============================ */
function App() {
  const [theme, setTheme] = uS(() => LS.get("theme", "aurora"));
  const [model, setModel] = uS(() => LS.get("model", "pro"));
  const [effort, setEffort] = uS(() => LS.get("effort", "high"));
  const [lang, setLangState] = uS(() => window.RXI.lang);
  const privy = window.PrivySDK.usePrivy();
  const loggedIn = privy.authenticated;
  const user = privy.authenticated && privy.user ? {
    email: privy.user.email?.address || privy.user.google?.email || "trader@robindex.ai",
    method: privy.user.google?.email ? "google" : "email"
  } : null;
  const promptLogin = () => {
    if (!privy || typeof privy.login !== "function") {
      console.error("[Desk] privy.login not available — is PrivyProvider mounted?");
      return;
    }
    try {
      console.log("[Desk] Calling privy.login with methods: email, google");
      privy.login({ loginMethods: ['email', 'google'] });
    } catch(e) {
      console.error("[Desk] privy.login error:", e);
    }
  };
  const requireAuth = () => { if (!loggedIn) { promptLogin(); return false; } return true; };
  const [target, setTarget] = uS("qinbafrank");
  const [view, setView] = uS("home");
  const [tab, setTab] = uS("ask");
  const [showSettings, setShowSettings] = uS(false);
  const [chats, setChats] = uS(() => {
    const saved = LS.get("chats", null);
    if (saved && Array.isArray(saved)) {
      return saved
        .map((c) => ({ ...c, messages: (c.messages || []).map((m) => normalizeHistoryMsg(m, c.kol && c.kol.id)) }))
        .filter((c) => c.messages && c.messages.length > 0);
    }
    try {
      const old = JSON.parse(localStorage.getItem("robindex_convs") || "[]");
      const validPersonas = ["qinbafrank", "aleabitoreddit"];
      return old.filter((c) => validPersonas.includes(c.persona)).map((c) => {
        const kolId = c.persona;
        const msgs = (c.messages || []).map((m, i) => normalizeHistoryMsg({ ...m, id: "old_" + i }, kolId));
        return {
          id: c.id, kol: { id: kolId, display_name: kolId === "qinbafrank" ? "Qinbafrank" : "Serenity", handle: kolId,
            avatar_url: kolId === "qinbafrank" ? "https://unavatar.io/x/qinbafrank" : "https://pbs.twimg.com/profile_images/1996176688414367744/LXfA_lIx_400x400.jpg",
            accent: kolId === "qinbafrank" ? "#3DDC97" : "#5B9DFF",
            role: "", bio: "", tagline: "", thesis: "", style: [], corpus: { tweets: "\u2014", since: "\u2014", persona: "\u2014" }, stats: { followers: "\u2014", tweets: "\u2014" }, suggested: [] },
          title: c.title || kolId, messages: msgs, ts: c.ts || Date.now(),
        };
      });
    } catch { return []; }
  });
  const [localUserId] = uS(() => {
    let id = LS.get("userId", null);
    if (!id) { id = "u_" + crypto.randomUUID(); LS.set("userId", id); }
    return id;
  });
  const userId = (privy.user && privy.user.id) || localUserId;
  const [active, setActive] = uS(null);
  const [messages, setMessages] = uS([]);
  const [railTab, setRailTab] = uS("persona");
  const [sources, setSources] = uS([]);
  const [highlight, setHighlight] = uS(null);
  const [citeTick, setCiteTick] = uS(0);
  const [mtab, setMtab] = uS("home");
  const [paywall, setPaywall] = uS(null);
  const [checkout, setCheckout] = uS(null);
  const [addModelOpen, setAddModelOpen] = uS(false);
  const [initDone, setInitDone] = uS(false);
  const [historyLoadDone, setHistoryLoadDone] = uS(false);
  const [railWidth, setRailWidth] = uS(380);
  const railDragRef = uR(null);
  const threadRef = uR(null);
  const mobile = useMedia("(max-width: 760px)");

  const onResizeMove = uC(function(e) {
    if (!railDragRef.current) return;
    const newW = window.innerWidth - e.clientX;
    const maxW = Math.floor(window.innerWidth * 0.5);
    setRailWidth(Math.max(240, Math.min(maxW, newW)));
  }, []);
  const onResizeUp = uC(function() {
    railDragRef.current = null;
    document.body.classList.remove("resizing");
    document.removeEventListener("mousemove", onResizeMove);
    document.removeEventListener("mouseup", onResizeUp);
  }, []);
  const onResizeDown = uC(function(e) {
    e.preventDefault();
    railDragRef.current = true;
    document.body.classList.add("resizing");
    document.addEventListener("mousemove", onResizeMove);
    document.addEventListener("mouseup", onResizeUp);
  }, []);

  const kols = RX.kols(lang);
  const models = localizeModels(lang);
  const curModel = models.find((m) => m.id === model) || models[0];
  const curKol = active ? (kols.find((k) => k.id === active.kol.id) || active.kol) : null;
  const requestedChatId = () => {
    const url = new URL(window.location);
    const pathMatch = url.pathname.match(/^\/chat\/([^/]+)\/?$/);
    return pathMatch ? decodeURIComponent(pathMatch[1]) : url.searchParams.get("chat");
  };
  const showChat = (chat) => {
    const saved = (chat.messages || []).map((m) => normalizeHistoryMsg(m, chat.kol && chat.kol.id));
    const normalizedChat = { ...chat, messages: saved };
    setActive(normalizedChat); setView("chat"); setTab("ask"); setMtab("chat");
    setMessages(saved);
    const lastK = saved.filter((m) => m.role === "k" && m.done);
    if (!lastK.length) { setSources([]); setRailTab("persona"); return; }
    const last = lastK[lastK.length - 1];
    const cites = last._citations || (last.resp && last.resp.citations) || [];
    if (!cites.length) { setSources([]); setRailTab("persona"); return; }
    setSources(cites);
    setRailTab("sources");
    RX.hydrateCitations(chat.kol.id, cites, chat.kol.handle).then((hydrated) => {
      setSources(hydrated);
      setMessages((msgs) => msgs.map((m) => m.id === last.id ? {
        ...m,
        _citations: hydrated,
        resp: { ...m.resp, citations: hydrated },
      } : m));
    });
  };

  uE(() => { document.documentElement.setAttribute("data-theme", theme); LS.set("theme", theme); }, [theme]);
  uE(() => { LS.set("model", model); }, [model]);
  uE(() => { LS.set("effort", effort); }, [effort]);
  uE(() => { const saved = chats.filter((c) => !isEmptyChat(c)); if (saved.length) LS.set("chats", saved); }, [chats]);
  uE(() => {
    if (!active && requestedChatId() && !historyLoadDone) return;
    if (active) {
      const url = new URL(window.location);
      url.pathname = "/chat/" + encodeURIComponent(active.id);
      url.searchParams.delete("chat");
      history.replaceState(null, "", url);
    } else {
      const url = new URL(window.location);
      if (url.pathname.startsWith("/chat/")) url.pathname = "/";
      url.searchParams.delete("chat");
      history.replaceState(null, "", url);
    }
  }, [active, historyLoadDone]);
  uE(() => {
    if (active && messages.length) {
      setChats((prev) => {
        const idx = prev.findIndex((c) => c.id === active.id);
        const firstUser = messages.find((m) => m.role === "u");
        const title = firstUser ? firstUser.text.slice(0, 22) : active.title;
        const updated = { ...active, messages, title, ts: Date.now() };
        setActive(updated);
        if (idx < 0) return [updated, ...prev];
        const next = [...prev];
        next[idx] = updated;
        return next;
      });
      const timer = setTimeout(() => {
        setChats((prev) => { const c = prev.find((x) => x.id === active.id); if (c) RX.saveChat(c, userId); return prev; });
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [messages]);
  uE(() => { if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight; }, [messages]);

  uE(() => {
    RX.init().then(async () => {
      setInitDone(true);
      const validIds = new Set(RX.kols(window.RXI.lang).map((k) => k.id));
      setChats((prev) => {
        const filtered = prev.filter((c) => validIds.has(c.kol.id) && !isEmptyChat(c));
        filtered.forEach((chat) => RX.saveChat(chat, userId));
        const chatParam = requestedChatId();
        if (chatParam) { const match = filtered.find((c) => c.id === chatParam); if (match) showChat(match); }
        return filtered;
      });
    }).catch((err) => {
      console.error("[Desk] RX.init failed in App:", err);
      setInitDone(true);
    });
  }, []);

  uE(() => {
    if (!initDone) return;
    const validIds = new Set(RX.kols(window.RXI.lang).map((k) => k.id));
    setHistoryLoadDone(false);
    RX.loadHistory(userId).then((cloudChats) => {
      if (!cloudChats.length) return;
      setChats((cur) => {
        const normalizedCloud = cloudChats.map((c) => ({
          ...c,
          messages: (c.messages || []).map((m) => normalizeHistoryMsg(m, c.kol && c.kol.id)),
        }));
        const localIds = new Set(cur.map((c) => c.id));
        const localKeys = new Set(cur.map((c) => c.kol.id + "::" + c.title));
        const newCloud = normalizedCloud.filter((c) => !isEmptyChat(c) && !localIds.has(c.id) && !localKeys.has(c.kol.id + "::" + c.title) && validIds.has(c.kol.id));
        if (newCloud.length) {
          const merged = [...newCloud, ...cur];
          const chatParam = requestedChatId();
          if (chatParam) { const match = merged.find((c) => c.id === chatParam); if (match) showChat(match); }
          return merged;
        }
        return cur;
      });
    }).catch(() => {}).finally(() => setHistoryLoadDone(true));
  }, [initDone, userId]);

  // Login transition: when Privy auth flips to true, ensure in-memory chats are persisted under the real user id
  uE(() => {
    const pid = privy.user && privy.user.id;
    if (loggedIn && pid) {
      const timer = setTimeout(() => {
        setChats((prev) => {
          prev.forEach((c) => { if (!isEmptyChat(c)) RX.saveChat(c, pid); });
          return prev;
        });
      }, 120);
      return () => clearTimeout(timer);
    }
  }, [loggedIn]); // pid derived inside, re-run on login flip is sufficient

  // Billing sync: hand the Privy access token to the store and load the server-authoritative balance.
  // Also reconcile after a Stripe redirect (?billing=success) — the webhook has usually landed by then,
  // and a short retry covers the race where it hasn't.
  uE(() => {
    if (!window.RXB) return;
    if (loggedIn && privy.authenticated && typeof privy.getAccessToken === "function") {
      window.RXB.setAuth(() => privy.getAccessToken(), user && user.email);
      window.RXB.syncFromServer();
      const params = new URLSearchParams(window.location.search);
      if (params.get("billing") === "success") {
        let tries = 0;
        const poll = setInterval(() => { tries++; window.RXB.syncFromServer(); if (tries >= 5) clearInterval(poll); }, 1500);
        params.delete("billing");
        const qs = params.toString();
        window.history.replaceState({}, "", window.location.pathname + (qs ? "?" + qs : ""));
        return () => clearInterval(poll);
      }
    } else {
      window.RXB.setAuth(null, null);
    }
  }, [loggedIn, privy.authenticated]);

  const setLang = (l) => { window.RXI.set(l); setLangState(l); document.documentElement.setAttribute("lang", l === "en" ? "en" : "zh"); };

  const openChatView = (chat) => {
    setActive(chat); setView("chat"); setTab("ask"); setMtab("chat");
    setMessages(chat.messages || []); setSources([]); setHighlight(null); setRailTab("persona");
  };
  const switchKol = (kol) => {
    if (!loggedIn) { promptLogin(); return; }
    const existingEmpty = chats.find((c) => c.kol.id === kol.id && isEmptyChat(c));
    if (existingEmpty) { openChatView(existingEmpty); return; }
    if (active && active.kol.id === kol.id && isEmptyChat(active)) { openChatView(active); return; }
    openChatView({ id: chatId(), kol, title: defaultChatTitle(kol, lang), messages: [], ts: Date.now() });
  };
  const openKol = (kol, firstQuestion) => {
    if (!loggedIn) { promptLogin(); return; }
    if (!firstQuestion) { switchKol(kol); return; }
    const chat = { id: chatId(), kol, title: firstQuestion.slice(0, 22), messages: [], ts: Date.now() };
    setChats((c) => [chat, ...c]);
    setActive(chat); setView("chat"); setTab("ask"); setMtab("chat");
    setMessages([]); setSources([]); setHighlight(null); setRailTab("persona");
    setTimeout(() => ask(kol, firstQuestion, chat.id), 60);
  };
  const openExisting = (chat) => {
    showChat(chat);
  };

  const ask = (kol, question, conversationIdOverride) => {
    const conversationId = conversationIdOverride || active?.id;
    const userMsg = { id: uid(), role: "u", text: question };
    const lang_ = window.RXI.lang;
    const ph = RX.phases(lang_);
    const kMsg = { id: uid(), role: "k", kol, resp: { phases: ph, toolCalls: [], processSteps: [] }, phase: 0, done: false, streamText: "", error: null };
    setMessages((m) => [...m, userMsg, kMsg]);

    const toolCalls = [];

    if (RX.isBackendReady()) {
      RX.streamChat(kol.id, question, model, conversationId, {
        onConversationId: (serverConversationId) => {
          if (!serverConversationId || serverConversationId === conversationId) return;
          setActive((cur) => cur && cur.id === conversationId ? { ...cur, id: serverConversationId } : cur);
          setChats((prev) => prev.map((c) => c.id === conversationId ? { ...c, id: serverConversationId } : c));
        },
        onPhase: (idx, text, phaseKey) => {
          const key = phaseKey || `phase-${idx}`;
          setMessages((m) => m.map((x) => {
            if (x.id !== kMsg.id) return x;
            const current = (x.resp.processSteps || []).map((s) => s.state === "run" && s.id !== `phase:${key}` ? { ...s, state: "done" } : s);
            const processSteps = upsertProcessStep(current, {
              id: `phase:${key}`,
              text: processText(lang_, kol, key, text),
              detail: text || "",
              kind: key,
              state: "run",
            });
            return { ...x, phase: Math.min(idx + 1, ph.length), resp: { ...x.resp, processSteps } };
          }));
        },
        onMeta: (meta) => {
          const cites = (meta.citations || []).map((c, i) => ({
            ref: c.ref || ("T" + (i + 1)),
            tweet_id: c.tweet_id || c.id || "",
            date: c.date || "",
            likes: c.likes || 0,
            views: c.views || "",
            url: c.url || "",
            snippet: c.snippet || c.text || "",
            quoted: c.quoted || null,
          }));
          setSources(cites);
          setRailTab("sources");
          setHighlight(null);
          console.log("[Desk] onMeta: citations =", cites.length);
          setMessages((m) => m.map((x) => {
            if (x.id !== kMsg.id) return x;
            const chartText = meta.chart && meta.chart.symbol ? (lang_ === "en" ? `, with ${meta.chart.symbol} market context` : `，并确认 ${meta.chart.symbol} 行情`) : "";
            const sourceText = lang_ === "en"
              ? `I found ${cites.length} source${cites.length === 1 ? "" : "s"} to ground the answer${chartText}`
              : `已筛选 ${cites.length} 条可引用原文${chartText}`;
            const current = (x.resp.processSteps || []).map((s) => s.state === "run" ? { ...s, state: "done" } : s);
            const processSteps = upsertProcessStep(current, { id: "phase:meta", text: sourceText, kind: "meta", state: "done" });
            return { ...x, _citations: cites, resp: { ...x.resp, citations: cites, processSteps } };
          }));
        },
        onToolCall: (tc) => {
          const displayArgs = typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args || {});
          toolCalls.push({ name: tc.name || "tool", args: displayArgs, result: {} });
          setMessages((m) => m.map((x) => {
            if (x.id !== kMsg.id) return x;
            const processSteps = upsertProcessStep(x.resp.processSteps || [], {
              id: `tool:${toolCalls.length}:${tc.name || "tool"}`,
              text: toolProcessText(tc.name || "tool", tc.args, lang_),
              detail: tc.name || "tool",
              kind: "tool",
              state: "done",
            });
            return { ...x, resp: { ...x.resp, toolCalls: [...toolCalls], processSteps } };
          }));
        },
        onDelta: (fullText) => {
          setMessages((m) => m.map((x) => {
            if (x.id !== kMsg.id) return x;
            const current = (x.resp.processSteps || []).map((s) => s.state === "run" ? { ...s, state: "done" } : s);
            const processSteps = upsertProcessStep(current, { id: "phase:write", text: processText(lang_, kol, "write"), kind: "write", state: "run" });
            return { ...x, streamText: fullText, resp: { ...x.resp, processSteps } };
          }));
        },
        onDone: (fullText, meta) => {
          const conviction = 60 + Math.floor(Math.random() * 25);
          setMessages((m) => m.map((x) => {
            if (x.id !== kMsg.id) return x;
            const cites = x._citations || x.resp.citations || [];
            const processSteps = (x.resp.processSteps || []).map((s) => ({ ...s, state: "done" }));
            return { ...x, done: true, phase: ph.length, streamText: "", _citations: cites,
              resp: { ...x.resp, answerMd: fullText, conviction, toolCalls: toolCalls, citations: cites, processSteps } };
          }));
          RX.fetchSuggestions(kol.id, question, fullText).then((suggs) => {
            if (suggs.length) {
              setMessages((m) => m.map((x) => x.id === kMsg.id ? {
                ...x, resp: { ...x.resp, suggestions: suggs },
              } : x));
            }
          });
        },
        onError: (err) => {
          setMessages((m) => m.map((x) => {
            if (x.id !== kMsg.id) return x;
            const processSteps = (x.resp.processSteps || []).map((s) => s.state === "run" ? { ...s, state: "error" } : s);
            return { ...x, done: true, error: err, resp: { ...x.resp, processSteps } };
          }));
        },
      });
    } else {
      setMessages((m) => m.map((x) => x.id === kMsg.id ? {
        ...x, done: true,
        resp: { ...x.resp, answerMd: T("composerFootB") + " " + kol.display_name + " \u2014 backend offline. Please deploy and try again.", conviction: 0 },
      } : x));
    }
  };

  const composerAsk = (question, atts) => { if (curKol) ask(curKol, question); };
  const onCite = (ref) => {
    setRailTab("sources");
    setHighlight(citeKey(ref));
    setCiteTick((n) => n + 1);
    if (mobile) setMtab("sources");
  };
  const onWriteCode = () => setTab("code");
  const goHome = () => { setView("home"); setActive(null); setMtab("home"); };
  const B = window.RXB;
  const onLocked = (kol, modelId) => setPaywall({ reason: "model-locked", kol, modelId });
  const onSubscribe = (kolId) => setPaywall({ reason: "quota", kol: kols.find((k) => k.id === kolId) || curKol, modelId: "flash" });
  const onCheckout = (item) => { setPaywall(null); setCheckout(item); };
  const onCheckoutDone = () => setCheckout(null);
  const openWallet = () => { setShowSettings(false); setView("wallet"); setActive(null); setMtab("wallet"); };
  const openSubs = () => { setShowSettings(false); setView("subs"); setActive(null); setMtab("subs"); };
  const openUsage = () => { setShowSettings(false); setView("usage"); setActive(null); setMtab("usage"); };
  const openAddModel = () => setAddModelOpen(true);
  const signOut = () => { privy.logout(); setShowSettings(false); goHome(); };

  if (!privy.ready || !initDone) return React.createElement(BootScreen, {
    label: window.RXI.lang === "en" ? "Preparing secure session" : "正在准备安全会话",
  });

  // Unauthenticated gate — branded welcome screen with a single Sign In button
  if (!loggedIn) return React.createElement(window.LoginGate, { privy, theme, setTheme, lang, setLang });

  const topRight = React.createElement(React.Fragment, null,
    React.createElement(window.LangToggle, { lang, setLang }),
    React.createElement(ThemeMenu, { value: theme, onChange: setTheme }),
    loggedIn
      ? React.createElement("button", { className: "icon-btn", onClick: () => setShowSettings(true), title: T("setTitle") }, React.createElement(Icon, { name: "settings", size: 17 }))
      : React.createElement("button", { className: "hdr-login", onClick: promptLogin }, T("hdrLogin") || T("authSignIn")));

  if (mobile) {
    let body;
    if (mtab === "home") body = React.createElement("div", { className: "m-body scrollable" }, React.createElement(Home, { kols, target, setTarget, onAsk: openKol, models, model, setModel, effort, setEffort, loggedIn, onLogin: promptLogin, onLocked, onSubscribe, onAddModel: openAddModel }));
    else if (mtab === "chat") body = curKol
      ? React.createElement("div", { className: "m-body chat-body" },
          React.createElement("div", { className: "m-subtabs" },
            React.createElement("button", { className: "tab" + (tab === "ask" ? " on" : ""), onClick: () => setTab("ask") }, React.createElement(Icon, { name: "sparkles", size: 13 }), T("tabAsk")),
            React.createElement("button", { className: "tab" + (tab === "code" ? " on" : ""), onClick: () => setTab("code") }, React.createElement(Icon, { name: "code", size: 13 }), T("tabCode"), React.createElement("span", { className: "soon-tag-sm" }, "SOON"))),
          React.createElement(ChatArea, { kol: curKol, messages, model: curModel, tab, setTab, onCite, onWriteCode, onAsk: composerAsk, threadRef, models, modelId: model, setModel, effort, setEffort, loggedIn, onLogin: promptLogin, onSubscribe, onAddModel: openAddModel, onLocked }))
      : React.createElement("div", { className: "m-body scrollable" }, React.createElement(MobileNoChat, { onHome: () => setMtab("home") }));
    else if (mtab === "sources") body = React.createElement("div", { className: "m-body" }, curKol
      ? React.createElement(Rail, { kol: curKol, sources, railTab, setRailTab, highlight, citeTick, mobile: true })
      : React.createElement(MobileNoChat, { onHome: () => setMtab("home") }));
    else if (mtab === "wallet") body = React.createElement("div", { className: "m-body scrollable" }, React.createElement(window.WalletPage, { onCheckout, onClose: () => setMtab("me"), onOpenUsage: () => setMtab("usage"), mobile: true }));
    else if (mtab === "usage") body = React.createElement("div", { className: "m-body scrollable" }, React.createElement(window.UsagePage, { onCheckout, onClose: () => setMtab("wallet"), mobile: true }));
    else if (mtab === "subs") body = React.createElement("div", { className: "m-body scrollable" }, React.createElement(window.SubsPage, { kols, onCheckout, onClose: () => setMtab("me"), mobile: true }));
    else body = React.createElement("div", { className: "m-body scrollable" }, loggedIn
      ? React.createElement(window.SettingsPage, { user, model, setModel, theme, setTheme, lang, setLang, onSignOut: signOut, onOpenWallet: openWallet, onOpenSubs: openSubs, onOpenUsage: () => setMtab("usage"), onAddModel: openAddModel })
      : React.createElement("div", { className: "m-body scrollable", style: { padding: 20 } },
          React.createElement("button", { className: "auth-primary", onClick: promptLogin }, T("authSignIn"))));
    const modals = React.createElement(React.Fragment, null,
      paywall && window.Paywall ? React.createElement(window.Paywall, { reason: paywall.reason, kol: paywall.kol, modelId: paywall.modelId, kols, onClose: () => setPaywall(null), onCheckout }) : null,
      checkout && window.Checkout ? React.createElement(window.Checkout, { item: checkout, kols, onClose: () => setCheckout(null), onDone: onCheckoutDone }) : null,
      addModelOpen && window.AddModelModal ? React.createElement(window.AddModelModal, { onClose: () => setAddModelOpen(false), onSaved: (m) => { setAddModelOpen(false); setModel(m.id); } }) : null);
    return React.createElement("div", { className: "app mobile" },
      React.createElement(window.MobileTopBar, { kol: mtab === "chat" ? curKol : null, lang, setLang, theme, setTheme, loggedIn, onLogin: promptLogin }),
      body,
      React.createElement(window.BottomNav, { tab: (mtab === "wallet" || mtab === "subs" || mtab === "usage") ? "me" : mtab, setTab: setMtab, srcCount: sources.length }),
      modals);
  }

  return React.createElement("div", { className: "app" },
    React.createElement(Sidebar, { kols, chats, activeChat: active, user, onPick: switchKol, onOpenChat: openExisting, onHome: goHome, onSettings: () => setShowSettings(true), loggedIn, onLogin: promptLogin, onWallet: openWallet, onSubs: openSubs, onUsage: openUsage }),
    React.createElement("div", { className: "main" },
      React.createElement("div", { className: "topbar" },
        view === "chat" && curKol
          ? React.createElement("div", { className: "kol-id" },
              React.createElement(Avatar, { kol: curKol, size: 34, radius: 9, className: "face" }),
              React.createElement("div", { className: "meta" },
                React.createElement("div", { className: "nm" }, curKol.display_name, React.createElement("span", { className: "live-pill" }, React.createElement("span", { className: "dot" }), T("online"))),
                React.createElement("div", { className: "role" }, curKol.role)))
          : React.createElement("div", { className: "kol-id" },
              React.createElement("div", { className: "brand-mark", style: { width: 34, height: 34, borderRadius: 9 } }, React.createElement(Icon, { name: view === "wallet" ? "wallet" : view === "subs" ? "crown" : view === "usage" ? "gauge" : "candlestick", size: 18, color: "var(--on-accent)" })),
              React.createElement("div", { className: "meta" },
                React.createElement("div", { className: "nm" }, view === "wallet" ? T("walletTitle") : view === "subs" ? T("subsTitle") : view === "usage" ? T("usageTitle") : T("selectPersona")),
                React.createElement("div", { className: "role" }, view === "wallet" ? T("creditsUnit") : view === "subs" ? T("planMember") : view === "usage" ? T("usageSub") : T("deskSub")))),
        view === "chat" && React.createElement("div", { className: "tabs" },
          React.createElement("button", { className: "tab" + (tab === "ask" ? " on" : ""), onClick: () => setTab("ask") }, React.createElement(Icon, { name: "sparkles", size: 13 }), T("tabAsk")),
          React.createElement("button", { className: "tab" + (tab === "code" ? " on" : ""), onClick: () => setTab("code") }, React.createElement(Icon, { name: "code", size: 13 }), T("tabCode"), React.createElement("span", { className: "soon-tag-sm" }, "SOON"))),
        React.createElement("div", { className: "spacer" }),
        topRight),
      view === "home"
        ? React.createElement(Home, { kols, target, setTarget, onAsk: openKol, models, model, setModel, effort, setEffort, loggedIn, onLogin: promptLogin, onLocked, onSubscribe, onAddModel: openAddModel })
        : view === "wallet"
          ? React.createElement(window.WalletPage, { onCheckout, onOpenUsage: openUsage })
          : view === "usage"
            ? React.createElement(window.UsagePage, { onCheckout })
            : view === "subs"
              ? React.createElement(window.SubsPage, { kols, onCheckout })
              : React.createElement("div", { className: "center" },
                  React.createElement(ChatArea, { kol: curKol, messages, model: curModel, tab, setTab, onCite, onWriteCode, onAsk: composerAsk, threadRef, models, modelId: model, setModel, effort, setEffort, loggedIn, onLogin: promptLogin, onSubscribe, onAddModel: openAddModel, onLocked }),
                  React.createElement("div", { className: "rail-wrap", style: { width: railWidth, minWidth: railWidth } },
                    React.createElement("div", { className: "rail-resize", onMouseDown: onResizeDown }),
                    React.createElement(Rail, { kol: curKol, sources, railTab, setRailTab, highlight, citeTick })))),
    showSettings && React.createElement("div", { className: "set-overlay", onClick: (e) => { if (e.target.classList.contains("set-overlay")) setShowSettings(false); } },
      React.createElement(window.SettingsPage, { user, model, setModel, theme, setTheme, lang, setLang, onSignOut: signOut, onClose: () => setShowSettings(false), onOpenWallet: openWallet, onOpenSubs: openSubs, onOpenUsage: openUsage, onAddModel: openAddModel })),
    paywall && window.Paywall ? React.createElement(window.Paywall, { reason: paywall.reason, kol: paywall.kol, modelId: paywall.modelId, kols, onClose: () => setPaywall(null), onCheckout }) : null,
    checkout && window.Checkout ? React.createElement(window.Checkout, { item: checkout, kols, onClose: () => setCheckout(null), onDone: onCheckoutDone }) : null,
    addModelOpen && window.AddModelModal ? React.createElement(window.AddModelModal, { onClose: () => setAddModelOpen(false), onSaved: (m) => { setAddModelOpen(false); setModel(m.id); } }) : null);
}

function MobileNoChat({ onHome }) {
  return React.createElement("div", { className: "m-nochat" },
    React.createElement(Icon, { name: "sparkles", size: 26, color: "var(--ghost)" }),
    React.createElement("p", null, T("selectPersona")),
    React.createElement("button", { className: "auth-primary", style: { maxWidth: 220 }, onClick: onHome }, T("chooseP")));
}

function AppWrapper() {
  const [privyAppId, setPrivyAppId] = React.useState(null);

  React.useEffect(() => {
    RX.init().then(() => {
      setPrivyAppId(RX.config.privyAppId);
    }).catch((err) => {
      console.error("[Desk] RX.init failed in AppWrapper:", err);
      setPrivyAppId(RX.config.privyAppId || "client-clxxyzdummyappidforlocaldev");
    });
  }, []);

  if (!privyAppId) {
    return React.createElement(BootScreen, {
      label: window.RXI.lang === "en" ? "Loading Robindex" : "正在加载 Robindex",
      detail: window.RXI.lang === "en" ? "Connecting persona data and login service" : "正在连接分身数据与登录服务",
    });
  }

  const { PrivyProvider } = window.PrivySDK;
  return React.createElement(
    PrivyProvider,
    {
      appId: privyAppId,
      config: {
        loginMethods: ['email', 'google'],
        appearance: {
          theme: 'dark',
          accentColor: '#3DDC97',
          logo: '/app/icon.svg',
          landingHeader: 'Welcome to Robindex',
          loginMessage: 'Log in with email or Google to continue',
          emailDomain: 'robindex.ai',
        }
      },
      onSuccess: (user, isNewUser, wasAlreadyAuthenticated, loginMethod) => {
        console.log('[Privy] Login success:', { email: user?.email?.address, method: loginMethod, isNewUser, wasAlreadyAuthenticated });
      },
      onError: (error) => {
        console.error('[Privy] Login error:', error);
      },
    },
    React.createElement(App)
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(AppWrapper));
