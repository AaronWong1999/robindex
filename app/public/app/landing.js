/* Robindex — Antigravity-style marketing landing. Reuses RXC icons/pickers + theme tokens. */
const { useState: lS, useEffect: lE, useRef: lR } = React;
const { Icon } = window.RXC;

/* ---- landing copy (zh/en; other langs fall back to en) ---- */
const LP = {
  zh: {
    navProduct: "产品", navPersonas: "分身", navHow: "原理", navPricing: "定价",
    open: "进入终端", login: "登录",
    heroPill: "金融研究终端 · 带原文出处 · 自选模型或自带 API",
    h1a: "把每一次交易判断，", h1b: "交给真正懂行的 AI 分身",
    heroSub: "选一位金融 KOL 的 AI 分身，用 ta 的判断框架回答你的每一个问题。答案逐句标注原文出处，可一键展开来源推文。贴一张 K 线图直接问，模型与推理算力你来定——用平台积分，或填入自己的 API Key 直连。",
    ctaPrimary: "免费开始 · 每天 2 次", ctaGhost: "看它怎么工作",
    heroNote: "登录即用 · 免费版每天 2 次 Flash · 积分或自有 API 任选",
    visTitle: "robindex.ai — AI Trader Desk",
    visQ: "你怎么看 CPO 延期，光互连 2026 真正受益的是谁？",
    visA1: "先给结论：", visABold: "CPO 是方向，但 2026 不是它的兑现年", visA2: "。真正兑现业绩的主力，是 1.6T 可插拔 + NPO 近封装",
    visSrcNote: "本回答引用 3 条原文",
    floatModel: "15+ 模型 · 或自带 API", floatCite: "原文出处 · 可追溯",
    stripLab: "数据来自交易者真正在读的人",
    f1eye: "对话即研究", f1h: "向分身提问，得到带出处的判断",
    f1p: "不是泛泛的 AI 回答。每个结论都来自 KOL 本人的历史推文，逐句打上原文角标，点开就是原文。看不懂的图表，直接粘贴进来一起问。",
    f1l1: "第一人称分身：用 KOL 的框架与语气作答", f1l2: "只引用 KOL 本人真实发言，绝不杜撰出处", f1l3: "支持粘贴 K 线图、研报截图等多模态提问",
    f2eye: "算力与成本，你说了算", f2h: "自选模型，或直接用自己的 API",
    f2p: "日常追问用 Flash，深度复盘切 GLM-5.2 或 Kimi K2.7。用平台积分按实际 Token 用量结算，不同模型不同倍率；已有 Token Plan / API Key？填进来直连，平台不收积分。",
    f2l1: "15+ 模型实时切换：DeepSeek V4 · GLM-5.2 · Kimi K2.7 · MiniMax-M3", f2l2: "按 Token 实扣积分，倍率 0.06x–1.06x，用量透明", f2l3: "自带 API（BYOK）：填入自有 Key，免积分直连",
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
    ctaH: "现在就让懂行的人回答你", ctaP: "免费进入，选一位分身开始提问。",
    footTag: "金融 KOL 的 AI 分身交易研究终端。答案带原文出处，仅供研究，非投资建议。",
    fcProduct: "产品", fcPersonas: "分身", fcHow: "原理", fcPricing: "定价", fcApp: "进入终端",
    fcCompany: "公司", fcAbout: "关于", fcBlog: "博客", fcCareers: "招聘",
    fcLegal: "条款", fcTerms: "服务条款", fcPrivacy: "隐私政策", fcRisk: "风险提示",
    risk: "投资有风险，本平台内容仅供研究，不构成投资建议。",
    rights: "保留所有权利。",
    priceEye: "定价", priceH: "从免费开始，按需付费",
    priceSub: "登录即用，每天免费提问 2 次。要更多，就订阅你最想问的分身，或按需充值积分——也可以填入自己的 API Key，零积分直连。",
    pFreeName: "免费版", pFreePrice: "$0", pFreeUnit: "", pFreeNote: "登录即用",
    pFree: ["每天 2 次提问（DeepSeek V4 Flash）", "任意分身均可试用", "回答逐句带原文出处", "每 24 小时自动刷新"],
    pFreeCta: "免费进入终端",
    pSubName: "分身订阅", pSubBadge: "最受欢迎", pSubPrice: "$19.9", pSubUnit: "/月",
    pSubWas: "原价 $39.9 / 月", pSubNote: "连续订阅特价 · 可随时取消",
    pSub: ["订阅的分身无限提问", "解锁全部 15+ 模型", "每月赠 2,000 积分", "支持自带 API · 跨设备同步"],
    pSubCta: "选择分身订阅",
    pCreditName: "AI 积分", pCreditPrice: "$9.9 起", pCreditUnit: "", pCreditNote: "充值永不过期",
    pCredit: ["为所有内置模型提供算力", "按实际 Token 用量 × 模型倍率结算", "5,000 积分起，越大越划算", "或填入自有 API Key，零积分直连"],
    pCreditCta: "充值积分",
    priceFoot: "由 Stripe 安全收款 · 支持 Visa / Mastercard / Apple Pay。所有价格以美元计。",
  },
  en: {
    navProduct: "Product", navPersonas: "Personas", navHow: "How it works", navPricing: "Pricing",
    open: "Open terminal", login: "Log in",
    heroPill: "The finance-native research desk · sourced · your model or your API",
    h1a: "Hand every market call to ", h1b: "an AI persona who knows the game",
    heroSub: "Pick a finance KOL's AI persona and get every question answered through their framework. Each claim is sourced sentence-by-sentence, expandable into the original tweet. Paste a chart and just ask — you pick the model and the compute, paying in credits or plugging in your own API key.",
    ctaPrimary: "Start free · 2 a day", ctaGhost: "See how it works",
    heroNote: "Sign in and go · 2 free Flash questions a day · credits or your own API",
    visTitle: "robindex.ai — AI Trader Desk",
    visQ: "With CPO delayed, who actually benefits from optical interconnect in 2026?",
    visA1: "Bottom line first: ", visABold: "CPO is the direction, but 2026 isn't its payoff year", visA2: ". What truly delivers is 1.6T pluggables + NPO near-package",
    visSrcNote: "This answer cites 3 sources",
    floatModel: "15+ models · or your own API", floatCite: "Sourced · traceable",
    stripLab: "Powered by the voices traders actually read",
    f1eye: "Chat is research", f1h: "Ask a persona, get a sourced verdict",
    f1p: "Not generic AI answers. Every conclusion comes from the KOL's own tweets, with a citation mark on each sentence — tap to read the original. Stuck on a chart? Paste it straight in and ask.",
    f1l1: "First-person persona: answers in the KOL's framework & voice", f1l2: "Cites only the KOL's real posts — never invents a source", f1l3: "Multimodal: paste candlestick charts, research screenshots & more",
    f2eye: "Your compute, your call", f2h: "Pick a model — or bring your own API",
    f2p: "Flash for quick follow-ups, GLM-5.2 or Kimi K2.7 for deep work. Pay in credits metered by real token usage, each model at its own rate — or plug in your own Token Plan / API key and the platform charges nothing.",
    f2l1: "15+ models in real time: DeepSeek V4 · GLM-5.2 · Kimi K2.7 · MiniMax-M3", f2l2: "Billed per token, rates 0.06x–1.06x, fully transparent", f2l3: "BYOK: paste your own key and run on your own quota, credit-free",
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
    ctaH: "Get answers from people who actually know", ctaP: "Open it free and pick a persona to start asking.",
    footTag: "AI persona trading-research terminal for finance KOLs. Every answer is sourced. Research only, not investment advice.",
    fcProduct: "Product", fcPersonas: "Personas", fcHow: "How it works", fcPricing: "Pricing", fcApp: "Open terminal",
    fcCompany: "Company", fcAbout: "About", fcBlog: "Blog", fcCareers: "Careers",
    fcLegal: "Legal", fcTerms: "Terms", fcPrivacy: "Privacy", fcRisk: "Risk disclosure",
    risk: "Investing carries risk. Content is for research only and is not investment advice.",
    rights: "All rights reserved.",
    priceEye: "Pricing", priceH: "Start free, pay as you grow",
    priceSub: "Sign in and ask 2 questions free every day. Want more — subscribe to the persona you ask most, or top up AI credits on demand. Or plug in your own API key and run credit-free.",
    pFreeName: "Free", pFreePrice: "$0", pFreeUnit: "", pFreeNote: "Sign in and go",
    pFree: ["2 questions a day (DeepSeek V4 Flash)", "Try any persona", "Every answer sourced line by line", "Resets every 24 hours"],
    pFreeCta: "Open the terminal free",
    pSubName: "Persona subscription", pSubBadge: "Most popular", pSubPrice: "$19.9", pSubUnit: "/mo",
    pSubWas: "was $39.9 / mo", pSubNote: "Recurring promo · cancel anytime",
    pSub: ["Unlimited questions to that persona", "Unlock all 15+ models", "2,000 bonus credits / month", "Bring your own API · synced across devices"],
    pSubCta: "Choose a persona plan",
    pCreditName: "AI credits", pCreditPrice: "from $9.9", pCreditUnit: "", pCreditNote: "Credits never expire",
    pCredit: ["Compute for every built-in model", "Billed by real token usage × model rate", "From 5,000 credits — bigger is better value", "Or plug in your own API key, credit-free"],
    pCreditCta: "Top up credits",
    priceFoot: "Secured by Stripe · Visa / Mastercard / Apple Pay. All prices in USD.",
  },
};
const lt = (lang) => LP[lang] || LP.en;

