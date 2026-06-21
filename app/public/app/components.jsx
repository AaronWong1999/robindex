/* Robindex — presentational components (icons, pickers, answer renderer, citations, rail, code) */
const { useState, useRef, useEffect, useMemo } = React;
const Tc = (k) => window.RXI.t(k);
const EN = () => window.RXI.lang === "en";

/* ----------------------------------------------------------------------------
   Icons — inline SVG (lucide-style stroke geometry + the X glyph).
   Raw inner-markup keeps us independent of any CDN icon API shape.
---------------------------------------------------------------------------- */
const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  sparkles: '<path d="M12 3l1.7 4.6L18 9l-4.3 1.4L12 15l-1.7-4.6L6 9l4.3-1.4z"/><path d="M19 14l.7 1.9L22 17l-2.3.6L19 20l-.7-2L16 17l2.3-1.1z"/>',
  send: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  refresh: '<path d="M21 3v6h-6M3 21v-6h6"/><path d="M3.5 9a9 9 0 0 1 14.9-3.4L21 9M21 15a9 9 0 0 1-14.9 3.4L3 15"/>',
  thumbsUp: '<path d="M7 10v11M15 5.9 14 10h5.8a2 2 0 0 1 2 2.6l-2.3 8a2 2 0 0 1-1.9 1.4H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.8a2 2 0 0 0 1.8-1.1L12 2a3.1 3.1 0 0 1 3 3.9z"/>',
  share: '<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8M16 6l-4-4-4 4M12 2v13"/>',
  code: '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>',
  link: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  heart: '<path d="M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7z"/>',
  eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  lightbulb: '<path d="M9 18h6M10 22h4M15 14c.2-1 .7-1.7 1.4-2.5A4.6 4.6 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.8 1.2 1.5 1.4 2.5"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4"/>',
  trendUp: '<path d="M16 7h6v6M22 7l-8.5 8.5-5-5L2 17"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.6 9a1 1 0 0 1-.8 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.7a1.2 1.2 0 0 1 1.6 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1z"/>',
  zap: '<path d="M4 14a1 1 0 0 1-.8-1.6l9.9-10.2a.5.5 0 0 1 .9.5l-1.9 6A1 1 0 0 0 13 10h7a1 1 0 0 1 .8 1.6l-9.9 10.2a.5.5 0 0 1-.9-.5l1.9-6A1 1 0 0 0 11 14z"/>',
  cpu: '<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
  terminal: '<path d="m4 17 6-6-6-6M12 19h8"/>',
  layers: '<path d="m12 2 9 5-9 5-9-5 9-5zM3 12l9 5 9-5M3 17l9 5 9-5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6.5 8-6.5S20 17 20 21"/>',
  arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  play: '<path d="M7 4v16l13-8z" fill="currentColor" stroke="none"/>',
  barChart: '<path d="M3 3v18h18M7 16v-5M12 16V8M17 16v-9"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  quote: '<path d="M7 7H4a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h2v3a3 3 0 0 1-3 3M17 7h-3a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h2v3a3 3 0 0 1-3 3" stroke="none" fill="none"/><path d="M10 11V7a2 2 0 0 0-2-2H5M20 11V7a2 2 0 0 0-2-2h-3M3 11h7v3a3 3 0 0 1-3 3M13 11h7v3a3 3 0 0 1-3 3"/>',
  candlestick: '<path d="M9 3v3M9 14v3M15 7v3M15 18v3M3 21h18"/><rect x="6.5" y="6" width="5" height="8" rx="1"/><rect x="12.5" y="10" width="5" height="8" rx="1"/>',
  xLogo: '<path d="M18.24 2.25h3.31l-7.23 8.26 8.5 11.24H16.2l-5.21-6.82L4.99 21.75H1.68l7.73-8.84L1.25 2.25H8.08l4.71 6.23 5.45-6.23zm-1.16 17.52h1.83L7.08 4.13H5.12l11.96 15.64z" fill="currentColor" stroke="none"/>',
  bot: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4M8 2h8"/><circle cx="9" cy="14" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="14" r="1.2" fill="currentColor" stroke="none"/>',
  swatch: '<circle cx="12" cy="12" r="9"/><circle cx="9.5" cy="9" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="10" r="1.3" fill="currentColor" stroke="none"/><circle cx="15.5" cy="14.5" r="1.3" fill="currentColor" stroke="none"/>',
  branch: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="8" r="2.5"/><path d="M6 8.5v7M18 10.5c0 4-3 5.5-6 5.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z"/>',
  gauge: '<path d="M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/><path d="M13.4 12.6 19 7M4 18a9 9 0 1 1 16 0"/>',
};

