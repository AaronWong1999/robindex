/* Robindex — static landing page enhancements (theme, i18n, nav, reveal). SEO content lives in HTML. */
(function () {
  const THEMES = ["terminal", "aurora", "matrix", "codex"];
  const THEME_LABELS = { terminal: "Terminal", aurora: "Aurora", matrix: "Matrix", codex: "Codex" };
  const COPY = {
    zh: {
      navProduct: "产品", navPersonas: "分身", navHow: "原理", navPricing: "定价",
      open: "进入终端", login: "登录",
      heroPill: "金融版 AI 工作台 · 已接入 2 位 KOL 分身",
      h1a: "把交易判断，", h1b: "交给懂行的 AI 分身",
      heroSub: "选一位金融 KOL 的 AI 分身，用 ta 的判断框架回答你的每一个问题。答案逐句标注原文出处，可一键展开来源推文。模型、推理算力、界面风格，全都你说了算。",
      ctaPrimary: "进入终端", ctaGhost: "看它怎么工作",
      heroNote: "无需信用卡 · DeepSeek V4 全程可调 · 中英多语言",
      visTitle: "robindex.ai — AI Trader Desk",
      visQ: "你怎么看 CPO 延期，光互连 2026 真正受益的是谁？",
      visA1: "先给结论：", visABold: "CPO 是方向，但 2026 不是它的兑现年", visA2: "。真正兑现业绩的主力，是 1.6T 可插拔 + NPO 近封装",
      visSrcNote: "本回答引用 3 条原文",
      floatModel: "自选模型 · 算力", floatCite: "原文出处 · 可追溯",
      stripLab: "数据来自交易者真正在读的人",
      secProductEyebrow: "它能做什么",
      secProductH: "一个会用你信任的声音回答的交易台",
      secProductP: "三件事，让 Robindex 不只是又一个聊天机器人。",
      f1eye: "对话即研究", f1h: "向分身提问，得到带出处的判断",
      f1p: "不是泛泛的 AI 回答。每个结论都来自 KOL 本人的历史推文，逐句标注 [#]，点开就是原文。",
      f1l1: "第一人称分身：用 KOL 的框架与语气作答", f1l2: "稀疏检索 + LLM 重排，只引用真实发言", f1l3: "判断信心可视化，不确定就说不确定",
      f2eye: "你掌控算力", f2h: "自选模型与推理强度",
      f2p: "日常追问用 Flash，深度复盘切 Pro，再按需调高推理算力。账单透明，按消耗计费。",
      f2l1: "DeepSeek V4 Pro / Flash 实时切换", f2l2: "推理强度：低 / 中 / 高 / 超高", f2l3: "用量与额度一目了然",
      f3eye: "为你而生的界面", f3h: "四种风格，一个终端",
      f3p: "信号绿交易终端、苹果留白、磷光黑客风、极简 Codex——一键切换，PC 与手机自适应，可直接添加到主屏当 App 用。",
      f3l1: "Terminal / Aurora / Matrix / Codex 四主题", f3l2: "桌面、平板、手机全自适应", f3l3: "PWA：添加到主屏，秒变原生 App",
      howEye: "两步上手", howH: "从提问到可执行策略",
      howSub: "今天先让分身解答你的问题；很快，让分身把判断写成可回测的策略代码。",
      s1h: "选择分身", s1p: "从金融 KOL 的 AI 分身中挑一位，ta 的全量推文已被索引为云端知识库。",
      s2h: "提问并追问", s2p: "用自然语言提问，分身以第一人称作答，逐句给出原文出处，可继续深挖。",
      s3h: "生成策略代码", s3p: "一键把判断变成可回测的策略代码，绑定券商沙盒验证。即将上线。",
      soon: "即将上线",
      personasEye: "已上线分身", personasH: "都是交易者真正在追的人",
      p1bio: "宏观×产业×行情的判断链。AI 基础设施重定价、美股调整规律、加密与 TradFi 融合。",
      p2bio: "从 hyperscaler capex 往下拆，寻找少数公司绕不过去的 chokepoint。光子/CPO、small-cap 高确信清单。",
      followers: "关注",
      ctaH: "现在就让懂行的人回答你", ctaP: "选一位分身开始提问。",
      footTag: "金融 KOL 的 AI 分身交易研究终端。答案带原文出处，仅供研究，非投资建议。",
      fcProduct: "产品", fcPersonas: "分身", fcHow: "原理", fcPricing: "定价", fcApp: "进入终端",
      fcCompany: "公司", fcAbout: "关于", fcBlog: "博客", fcCareers: "招聘",
      fcLegal: "条款", fcTerms: "服务条款", fcPrivacy: "隐私政策", fcRisk: "风险提示",
      risk: "投资有风险，本平台内容仅供研究，不构成投资建议。",
      rights: "保留所有权利。",
      operatedBy: "由 SYNHEART GROUP LIMITED（心合集團有限公司）运营",
      mockRetrieval: "检索完成 · 4/4 阶段",
      mockReasoning: "推理强度",
      effLabels: ["低", "中", "高", "超高"],
      themeTerminal: "信号绿", themeAurora: "苹果留白", themeMatrix: "磷光黑客", themeCodex: "极简",
      src1: "一张图看清 26 年光互连哪些环节真正受益…",
      src2: "CPO 大规模落地推迟到 27-28；26 年主力是 1.6T + NPO…",
      mockPro: "深度分析 · 多工具", mockFlash: "快速 · 低成本",
    },
    en: {
      navProduct: "Product", navPersonas: "Personas", navHow: "How it works", navPricing: "Pricing",
      open: "Open terminal", login: "Log in",
      heroPill: "The AI desk for finance · 2 KOL personas live",
      h1a: "Hand your market calls to ", h1b: "AI personas who know the game",
      heroSub: "Pick a finance KOL's AI persona and get every question answered through their framework. Each claim is sourced sentence-by-sentence, expandable into the original tweet. You control the model, the reasoning effort, and the look.",
      ctaPrimary: "Open terminal", ctaGhost: "See how it works",
      heroNote: "No credit card · DeepSeek V4, fully tunable · multilingual",
      visTitle: "robindex.ai — AI Trader Desk",
      visQ: "With CPO delayed, who actually benefits from optical interconnect in 2026?",
      visA1: "Bottom line first: ", visABold: "CPO is the direction, but 2026 isn't its payoff year", visA2: ". What truly delivers is 1.6T pluggables + NPO near-package",
      visSrcNote: "This answer cites 3 sources",
      floatModel: "Your model · your compute", floatCite: "Sourced · traceable",
      stripLab: "Powered by the voices traders actually read",
      secProductEyebrow: "What it does",
      secProductH: "A trading desk that answers in a voice you trust",
      secProductP: "Three things make Robindex different from a generic chatbot.",
      f1eye: "Chat is research", f1h: "Ask a persona, get a sourced verdict",
      f1p: "Not generic AI answers. Every conclusion comes from the KOL's own tweets, tagged [#] sentence by sentence — tap to read the original.",
      f1l1: "First-person persona: answers in the KOL's framework & voice", f1l2: "Sparse retrieval + LLM rerank — cites only real posts", f1l3: "Conviction made visible; uncertainty stays honest",
      f2eye: "You own the compute", f2h: "Pick the model and the reasoning effort",
      f2p: "Flash for quick follow-ups, Pro for deep work, then dial reasoning effort up on demand. Transparent, usage-based billing.",
      f2l1: "Switch DeepSeek V4 Pro / Flash in real time", f2l2: "Reasoning effort: Low / Medium / High / Max", f2l3: "Usage and credits at a glance",
      f3eye: "An interface built for you", f3h: "Four looks, one terminal",
      f3p: "Signal-green terminal, Apple white-space, phosphor hacker, minimal Codex — switch in a tap. Adaptive on desktop and phone, add to home screen as an app.",
      f3l1: "Terminal / Aurora / Matrix / Codex themes", f3l2: "Adaptive across desktop, tablet, phone", f3l3: "PWA: add to home screen, instant native app",
      howEye: "Two steps", howH: "From a question to an executable strategy",
      howSub: "Today, personas answer your questions; soon, they turn judgment into backtestable strategy code.",
      s1h: "Choose a persona", s1p: "Pick a finance KOL's AI persona — their full tweet history is indexed into a cloud knowledge base.",
      s2h: "Ask and dig deeper", s2p: "Ask in natural language; the persona answers first-person, citing sources line by line, ready for follow-ups.",
      s3h: "Generate strategy code", s3p: "Turn judgment into backtestable strategy code, bound to a broker sandbox. Coming soon.",
      soon: "Coming soon",
      personasEye: "Live personas", personasH: "The people traders actually follow",
      p1bio: "Macro × industry × tape as one judgment chain. AI infra repricing, US-equity drawdown patterns, crypto×TradFi convergence.",
      p2bio: "Work down from hyperscaler capex to the chokepoints a few companies own. Photonics/CPO, high-conviction small-cap lists.",
      followers: "followers",
      ctaH: "Get answers from people who actually know", ctaP: "Pick a persona to start asking.",
      footTag: "AI persona trading-research terminal for finance KOLs. Every answer is sourced. Research only, not investment advice.",
      fcProduct: "Product", fcPersonas: "Personas", fcHow: "How it works", fcPricing: "Pricing", fcApp: "Open terminal",
      fcCompany: "Company", fcAbout: "About", fcBlog: "Blog", fcCareers: "Careers",
      fcLegal: "Legal", fcTerms: "Terms", fcPrivacy: "Privacy", fcRisk: "Risk disclosure",
      risk: "Investing carries risk. Content is for research only and is not investment advice.",
      rights: "All rights reserved.",
      operatedBy: "Operated by SYNHEART GROUP LIMITED (心合集團有限公司)",
      mockRetrieval: "retrieval complete · 4/4 stages",
      mockReasoning: "Reasoning effort",
      effLabels: ["Low", "Med", "High", "Max"],
      themeTerminal: "signal green", themeAurora: "apple white", themeMatrix: "phosphor", themeCodex: "minimal",
      src1: "One chart on which optical-interconnect links truly benefit in '26…",
      src2: "Mass CPO deployment slips to 2027-2028; the '26 driver is 1.6T + NPO…",
      mockPro: "deep analysis · tools", mockFlash: "fast · low cost",
    },
  };

  let lang = "zh";
  let theme = "aurora";
  let menuOpen = false;

  function getTheme() {
    try {
      const v = localStorage.getItem("rx.theme");
      if (v) return JSON.parse(v);
    } catch (e) {}
    return "aurora";
  }

  function setTheme(t) {
    theme = t;
    document.documentElement.setAttribute("data-theme", t);
    try { localStorage.setItem("rx.theme", JSON.stringify(t)); } catch (e) {}
    document.querySelectorAll("[data-theme-opt]").forEach((el) => {
      el.classList.toggle("on", el.getAttribute("data-theme-opt") === t);
    });
  }

  function uiT(key) {
    if (window.RXI && window.RXI.t) return window.RXI.t(key);
    const fall = { zh: { langTitle: "语言", langSoon: "即将" }, en: { langTitle: "Language", langSoon: "soon" } };
    return (fall[lang] || fall.zh)[key] || key;
  }

  function langDef(id) {
    const langs = window.RXLANGS || [];
    return langs.find((x) => x.id === id) || langs[0];
  }

  function updateLangCur() {
    const el = document.getElementById("langCur");
    const cur = langDef(lang);
    if (el && cur) el.textContent = cur.label;
    const toggle = document.getElementById("langToggle");
    if (toggle) toggle.setAttribute("aria-label", uiT("langTitle"));
    const menu = document.getElementById("langMenu");
    if (menu) menu.setAttribute("aria-label", uiT("langTitle"));
  }

  function renderLangMenu() {
    const menu = document.getElementById("langMenu");
    const head = document.getElementById("langMenuHead");
    if (!menu) return;
    if (head) head.textContent = uiT("langTitle");
    menu.querySelectorAll(".mp-item").forEach((el) => el.remove());
    const langs = window.RXLANGS || [];
    const checkSvg = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 12l5 5L19 7"/></svg>';
    langs.forEach((item) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "mp-item" + (item.active ? "" : " disabled");
      btn.setAttribute("data-lang", item.id);
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-selected", item.active && item.id === lang ? "true" : "false");
      if (!item.active) btn.disabled = true;
      const body = document.createElement("div");
      body.style.cssText = "min-width:0;flex:1";
      const nm = document.createElement("div");
      nm.className = "nm";
      nm.textContent = item.label;
      const sub = document.createElement("div");
      sub.className = "sub";
      sub.textContent = item.sub;
      body.appendChild(nm);
      body.appendChild(sub);
      btn.appendChild(body);
      if (!item.active) {
        const tag = document.createElement("span");
        tag.className = "soon-tag-sm";
        tag.textContent = uiT("langSoon");
        btn.appendChild(tag);
      } else if (item.id === lang) {
        btn.insertAdjacentHTML("beforeend", checkSvg);
      }
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!item.active) return;
        applyLang(item.id);
        menu.hidden = true;
        const toggle = document.getElementById("langToggle");
        if (toggle) toggle.setAttribute("aria-expanded", "false");
      });
      menu.appendChild(btn);
    });
  }

  function applyLang(l) {
    lang = l;
    if (window.RXI) window.RXI.set(l);
    const t = COPY[l] || COPY.en;
    document.documentElement.setAttribute("lang", l === "en" ? "en" : "zh");
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.getAttribute("data-i18n");
      if (t[key] != null) el.textContent = t[key];
    });
    document.querySelectorAll("[data-i18n-html]").forEach((el) => {
      const key = el.getAttribute("data-i18n-html");
      if (t[key] != null) el.innerHTML = t[key];
    });
    const eff = document.querySelector(".mock-eff");
    if (eff && t.effLabels) {
      eff.querySelectorAll("i").forEach((item, i) => { item.textContent = t.effLabels[i] || ""; });
    }
    try { localStorage.setItem("rx.lang", l); } catch (e) {}
    updateLangCur();
    renderLangMenu();
  }

  function initReveal() {
    const root = document.querySelector(".lp");
    if (root) root.classList.add("armed");
    const mark = () => {
      const h = window.innerHeight;
      document.querySelectorAll(".rv").forEach((el) => {
        if (el.classList.contains("in")) return;
        const r = el.getBoundingClientRect();
        if (r.top < h * 0.92 && r.bottom > 0) el.classList.add("in");
      });
    };
    mark();
    const io = new IntersectionObserver((es) => es.forEach((e) => {
      if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
    }), { threshold: 0, rootMargin: "0px 0px -6% 0px" });
    document.querySelectorAll(".rv").forEach((el) => io.observe(el));
    window.addEventListener("scroll", mark, { passive: true });
    setTimeout(mark, 120);
  }

  function initNav() {
    const nav = document.querySelector(".lnav");
    const burger = document.querySelector(".lnav-burger");
    const mobileMenu = document.querySelector(".lmobile-menu");
    const onScroll = () => nav && nav.classList.toggle("scrolled", window.scrollY > 20);
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    if (burger && mobileMenu) {
      burger.addEventListener("click", () => {
        menuOpen = !menuOpen;
        mobileMenu.hidden = !menuOpen;
        burger.setAttribute("aria-expanded", menuOpen ? "true" : "false");
      });
      mobileMenu.querySelectorAll("a").forEach((a) => {
        a.addEventListener("click", () => {
          menuOpen = false;
          mobileMenu.hidden = true;
          burger.setAttribute("aria-expanded", "false");
        });
      });
    }
  }

  function initThemeMenu() {
    const btn = document.querySelector(".theme-btn");
    const menu = document.querySelector(".theme-menu");
    if (!btn || !menu) return;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = menu.hidden;
      menu.hidden = !open;
      const langMenu = document.getElementById("langMenu");
      const langToggle = document.getElementById("langToggle");
      if (langMenu && open) {
        langMenu.hidden = true;
        if (langToggle) langToggle.setAttribute("aria-expanded", "false");
      }
    });
    document.addEventListener("click", () => { menu.hidden = true; });
    menu.querySelectorAll("[data-theme-opt]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        setTheme(el.getAttribute("data-theme-opt"));
        menu.hidden = true;
      });
    });
  }

  function initLangMenu() {
    const toggle = document.getElementById("langToggle");
    const menu = document.getElementById("langMenu");
    if (!toggle || !menu) return;
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = menu.hidden;
      menu.hidden = !open;
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      const themeMenu = document.querySelector(".theme-menu");
      if (themeMenu && open) themeMenu.hidden = true;
    });
    document.addEventListener("click", () => {
      menu.hidden = true;
      toggle.setAttribute("aria-expanded", "false");
    });
    menu.addEventListener("click", (e) => e.stopPropagation());
  }

  document.addEventListener("DOMContentLoaded", () => {
    theme = getTheme();
    setTheme(theme);
    try {
      const saved = localStorage.getItem("rx.lang");
      if (saved === "en" || saved === "zh") lang = saved;
    } catch (e) {}
    if (new URLSearchParams(location.search).get("lang") === "en") lang = "en";
    applyLang(lang);
    initLangMenu();
    initNav();
    initThemeMenu();
    initReveal();
    const visual = document.querySelector(".lvisual");
    if (visual) {
      const io = new IntersectionObserver((es) => es.forEach((e) => {
        if (e.isIntersecting) e.target.classList.add("in");
      }), { threshold: 0.2 });
      io.observe(visual);
    }
  });
})();