const PERSONAS = [
  { id: "qinbafrank", name: "Qinbafrank", handle: "qinbafrank", avatar: "https://unavatar.io/x/qinbafrank", accent: "#3DDC97",
    followers: "284K", tags: { zh: ["宏观传导", "AI 主线", "美股节奏"], en: ["Macro", "AI thesis", "US tape"] } },
  { id: "aleabitoreddit", name: "Serenity", handle: "aleabitoreddit", avatar: "https://pbs.twimg.com/profile_images/1996176688414367744/LXfA_lIx_400x400.jpg", accent: "#5B9DFF",
    followers: "96K", tags: { zh: ["供应链", "光子/CPO", "chokepoint"], en: ["Supply chain", "Photonics/CPO", "Chokepoint"] } },
];

function useReveal() {
  lE(() => {
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
    const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }), { threshold: 0, rootMargin: "0px 0px -6% 0px" });
    document.querySelectorAll(".rv").forEach((el) => io.observe(el));
    window.addEventListener("scroll", mark, { passive: true });
    const id = setTimeout(mark, 120);
    return () => { io.disconnect(); window.removeEventListener("scroll", mark); clearTimeout(id); };
  }, []);
}

function Nav({ lang, setLang, theme, setTheme, onOpen, t }) {
  const [scrolled, setScrolled] = lS(false);
  const [menu, setMenu] = lS(false);
  const { ThemeMenu } = window.RXC;
  lE(() => { const h = () => setScrolled(window.scrollY > 20); window.addEventListener("scroll", h); return () => window.removeEventListener("scroll", h); }, []);
  const links = [["#product", t.navProduct], ["#personas", t.navPersonas], ["#how", t.navHow], ["#pricing", t.navPricing]];
  return React.createElement(React.Fragment, null,
    React.createElement("nav", { className: "lnav" + (scrolled ? " scrolled" : "") },
      React.createElement("a", { className: "lnav-brand", href: "#top" },
        React.createElement("div", { className: "lnav-mark" }, React.createElement(Icon, { name: "candlestick", size: 17, color: "var(--on-accent)" })),
        React.createElement("div", { className: "lnav-name" }, "Robindex ", React.createElement("span", null, "Desk"))),
      React.createElement("div", { className: "lnav-links" }, links.map(([h, l]) => React.createElement("a", { key: h, href: h }, l))),
      React.createElement("div", { className: "lnav-right" },
        React.createElement(window.LangToggle, { lang, setLang }),
        React.createElement(ThemeMenu, { value: theme, onChange: setTheme }),
        React.createElement("a", { className: "lnav-ghost", href: "Robindex Desk.html" }, t.login),
        React.createElement("a", { className: "lnav-cta", href: "Robindex Desk.html" }, t.open, React.createElement(Icon, { name: "arrowRight", size: 15 })),
        React.createElement("button", { className: "lnav-burger", onClick: () => setMenu((m) => !m) }, React.createElement(Icon, { name: menu ? "x" : "layers", size: 18 })))),
    menu && React.createElement("div", { className: "lmobile-menu" },
      links.map(([h, l]) => React.createElement("a", { key: h, href: h, onClick: () => setMenu(false) }, l)),
      React.createElement("a", { className: "lnav-cta", href: "Robindex Desk.html", style: { justifyContent: "center", marginTop: 12, padding: 15 } }, t.open)));
}

