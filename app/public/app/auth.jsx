/* Robindex — Privy-style login / register screen */
const { useState: useStateA } = React;
const T = (k) => window.RXI.t(k);

const BRAND_ICONS = {
  google: '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="#4285F4" d="M22.5 12.2c0-.8-.07-1.4-.2-2.1H12v3.9h5.9a5 5 0 0 1-2.2 3.3v2.7h3.6c2.1-1.9 3.2-4.8 3.2-7.8z"/><path fill="#34A853" d="M12 23c2.9 0 5.4-1 7.2-2.6l-3.6-2.7c-1 .7-2.3 1.1-3.6 1.1-2.8 0-5.1-1.9-6-4.4H2.3v2.8A10.9 10.9 0 0 0 12 23z"/><path fill="#FBBC05" d="M6 14.3a6.5 6.5 0 0 1 0-4.2V7.3H2.3a11 11 0 0 0 0 9.8L6 14.3z"/><path fill="#EA4335" d="M12 5.4c1.6 0 3 .55 4.1 1.6l3.1-3.1A10.9 10.9 0 0 0 12 1 10.9 10.9 0 0 0 2.3 7.3L6 10.1C6.9 7.5 9.2 5.4 12 5.4z"/></svg>',
  apple: '<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor"><path d="M16.4 12.7c0-2.3 1.9-3.4 2-3.5-1.1-1.6-2.8-1.8-3.4-1.8-1.4-.15-2.8.85-3.5.85-.7 0-1.85-.83-3-.8-1.55.02-3 .9-3.8 2.3-1.6 2.8-.4 7 1.2 9.3.78 1.1 1.7 2.4 2.9 2.35 1.16-.05 1.6-.75 3-.75s1.8.75 3 .73c1.24-.02 2-1.13 2.8-2.25.88-1.3 1.24-2.55 1.26-2.6-.03-.02-2.4-.92-2.4-3.6zM14.1 5.6c.63-.77 1.06-1.84.94-2.9-.9.04-2 .6-2.66 1.36-.58.67-1.1 1.76-.96 2.8 1.01.08 2.04-.5 2.68-1.26z"/></svg>',
  wallet: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v1H5a2 2 0 0 0 0 4h14a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="16.5" cy="13" r="1.3" fill="currentColor" stroke="none"/></svg>',
  x: '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M18.24 2.25h3.31l-7.23 8.26 8.5 11.24H16.2l-5.21-6.82L4.99 21.75H1.68l7.73-8.84L1.25 2.25H8.08l4.71 6.23 5.45-6.23zm-1.16 17.52h1.83L7.08 4.13H5.12l11.96 15.64z"/></svg>',
  lock: '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
};
function Brand({ name }) { return React.createElement("span", { className: "brand-glyph", dangerouslySetInnerHTML: { __html: BRAND_ICONS[name] } }); }

function AuthScreen({ onAuthed, theme, setTheme, lang, setLang }) {
  const { Icon, ThemeMenu } = window.RXC;
  const [step, setStep] = useStateA("email");
  const [email, setEmail] = useStateA("");
  const [code, setCode] = useStateA("");
  const valid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());
  return React.createElement("div", { className: "auth" },
    React.createElement("div", { className: "auth-bg" }),
    React.createElement("div", { className: "auth-top" },
      React.createElement(LangToggle, { lang, setLang }),
      React.createElement(ThemeMenu, { value: theme, onChange: setTheme })),
    React.createElement("div", { className: "auth-card" },
      React.createElement("div", { className: "auth-logo" }, React.createElement(Icon, { name: "candlestick", size: 22, color: "var(--on-accent)" })),
      React.createElement("h1", { className: "auth-h" }, T("authTitle")),
      React.createElement("p", { className: "auth-sub" }, T("authSub")),
      step === "email"
        ? React.createElement(React.Fragment, null,
            React.createElement("label", { className: "auth-field" + (valid ? " ok" : "") },
              React.createElement(Icon, { name: "user", size: 16, color: "var(--faint)" }),
              React.createElement("input", {
                type: "email", value: email, placeholder: T("authEmail"), autoFocus: true,
                onChange: (e) => setEmail(e.target.value),
                onKeyDown: (e) => { if (e.key === "Enter" && valid) setStep("code"); } })),
            React.createElement("button", { className: "auth-primary", disabled: !valid, onClick: () => setStep("code") },
              T("authContinue"), React.createElement(Icon, { name: "arrowRight", size: 16 })),
            React.createElement("div", { className: "auth-or" }, React.createElement("span", null, T("authOr"))),
            React.createElement("button", { className: "auth-social", onClick: () => onAuthed({ method: "google", email: "trader@gmail.com" }) },
              React.createElement(Brand, { name: "google" }), T("authGoogle")),
            React.createElement("button", { className: "auth-social", onClick: () => onAuthed({ method: "apple", email: "trader@icloud.com" }) },
              React.createElement(Brand, { name: "apple" }), T("authApple")),
            React.createElement("button", { className: "auth-social", onClick: () => onAuthed({ method: "x", email: "@trader" }) },
              React.createElement(Brand, { name: "x" }), T("authX")),
            React.createElement("button", { className: "auth-wallet", onClick: () => onAuthed({ method: "wallet", email: "0x7f…3Ab2" }) },
              React.createElement(Brand, { name: "wallet" }),
              React.createElement("div", { style: { textAlign: "left", flex: 1 } },
                React.createElement("div", { className: "aw-t" }, T("authWallet")),
                React.createElement("div", { className: "aw-s" }, T("authWalletSub"))),
              React.createElement(Icon, { name: "chevronRight", size: 16, color: "var(--faint)" })))
        : React.createElement(React.Fragment, null,
            React.createElement("button", { className: "auth-back", onClick: () => setStep("email") },
              React.createElement(Icon, { name: "chevronRight", size: 14, style: { transform: "rotate(180deg)" } }), T("authBackeso")),
            React.createElement("div", { className: "auth-code-lab" }, T("authCodeTitle")),
            React.createElement("div", { className: "auth-code-sub" }, T("authCodeSub")(email)),
            React.createElement("div", { className: "code-wrap" },
              React.createElement("div", { className: "code-cells" },
                [0, 1, 2, 3, 4, 5].map((i) => React.createElement("div", { key: i, className: "code-cell" + (code.length === i ? " active" : "") }, code[i] || ""))),
              React.createElement("input", { className: "code-hidden", value: code, autoFocus: true, inputMode: "numeric", maxLength: 6,
                onChange: (e) => { const v = e.target.value.replace(/\D/g, "").slice(0, 6); setCode(v); if (v.length === 6) setTimeout(() => onAuthed({ method: "email", email }), 250); } })),
            React.createElement("button", { className: "auth-primary", disabled: code.length < 6, onClick: () => onAuthed({ method: "email", email }) }, T("authVerify"))),
      React.createElement("div", { className: "auth-foot" },
        React.createElement("span", { className: "auth-protected" }, React.createElement(Brand, { name: "lock" }), T("authProtected")),
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

Object.assign(window, { AuthScreen, LangToggle });
