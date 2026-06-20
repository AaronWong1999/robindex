/* Robindex — Login gate: branded welcome screen + Privy native modal */
const { useState: useStateA } = React;
const T = (k) => window.RXI.t(k);

function LoginGate({ privy, theme, setTheme, lang, setLang }) {
  const { Icon, ThemeMenu } = window.RXC;
  const [loading, setLoading] = useStateA(false);
  const [error, setError] = useStateA(null);

  const handleSignIn = () => {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      if (!privy || typeof privy.login !== "function") {
        setError(window.RXI.lang === "en" ? "Login service not ready. Please refresh the page." : "\u767b\u5f55\u670d\u52a1\u672a\u5c31\u7eea\uff0c\u8bf7\u5237\u65b0\u9875\u9762\u3002");
        setLoading(false);
        return;
      }
      console.log("[LoginGate] Calling privy.login with methods: email, google");
      privy.login({ loginMethods: ['email', 'google'] });
      // Privy modal takes over — reset loading after a short delay in case login is cancelled
      setTimeout(() => setLoading(false), 2000);
    } catch (err) {
      console.error("[LoginGate] privy.login error:", err);
      setError(err.message || "Login failed");
      setLoading(false);
    }
  };

  return React.createElement("div", { className: "auth" },
    React.createElement("div", { className: "auth-bg" }),
    React.createElement("div", { className: "auth-top" },
      React.createElement(LangToggle, { lang, setLang }),
      React.createElement(ThemeMenu, { value: theme, onChange: setTheme })),
    React.createElement("div", { className: "auth-card" },
      React.createElement("div", { className: "auth-logo" }, React.createElement(Icon, { name: "candlestick", size: 22, color: "var(--on-accent)" })),
      React.createElement("h1", { className: "auth-h" }, T("authTitle")),
      React.createElement("p", { className: "auth-sub" }, T("authSub")),
      error && React.createElement("div", { style: { color: "var(--down)", marginBottom: 12, fontSize: 13, textAlign: "center" } }, error),
      React.createElement("button", { className: "auth-primary", onClick: handleSignIn, disabled: loading, style: loading ? { opacity: 0.6, cursor: "wait" } : undefined },
        loading
          ? React.createElement(React.Fragment, null,
              React.createElement("span", { className: "tdots", style: { display: "inline-flex" } },
                React.createElement("i"), React.createElement("i"), React.createElement("i")))
          : React.createElement(React.Fragment, null,
              T("authSignIn"),
              React.createElement(Icon, { name: "arrowRight", size: 16 }))),
      React.createElement("div", { className: "auth-foot" },
        React.createElement("span", { className: "auth-protected" },
          React.createElement("span", { dangerouslySetInnerHTML: { __html: '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>' } }),
          " ", T("authProtected")),
        React.createElement("div", { className: "auth-terms" }, T("authTerms")))));
}

function LangToggle({ lang, setLang }) {
  const { Icon } = window.RXC;
  const [open, setOpen] = useStateA(false);
  const ref = React.useRef(null);
  React.useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", h); return () => document.removeEventListener("mousedown", h);
  }, []);
  const langs = window.RXLANGS;
  const cur = langs.find((l) => l.id === lang) || langs[0];
  return React.createElement("div", { className: "mp", ref },
    React.createElement("button", { className: "lang-toggle", onClick: () => setOpen((o) => !o), title: "Language" },
      React.createElement(Icon, { name: "globe", size: 14, color: "var(--faint)" }),
      React.createElement("span", { className: "lt-cur" }, cur.label),
      React.createElement(Icon, { name: "chevronDown", size: 12, color: "var(--faint)" })),
    open && React.createElement("div", { className: "mp-menu lang-menu" },
      React.createElement("div", { className: "mp-head" }, T("langTitle")),
      langs.map((l) => React.createElement("button", {
        key: l.id, className: "mp-item" + (l.active ? "" : " disabled"), disabled: !l.active,
        onClick: () => { if (l.active) { setLang(l.id); setOpen(false); } } },
        React.createElement("div", { style: { minWidth: 0, flex: 1 } },
          React.createElement("div", { className: "nm" }, l.label),
          React.createElement("div", { className: "sub" }, l.sub)),
        !l.active && React.createElement("span", { className: "soon-tag-sm" }, T("langSoon")),
        l.active && l.id === lang && React.createElement(Icon, { name: "check", size: 15, color: "var(--accent)" })))));
}

window.LoginGate = LoginGate;
window.LangToggle = LangToggle;