function Hero({ t, lang }) {
  return React.createElement("header", { className: "lhero", id: "top" },
    React.createElement("div", { className: "lhero-mesh" }),
    React.createElement("div", { className: "lhero-grid" }),
    React.createElement("div", { className: "lhero-inner" },
      React.createElement("div", { className: "lpill rv" }, React.createElement("span", { className: "dot" }), t.heroPill),
      React.createElement("h1", { className: "rv", style: { transitionDelay: ".05s" } }, t.h1a, React.createElement("em", null, t.h1b)),
      React.createElement("p", { className: "sub rv", style: { transitionDelay: ".1s" } }, t.heroSub),
      React.createElement("div", { className: "lhero-cta rv", style: { transitionDelay: ".15s" } },
        React.createElement("a", { className: "lbtn lbtn-primary", href: "Robindex Desk.html" }, t.ctaPrimary, React.createElement(Icon, { name: "arrowRight", size: 17 })),
        React.createElement("a", { className: "lbtn lbtn-ghost", href: "#how" }, React.createElement(Icon, { name: "play", size: 15 }), t.ctaGhost)),
      React.createElement("div", { className: "lhero-note rv", style: { transitionDelay: ".2s" } }, t.heroNote)),
    React.createElement(HeroVisual, { t, lang }));
}

