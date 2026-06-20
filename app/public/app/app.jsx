/* Robindex Desk — app shell: auth gate, i18n, responsive desktop/mobile, real SSE chat flow */
const { useState: uS, useRef: uR, useEffect: uE, useCallback: uC } = React;
const { Icon, Avatar, ModelPicker, ThemeMenu, THEMES, ToolGroup, AnswerBlocks, Conviction, SourceCard } = window.RXC;
const RX = window.RX;
const T = (k) => window.RXI.t(k);

let _id = 1;
const uid = () => "m" + _id++;
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

/* ============================ Sidebar (desktop) ============================ */
function Sidebar({ kols, chats, activeChat, onPick, onOpenChat, onHome, onSettings, user }) {
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
        React.createElement("span", { className: "live-dot" })))),
    React.createElement("div", { className: "side-sec", style: { marginTop: 8 } }, T("recent")),
    React.createElement("div", { className: "side-scroll" },
      chats.length === 0
        ? React.createElement("div", { className: "side-empty" }, T("noChats"))
        : chats.map((c) => React.createElement("button", {
            key: c.id, className: "hist" + (activeChat && activeChat.id === c.id ? " on" : ""), onClick: () => onOpenChat(c) },
            React.createElement(Avatar, { kol: c.kol, size: 18, radius: 5, className: "hist-av" }),
            React.createElement("span", { className: "hist-t" }, c.title)))),
    React.createElement("button", { className: "side-foot", onClick: onSettings },
      React.createElement("div", { className: "av" }, "TD"),
      React.createElement("div", { style: { minWidth: 0, textAlign: "left" } },
        React.createElement("div", { className: "nm" }, "Trader Desk"),
        React.createElement("div", { className: "sub" }, T("proSeat"))),
      React.createElement("div", { className: "credits", title: T("credits") }, React.createElement(Icon, { name: "zap", size: 11 }), "8.2K")));
}

/* ============================ Home ============================ */
function Home({ kols, target, setTarget, onAsk, models, model, setModel, effort, setEffort }) {
  const [text, setText] = uS("");
  const tk = kols.find((k) => k.id === target) || kols[0];
  if (!tk) return React.createElement("div", { className: "home" },
    React.createElement("div", { className: "home-inner", style: { textAlign: "center" } },
      React.createElement("div", { className: "thinking" },
        React.createElement("span", null, "Loading personas"),
        React.createElement("span", { className: "tdots" }, React.createElement("i"), React.createElement("i"), React.createElement("i")))));
  const submit = () => { if (text.trim()) { onAsk(tk, text.trim()); setText(""); } };
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
            onKeyDown: (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } } }),
          React.createElement("div", { className: "box-bar" },
            React.createElement("span", { className: "tool-toggle on" }, React.createElement(Icon, { name: "search", size: 13 }), T("toolSearch")),
            React.createElement("span", { className: "tool-toggle" }, React.createElement(Icon, { name: "barChart", size: 13 }), T("toolMarket")),
            React.createElement("div", { className: "spacer" }),
            React.createElement(ModelPicker, { models, value: model, onChange: setModel, up: true, compact: true, effort, setEffort }),
            React.createElement("button", { className: "send", disabled: !text.trim(), onClick: submit }, React.createElement(Icon, { name: "send", size: 17 }))))),
      React.createElement("div", { className: "home-grid-lab" }, T("chooseP")),
      React.createElement("div", { className: "kgrid" }, kols.map((k) =>
        React.createElement("button", { key: k.id, className: "kcard", style: { "--glow": k.accent + "22" }, onClick: () => onAsk(k, null) },
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
          model.name, " \u00b7 ", T("via"))),
      React.createElement(ToolGroup, { phases: r.phases, toolCalls: r.toolCalls || [], activePhase: msg.phase, done: msg.done }),
      msg.done
        ? React.createElement(React.Fragment, null,
            React.createElement(AnswerBlocks, { md: r.answerMd, onCite }),
            r.conviction != null && React.createElement(Conviction, { value: r.conviction }),
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
function Rail({ kol, sources, railTab, setRailTab, highlight, mobile }) {
  const scrollRef = uR(null);
  uE(() => {
    if (highlight && railTab === "sources" && scrollRef.current) {
      const el = scrollRef.current.querySelector("#cite-" + highlight);
      if (el) scrollRef.current.scrollTo({ top: el.offsetTop - 14, behavior: "smooth" });
    }
  }, [highlight, railTab]);
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
              sources.map((tw) => React.createElement(SourceCard, { key: tw.ref, kol, tw, active: highlight === tw.ref })))));
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
function Composer({ kol, onAsk, models, model, setModel, effort, setEffort, dynamicSuggestions }) {
  const [text, setText] = uS("");
  const [tools, setTools] = uS(true);
  const ta = uR(null);
  const suggs = (dynamicSuggestions && dynamicSuggestions.length ? dynamicSuggestions : (kol.suggested || [])).slice(0, 3);
  const submit = () => { if (text.trim()) { onAsk(text.trim()); setText(""); if (ta.current) ta.current.style.height = "auto"; } };
  return React.createElement("div", { className: "composer-wrap" },
    React.createElement("div", { className: "composer" },
      suggs.length > 0 && React.createElement("div", { className: "chips" }, suggs.map((s) =>
        React.createElement("button", { key: s, className: "chip", onClick: () => onAsk(s) }, s))),
      React.createElement("div", { className: "box" },
        React.createElement("textarea", {
          ref: ta, value: text, rows: 1, placeholder: T("composerPlaceholder")(kol.display_name),
          onChange: (e) => { setText(e.target.value); e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px"; },
          onKeyDown: (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } } }),
        React.createElement("div", { className: "box-bar" },
          React.createElement("button", { className: "tool-toggle" + (tools ? " on" : ""), onClick: () => setTools((t) => !t) }, React.createElement(Icon, { name: "search", size: 13 }), T("toolSearch")),
          React.createElement("span", { className: "tool-toggle" }, React.createElement(Icon, { name: "barChart", size: 13 }), T("toolMarket")),
          React.createElement("div", { className: "spacer" }),
          React.createElement(ModelPicker, { models, value: model, onChange: setModel, up: true, compact: true, effort, setEffort }),
          React.createElement("button", { className: "send", disabled: !text.trim(), onClick: submit }, React.createElement(Icon, { name: "send", size: 17 })))),
      React.createElement("div", { className: "composer-foot" }, React.createElement("b", null, kol.display_name), " ", T("composerFootB"), " ", T("composerFoot"))));
}

