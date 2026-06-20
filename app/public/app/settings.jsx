/* Robindex — settings page (account, model default, appearance, language, billing) */
const { useState: useStateS } = React;

function SettingsPage({ user, model, setModel, theme, setTheme, lang, setLang, onSignOut, onClose }) {
  const { Icon, THEMES } = window.RXC;
  const T = (k) => window.RXI.t(k);
  const models = window.RX.MODELS;
  const noteOf = (m) => (m.note && typeof m.note === "object") ? (m.note[lang] || m.note.zh) : m.note;
  return React.createElement("div", { className: "settings" },
    React.createElement("div", { className: "set-head" },
      React.createElement("h1", null, T("setTitle")),
      onClose && React.createElement("button", { className: "set-done", onClick: onClose }, T("setDone"))),
    React.createElement("div", { className: "set-scroll" },
      // account
      React.createElement("div", { className: "set-sec" },
        React.createElement("div", { className: "set-sec-h" }, T("setAccount")),
        React.createElement("div", { className: "set-card" },
          React.createElement("div", { className: "set-account" },
            React.createElement("div", { className: "set-av" }, "TD"),
            React.createElement("div", { style: { flex: 1, minWidth: 0 } },
              React.createElement("div", { className: "set-acc-nm" }, user && user.email ? user.email.split("@")[0] : "Trader Desk"),
              React.createElement("div", { className: "set-acc-sub" }, user && user.email ? user.email : "trader@robindex.ai")),
            React.createElement("span", { className: "set-plan-pill" }, T("setPlanV"))))),
      // preferences
      React.createElement("div", { className: "set-sec" },
        React.createElement("div", { className: "set-sec-h" }, T("setPrefs")),
        React.createElement("div", { className: "set-card" },
          // default model
          React.createElement("div", { className: "set-row col" },
            React.createElement("div", { className: "set-row-top" },
              React.createElement(Icon, { name: "cpu", size: 16, color: "var(--faint)" }),
              React.createElement("span", { className: "set-row-lab" }, T("setDefModel"))),
            React.createElement("div", { className: "seg" }, models.map((m) =>
              React.createElement("button", { key: m.id, className: "seg-btn" + (model === m.id ? " on" : ""), onClick: () => setModel(m.id) },
                React.createElement("span", { className: "mp-badge", style: { background: m.color, width: 17, height: 17, fontSize: 8 } }, m.badge),
                React.createElement("div", { style: { textAlign: "left", minWidth: 0 } },
                  React.createElement("div", { className: "seg-nm" }, m.name),
                  React.createElement("div", { className: "seg-sub" }, noteOf(m))))))),
          // language
          React.createElement("div", { className: "set-row col" },
            React.createElement("div", { className: "set-row-top" }, React.createElement(Icon, { name: "globe", size: 16, color: "var(--faint)" }), React.createElement("span", { className: "set-row-lab" }, T("setLang"))),
            React.createElement("div", { className: "lang-list" }, window.RXLANGS.map((l) =>
              React.createElement("button", { key: l.id, className: "lang-li" + (lang === l.id ? " on" : "") + (l.active ? "" : " disabled"), disabled: !l.active, onClick: () => l.active && setLang(l.id) },
                React.createElement("div", { style: { minWidth: 0, textAlign: "left" } },
                  React.createElement("div", { className: "ll-nm" }, l.label),
                  React.createElement("div", { className: "ll-sub" }, l.sub)),
                !l.active && React.createElement("span", { className: "soon-tag-sm" }, T("langSoon")),
                l.active && lang === l.id && React.createElement(Icon, { name: "check", size: 15, color: "var(--accent)" }))))),
          // appearance
          React.createElement("div", { className: "set-row col" },
            React.createElement("div", { className: "set-row-top" }, React.createElement(Icon, { name: "swatch", size: 16, color: "var(--faint)" }), React.createElement("span", { className: "set-row-lab" }, T("setTheme"))),
            React.createElement("div", { className: "theme-grid" }, THEMES.map((t) =>
              React.createElement("button", { key: t.id, className: "theme-opt" + (theme === t.id ? " on" : ""), onClick: () => setTheme(t.id) },
                React.createElement("span", { className: "theme-sw" }, t.sw.map((c, i) => React.createElement("i", { key: i, style: { background: c } }))),
                React.createElement("span", { className: "theme-nm" }, t.name),
                theme === t.id && React.createElement(Icon, { name: "check", size: 14, color: "var(--accent)", style: { marginLeft: "auto" } })))))) ),
      // usage / billing
      React.createElement("div", { className: "set-sec" },
        React.createElement("div", { className: "set-sec-h" }, T("setUsage")),
        React.createElement("div", { className: "set-card" },
          React.createElement("div", { className: "usage-row" },
            React.createElement("div", null,
              React.createElement("div", { className: "usage-v" }, "1,842 ", React.createElement("span", null, "/ 10,000")),
              React.createElement("div", { className: "usage-k" }, T("setUsageV"))),
            React.createElement("button", { className: "set-manage" }, T("setManage"))),
          React.createElement("div", { className: "usage-bar" }, React.createElement("div", { className: "usage-fill", style: { width: "18.4%" } })))),
      // sign out
      React.createElement("button", { className: "set-signout", onClick: onSignOut },
        React.createElement(Icon, { name: "arrowRight", size: 15 }), T("setSignOut"))));
}

window.SettingsPage = SettingsPage;