function HeroVisual({ t, lang }) {
  const ref = lR(null);
  lE(() => {
    const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) e.target.classList.add("in"); }), { threshold: 0.2 });
    if (ref.current) io.observe(ref.current);
    return () => io.disconnect();
  }, []);
  return React.createElement("div", { className: "lvisual rv", ref, style: { transitionDelay: ".25s" } },
    React.createElement("div", { className: "lfloat f1" },
      React.createElement("span", { className: "mp-badge", style: { background: "#4D6BFE" } }, "P4"),
      React.createElement("div", null, React.createElement("b", null, "DeepSeek V4 Pro"), React.createElement("div", { className: "s" }, t.floatModel))),
    React.createElement("div", { className: "lfloat f2" },
      React.createElement(Icon, { name: "quote", size: 16, color: "var(--accent)" }),
      React.createElement("div", null, React.createElement("b", null,
        React.createElement("span", { className: "lvf-cite" }, "1"), React.createElement("span", { className: "lvf-cite" }, "2"), React.createElement("span", { className: "lvf-cite" }, "3")),
        React.createElement("div", { className: "s" }, t.floatCite))),
    React.createElement("div", { className: "lvisual-frame" },
      React.createElement("div", { className: "lvf-bar" },
        React.createElement("div", { className: "lvf-dots" }, React.createElement("i", { style: { background: "#FF5F57" } }), React.createElement("i", { style: { background: "#FEBC2E" } }), React.createElement("i", { style: { background: "#28C840" } })),
        React.createElement("div", { className: "lvf-title" }, t.visTitle)),
      React.createElement("div", { className: "lvf-body" },
        React.createElement("div", { className: "lvf-chat" },
          React.createElement("div", { className: "lvf-q" }, t.visQ),
          React.createElement("div", { className: "lvf-a" },
            React.createElement("img", { className: "lvf-src-av", src: PERSONAS[0].avatar, alt: "" }),
            React.createElement("div", { className: "lvf-ans" },
              t.visA1, React.createElement("b", null, t.visABold), React.createElement("span", { className: "lvf-cite" }, "1"),
              t.visA2, React.createElement("span", { className: "lvf-cite" }, "2"), "。"))),
        React.createElement("div", { className: "lvf-side" },
          React.createElement("div", { className: "lvf-side-h" }, t.visSrcNote),
          [["1", PERSONAS[0]], ["2", PERSONAS[0]]].map(([ref2, p], i) =>
            React.createElement("div", { className: "lvf-src", key: i },
              React.createElement("div", { className: "lvf-src-top" },
                React.createElement("img", { className: "lvf-src-av", src: p.avatar, alt: "" }),
                React.createElement("div", null, React.createElement("div", { className: "lvf-src-nm" }, p.name), React.createElement("div", { className: "lvf-src-h" }, "@" + p.handle)),
                React.createElement("span", { className: "lvf-src-ref" }, ref2)),
              React.createElement("div", { className: "lvf-src-tx" }, i === 0
                ? (lang === "en" ? "One chart on which optical-interconnect links truly benefit in '26…" : "一张图看清 26 年光互连哪些环节真正受益…")
                : (lang === "en" ? "Mass CPO deployment slips to 2027-2028; the '26 driver is 1.6T + NPO…" : "CPO 大规模落地推迟到 27-28；26 年主力是 1.6T + NPO…")))))))); 
}

