/* Robindex — mobile app shell: compact top bar + bottom tab bar (PWA-style) */

function MobileTopBar({ kol, lang, setLang, theme, setTheme, loggedIn, onLogin }) {
  const { Icon, ThemeMenu } = window.RXC;
  const T = (k) => window.RXI.t(k);
  return React.createElement("div", { className: "m-topbar" },
    kol
      ? React.createElement("div", { className: "m-kol" },
          React.createElement(window.RXC.Avatar, { kol, size: 30, radius: 8 }),
          React.createElement("div", { style: { minWidth: 0 } },
            React.createElement("div", { className: "m-kol-nm" }, kol.display_name),
            React.createElement("div", { className: "m-kol-role" }, kol.role)))
      : React.createElement("div", { className: "m-brand" },
          React.createElement("div", { className: "brand-mark", style: { width: 26, height: 26, borderRadius: 7 } }, React.createElement(Icon, { name: "candlestick", size: 15, color: "var(--on-accent)" })),
          React.createElement("div", { className: "brand-name", style: { fontSize: 14 } }, "Robindex ", React.createElement("span", null, "Desk"))),
    React.createElement("div", { className: "m-top-actions" },
      !loggedIn && React.createElement("button", { className: "hdr-login", style: { height: "28px", fontSize: "12px", padding: "0 10px" }, onClick: onLogin }, T("hdrLogin")),
      React.createElement(window.LangToggle, { lang, setLang }),
      React.createElement(ThemeMenu, { value: theme, onChange: setTheme })));
}

function BottomNav({ tab, setTab, srcCount }) {
  const { Icon } = window.RXC;
  const T = (k) => window.RXI.t(k);
  const items = [
    { id: "home", icon: "layers", label: T("navHome") },
    { id: "chat", icon: "sparkles", label: T("navChat") },
    { id: "sources", icon: "quote", label: T("navSources"), badge: srcCount },
    { id: "me", icon: "user", label: T("navMe") },
  ];
  return React.createElement("nav", { className: "bottom-nav" }, items.map((it) =>
    React.createElement("button", { key: it.id, className: "bn-item" + (tab === it.id ? " on" : ""), onClick: () => setTab(it.id) },
      React.createElement("span", { className: "bn-ic" },
        React.createElement(Icon, { name: it.icon, size: 21 }),
        it.badge ? React.createElement("span", { className: "bn-badge" }, it.badge) : null),
      React.createElement("span", { className: "bn-lab" }, it.label))));
}

Object.assign(window, { MobileTopBar, BottomNav });
