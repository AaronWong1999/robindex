/* Robindex — settings (account, default model, appearance, language, billing summary) */
const { useState: useStateS } = React;

function SettingsPage({ user, model, setModel, theme, setTheme, lang, setLang, onSignOut, onClose, onOpenWallet, onOpenSubs, onOpenUsage, onAddModel }) {
  const { Icon, THEMES } = window.RXC;
  const T = (k) => window.RXI.t(k);
  const a = window.useBilling();
  const B = window.RXB;
  const noteOf = (m) => (m.note && typeof m.note === "object") ? (m.note[lang] || m.note.zh) : m.note;
  const models = (window.RX.MODELS || []).map((m) => ({ ...m, note: noteOf(m) })).concat(((a.customModels) || []).map((m) => ({ ...m, note: noteOf(m) })));
  const custom = (a.customModels) || [];
  const subIds = Object.keys(B.KOL_PLANS).filter((id) => B.isSubscribed(id));
  const nSubs = subIds.length;
  const planLabel = nSubs > 0 ? T("planMember") : T("planFree");
  const freeLeft = B.freeLeft();
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
            React.createElement("div", { className: "set-av" }, (user && user.email ? user.email[0] : "T").toUpperCase()),
            React.createElement("div", { style: { flex: 1, minWidth: 0 } },
              React.createElement("div", { className: "set-acc-nm" }, user && user.email ? user.email.split("@")[0] : "Trader Desk"),
              React.createElement("div", { className: "set-acc-sub" }, user && user.email ? user.email : "trader@robindex.ai")),
            React.createElement("span", { className: "set-plan-pill" + (nSubs > 0 ? " mem" : "") }, planLabel)))),
      // billing & credits
      React.createElement("div", { className: "set-sec" },
        React.createElement("div", { className: "set-sec-h" }, T("setBilling")),
        React.createElement("div", { className: "set-card" },
          React.createElement("button", { className: "set-bill-row", onClick: onOpenWallet },
            React.createElement("span", { className: "sbr-ic" }, React.createElement(Icon, { name: "wallet", size: 16, color: "var(--accent)" })),
            React.createElement("div", { className: "sbr-mid" },
              React.createElement("div", { className: "sbr-t" }, T("setCreditsBal")),
              React.createElement("div", { className: "sbr-s" }, T("estFlash")(B.fmt(Math.floor(a.credits / (B.typicalCost("flash") || 0.08)))))),
            React.createElement("span", { className: "sbr-v" }, React.createElement(Icon, { name: "zap", size: 12, color: "var(--accent)" }), B.fmtPts(a.credits)),
            React.createElement(Icon, { name: "chevronRight", size: 16, color: "var(--faint)" })),
          onOpenUsage && React.createElement("button", { className: "set-bill-row", onClick: onOpenUsage },
            React.createElement("span", { className: "sbr-ic" }, React.createElement(Icon, { name: "gauge", size: 16, color: "var(--accent)" })),
            React.createElement("div", { className: "sbr-mid" },
              React.createElement("div", { className: "sbr-t" }, T("usageTitle")),
              React.createElement("div", { className: "sbr-s" }, T("usageSub"))),
            React.createElement(Icon, { name: "chevronRight", size: 16, color: "var(--faint)" })),
          React.createElement("button", { className: "set-bill-row", onClick: onOpenSubs },
            React.createElement("span", { className: "sbr-ic" }, React.createElement(Icon, { name: "crown", size: 16, color: "var(--accent)" })),
            React.createElement("div", { className: "sbr-mid" },
              React.createElement("div", { className: "sbr-t" }, T("mySubs")),
              React.createElement("div", { className: "sbr-s" }, nSubs > 0 ? T("setNSubs")(nSubs) : T("freeHint")(B.freeCap))),
            nSubs > 0 && React.createElement("span", { className: "sbr-badge" }, nSubs),
            React.createElement(Icon, { name: "chevronRight", size: 16, color: "var(--faint)" })),
          nSubs < Object.keys(B.KOL_PLANS).length && React.createElement("div", { className: "set-free-row" },
            React.createElement("span", { className: "sbr-ic" }, React.createElement(Icon, { name: "zap", size: 16, color: "var(--faint)" })),
            React.createElement("div", { className: "sbr-mid" },
              React.createElement("div", { className: "sbr-t" }, T("freeToday")),
              React.createElement("div", { className: "sbr-s" }, T("flashOnly"))),
            React.createElement("span", { className: "free-pips" }, [0, 1].map((i) =>
              React.createElement("i", { key: i, className: i < (B.freeCap - freeLeft) ? "used" : "" }))),
            React.createElement("span", { className: "sbr-v sm" }, T("freeOf")(freeLeft, B.freeCap))))),
      // custom models (BYOK)
      React.createElement("div", { className: "set-sec" },
        React.createElement("div", { className: "set-sec-h" }, T("customModelsTitle")),
        React.createElement("div", { className: "set-card" },
          React.createElement("div", { className: "set-byok-sub" }, T("customModelsSub")),
          custom.length === 0
            ? React.createElement("div", { className: "byok-empty" }, React.createElement(Icon, { name: "plug", size: 18, color: "var(--faint)" }), T("noCustomModels"))
            : custom.map((m) => React.createElement("div", { className: "byok-row", key: m.id },
                React.createElement("span", { className: "mp-badge", style: { background: m.color, width: 24, height: 24, fontSize: 9 } }, m.badge),
                React.createElement("div", { className: "byok-mid" },
                  React.createElement("div", { className: "byok-nm" }, m.name, React.createElement("span", { className: "byok-tag" }, React.createElement(Icon, { name: "key", size: 9 }), T("byokTag"))),
                  React.createElement("div", { className: "byok-meta" }, m.providerName, " · ", m.apiKey || "••••")),
                React.createElement("button", { className: "byok-del", onClick: () => B.removeCustomModel(m.id), title: T("removeModel") }, React.createElement(Icon, { name: "trash", size: 15 })))),
          React.createElement("button", { className: "byok-add", onClick: onAddModel }, React.createElement(Icon, { name: "plus", size: 15 }), T("addModel")))),
      // preferences
      React.createElement("div", { className: "set-sec" },
        React.createElement("div", { className: "set-sec-h" }, T("setPrefs")),
        React.createElement("div", { className: "set-card" },
          React.createElement("div", { className: "set-row col" },
            React.createElement("div", { className: "set-row-top" },
              React.createElement(Icon, { name: "cpu", size: 16, color: "var(--faint)" }),
              React.createElement("span", { className: "set-row-lab" }, T("setDefModel"))),
            React.createElement("div", { style: { alignSelf: "flex-start" } },
              React.createElement(window.RXC.ModelPicker, { models, value: model, onChange: setModel, subscribed: true, onAddModel }))),
          React.createElement("div", { className: "set-row col" },
            React.createElement("div", { className: "set-row-top" }, React.createElement(Icon, { name: "globe", size: 16, color: "var(--faint)" }), React.createElement("span", { className: "set-row-lab" }, T("setLang"))),
            React.createElement("div", { className: "lang-list" }, window.RXLANGS.map((l) =>
              React.createElement("button", { key: l.id, className: "lang-li" + (lang === l.id ? " on" : "") + (l.active ? "" : " disabled"), disabled: !l.active, onClick: () => l.active && setLang(l.id) },
                React.createElement("div", { style: { minWidth: 0, textAlign: "left" } },
                  React.createElement("div", { className: "ll-nm" }, l.label),
                  React.createElement("div", { className: "ll-sub" }, l.sub)),
                !l.active && React.createElement("span", { className: "soon-tag-sm" }, T("langSoon")),
                l.active && lang === l.id && React.createElement(Icon, { name: "check", size: 15, color: "var(--accent)" }))))),
          React.createElement("div", { className: "set-row col" },
            React.createElement("div", { className: "set-row-top" }, React.createElement(Icon, { name: "swatch", size: 16, color: "var(--faint)" }), React.createElement("span", { className: "set-row-lab" }, T("setTheme"))),
            React.createElement("div", { className: "theme-grid" }, THEMES.map((t) =>
              React.createElement("button", { key: t.id, className: "theme-opt" + (theme === t.id ? " on" : ""), onClick: () => setTheme(t.id) },
                React.createElement("span", { className: "theme-sw" }, t.sw.map((c, i) => React.createElement("i", { key: i, style: { background: c } }))),
                React.createElement("span", { className: "theme-nm" }, t.name),
                theme === t.id && React.createElement(Icon, { name: "check", size: 14, color: "var(--accent)", style: { marginLeft: "auto" } })))))) ),
      // sign out
      React.createElement("button", { className: "set-signout", onClick: onSignOut },
        React.createElement(Icon, { name: "arrowRight", size: 15 }), T("setSignOut"))));
}

window.SettingsPage = SettingsPage;