function Strip({ t }) {
  return React.createElement("section", { className: "lstrip rv" },
    React.createElement("div", { className: "lstrip-lab" }, t.stripLab),
    React.createElement("div", { className: "lstrip-row" },
      PERSONAS.map((p) => React.createElement("span", { key: p.id },
        React.createElement("img", { src: p.avatar, alt: "", style: { width: 24, height: 24, borderRadius: "50%", objectFit: "cover" } }),
        "@" + p.handle)),
      React.createElement("span", null, React.createElement(Icon, { name: "xLogo", size: 15 }), "X / Twitter"),
      React.createElement("span", null, React.createElement("span", { className: "mp-badge", style: { background: "#4D6BFE", width: 20, height: 20, fontSize: 8, borderRadius: 5 } }, "V4"), "DeepSeek V4")));
}

function Feature({ num, eye, h, p, list, rev, visual }) {
  return React.createElement("div", { className: "lfeat rv" + (rev ? " rev" : "") },
    React.createElement("div", { className: "lfeat-text" },
      React.createElement("div", { className: "lfeat-num" }, num, " · ", eye),
      React.createElement("h3", null, h),
      React.createElement("p", null, p),
      React.createElement("div", { className: "lfeat-list" }, list.map((li, i) =>
        React.createElement("div", { className: "lfeat-li", key: i }, React.createElement(Icon, { name: "check", size: 16, color: "var(--accent)" }), li)))),
    React.createElement("div", { className: "lfeat-vis" }, visual));
}

function FeatVisChat({ t, lang }) {
  return React.createElement("div", null,
    React.createElement("div", { className: "mock-bar" }, React.createElement("i", { style: { background: "#FF5F57" } }), React.createElement("i", { style: { background: "#FEBC2E" } }), React.createElement("i", { style: { background: "#28C840" } }), "ask · " + PERSONAS[0].name),
    React.createElement("div", { className: "mock-pad" },
      React.createElement("div", { className: "mock-bar", style: { border: "1px solid var(--border)", borderRadius: 10, marginBottom: 12 } },
        React.createElement(Icon, { name: "cpu", size: 13, color: "var(--accent)" }), (lang === "en" ? "sourcing complete · 3 tweets cited" : "出处已匹配 · 引用 3 条推文")),
      React.createElement("div", { className: "mock-pipe" },
        [["scan.tweets", lang === "en" ? "history" : "全量推文"], ["match.source", lang === "en" ? "verbatim" : "原文"], ["cite.inline", lang === "en" ? "per-claim" : "逐句"]].map(([fn, ar], i) =>
          React.createElement("div", { className: "mock-step", key: i },
            React.createElement("span", { className: "ok" }, React.createElement(Icon, { name: "check", size: 10, color: "var(--accent)" })),
            React.createElement("span", { className: "fn" }, fn), React.createElement("span", { className: "ar" }, "(" + ar + ")")))),
      React.createElement("div", { className: "lvf-ans", style: { marginTop: 14, fontSize: 13 } },
        React.createElement("b", null, t.visABold), React.createElement("span", { className: "lvf-cite" }, "1"), " · ",
        React.createElement("span", { className: "lvf-cite" }, "2"), " · ", React.createElement("span", { className: "lvf-cite" }, "3"))));
}