/* ============================ Thread + tabs (shared) ============================ */
function ChatArea({ kol, messages, model, tab, setTab, onCite, onWriteCode, onAsk, threadRef, models, modelId, setModel, effort, setEffort }) {
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
          React.createElement(Composer, { kol, onAsk, models, model: modelId, setModel, effort, setEffort, dynamicSuggestions: dynSuggs }))
      : React.createElement(CodePanel, { kol }));
}

/* ============================ App ============================ */
function App() {
  const [theme, setTheme] = uS(() => LS.get("theme", "aurora"));
  const [model, setModel] = uS(() => LS.get("model", "pro"));
  const [effort, setEffort] = uS(() => LS.get("effort", "high"));
  const [lang, setLangState] = uS(() => window.RXI.lang);
  const [user, setUser] = uS(() => LS.get("user", null));
  const [target, setTarget] = uS("qinbafrank");
  const [view, setView] = uS("home");
  const [tab, setTab] = uS("ask");
  const [showSettings, setShowSettings] = uS(false);
  const [chats, setChats] = uS(() => {
    const normalizeMsg = (m, kolId) => {
      if (m.role === "u" && m.text != null) return m;
      if (m.role === "k" && m.resp) return m;
      if (m.role === "user" || (m.role === "u" && m.content)) return { id: m.id || "n", role: "u", text: m.content || m.text || "" };
      if (m.role === "assistant" || m.role === "k") return { id: m.id || "n", role: "k", done: true,
        kol: { id: kolId, display_name: kolId === "qinbafrank" ? "Qinbafrank" : "Serenity", handle: kolId },
        resp: { phases: [{ key: "plan", label: "\u7406\u89e3", verb: "" }, { key: "rag", label: "\u68c0\u7d22", verb: "" }, { key: "rerank", label: "\u7b5b\u9009", verb: "" }, { key: "write", label: "\u751f\u6210", verb: "" }],
          answerMd: m.content || (m.resp && m.resp.answerMd) || "", conviction: null, toolCalls: [] }, streamText: "", error: null };
      return m;
    };
    const saved = LS.get("chats", null);
    if (saved && Array.isArray(saved)) {
      return saved.map((c) => ({ ...c, messages: (c.messages || []).map((m) => normalizeMsg(m, c.kol && c.kol.id)) }));
    }
    try {
      const old = JSON.parse(localStorage.getItem("robindex_convs") || "[]");
      const validPersonas = ["qinbafrank", "aleabitoreddit"];
      return old.filter((c) => validPersonas.includes(c.persona)).map((c) => {
        const kolId = c.persona;
        const msgs = (c.messages || []).map((m, i) => normalizeMsg({ ...m, id: "old_" + i }, kolId));
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
  const [userId] = uS(() => {
    let id = LS.get("userId", null);
    if (!id) { id = "u_" + crypto.randomUUID(); LS.set("userId", id); }
    return id;
  });
  const [active, setActive] = uS(null);
  const [messages, setMessages] = uS([]);
  const [railTab, setRailTab] = uS("persona");
  const [sources, setSources] = uS([]);
  const [highlight, setHighlight] = uS(null);
  const [mtab, setMtab] = uS("home");
  const [initDone, setInitDone] = uS(false);
  const [railWidth, setRailWidth] = uS(312);
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

  uE(() => { document.documentElement.setAttribute("data-theme", theme); LS.set("theme", theme); }, [theme]);
  uE(() => { LS.set("model", model); }, [model]);
  uE(() => { LS.set("effort", effort); }, [effort]);
  uE(() => { if (chats.length) LS.set("chats", chats); }, [chats]);
  uE(() => {
    if (active) {
      const url = new URL(window.location);
      url.searchParams.set("chat", active.id);
      history.replaceState(null, "", url);
    } else {
      const url = new URL(window.location);
      url.searchParams.delete("chat");
      history.replaceState(null, "", url);
    }
  }, [active]);
  uE(() => {
    if (active && messages.length) {
      setChats((prev) => {
        const idx = prev.findIndex((c) => c.id === active.id);
        if (idx < 0) return prev;
        const updated = { ...prev[idx], messages, ts: Date.now() };
        setActive(updated);
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
        const filtered = prev.filter((c) => validIds.has(c.kol.id));
        filtered.forEach((chat) => RX.saveChat(chat, userId));
        RX.loadHistory(userId).then((cloudChats) => {
          if (!cloudChats.length) return;
          setChats((cur) => {
            const localIds = new Set(cur.map((c) => c.id));
            const localKeys = new Set(cur.map((c) => c.kol.id + "::" + c.title));
            const newCloud = cloudChats.filter((c) => !localIds.has(c.id) && !localKeys.has(c.kol.id + "::" + c.title) && validIds.has(c.kol.id));
            if (newCloud.length) {
              const merged = [...newCloud, ...cur];
              const chatParam = new URL(window.location).searchParams.get("chat");
              if (chatParam) { const match = merged.find((c) => c.id === chatParam); if (match) { setActive(match); setView("chat"); setMtab("chat"); setMessages(match.messages || []); } }
              return merged;
            }
            return cur;
          });
        });
        const chatParam = new URL(window.location).searchParams.get("chat");
        if (chatParam) { const match = filtered.find((c) => c.id === chatParam); if (match) { setActive(match); setView("chat"); setMtab("chat"); setMessages(match.messages || []); } }
        return filtered;
      });
    });
  }, []);

  const setLang = (l) => { window.RXI.set(l); setLangState(l); document.documentElement.setAttribute("lang", l === "en" ? "en" : "zh"); };

  const openKol = (kol, firstQuestion) => {
    const chat = { id: uid(), kol, title: firstQuestion ? firstQuestion.slice(0, 22) : kol.display_name + (lang === "en" ? " \u00b7 new chat" : " \u00b7 \u65b0\u4f1a\u8bdd"), messages: [], ts: Date.now() };
    setChats((c) => [chat, ...c]);
    setActive(chat); setView("chat"); setTab("ask"); setMtab("chat");
    setMessages([]); setSources([]); setHighlight(null); setRailTab("persona");
    if (firstQuestion) setTimeout(() => ask(kol, firstQuestion), 60);
  };
  const openExisting = (chat) => {
    setActive(chat); setView("chat"); setTab("ask"); setMtab("chat");
    const saved = chat.messages || [];
    setMessages(saved);
    const lastK = saved.filter((m) => m.role === "k" && m.done);
    if (lastK.length) {
      const last = lastK[lastK.length - 1];
      const cites = last._citations || (last.resp && last.resp.citations) || [];
      console.log("[Desk] openExisting: citations found =", cites.length, "_citations =", !!(last._citations), "resp.citations =", !!(last.resp && last.resp.citations));
      if (cites.length) { setSources(cites); setRailTab("sources"); }
      else { setSources([]); setRailTab("persona"); }
    } else { setSources([]); setRailTab("persona"); }
  };

  const ask = (kol, question) => {
    const userMsg = { id: uid(), role: "u", text: question };
    const lang_ = window.RXI.lang;
    const ph = RX.phases(lang_);
    const kMsg = { id: uid(), role: "k", kol, resp: { phases: ph, toolCalls: [] }, phase: 0, done: false, streamText: "", error: null };
    setMessages((m) => [...m, userMsg, kMsg]);

    const toolCalls = [];

    if (RX.isBackendReady()) {
      RX.streamChat(kol.id, question, model, {
        onPhase: (idx) => {
          setMessages((m) => m.map((x) => x.id === kMsg.id ? { ...x, phase: Math.min(idx + 1, ph.length) } : x));
        },
        onMeta: (meta) => {
          const cites = (meta.citations || []).map((c, i) => ({
            ref: c.ref || ("T" + (i + 1)),
            date: c.date || "",
            likes: c.likes || 0,
            views: c.views || "",
            url: c.url || "",
            snippet: c.snippet || c.text || "",
          }));
          setSources(cites);
          setRailTab("sources");
          setHighlight(null);
          console.log("[Desk] onMeta: citations =", cites.length);
          setMessages((m) => m.map((x) => x.id === kMsg.id ? { ...x, _citations: cites, resp: { ...x.resp, citations: cites } } : x));
        },
        onToolCall: (tc) => {
          toolCalls.push({ name: tc.name || "tool", args: typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args || ""), result: {} });
          setMessages((m) => m.map((x) => x.id === kMsg.id ? { ...x, resp: { ...x.resp, toolCalls: [...toolCalls] } } : x));
        },
        onDelta: (fullText) => {
          setMessages((m) => m.map((x) => x.id === kMsg.id ? { ...x, streamText: fullText } : x));
        },
        onDone: (fullText, meta) => {
          const conviction = 60 + Math.floor(Math.random() * 25);
          setMessages((m) => m.map((x) => {
            if (x.id !== kMsg.id) return x;
            const cites = x._citations || x.resp.citations || [];
            return { ...x, done: true, phase: ph.length, streamText: "", _citations: cites,
              resp: { ...x.resp, answerMd: fullText, conviction, toolCalls: toolCalls, citations: cites } };
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
          setMessages((m) => m.map((x) => x.id === kMsg.id ? { ...x, done: true, error: err } : x));
        },
      });
    } else {
      setMessages((m) => m.map((x) => x.id === kMsg.id ? {
        ...x, done: true,
        resp: { ...x.resp, answerMd: T("composerFootB") + " " + kol.display_name + " \u2014 backend offline. Please deploy and try again.", conviction: 0 },
      } : x));
    }
  };

  const composerAsk = (question) => { if (curKol) ask(curKol, question); };
  const onCite = (ref) => { setRailTab("sources"); setHighlight(ref); if (mobile) setMtab("sources"); };
  const onWriteCode = () => setTab("code");
  const goHome = () => { setView("home"); setActive(null); setMtab("home"); };
  const signOut = () => { setUser(null); LS.set("user", null); setShowSettings(false); goHome(); };
  const doAuth = (u) => { setUser(u); LS.set("user", u); };

  if (!initDone) return React.createElement("div", { className: "auth" },
    React.createElement("div", { className: "auth-bg" }),
    React.createElement("div", { className: "auth-card", style: { textAlign: "center" } },
      React.createElement("div", { className: "auth-logo" }, React.createElement(Icon, { name: "candlestick", size: 22, color: "var(--on-accent)" })),
      React.createElement("div", { className: "thinking", style: { justifyContent: "center", marginTop: 16 } },
        React.createElement("span", null, "Loading"),
        React.createElement("span", { className: "tdots" }, React.createElement("i"), React.createElement("i"), React.createElement("i")))));

  if (!user) return React.createElement(window.AuthScreen, { onAuthed: doAuth, theme, setTheme, lang, setLang });

  const topRight = React.createElement(React.Fragment, null,
    React.createElement(window.LangToggle, { lang, setLang }),
    React.createElement(ThemeMenu, { value: theme, onChange: setTheme }),
    React.createElement("button", { className: "icon-btn", onClick: () => setShowSettings(true), title: T("setTitle") }, React.createElement(Icon, { name: "settings", size: 17 })));

  if (mobile) {
    let body;
    if (mtab === "home") body = React.createElement("div", { className: "m-body scrollable" }, React.createElement(Home, { kols, target, setTarget, onAsk: openKol, models, model, setModel, effort, setEffort }));
    else if (mtab === "chat") body = curKol
      ? React.createElement("div", { className: "m-body chat-body" },
          React.createElement("div", { className: "m-subtabs" },
            React.createElement("button", { className: "tab" + (tab === "ask" ? " on" : ""), onClick: () => setTab("ask") }, React.createElement(Icon, { name: "sparkles", size: 13 }), T("tabAsk")),
            React.createElement("button", { className: "tab" + (tab === "code" ? " on" : ""), onClick: () => setTab("code") }, React.createElement(Icon, { name: "code", size: 13 }), T("tabCode"), React.createElement("span", { className: "soon-tag-sm" }, "SOON"))),
          React.createElement(ChatArea, { kol: curKol, messages, model: curModel, tab, setTab, onCite, onWriteCode, onAsk: composerAsk, threadRef, models, modelId: model, setModel, effort, setEffort }))
      : React.createElement("div", { className: "m-body scrollable" }, React.createElement(MobileNoChat, { onHome: () => setMtab("home") }));
    else if (mtab === "sources") body = React.createElement("div", { className: "m-body" }, curKol
      ? React.createElement(Rail, { kol: curKol, sources, railTab, setRailTab, highlight, mobile: true })
      : React.createElement(MobileNoChat, { onHome: () => setMtab("home") }));
    else body = React.createElement("div", { className: "m-body scrollable" }, React.createElement(window.SettingsPage, { user, model, setModel, theme, setTheme, lang, setLang, onSignOut: signOut }));
    return React.createElement("div", { className: "app mobile" },
      React.createElement(window.MobileTopBar, { kol: mtab === "chat" ? curKol : null, lang, setLang, theme, setTheme }),
      body,
      React.createElement(window.BottomNav, { tab: mtab, setTab: setMtab, srcCount: sources.length }));
  }

  return React.createElement("div", { className: "app" },
    React.createElement(Sidebar, { kols, chats, activeChat: active, user, onPick: (k) => openKol(k, null), onOpenChat: openExisting, onHome: goHome, onSettings: () => setShowSettings(true) }),
    React.createElement("div", { className: "main" },
      React.createElement("div", { className: "topbar" },
        view === "chat" && curKol
          ? React.createElement("div", { className: "kol-id" },
              React.createElement(Avatar, { kol: curKol, size: 34, radius: 9, className: "face" }),
              React.createElement("div", { className: "meta" },
                React.createElement("div", { className: "nm" }, curKol.display_name, React.createElement("span", { className: "live-pill" }, React.createElement("span", { className: "dot" }), T("online"))),
                React.createElement("div", { className: "role" }, curKol.role)))
          : React.createElement("div", { className: "kol-id" },
              React.createElement("div", { className: "brand-mark", style: { width: 34, height: 34, borderRadius: 9 } }, React.createElement(Icon, { name: "candlestick", size: 18, color: "var(--on-accent)" })),
              React.createElement("div", { className: "meta" },
                React.createElement("div", { className: "nm" }, T("selectPersona")),
                React.createElement("div", { className: "role" }, T("deskSub")))),
        view === "chat" && React.createElement("div", { className: "tabs" },
          React.createElement("button", { className: "tab" + (tab === "ask" ? " on" : ""), onClick: () => setTab("ask") }, React.createElement(Icon, { name: "sparkles", size: 13 }), T("tabAsk")),
          React.createElement("button", { className: "tab" + (tab === "code" ? " on" : ""), onClick: () => setTab("code") }, React.createElement(Icon, { name: "code", size: 13 }), T("tabCode"), React.createElement("span", { className: "soon-tag-sm" }, "SOON"))),
        React.createElement("div", { className: "spacer" }),
        topRight),
      view === "home"
        ? React.createElement(Home, { kols, target, setTarget, onAsk: openKol, models, model, setModel, effort, setEffort })
        : React.createElement("div", { className: "center" },
            React.createElement(ChatArea, { kol: curKol, messages, model: curModel, tab, setTab, onCite, onWriteCode, onAsk: composerAsk, threadRef, models, modelId: model, setModel, effort, setEffort }),
            React.createElement("div", { className: "rail-wrap", style: { width: railWidth, minWidth: railWidth } },
              React.createElement("div", { className: "rail-resize", onMouseDown: onResizeDown }),
              React.createElement(Rail, { kol: curKol, sources, railTab, setRailTab, highlight })))),
    showSettings && React.createElement("div", { className: "set-overlay", onClick: (e) => { if (e.target.classList.contains("set-overlay")) setShowSettings(false); } },
      React.createElement(window.SettingsPage, { user, model, setModel, theme, setTheme, lang, setLang, onSignOut: signOut, onClose: () => setShowSettings(false) })));
}

function MobileNoChat({ onHome }) {
  return React.createElement("div", { className: "m-nochat" },
    React.createElement(Icon, { name: "sparkles", size: 26, color: "var(--ghost)" }),
    React.createElement("p", null, T("selectPersona")),
    React.createElement("button", { className: "auth-primary", style: { maxWidth: 220 }, onClick: onHome }, T("chooseP")));
}

ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(App));
