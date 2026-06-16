"use strict";
/* Shared top navigation: hamburger (mobile) + dropdown (desktop) + theme toggle. */
(function () {
  const X_URL = "https://x.com/qinbafrank";
  const ITEMS = [
    { label: "AI 研究助手", href: "/research", key: "research" },
    {
      label: "每日简报", key: "briefings", menu: [
        ["盘前早报", "/briefings?type=morning"],
        ["盘后晚报", "/briefings?type=evening"],
        ["KOL 日报", "/briefings?type=kol"],
      ],
    },
    {
      label: "投研", key: "invest", menu: [
        ["博主研究室", "/kol"],
        ["个股研究", "/stock"],
        ["宏观研究", "/macro"],
      ],
    },
    {
      label: "我的", key: "me", menu: [
        ["专属日报", "/for-you"],
        ["我的自选股", "/watchlist"],
      ],
    },
    { label: "定价", href: "/pricing", key: "pricing" },
  ];

  function activeKey() {
    const p = location.pathname;
    if (p === "/research") return "research";
    if (p.startsWith("/briefings") || p === "/today" || p === "/morning") return "briefings";
    if (p === "/pricing") return "pricing";
    if (p === "/for-you" || p === "/watchlist") return "me";
    if (p === "/" || p.startsWith("/kol") || p === "/stock" || p === "/macro") return "invest";
    return "";
  }

  function buildLinks() {
    const ak = activeKey();
    return ITEMS.map((it) => {
      const on = it.key === ak ? " active" : "";
      if (!it.menu) return `<a class="nav-link${on}" href="${it.href}">${it.label}</a>`;
      const menu = it.menu.map(([t, h]) => `<a href="${h}">${t}</a>`).join("");
      return `<div class="nav-item">
        <button class="nav-link nav-trigger${on}" aria-haspopup="true" aria-expanded="false">${it.label} <span class="caret">▾</span></button>
        <div class="nav-menu">${menu}</div>
      </div>`;
    }).join("");
  }

  function buildMobileMenu() {
    const ak = activeKey();
    let html = "";
    for (const it of ITEMS) {
      if (!it.menu) {
        html += `<a href="${it.href}" class="${it.key === ak ? "active" : ""}">${it.label}</a>`;
      } else {
        html += `<div class="group-label">${it.label}</div>`;
        for (const [label, href] of it.menu) {
          html += `<a class="sub" href="${href}">${label}</a>`;
        }
      }
    }
    return html;
  }

  function applyTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
    try { localStorage.setItem("robindex_theme", t); } catch (e) {}
    document.querySelectorAll(".theme-toggle").forEach((b) => (b.textContent = t === "light" ? "☾" : "☀"));
  }

  function mount() {
    const header = document.querySelector("header.nav");
    if (!header) return;
    header.innerHTML = `
      <a class="brand" href="/" aria-label="Robindex 首页"><span class="mark">R</span><span class="bt"><b>Robindex</b><span>MARKET INTELLIGENCE</span></span></a>
      <nav class="nav-links">${buildLinks()}</nav>
      <div class="nav-right">
        <a class="nav-icon" href="${X_URL}" target="_blank" rel="noopener" aria-label="X">𝕏</a>
        <button class="nav-icon theme-toggle" aria-label="切换主题">☀</button>
        <button class="nav-hamburger" aria-label="菜单" aria-expanded="false">☰</button>
      </div>`;

    // Mobile overlay
    let overlay = document.querySelector(".nav-mobile-overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.className = "nav-mobile-overlay";
      document.body.appendChild(overlay);
    }
    overlay.innerHTML = buildMobileMenu();

    // Hamburger toggle
    const hamburger = header.querySelector(".nav-hamburger");
    hamburger.addEventListener("click", (e) => {
      e.stopPropagation();
      const isOpen = overlay.classList.contains("open");
      overlay.classList.toggle("open");
      hamburger.setAttribute("aria-expanded", String(!isOpen));
      hamburger.textContent = isOpen ? "☰" : "✕";
      document.body.style.overflow = isOpen ? "" : "hidden";
    });

    // Close mobile menu on link click
    overlay.querySelectorAll("a").forEach((a) => {
      a.addEventListener("click", () => {
        overlay.classList.remove("open");
        hamburger.setAttribute("aria-expanded", "false");
        hamburger.textContent = "☰";
        document.body.style.overflow = "";
      });
    });

    // Desktop dropdown toggles
    const items = header.querySelectorAll(".nav-item");
    items.forEach((item) => {
      const trigger = item.querySelector(".nav-trigger");
      trigger.addEventListener("click", (e) => {
        e.preventDefault();
        const isOpen = item.classList.contains("open");
        items.forEach((o) => { o.classList.remove("open"); o.querySelector(".nav-trigger").setAttribute("aria-expanded", "false"); });
        if (!isOpen) { item.classList.add("open"); trigger.setAttribute("aria-expanded", "true"); }
      });
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".nav-item")) items.forEach((o) => o.classList.remove("open"));
    });

    // Theme toggle
    const themeBtn = header.querySelector(".theme-toggle");
    const cur = document.documentElement.getAttribute("data-theme") || "dark";
    applyTheme(cur);
    themeBtn.addEventListener("click", () => {
      const next = (document.documentElement.getAttribute("data-theme") === "light") ? "dark" : "light";
      applyTheme(next);
    });
  }

  // Restore saved theme ASAP
  try {
    const saved = localStorage.getItem("robindex_theme");
    if (saved) document.documentElement.setAttribute("data-theme", saved);
  } catch (e) {}

  window.RobindexNav = { mount, applyTheme };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