function FeatVisModel({ lang }) {
  const efs = ["L", "M", "H", "X"]; const labels = lang === "en" ? ["Low", "Med", "High", "Max"] : ["低", "中", "高", "超高"];
  return React.createElement("div", { className: "mock-models" },
    React.createElement("div", { className: "mock-model on" },
      React.createElement("span", { className: "mp-badge", style: { background: "#4D6BFE" } }, "P4"),
      React.createElement("div", null, React.createElement("div", { className: "mock-mn" }, "DeepSeek V4 Pro"), React.createElement("div", { className: "mock-ms" }, lang === "en" ? "deep analysis · tools" : "深度分析 · 多工具")),
      React.createElement(Icon, { name: "check", size: 15, color: "var(--accent)", style: { marginLeft: "auto" } })),
    React.createElement("div", { className: "mock-model" },
      React.createElement("span", { className: "mp-badge", style: { background: "#6E8BFF" } }, "F4"),
      React.createElement("div", null, React.createElement("div", { className: "mock-mn" }, "DeepSeek V4 Flash"), React.createElement("div", { className: "mock-ms" }, lang === "en" ? "fast · low cost" : "快速 · 低成本"))),
    React.createElement("div", { style: { marginTop: 4 } },
      React.createElement("div", { className: "lvf-side-h", style: { marginBottom: 8 } }, lang === "en" ? "Reasoning effort" : "推理强度"),
      React.createElement("div", { className: "mock-eff" }, efs.map((e, i) =>
        React.createElement("i", { key: e, className: i === 2 ? "on" : "" }, labels[i])))));
}

function FeatVisThemes({ lang }) {
  const themes = [
    { n: "Terminal", d: lang === "en" ? "signal green" : "信号绿", sw: ["#0A0B0D", "#3DDC97", "#5B9DFF"] },
    { n: "Aurora", d: lang === "en" ? "apple white" : "苹果留白", sw: ["#FBFBFD", "#0071E3", "#1D1D1F"] },
    { n: "Matrix", d: lang === "en" ? "phosphor" : "磷光黑客", sw: ["#000000", "#00FF85", "#0C1A0E"] },
    { n: "Codex", d: lang === "en" ? "minimal" : "极简", sw: ["#0D0D0D", "#ECECEC", "#19C37D"] },
  ];
  return React.createElement("div", { className: "mock-themes" }, themes.map((th) =>
    React.createElement("div", { className: "mock-theme", key: th.n },
      React.createElement("div", { className: "mock-theme-sw" }, th.sw.map((c, i) => React.createElement("i", { key: i, style: { background: c } }))),
      React.createElement("div", { className: "mock-theme-lab" }, th.n, React.createElement("span", null, th.d)))));
}

function Steps({ t }) {
  const steps = [["1", t.s1h, t.s1p, false], ["2", t.s2h, t.s2p, false], ["3", t.s3h, t.s3p, true]];
  return React.createElement("section", { className: "lsec", id: "how" },
    React.createElement("div", { className: "lsec-head rv" },
      React.createElement("span", { className: "lsec-eyebrow" }, t.howEye),
      React.createElement("h2", null, t.howH),
      React.createElement("p", null, t.howSub)),
    React.createElement("div", { className: "lsteps" }, steps.map(([n, h, p, soon]) =>
      React.createElement("div", { className: "lstep rv", key: n },
        React.createElement("div", { className: "lstep-n" }, n),
        React.createElement("h4", null, h, soon && React.createElement("span", { className: "soon-tag-sm", style: { marginLeft: 8 } }, t.soon)),
        React.createElement("p", null, p)))));
}