function Icon({ name, size = 18, color, strokeWidth = 1.8, style }) {
  return React.createElement("svg", {
    width: size, height: size, viewBox: "0 0 24 24", fill: "none",
    stroke: color || "currentColor", strokeWidth, strokeLinecap: "round", strokeLinejoin: "round",
    style: { display: "block", flex: "none", ...(style || {}) },
    dangerouslySetInnerHTML: { __html: ICONS[name] || "" },
  });
}

/* small deterministic avatar fallback (initials on accent) ----------------- */
function Avatar({ kol, size = 34, radius = 9, className }) {
  const [err, setErr] = useState(false);
  const initials = kol.display_name.slice(0, 2);
  if (kol.avatar_url && !err) {
    return React.createElement("img", {
      className, src: kol.avatar_url, alt: kol.display_name, onError: () => setErr(true),
      style: { width: size, height: size, borderRadius: radius, objectFit: "cover", flex: "none",
        background: kol.accent, border: "1px solid var(--border)" },
    });
  }
  return React.createElement("div", {
    className, style: { width: size, height: size, borderRadius: radius, flex: "none",
      display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 600,
      fontSize: size * 0.4, color: "var(--on-accent)",
      background: `linear-gradient(135deg, ${kol.accent}, ${kol.accent}99)` },
  }, initials);
}

/* ----------------------------------------------------------------------------
   Model picker (DeepSeek V4 Pro / Flash)
---------------------------------------------------------------------------- */
function ModelPicker({ models, value, onChange, up, compact, effort, setEffort }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", h); return () => document.removeEventListener("mousedown", h);
  }, []);
  const cur = models.find((m) => m.id === value) || models[0];
  const efs = [{ id: "low", k: "effLow" }, { id: "med", k: "effMed" }, { id: "high", k: "effHigh" }, { id: "max", k: "effMax" }];
  const hasEff = !!setEffort;
  const curEf = efs.find((e) => e.id === effort) || efs[2];
  return React.createElement("div", { className: "mp" + (up ? " mp-up" : ""), ref },
    React.createElement("button", { className: "mp-btn" + (compact ? " compact" : ""), onClick: () => setOpen((o) => !o) },
      React.createElement("span", { className: "mp-badge", style: { background: cur.color } }, cur.badge),
      React.createElement("span", { className: "nm" }, cur.name),
      hasEff && React.createElement("span", { className: "mp-eff" }, Tc(curEf.k)),
      React.createElement(Icon, { name: "chevronDown", size: 13, color: "var(--faint)", style: up ? { transform: "rotate(180deg)" } : null })),
    open && React.createElement("div", { className: "mp-menu" + (up ? " up" : "") },
      hasEff && React.createElement(React.Fragment, null,
        React.createElement("div", { className: "mp-head" }, React.createElement(Icon, { name: "gauge", size: 12, color: "var(--faint)" }), Tc("reasoningTitle")),
        React.createElement("div", { className: "eff-row" }, efs.map((e) =>
          React.createElement("button", { key: e.id, className: "eff-pill" + (curEf.id === e.id ? " on" : ""), onClick: () => setEffort(e.id) }, Tc(e.k)))),
        React.createElement("div", { className: "mp-sep" })),
      React.createElement("div", { className: "mp-head" }, hasEff ? Tc("modelTitle") : (EN() ? "Select model · your compute" : "选择模型 · 自选算力")),
      models.map((m) => React.createElement("button", {
        key: m.id, className: "mp-item", onClick: () => { onChange(m.id); setOpen(false); } },
        React.createElement("span", { className: "mp-badge", style: { background: m.color } }, m.badge),
        React.createElement("div", { style: { minWidth: 0, flex: 1 } },
          React.createElement("div", { className: "nm" }, m.name),
          React.createElement("div", { className: "sub" }, m.note)),
        m.id === value && React.createElement(Icon, { name: "check", size: 15, color: "var(--accent)" })))));
}

