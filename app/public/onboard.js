(() => {
  if (window.location.pathname === "/api/onboarding/page") {
    window.history.replaceState({}, "", "/add-kol");
  }
  const $ = (id) => document.getElementById(id);
  const jobsEl = $("jobs");
  const emptyEl = $("empty");
  const errorEl = $("form-error");
  const button = $("submit-button");
  const terminal = new Set(["ready", "failed"]);
  let timer = null;

  const esc = (value) => String(value == null ? "" : value)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");

  async function api(path, options = {}) {
    const res = await fetch(path, {
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      ...options,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message || body.error || `请求失败 (${res.status})`);
    return body;
  }

  const phaseLabel = {
    queued: "排队中", validating: "验证账号", ingesting: "抓取语料", reconciling: "补齐历史",
    indexing: "建立索引", mapping: "Map 蒸馏", reducing: "Reduce 合并", profiling: "生成前端资料",
    evaluating: "质量评测", provisioning: "配置订阅", ready: "已上线", failed: "失败",
  };
  const phaseProgress = {
    queued: 2, validating: 6, ingesting: 28, reconciling: 38, indexing: 44,
    mapping: 60, reducing: 72, profiling: 78, evaluating: 90, provisioning: 97, ready: 100, failed: 100,
  };

  function render(items) {
    emptyEl.hidden = items.length > 0;
    jobsEl.innerHTML = items.map((job) => {
      const state = job.state || "queued";
      const pct = job.progress_percent ?? phaseProgress[state] ?? 0;
      const corpus = job.corpus || {};
      const profile = job.profile || {};
      const actions = state === "ready"
        ? `<a href="/?kol=${encodeURIComponent(job.kol_id)}">打开 KOL</a>`
        : state === "failed"
          ? `<button type="button" data-retry="${esc(job.id)}">重试</button>`
          : "";
      return `<article class="job">
        <div class="job-top">
          <div class="identity">
            ${profile.avatar_url ? `<img class="avatar" alt="" src="${esc(profile.avatar_url)}">` : `<span class="avatar"></span>`}
            <div><strong>${esc(profile.display_name || job.handle)}</strong><div class="handle">@${esc(job.handle)}</div></div>
          </div>
          <span class="state ${esc(state)}">${esc(phaseLabel[state] || state)}</span>
        </div>
        <div class="bar"><span style="width:${Math.max(0, Math.min(100, pct))}%"></span></div>
        <div class="metrics">
          <div class="metric"><b>${Number(corpus.originals || 0).toLocaleString()}</b><span>原创语料</span></div>
          <div class="metric"><b>${Number(job.pages_fetched || 0).toLocaleString()}</b><span>抓取页数</span></div>
          <div class="metric"><b>${Number(job.indexed || 0).toLocaleString()}</b><span>FTS 索引</span></div>
          <div class="metric"><b>${Number(job.distill_steps || 0).toLocaleString()}</b><span>蒸馏步骤</span></div>
        </div>
        ${job.last_error ? `<div class="job-error">${esc(job.last_error)}</div>` : ""}
        <div class="job-foot">
          <span>${esc(job.status_text || "Cloudflare 将自动继续，无需保持页面打开")}</span>
          <div class="actions">${actions}</div>
        </div>
      </article>`;
    }).join("");
    jobsEl.querySelectorAll("[data-retry]").forEach((el) => {
      el.addEventListener("click", async () => {
        el.disabled = true;
        try { await api(`/api/onboarding/requests/${encodeURIComponent(el.dataset.retry)}/retry`, { method: "POST", body: "{}" }); await load(); }
        catch (error) { alert(error.message); }
        finally { el.disabled = false; }
      });
    });
    const active = items.some((item) => !terminal.has(item.state));
    clearTimeout(timer);
    if (active) timer = setTimeout(load, 5000);
  }

  async function load() {
    try {
      const body = await api("/api/onboarding/requests");
      render(body.requests || []);
    } catch (error) {
      if (error.message.includes("404")) location.replace("/");
    }
  }

  $("submit-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    errorEl.hidden = true;
    button.disabled = true;
    try {
      await api("/api/onboarding/submit", {
        method: "POST",
        body: JSON.stringify({ url: $("kol-url").value }),
      });
      $("kol-url").value = "";
      await load();
    } catch (error) {
      errorEl.textContent = error.message;
      errorEl.hidden = false;
    } finally {
      button.disabled = false;
    }
  });
  $("refresh-button").addEventListener("click", load);
  load();
})();