function Personas({ t, lang }) {
  return React.createElement("section", { className: "lsec", id: "personas" },
    React.createElement("div", { className: "lsec-head rv" },
      React.createElement("span", { className: "lsec-eyebrow" }, t.personasEye),
      React.createElement("h2", null, t.personasH)),
    React.createElement("div", { className: "lpersonas" }, PERSONAS.map((p, i) =>
      React.createElement("a", { className: "lpcard rv", key: p.id, href: "Robindex Desk.html" },
        React.createElement("img", { src: p.avatar, alt: p.name }),
        React.createElement("div", { style: { flex: 1, minWidth: 0 } },
          React.createElement("div", { className: "lpcard-nm" }, p.name, React.createElement(Icon, { name: "xLogo", size: 12, color: "var(--faint)" })),
          React.createElement("div", { className: "lpcard-h" }, "@" + p.handle),
          React.createElement("div", { className: "lpcard-bio" }, i === 0 ? t.p1bio : t.p2bio),
          React.createElement("div", { className: "lpcard-tags" }, (p.tags[lang] || p.tags.en).map((tg) => React.createElement("span", { key: tg }, tg)))),
        React.createElement("div", { className: "lpcard-stat" },
          React.createElement("div", { className: "v" }, p.followers),
          React.createElement("div", { className: "k" }, t.followers))))));
}

function Pricing({ t }) {
  const cards = [
    { name: t.pFreeName, price: t.pFreePrice, unit: t.pFreeUnit, note: t.pFreeNote, was: null, feats: t.pFree, cta: t.pFreeCta, kind: "free" },
    { name: t.pSubName, price: t.pSubPrice, unit: t.pSubUnit, note: t.pSubNote, was: t.pSubWas, feats: t.pSub, cta: t.pSubCta, kind: "sub", badge: t.pSubBadge },
    { name: t.pCreditName, price: t.pCreditPrice, unit: t.pCreditUnit, note: t.pCreditNote, was: null, feats: t.pCredit, cta: t.pCreditCta, kind: "credit" },
  ];
  return React.createElement("section", { className: "lsec lprice", id: "pricing" },
    React.createElement("div", { className: "lsec-head rv" },
      React.createElement("span", { className: "lsec-eyebrow" }, t.priceEye),
      React.createElement("h2", null, t.priceH),
      React.createElement("p", null, t.priceSub)),
    React.createElement("div", { className: "lprice-grid" }, cards.map((c) =>
      React.createElement("a", { key: c.name, className: "lprice-card rv" + (c.kind === "sub" ? " feat" : ""), href: "Robindex Desk.html" },
        c.badge && React.createElement("span", { className: "lprice-badge" }, c.badge),
        React.createElement("div", { className: "lprice-name" },
          c.kind === "sub" ? React.createElement(Icon, { name: "crown", size: 15, color: "var(--accent)" }) : c.kind === "credit" ? React.createElement(Icon, { name: "zap", size: 15, color: "var(--accent)" }) : null,
          c.name),
        React.createElement("div", { className: "lprice-price" }, c.price, c.unit && React.createElement("span", null, c.unit)),
        c.was ? React.createElement("div", { className: "lprice-was" }, c.was) : React.createElement("div", { className: "lprice-note" }, c.note),
        React.createElement("div", { className: "lprice-feats" }, c.feats.map((f, i) =>
          React.createElement("div", { className: "lprice-li", key: i }, React.createElement(Icon, { name: "check", size: 15, color: "var(--accent)" }), React.createElement("span", null, f)))),
        React.createElement("div", { className: "lprice-cta" + (c.kind === "sub" ? " primary" : "") }, c.cta, React.createElement(Icon, { name: "arrowRight", size: 15 })))),
    ),
    React.createElement("div", { className: "lprice-foot rv" }, t.priceFoot));
}

function CTA({ t }) {
  return React.createElement("section", { className: "lcta", id: "start" },
    React.createElement("div", { className: "lcta-inner rv" },
      React.createElement("div", { className: "lcta-mesh" }),
      React.createElement("h2", null, t.ctaH),
      React.createElement("p", null, t.ctaP),
      React.createElement("div", { className: "lhero-cta" },
        React.createElement("a", { className: "lbtn lbtn-primary", href: "Robindex Desk.html" }, t.ctaPrimary, React.createElement(Icon, { name: "arrowRight", size: 17 })))));
}