/* ----------------------------------------------------------------------------
   Theme switcher
---------------------------------------------------------------------------- */
const THEMES = [
  { id: "aurora", name: "Aurora", desc: "极简留白 · 苹果风", sw: ["#FBFBFD", "#0071E3", "#1D1D1F"] },
  { id: "codex", name: "Codex", desc: "中性暗色 · 极克制", sw: ["#0D0D0D", "#ECECEC", "#19C37D"] },
  { id: "matrix", name: "Matrix", desc: "磷光黑客终端", sw: ["#000000", "#00FF85", "#0C1A0E"] },
  { id: "terminal", name: "Terminal", desc: "信号绿 · 交易终端", sw: ["#0A0B0D", "#3DDC97", "#5B9DFF"] },
];
function ThemeMenu({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", h); return () => document.removeEventListener("mousedown", h);
  }, []);
  return React.createElement("div", { className: "mp", ref },
    React.createElement("button", { className: "icon-btn", onClick: () => setOpen((o) => !o), title: "切换界面风格" },
      React.createElement(Icon, { name: "swatch", size: 17 })),
    open && React.createElement("div", { className: "mp-menu", style: { width: 248 } },
      React.createElement("div", { className: "mp-head" }, EN() ? "Appearance · 4 directions" : "界面风格 · 4 种方向"),
      THEMES.map((t) => React.createElement("button", {
        key: t.id, className: "mp-item", onClick: () => { onChange(t.id); setOpen(false); } },
        React.createElement("span", { className: "th-sw" }, t.sw.map((c, i) =>
          React.createElement("i", { key: i, style: { background: c } }))),
        React.createElement("div", { style: { minWidth: 0 } },
          React.createElement("div", { className: "nm" }, t.name),
          React.createElement("div", { className: "sub" }, t.desc)),
        t.id === value && React.createElement(Icon, { name: "check", size: 15, color: "var(--accent)", style: { marginLeft: "auto" } })))));
}

/* ----------------------------------------------------------------------------
   Pipeline / tool run group — mirrors the live SSE phase + tool stream
---------------------------------------------------------------------------- */
function ToolGroup({ phases, toolCalls, activePhase, done }) {
  const phaseDoneCount = done ? phases.length : activePhase;
  return React.createElement("div", { className: "toolgrp" },
    React.createElement("div", { className: "toolgrp-head" },
      React.createElement(Icon, { name: done ? "check" : "cpu", size: 14, color: "var(--accent)", style: { flex: "none" } }),
      React.createElement("b", null, done ? Tc("retrievalDone") : Tc("toolRun")),
      React.createElement("span", { className: "count" }, `${phaseDoneCount}/${phases.length} ${Tc("phasesUnit")}`)),
    phases.map((p, i) => {
      const state = done || i < activePhase ? "done" : i === activePhase ? "run" : "wait";
      const tc = toolCalls[i];
      return React.createElement("div", { className: "tool", key: p.key, "data-state": state },
        React.createElement("div", { className: "tool-line" },
          React.createElement("span", { className: "st" },
            state === "run" ? React.createElement("span", { className: "spin" })
              : state === "done" ? React.createElement(Icon, { name: "check", size: 14, color: "var(--accent)" })
              : React.createElement("span", { className: "st-wait" })),
          React.createElement("span", { className: "tool-call" },
            React.createElement("span", { className: "fn" }, tc ? tc.name : p.key),
            tc ? React.createElement("span", { className: "arg" }, `(${tc.args})`) : null),
          React.createElement("span", { className: "tool-ms" }, p.label)),
        state === "done" && tc && React.createElement("div", { className: "tool-res" },
          Object.entries(tc.result).map(([k, v]) =>
            React.createElement("span", { className: "kv", key: k },
              React.createElement("span", { className: "k" }, k),
              React.createElement("span", { className: "v" }, String(v))))));
    }));
}

/* ----------------------------------------------------------------------------
   Answer renderer — markdown-lite with **bold** + clickable [T#] citations
---------------------------------------------------------------------------- */
const LABEL_RE = /^(结论|定位|底线|核心|一句话)\s*[:：]/;
const URL_RE = /(https?:\/\/\S+)/;
function citeKey(ref) {
  const s = String(ref || "").trim();
  const m = s.match(/^T?(\d+)$/i);
  return m ? "T" + m[1] : s;
}
function citeLabel(ref) {
  return citeKey(ref).replace(/^T/i, "");
}
function inline(text, onCite, key) {
  const parts = text.split(/(\*\*.+?\*\*|\[T?\d+(?:\s*,\s*T?\d+)*\])/g).filter(Boolean);
  return parts.map((seg, i) => {
    if (/^\*\*.+\*\*$/.test(seg)) return React.createElement("b", { key: i }, seg.slice(2, -2));
    const m = seg.match(/^\[(T?\d+(?:\s*,\s*T?\d+)*)\]$/i);
    if (m) {
      const refs = m[1].split(/\s*,\s*/);
      return React.createElement("span", { key: i, className: "cite-grp" },
        refs.map((r, j) => React.createElement("button", {
          key: j, className: "cite", onClick: () => onCite(citeKey(r)), title: `来源 ${citeLabel(r)}` },
          citeLabel(r))));
    }
    if (URL_RE.test(seg)) {
      const urlParts = seg.split(URL_RE).filter(Boolean);
      return React.createElement(React.Fragment, { key: i },
        urlParts.map((u, k) => URL_RE.test(u)
          ? React.createElement("a", { key: k, className: "inline-url", href: u, target: "_blank", rel: "noreferrer" }, u)
          : u));
    }
    return seg;
  });
}
function AnswerBlocks({ md, onCite }) {
  const paras = md.trim().split(/\n\n+/);
  return React.createElement(React.Fragment, null, paras.map((p, i) => {
    const labelMatch = p.match(LABEL_RE);
    if (labelMatch) {
      const lab = labelMatch[1];
      const rest = p.replace(LABEL_RE, "").trim();
      return React.createElement("div", { className: "callout", key: i },
        React.createElement("span", { className: "ic" }, React.createElement(Icon, { name: "target", size: 17, color: "var(--accent)" })),
        React.createElement("div", null,
          React.createElement("div", { className: "lab", style: { color: "var(--accent)" } }, lab),
          React.createElement("div", { className: "ctext" }, inline(rest, onCite))));
    }
    return React.createElement("p", { className: "ablk", key: i }, inline(p, onCite));
  }));
}

