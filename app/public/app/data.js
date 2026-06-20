/* Robindex Desk — data layer with real backend integration + mock fallback.
   RX.init() fetches /api/kols and merges with frontend enrichment data.
   RX.streamChat() does real SSE streaming from /api/chat. */
(function () {
  const pick = (o, lang) => (o && typeof o === "object" && ("zh" in o || "en" in o)) ? (o[lang] || o.zh) : o;

  const MODELS = [
    { id: "pro", name: "DeepSeek V4 Pro", short: "Pro", provider: "DeepSeek", badge: "P4", color: "#4D6BFE",
      note: { zh: "深度分析 · 长链推理 · 多工具", en: "Deep analysis · long reasoning · tools" } },
    { id: "flash", name: "DeepSeek V4 Flash", short: "Flash", provider: "DeepSeek", badge: "F4", color: "#6E8BFF",
      note: { zh: "快速 · 低成本 · 日常追问", en: "Fast · low cost · quick follow-ups" } },
  ];

  const PHASES = [
    { key: "plan", label: { zh: "理解问题", en: "Understand" }, verb: { zh: "扩展检索词 · 识别标的", en: "expand queries · detect tickers" } },
    { key: "rag", label: { zh: "检索原文", en: "Retrieve" }, verb: { zh: "在博主全量推文中稀疏检索", en: "sparse search over full tweet corpus" } },
    { key: "rerank", label: { zh: "筛选证据", en: "Rerank" }, verb: { zh: "LLM 重排，选定来源推文", en: "LLM rerank, pick source tweets" } },
    { key: "write", label: { zh: "生成回答", en: "Generate" }, verb: { zh: "以博主第一人称 + 引用流式输出", en: "stream first-person answer + cites" } },
  ];

  const BACKEND_PHASE_MAP = {
    plan: 0,
    market: 1,
    rag: 1,
    tools: 2,
    thinking: 3,
  };

  const KOL_ENRICHMENT = {
    qinbafrank: {
      accent: "#3DDC97",
      role: { zh: "宏观传导 · AI 大趋势", en: "Macro transmission · AI megatrends" },
      bio: { zh: "宏观×产业×行情的判断链。AI 基础设施重定价、美股调整规律、加密与 TradFi 融合。看对继续努力，看错接受批评。",
        en: "Macro × industry × tape, as one judgment chain. AI infra repricing, US-equity drawdown patterns, crypto×TradFi convergence." },
      tagline: { zh: "把公司放回宏观与产业主线里复盘，按权重排序判断链。", en: "Put each name back into the macro & industry storyline, then rank the judgment chain." },
      thesis: { zh: "市场先看分母（利率、流动性、宏观止血信号），再回到分子（AI 算力、capex、商业化）。我的方法是自上而下定位主线，再用历史原文复盘判断有没有被验证或打脸。",
        en: "Markets price the denominator first (rates, liquidity, a macro 'stop-the-bleeding' signal), then return to the numerator (AI compute, capex, monetization). I locate the main line top-down, then replay my old posts to see if a call was confirmed or proven wrong." },
      style: { zh: ["宏观传导", "AI 主线", "美股节奏", "加密×TradFi", "复盘"], en: ["Macro", "AI thesis", "US tape", "Crypto×TradFi", "Post-mortem"] },
      corpus: { tweets: "13.7k", since: "2014", persona: "v2-mapreduce-2026-06-18" },
      stats: { followers: "284K", tweets: "13.7k" },
      suggested: {
        zh: ["你怎么看 CPO 延期，光互连 2026 真正受益的是谁？", "SpaceX 上市后，太空经济板块还能买吗？", "美伊停战、油价下行，对宏观和美股意味着什么？", "AI 成长股市盈率这么高，凭什么还能买？"],
        en: ["With CPO delayed, who actually benefits from optical interconnect in 2026?", "After SpaceX's IPO, is the space-economy basket still buyable?", "US–Iran truce and falling oil — what does it mean for macro & US equities?", "AI growth stocks trade at huge P/Es — why are they still buyable?"],
      },
    },
    aleabitoreddit: {
      accent: "#5B9DFF",
      role: { zh: "AI 半导体供应链 · 光子/CPO", en: "AI semis supply chain · photonics/CPO" },
      bio: { zh: "从 hyperscaler capex 往下拆，寻找少数公司绕不过去的 chokepoint。光子/CPO、底层瓶颈迁移、small-cap 高确信清单。",
        en: "Work down from hyperscaler capex to the chokepoints a few companies simply own. Photonics/CPO, bottleneck migration, high-conviction small-cap lists." },
      tagline: { zh: "沿客户需求往上游拆，找少数公司绕不过去的位置。", en: "Trace demand upstream to the positions only a few companies can occupy." },
      thesis: { zh: "AI 的钱从 hyperscaler capex 出发，沿着算力→网络→光互连→上游器件层层漏下来。我只找漏斗收窄处的 chokepoint：谁是绕不过去的瓶颈，谁就有定价权。优先盯被忽视的 small-cap。",
        en: "AI money starts at hyperscaler capex and drips down through compute → networking → optical interconnect → upstream components. I only hunt the chokepoints where the funnel narrows: whoever is the unavoidable bottleneck has pricing power. I prioritize overlooked small-caps." },
      style: { zh: ["供应链", "光子/CPO", "chokepoint", "small-cap", "capex 漏斗"], en: ["Supply chain", "Photonics/CPO", "Chokepoint", "Small-cap", "Capex funnel"] },
      corpus: { tweets: "5.9k", since: "2018", persona: "v2-mapreduce-2026-06-19" },
      stats: { followers: "96K", tweets: "5.9k" },
      suggested: {
        zh: ["AI capex 漏斗里，2026 哪个环节最绕不过去？", "光模块从 1.6T 到 CPO，瓶颈迁移到哪了？", "有哪些被忽视的 small-cap 供应链 chokepoint？", "硅光、InP 衬底、激光器，谁的定价权最强？"],
        en: ["In the AI capex funnel, which 2026 layer is most unavoidable?", "From 1.6T to CPO — where has the bottleneck migrated?", "Which overlooked small-cap supply-chain chokepoints exist?", "Silicon photonics, InP substrates, lasers — who has the most pricing power?"],
      },
    },
  };

  const AVATAR_URLS = {
    qinbafrank: "https://unavatar.io/x/qinbafrank",
    aleabitoreddit: "https://pbs.twimg.com/profile_images/1996176688414367744/LXfA_lIx_400x400.jpg",
  };

  function localizeKol(k, lang) {
    return {
      id: k.id, display_name: k.display_name, handle: k.handle,
      avatar_url: k.avatar_url || AVATAR_URLS[k.id] || "",
      accent: k.accent, role: pick(k.role, lang), bio: pick(k.bio, lang),
      tagline: pick(k.tagline, lang), thesis: pick(k.thesis, lang),
      style: pick(k.style, lang), suggested: pick(k.suggested, lang),
      corpus: k.corpus, stats: k.stats,
    };
  }

  let _kols = [];
  let _backendReady = false;
  let _config = { privyAppId: "client-clxxyzdummyappidforlocaldev" };

  function kols(lang) { return _kols.map((k) => localizeKol(k, lang)); }
  function phases(lang) { return PHASES.map((p) => ({ key: p.key, label: pick(p.label, lang), verb: pick(p.verb, lang) })); }

  async function init() {
    if (_backendReady) return;
    try {
      const [r, rConfig] = await Promise.all([
        fetch("/api/kols"),
        fetch("/api/config").catch(() => null)
      ]);
      if (rConfig && rConfig.ok) {
        const configJson = await rConfig.json();
        _config = { ..._config, ...configJson };
      }
      if (!r.ok) throw new Error("kols fetch failed");
      const j = await r.json();
      const backendKols = j.kols || [];
      _kols = backendKols.map((bk) => {
        const enrich = KOL_ENRICHMENT[bk.id] || {};
        return {
          id: bk.id,
          display_name: bk.display_name || bk.id,
          handle: bk.handle || bk.id,
          avatar_url: bk.avatar_url || AVATAR_URLS[bk.id] || "",
          accent: enrich.accent || "#3DDC97",
          role: enrich.role || bk.desc || "",
          bio: enrich.bio || bk.desc || "",
          tagline: enrich.tagline || "",
          thesis: enrich.thesis || "",
          style: enrich.style || [],
          corpus: enrich.corpus || { tweets: "—", since: "—", persona: "—" },
          stats: enrich.stats || { followers: "—", tweets: "—" },
          suggested: enrich.suggested || { zh: [], en: [] },
        };
      });
      _backendReady = true;
    } catch (e) {
      _kols = Object.entries(KOL_ENRICHMENT).map(([id, enrich]) => ({
        id, display_name: id === "qinbafrank" ? "Qinbafrank" : "Serenity",
        handle: id, avatar_url: AVATAR_URLS[id] || "",
        ...enrich,
      }));
      _backendReady = false;
    }
  }

  function isBackendReady() { return _backendReady; }

  async function streamChat(kolId, question, model, callbacks) {
    const { onPhase, onMeta, onToolCall, onDelta, onDone, onError } = callbacks;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kol_id: kolId, model, message: question }),
      });
      if (!res.ok) { onError("Server error: " + res.status); return; }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let fullText = "";
      let meta = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const events = buf.split("\n\n");
        buf = events.pop() || "";
        for (const ev of events) {
          let type = "message", data = "";
          for (const ln of ev.split("\n")) {
            if (ln.startsWith("event:")) type = ln.slice(6).trim();
            else if (ln.startsWith("data:")) data += ln.slice(5).trim();
          }
          if (!data) continue;
          try {
            const parsed = JSON.parse(data);
            if (type === "progress") {
              const phaseIdx = BACKEND_PHASE_MAP[parsed.phase] ?? 0;
              onPhase(phaseIdx, parsed.text);
            } else if (type === "meta") {
              meta = parsed;
              onMeta(parsed);
            } else if (type === "tool_call") {
              onToolCall(parsed);
            } else if (type === "delta") {
              fullText += parsed;
              onDelta(fullText);
            } else if (type === "error") {
              onError(parsed.message || "Unknown error");
              return;
            }
          } catch {}
        }
      }
      onDone(fullText, meta);
    } catch (e) {
      onError(e.message || "Network error");
    }
  }

  async function fetchSuggestions(kolId, question, answer) {
    try {
      const r = await fetch("/api/suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kol_id: kolId, question, answer }),
      });
      const j = await r.json();
      return j.suggestions || [];
    } catch { return []; }
  }

  function strategyFor(kol, lang) {
    const sym = kol.id === "aleabitoreddit" ? (lang === "en" ? "Optical basket" : "光互连篮子") : "RKLB";
    const c1 = lang === "en" ? `# Strategy generated by ${kol.display_name}'s persona · thesis → backtestable signal` : `# 策略由 ${kol.display_name} 分身生成 · 论点 → 可回测信号`;
    const c2 = lang === "en" ? `# Framework: ${pick(kol.tagline, lang) || kol.tagline}` : `# 框架: ${kol.tagline}`;
    const c3 = lang === "en" ? "# 1) Encode the persona's judgment chain into testable conditions" : "# 1) 把博主的判断链编码成可验证条件";
    const c4 = lang === "en" ? "# 2) Signal: order-momentum + valuation digestion (PEG)" : "# 2) 信号: 订单兑现动量 + 估值消化 (PEG)";
    const c5 = lang === "en" ? "# → backtest panel on the right" : "# → 右侧回测面板";
    const bt = [
      { v: "+34.2%", k: { zh: "年化收益", en: "Annualized" }, up: true },
      { v: "1.78", k: { zh: "夏普比率", en: "Sharpe" }, up: null },
      { v: "−16.8%", k: { zh: "最大回撤", en: "Max drawdown" }, up: false },
      { v: "61%", k: { zh: "胜率", en: "Win rate" }, up: null },
    ];
    return {
      filename: `strategy_${kol.id}.py`, title: lang === "en" ? `Generated by ${kol.display_name}'s persona` : `由 ${kol.display_name} 分身生成`, symbol: sym,
      lines: [
        ["cm", c1], ["cm", c2], ["", ""],
        ["kw", "import", " robindex ", "kw", "as", " rx"],
        ["kw", "from", " robindex ", "kw", "import", " signals, backtest"], ["", ""],
        ["cm", c3],
        ["var", "thesis ", "= rx.", "fn2", "persona", "(", "str", `"${kol.handle}"`, ").", "fn2", "thesis", "()"],
        ["var", "universe ", "= rx.", "fn2", "screen", "(thesis.tags, mcap=", "str", '"small-mid"', ")"], ["", ""],
        ["cm", c4],
        ["var", "entry ", "= (signals.", "fn2", "order_momentum", "(universe) > ", "num", "0", ")"],
        ["", "        & (signals.", "fn2", "peg", "(universe) < ", "num", "1.2", ")"],
        ["var", "exit  ", "= signals.", "fn2", "thesis_broken", "(universe, thesis)"], ["", ""],
        ["var", "pf ", "= backtest.", "fn2", "run", "(universe, entry, exit,"],
        ["", "    size=backtest.", "fn2", "risk_parity", "(target_vol=", "num", "0.18", "),"],
        ["", "    fees=", "num", "0.0005", ")"], ["", ""],
        ["fn2", "rx.report", "(pf)  ", "cm", c5],
      ],
      backtest: bt.map((b) => ({ v: b.v, k: pick(b.k, lang), up: b.up })),
    };
  }

  async function loadHistory(userId) {
    try {
      const r = await fetch(`/api/chat/history?user_id=${encodeURIComponent(userId)}`);
      if (!r.ok) return [];
      const j = await r.json();
      return (j.chats || []).map((c) => ({
        id: c.id,
        kol: { id: c.kol_id, display_name: c.kol_id, handle: c.kol_id,
          avatar_url: c.kol_id === "qinbafrank" ? "https://unavatar.io/x/qinbafrank" : "https://pbs.twimg.com/profile_images/1996176688414367744/LXfA_lIx_400x400.jpg",
          accent: c.kol_id === "qinbafrank" ? "#3DDC97" : "#5B9DFF",
          role: "", bio: "", tagline: "", thesis: "", style: [], corpus: { tweets: "\u2014", since: "\u2014", persona: "\u2014" }, stats: { followers: "\u2014", tweets: "\u2014" }, suggested: [] },
        title: c.title || c.kol_id,
        messages: JSON.parse(c.messages_json || "[]"),
        ts: new Date(c.updated_at).getTime() || Date.now(),
      }));
    } catch { return []; }
  }

  async function saveChat(chat, userId) {
    try {
      await fetch(`/api/chat/history/${encodeURIComponent(chat.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: userId, kol_id: chat.kol.id, title: chat.title,
          messages_json: JSON.stringify(chat.messages || []),
        }),
      });
    } catch {}
  }

  async function deleteChat(chatId, userId) {
    try {
      await fetch(`/api/chat/history/${encodeURIComponent(chatId)}?user_id=${encodeURIComponent(userId)}`, { method: "DELETE" });
    } catch {}
  }

  window.RX = { MODELS, kols, phases, init, isBackendReady, streamChat, fetchSuggestions, strategyFor, loadHistory, saveChat, deleteChat, get config() { return _config; } };
})();