function Footer({ t }) {
  const cols = [
    [t.fcProduct, [[t.fcPersonas, "#personas"], [t.fcHow, "#how"], [t.fcPricing, "#pricing"], [t.fcApp, "Robindex Desk.html"]]],
    [t.fcCompany, [[t.fcAbout, "#"], [t.fcBlog, "#"], [t.fcCareers, "#"]]],
    [t.fcLegal, [[t.fcTerms, "#"], [t.fcPrivacy, "#"], [t.fcRisk, "#"]]],
  ];
  return React.createElement("footer", { className: "lfoot" },
    React.createElement("div", { className: "lfoot-inner" },
      React.createElement("div", { className: "lfoot-brand" },
        React.createElement("a", { className: "lnav-brand", href: "#top" },
          React.createElement("div", { className: "lnav-mark" }, React.createElement(Icon, { name: "candlestick", size: 17, color: "var(--on-accent)" })),
          React.createElement("div", { className: "lnav-name" }, "Robindex ", React.createElement("span", null, "Desk"))),
        React.createElement("p", null, t.footTag)),
      React.createElement("div", { className: "lfoot-cols" }, cols.map(([h, links]) =>
        React.createElement("div", { className: "lfoot-col", key: h },
          React.createElement("h5", null, h),
          links.map(([l, href]) => React.createElement("a", { key: l, href }, l)))))),
    React.createElement("div", { className: "lfoot-base" },
      React.createElement("span", { className: "risk" }, t.risk),
      React.createElement("span", null, "© 2026 Robindex · ", t.rights)));
}

function Landing() {
  const [theme, setTheme] = lS(() => { try { const v = localStorage.getItem("rx.theme"); return v ? JSON.parse(v) : "aurora"; } catch (e) { return "aurora"; } });
  const [lang, setLangState] = lS(() => window.RXI.lang);
  const t = lt(lang);
  lE(() => { document.documentElement.setAttribute("data-theme", theme); try { localStorage.setItem("rx.theme", JSON.stringify(theme)); } catch (e) {} }, [theme]);
  const setLang = (l) => { window.RXI.set(l); setLangState(l); document.documentElement.setAttribute("lang", l === "en" ? "en" : "zh"); };
  useReveal();
  // re-run reveal when language/theme changes layout height
  lE(() => { const id = setTimeout(() => document.querySelectorAll(".rv").forEach((el) => { const r = el.getBoundingClientRect(); if (r.top < window.innerHeight * 0.9) el.classList.add("in"); }), 60); return () => clearTimeout(id); }, [lang]);
  return React.createElement("div", { className: "lp" },
    React.createElement(Nav, { lang, setLang, theme, setTheme, t }),
    React.createElement(Hero, { t, lang }),
    React.createElement(Strip, { t }),
    React.createElement("section", { className: "lsec", id: "product" },
      React.createElement("div", { className: "lsec-head rv" },
        React.createElement("span", { className: "lsec-eyebrow" }, lang === "en" ? "What it does" : "它能做什么"),
        React.createElement("h2", null, lang === "en" ? "A trading desk that answers in a voice you trust" : "一个会用你信任的声音回答的交易台"),
        React.createElement("p", null, lang === "en" ? "Three things make Robindex different from a generic chatbot." : "三件事，让 Robindex 不只是又一个聊天机器人。")),
      React.createElement(Feature, { num: "01", eye: t.f1eye, h: t.f1h, p: t.f1p, list: [t.f1l1, t.f1l2, t.f1l3], visual: React.createElement(FeatVisChat, { t, lang }) }),
      React.createElement(Feature, { num: "02", eye: t.f2eye, h: t.f2h, p: t.f2p, list: [t.f2l1, t.f2l2, t.f2l3], rev: true, visual: React.createElement(FeatVisModel, { lang }) }),
      React.createElement(Feature, { num: "03", eye: t.f3eye, h: t.f3h, p: t.f3p, list: [t.f3l1, t.f3l2, t.f3l3], visual: React.createElement(FeatVisThemes, { lang }) })),
    React.createElement(Steps, { t }),
    React.createElement(Personas, { t, lang }),
    React.createElement(Pricing, { t }),
    React.createElement(CTA, { t }),
    React.createElement(Footer, { t }));
}

ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(Landing));