/* conviction meter ---------------------------------------------------------- */
function Conviction({ value }) {
  const [w, setW] = useState(0);
  useEffect(() => { const t = setTimeout(() => setW(value), 80); return () => clearTimeout(t); }, [value]);
  return React.createElement("div", { className: "conv" },
    React.createElement("span", { className: "conv-lab" }, Tc("conviction")),
    React.createElement("div", { className: "conv-bar" }, React.createElement("div", { className: "conv-fill", style: { width: w + "%" } })),
    React.createElement("span", { className: "conv-val" }, value + "%"));
}

/* ----------------------------------------------------------------------------
   Source-tweet card (the hero: every [T#] resolves to a real cited tweet)
---------------------------------------------------------------------------- */
function SourceCard({ kol, tw, active }) {
  const [expanded, setExpanded] = React.useState(false);
  const isLong = tw.snippet && tw.snippet.length > 160;
  const quoted = tw.quoted && tw.quoted.text ? tw.quoted : null;
  React.useEffect(() => { if (active) setExpanded(true); }, [active]);
  return React.createElement("div", {
    className: "src" + (active ? " on" : ""), id: "cite-" + citeKey(tw.ref) },
    React.createElement("div", { className: "src-top" },
      React.createElement(Avatar, { kol, size: 34, radius: 17 }),
      React.createElement("div", { className: "src-id" },
        React.createElement("div", { className: "src-nm" }, kol.display_name,
          React.createElement(Icon, { name: "xLogo", size: 11, color: "var(--faint)" })),
        React.createElement("div", { className: "src-h" }, "@" + kol.handle, " · ", tw.date)),
      React.createElement("span", { className: "src-ref" }, citeLabel(tw.ref))),
    React.createElement("div", { className: "src-text" + (!expanded && isLong ? " clamp" : "") }, tw.snippet),
    isLong && React.createElement("button", {
      className: "src-toggle",
      onClick: () => setExpanded((v) => !v) },
      expanded ? (EN() ? "Collapse" : "收起") : (EN() ? "Expand" : "展开原文")),
    quoted && React.createElement("a", {
      className: "src-quote", href: quoted.url || tw.url, target: "_blank", rel: "noreferrer" },
      React.createElement("div", { className: "src-quote-top" },
        quoted.handle
          ? React.createElement("img", {
              className: "src-quote-avatar", src: "https://unavatar.io/x/" + quoted.handle,
              alt: quoted.name || quoted.handle, loading: "lazy",
              onError: (e) => { e.currentTarget.style.display = "none"; const f = e.currentTarget.nextSibling; if (f) f.style.display = "flex"; },
            })
          : null,
        React.createElement("div", { className: "src-quote-avatar src-quote-fallback", style: { display: quoted.handle ? "none" : "flex" } },
          (quoted.name || quoted.handle || "?").slice(0, 1).toUpperCase()),
        React.createElement("div", { className: "src-quote-id" },
          React.createElement("div", { className: "src-quote-nm" }, quoted.name || quoted.handle || "Quoted tweet"),
          React.createElement("div", { className: "src-quote-h" }, quoted.handle ? "@" + quoted.handle : "", quoted.date ? " · " + quoted.date : ""))),
      React.createElement("div", { className: "src-quote-text" }, quoted.text)),
    React.createElement("div", { className: "src-foot" },
      React.createElement("a", { className: "src-open", href: tw.url, target: "_blank", rel: "noreferrer" },
        EN() ? "View on X →" : "在 X 查看原文 →")));
}

window.RXC = { Icon, Avatar, ModelPicker, ThemeMenu, THEMES, ToolGroup, AnswerBlocks, Conviction, SourceCard, citeKey, citeLabel };
