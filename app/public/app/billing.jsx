/* Robindex — billing UI: Wallet, Subscriptions, Paywall, Checkout (Stripe), quota chips.
   Pure presentational + RXB store calls. Exposed on window. */
const { useState: bS, useEffect: bE, useRef: bR } = React;
const BT = (k) => window.RXI.t(k);
const Bicon = (p) => React.createElement(window.RXC.Icon, p);
const BAvatar = (p) => React.createElement(window.RXC.Avatar, p);

function useBilling() {
  const [, force] = bS(0);
  bE(() => window.RXB.onChange(() => force((n) => n + 1)), []);
  return window.RXB.get();
}
function fmtDate(ts) {
  const d = new Date(ts);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function kolMeta(kols, id) {
  return (kols || []).find((k) => k.id === id) || { id, display_name: window.RXB.planFor(id).name, accent: window.RXB.planFor(id).accent, avatar_url: "", role: "" };
}

/* ===================== Credit badge (sidebar / topbar) ===================== */
function CreditBadge({ onClick, compact }) {
  const a = useBilling(); const B = window.RXB;
  return (
    <button className={"credit-badge" + (compact ? " compact" : "")} onClick={onClick} title={BT("wallet")}>
      <Bicon name="zap" size={12} />
      <span className="cb-n">{B.fmtPts(a.credits)}</span>
      {!compact && <span className="cb-u">{BT("creditsWord")}</span>}
    </button>
  );
}

/* ===================== Free-quota bar (composer) ===================== */
function FreeQuotaBar({ kol, onSubscribe }) {
  const a = useBilling(); const B = window.RXB;
  if (B.isSubscribed(kol.id)) return null;
  const left = B.freeLeft();
  const resetTxt = B.hoursMins(B.freeResetIn(), window.RXI.lang);
  return (
    <div className={"quota-bar" + (left === 0 ? " out" : "")}>
      <span className="qb-ic"><Bicon name={left === 0 ? "lock" : "zap"} size={13} /></span>
      <span className="qb-main">
        <b>{BT("freeToday")}</b>
        <span className="qb-dots">{[0, 1].map((i) => <i key={i} className={i < (B.freeCap - left) ? "used" : ""} />)}</span>
        <span className="qb-txt">{left > 0 ? BT("freeOf")(left, B.freeCap) : BT("freeResetIn")(resetTxt)}</span>
        <span className="qb-flash">{BT("flashOnly")}</span>
      </span>
      <button className="qb-cta" onClick={() => onSubscribe(kol.id)}>
        <Bicon name="crown" size={12} />{BT("subscribeCta")}
      </button>
    </div>
  );
}

/* ===================== Paywall modal ===================== */
function Paywall({ reason, kol, modelId, kols, onClose, onCheckout }) {
  const a = useBilling(); const B = window.RXB;
  const plan = B.planFor(kol.id);
  const m = B.model(modelId);
  const resetTxt = B.hoursMins(B.freeResetIn(), window.RXI.lang);
  const isCredits = reason === "credits";

  const head = isCredits
    ? { icon: "zap", title: BT("pwCreditsTitle"), body: BT("pwCreditsBody")(B.fmtPts(B.typicalCost(modelId)), B.fmtPts(a.credits)) }
    : reason === "model-locked"
      ? { icon: "lock", title: BT("pwModelTitle")(m ? m.name : ""), body: BT("pwModelBody")(kol.display_name) }
      : { icon: "flame", title: BT("pwQuotaTitle"), body: BT("pwQuotaBody")(kol.display_name) };

  return (
    <div className="pw-overlay" onClick={(e) => { if (e.target.classList.contains("pw-overlay")) onClose(); }}>
      <div className="pw-card">
        <button className="pw-x" onClick={onClose}><Bicon name="x" size={16} /></button>
        <div className="pw-hero" style={{ "--ac": kol.accent }}>
          <div className="pw-ic"><Bicon name={head.icon} size={22} color="var(--on-accent)" /></div>
          <h2>{head.title}</h2>
          <p>{head.body}</p>
        </div>

        {isCredits ? (
          <div className="pw-packs">
            {B.PACKS.map((p) => (
              <button key={p.id} className={"pw-pack" + (p.popular ? " pop" : "")} onClick={() => onCheckout({ type: "pack", packId: p.id })}>
                <div className="pwp-cr"><Bicon name="zap" size={12} />{B.fmt(p.credits)}</div>
                {p.bonus > 0 && <div className="pwp-bonus">{BT("bonusN")(Math.round(p.bonus * 100))}</div>}
                <div className="pwp-usd">{B.fmtUsd(p.usd)}</div>
              </button>
            ))}
          </div>
        ) : (
          <div className="pw-offer" style={{ "--ac": kol.accent }}>
            <div className="pwo-top">
              <BAvatar kol={kol} size={38} radius={11} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="pwo-nm">{kol.display_name}</div>
                <div className="pwo-role">{kol.role}</div>
              </div>
              <div className="pwo-price">
                <div className="pwo-now">{B.fmtUsd(plan.promoMonthly)}<span>{BT("perMonth")}</span></div>
                <div className="pwo-was">{BT("wasPrice")(B.fmtUsd(plan.priceMonthly))}</div>
              </div>
            </div>
            <div className="pwo-benefits">
              <span><Bicon name="infinity" size={13} color="var(--accent)" />{BT("pwBenefit1")}</span>
              <span><Bicon name="cpu" size={13} color="var(--accent)" />{BT("pwBenefit2")}</span>
              <span><Bicon name="gift" size={13} color="var(--accent)" />{BT("pwBenefit3")(B.fmt(plan.gift))}</span>
            </div>
          </div>
        )}

        <div className="pw-actions">
          {isCredits ? (
            <button className="pw-primary" onClick={() => onCheckout({ type: "pack", packId: "pro" })}>
              {BT("pwTopupCta")}<Bicon name="arrowRight" size={16} />
            </button>
          ) : (
            <button className="pw-primary" onClick={() => onCheckout({ type: "sub", kolId: kol.id, plan: "promo" })}>
              {BT("pwSubCta")(kol.display_name, B.fmtUsd(plan.promoMonthly))}<Bicon name="arrowRight" size={16} />
            </button>
          )}
          <div className="pw-foot">
            {reason === "quota" && <span>{BT("pwWaitReset")(resetTxt)}</span>}
            {!isCredits && <span className="pw-promo">{BT("pwPromoNote")(B.fmtUsd(plan.promoMonthly), B.fmtUsd(plan.priceMonthly))}</span>}
            <button className="pw-later" onClick={onClose}>{BT("pwLater")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ===================== Checkout modal ===================== */
function Checkout({ item, kols, onClose, onDone }) {
  const B = window.RXB;
  const L = (zh, en) => (window.RXI.lang === "en" ? en : zh);
  const [busy, setBusy] = bS(false);
  const [err, setErr] = bS(null);
  const pay = async () => {
    setBusy(true); setErr(null);
    const res = await B.checkout(item); // redirects to Stripe on success
    if (!res || !res.ok) { setBusy(false); setErr(res && res.error || "error"); }
  };
  const isSub = item.type === "sub";
  const kol = isSub ? kolMeta(kols, item.kolId) : null;
  const plan = isSub ? B.planFor(item.kolId) : null;
  const pack = !isSub ? B.PACKS.find((p) => p.id === item.packId) : null;
  const price = isSub ? plan.promoMonthly : pack.usd;
  const title = isSub ? kol.display_name : (B.pick(pack.label, window.RXI.lang) + " · " + B.fmt(pack.credits) + " " + BT("creditsWord"));
  const sub = isSub ? BT("monthlySub") : BT("creditPack");

  return (
    <div className="pw-overlay" onClick={(e) => { if (e.target.classList.contains("pw-overlay")) onClose(); }}>
      <div className="co-card">
        <div className="co-head">
          <div className="co-h-l">
            <div className="co-stripe"><Bicon name="creditCard" size={15} color="var(--accent)" /></div>
            <span>{BT("checkout")}</span>
          </div>
          <button className="pw-x stat" onClick={onClose}><Bicon name="x" size={16} /></button>
        </div>
        <div className="co-order">
          <div className="co-ord-l">
            {isSub ? <BAvatar kol={kol} size={34} radius={9} /> : <div className="co-pack-ic"><Bicon name="zap" size={16} color="var(--accent)" /></div>}
            <div style={{ minWidth: 0 }}>
              <div className="co-ord-t">{title}</div>
              <div className="co-ord-s">{sub}</div>
            </div>
          </div>
          <div className="co-ord-p">{B.fmtUsd(price)}{isSub && <span>{BT("perMonth")}</span>}</div>
        </div>
        {err && (
          <div className="co-form co-pending" style={{ borderColor: "var(--danger, #e5484d)" }}>
            <div className="co-pending-ic"><Bicon name="x" size={18} color="var(--danger, #e5484d)" /></div>
            <div>
              <h3>{L("无法发起支付", "Couldn't start checkout")}</h3>
              <p>{
                err === "not_signed_in" ? L("请先登录再支付。", "Please sign in first.")
                : err === "no_payment_provider" ? L("支付尚未配置。", "Payments not configured yet.")
                : err === "sub_unsupported_airwallex" ? L("订阅暂不支持 Airwallex，请用积分充值；订阅功能将随 Stripe 上线。", "Subscriptions aren't on Airwallex yet — use credit packs; subscriptions arrive with Stripe.")
                : L("请稍后重试，或联系支持。", "Please try again, or contact support.")
              }</p>
            </div>
          </div>
        )}
        <button className="pw-primary co-pay" onClick={pay} disabled={busy}>
          {busy ? L("正在跳转到 Stripe…", "Redirecting to Stripe…") : (<>{L("前往安全支付", "Continue to secure checkout")}<Bicon name="arrowRight" size={16} /></>)}
        </button>
        <div className="co-note">{L("由 Stripe 安全处理 · 支付成功后积分/订阅立即到账", "Secured by Stripe · credits/subscription apply right after payment")}</div>
      </div>
    </div>
  );
}

/* ===================== Add custom model (BYOK) modal ===================== */
function AddModelModal({ onClose, onSaved }) {
  const B = window.RXB;
  const provs = B.providers();
  const initProv = provs.find((p) => p.dflt) || provs[0];
  const [provId, setProvId] = bS(initProv.id);
  const [provOpen, setProvOpen] = bS(false);
  const [apiKey, setApiKey] = bS("");
  const [showKey, setShowKey] = bS(false);
  // baseUrl is read-only for built-in providers; only editable when the user picks "自定义" OR
  // edits a built-in URL (in which case we silently flip to "custom" so the saved record reflects reality).
  const [baseUrl, setBaseUrl] = bS(initProv.baseUrl || "");
  const [baseUrlDirty, setBaseUrlDirty] = bS(false);
  const [modelName, setModelName] = bS(initProv.models?.[0] || "Auto");
  const prov = B.provider(provId) || provs[0];
  const groups = [];
  provs.forEach((p) => { let g = groups.find((x) => x.g === p.group); if (!g) { g = { g: p.group, items: [] }; groups.push(g); } g.items.push(p); });
  // If the user edits the baseUrl of a built-in provider, treat it as a custom endpoint.
  const effectiveProvId = baseUrlDirty && provId !== "custom" ? "custom" : provId;
  const isCustom = effectiveProvId === "custom";
  const pickProv = (p) => {
    setProvId(p.id);
    setBaseUrl(p.baseUrl || "");
    setBaseUrlDirty(false);
    setModelName(p.models?.[0] || "Auto");
    setProvOpen(false);
  };
  const onBaseUrlChange = (v) => {
    setBaseUrl(v);
    // Built-in providers have a known default; any deviation means the user is overriding the endpoint.
    if (provId !== "custom" && v && v !== prov.baseUrl) setBaseUrlDirty(true);
  };
  const save = () => {
    const finalUrl = (baseUrl || prov.baseUrl || "").trim();
    if (!finalUrl) { alert("请填写接口地址"); return; }
    // Persist with the effective provider id — if the URL was edited, we treat it as a custom endpoint.
    const useProv = isCustom ? "custom" : provId;
    const m = B.addCustomModel({ providerId: useProv, providerName: prov.name, baseUrl: finalUrl, apiKey, modelName });
    onSaved && onSaved(m);
  };
  const groupLabel = (g) => g === "Custom" ? BT("provCustom") : g;
  return (
    <div className="pw-overlay" onClick={(e) => { if (e.target.classList.contains("pw-overlay")) onClose(); }}>
      <div className="am-card">
        <div className="am-head">
          <div className="am-title">{BT("addModel")}<span className="am-proto">{BT("openaiOnly")}</span></div>
          <button className="pw-x stat" onClick={onClose}><Bicon name="x" size={16} /></button>
        </div>
        <div className="am-body">
          <div className="am-field">
            <div className="am-lab-row"><span className="am-lab">{BT("provider")}</span><a className="am-doc" href="#" onClick={(e) => e.preventDefault()}>{BT("viewDocs")}</a></div>
            <div className="am-select">
              <button className="am-sel-btn" onClick={() => setProvOpen((o) => !o)}>
                <span className="mp-badge" style={{ background: prov.color, width: 18, height: 18, fontSize: 8 }}>{prov.badge}</span>
                <span className="am-sel-nm">{prov.name}</span>
                <Bicon name="chevronDown" size={14} color="var(--faint)" />
              </button>
              {provOpen && (
                <div className="am-menu">
                  {groups.map((g) => (
                    <React.Fragment key={g.g}>
                      <div className="mp-head">{groupLabel(g.g)}</div>
                      {g.items.map((p) => (
                        <button key={p.id} className={"mp-item" + (p.id === provId ? " sel" : "")} onClick={() => pickProv(p)}>
                          <span className="mp-badge" style={{ background: p.color, width: 18, height: 18, fontSize: 8 }}>{p.badge}</span>
                          <span className="nm" style={{ flex: 1 }}>{p.name}</span>
                          {p.id === provId && <Bicon name="check" size={14} color="var(--accent)" />}
                        </button>
                      ))}
                    </React.Fragment>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="am-field">
            <span className="am-lab">{BT("baseUrl")}</span>
            <input
              className="am-input"
              type="text"
              value={baseUrl}
              onChange={(e) => onBaseUrlChange(e.target.value)}
              readOnly={!isCustom}
              placeholder={isCustom ? "https://api.example.com/v1/chat/completions" : (prov.baseUrl || BT("customUrlPlaceholder"))}
              style={!isCustom ? { background: "var(--panel-2)", color: "var(--faint)", cursor: "default" } : null}
            />
          </div>
          <div className="am-field">
            <span className="am-lab">API Key</span>
            <div className="am-key">
              <input type={showKey ? "text" : "password"} value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={BT("apiKeyPlaceholder")} />
              <button className="am-eye" onClick={() => setShowKey((s) => !s)}><Bicon name="eye" size={15} /></button>
            </div>
          </div>
          <div className="am-field">
            <span className="am-lab">{BT("modelName")}</span>
            <input
              className="am-input"
              type="text"
              value={modelName}
              onChange={(e) => setModelName(e.target.value)}
              placeholder={isCustom ? BT("customModelPlaceholder") : (prov.models?.[0] || "Auto")}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="am-note"><Bicon name="key" size={12} color="var(--faint)" />{BT("byokNote")}</div>
        </div>
        <div className="am-foot">
          <button className="am-cancel" onClick={onClose}>{BT("cancel")}</button>
          <button className="am-save" onClick={save}>{BT("save")}</button>
        </div>
      </div>
    </div>
  );
}

/* ===================== Wallet page ===================== */
function WalletPage({ onCheckout, onClose, onOpenUsage, mobile }) {
  const a = useBilling(); const B = window.RXB;
  const [tab, setTab] = bS("all");
  const flashCost = B.typicalCost("flash") || 0.08;
  const estFlash = Math.floor(a.credits / flashCost);
  const rates = (window.RX.MODELS || []).slice().sort((x, y) => (x.mult || 0) - (y.mult || 0));
  const lang = window.RXI.lang;
  const entries = [
    ...a.ledger.map((e) => ({ ...e, dir: "in" })),
    ...a.consumption.map((e) => ({ type: "spend", points: e.points, ts: e.ts, dir: e.byok ? "byok" : e.free ? "free" : "out", label: e.q ? B.pick(e.q, lang) : "", model: e.model, free: e.free, byok: e.byok, tokIn: e.tokIn, tokOut: e.tokOut })),
  ].sort((x, y) => y.ts - x.ts);
  const filt = entries.filter((e) =>
    tab === "all" ? true : tab === "gift" ? (e.type === "signup" || e.type === "subscription") : tab === "topup" ? e.type === "topup" : e.type === "spend");

  return (
    <div className={"bill-page" + (mobile ? " mob" : "")}>
      <div className="bill-head">
        {onClose && <button className="bill-back" onClick={onClose}><Bicon name="chevronRight" size={16} style={{ transform: "rotate(180deg)" }} /></button>}
        <h1>{BT("walletTitle")}</h1>
      </div>
      <div className="bill-scroll">
        {/* balance hero */}
        <div className="wal-hero">
          <div className="wal-bal">
            <div className="wal-bal-k">{BT("balance")}</div>
            <div className="wal-bal-v"><Bicon name="zap" size={22} color="var(--accent)" />{B.fmtPts(a.credits)}<span>{BT("creditsWord")}</span></div>
            <div className="wal-bal-est">{BT("estFlash")(B.fmt(estFlash))}</div>
            {onOpenUsage && <button className="wal-usage-link" onClick={onOpenUsage}><Bicon name="gauge" size={13} />{BT("usageDetail")}<Bicon name="arrowRight" size={13} /></button>}
          </div>
          <div className="wal-hero-glow" />
        </div>

        {/* top-up packs */}
        <div className="bill-sec-h">{BT("topUp")}</div>
        <div className="bill-sub">{BT("topUpSub")}</div>
        <div className="pack-grid">
          {B.PACKS.map((p) => (
            <button key={p.id} className={"pack" + (p.popular ? " pop" : "") + (p.best ? " best" : "")} onClick={() => onCheckout({ type: "pack", packId: p.id })}>
              {p.popular && <span className="pack-tag">{BT("mostPopular")}</span>}
              {p.best && <span className="pack-tag best">{BT("bestValue")}</span>}
              <div className="pack-cr"><Bicon name="zap" size={15} color="var(--accent)" />{B.fmt(p.credits)}</div>
              {p.bonus > 0 && <div className="pack-bonus">{BT("bonusN")(Math.round(p.bonus * 100))}</div>}
              <div className="pack-usd">{B.fmtUsd(p.usd)}</div>
              <div className="pack-est">{BT("estFlash")(B.fmt(Math.floor(p.credits / flashCost)))}</div>
              <div className="pack-buy">{BT("buy")}</div>
            </button>
          ))}
        </div>

        {/* per-model rates */}
        <div className="bill-sec-h">{BT("ratesTitle")}</div>
        <div className="bill-sub">{BT("ratesSub")}</div>
        <div className="rates-formula"><Bicon name="gauge" size={13} color="var(--accent)" />{BT("formulaNote")(B.RATE.in, B.RATE.out)}</div>
        <div className="rates">
          {rates.map((m) => (
            <div className="rate-row" key={m.id}>
              <span className="mp-badge" style={{ background: m.color, width: 18, height: 18, fontSize: 8 }}>{m.badge}</span>
              <span className="rate-nm">{m.name}{m.free && <span className="rate-free">{BT("mpFree")}</span>}</span>
              <span className={"mp-reason r-" + (m.reason || "med")}>{BT(m.reason === "low" ? "effLow" : m.reason === "high" ? "effHigh" : "effMed")}</span>
              {m.discount && <span className="mp-disc">{BT("discTag")}</span>}
              <span className={"rate-mult" + (m.discount ? " disc" : "")}>{B.fmtMult(m.mult)}</span>
            </div>
          ))}
        </div>

        {/* ledger */}
        <div className="bill-sec-h">{BT("ledgerTitle")}</div>
        <div className="lg-tabs">
          {[["all", "lgAll"], ["gift", "lgGift"], ["spend", "lgSpend"], ["topup", "lgTopup"]].map(([id, k]) => (
            <button key={id} className={"lg-tab" + (tab === id ? " on" : "")} onClick={() => setTab(id)}>{BT(k)}</button>
          ))}
        </div>
        <div className="lg-list">
          {filt.length === 0 ? <div className="lg-empty">{BT("ledgerEmpty")}</div> : filt.map((e, i) => {
            const isIn = e.dir === "in"; const isFree = e.dir === "free"; const isByok = e.dir === "byok";
            const icon = e.type === "topup" ? "creditCard" : e.type === "spend" ? (isByok ? "key" : isFree ? "zap" : "sparkles") : "gift";
            const label = e.label || (e.type === "spend" ? (window.RXI.lang === "en" ? "Question" : "提问") : "");
            const tok = (e.tokIn != null) ? " · ↓" + B.fmtTok(e.tokIn) + " ↑" + B.fmtTok(e.tokOut) : "";
            return (
              <div className="lg-row" key={i}>
                <span className={"lg-ic " + e.dir}><Bicon name={icon} size={14} /></span>
                <div className="lg-mid">
                  <div className="lg-lbl">{typeof label === "object" ? B.pick(label, lang) : label}</div>
                  <div className="lg-ts">{B.timeAgo(e.ts, lang)}{e.model ? " · " + (B.model(e.model) ? B.model(e.model).name : e.model) : ""}{tok}</div>
                </div>
                <div className={"lg-amt " + (isIn ? "in" : isByok ? "byok" : isFree ? "free" : "out")}>
                  {isByok ? BT("byokTag") : isFree ? BT("mpFree") : isIn ? "+" + B.fmt(Math.abs(e.credits)) : "−" + B.fmtPts(Math.abs(e.points))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ===================== Subscriptions page ===================== */
function SubsPage({ kols, onCheckout, onClose, mobile }) {
  const a = useBilling(); const B = window.RXB;
  const list = Object.keys(B.KOL_PLANS);
  return (
    <div className={"bill-page" + (mobile ? " mob" : "")}>
      <div className="bill-head">
        {onClose && <button className="bill-back" onClick={onClose}><Bicon name="chevronRight" size={16} style={{ transform: "rotate(180deg)" }} /></button>}
        <h1>{BT("subsTitle")}</h1>
      </div>
      <div className="bill-scroll">
        <div className="bill-sub" style={{ marginBottom: 16 }}>{BT("subsSub")}</div>
        <div className="sub-cards">
          {list.map((id) => {
            const kol = kolMeta(kols, id); const plan = B.planFor(id);
            const subbed = B.isSubscribed(id); const s = B.sub(id);
            const days = B.subDaysLeft(id);
            const pct = subbed ? Math.max(4, Math.min(100, (days / 30) * 100)) : 0;
            return (
              <div className={"sub-card" + (subbed ? " on" : "")} key={id} style={{ "--ac": kol.accent }}>
                <div className="sub-top">
                  <BAvatar kol={kol} size={46} radius={13} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="sub-nm">{kol.display_name}{subbed && <span className="sub-pill"><Bicon name="crown" size={11} />{BT("subActive")}</span>}</div>
                    <div className="sub-role">{kol.role}</div>
                  </div>
                  {!subbed && (
                    <div className="sub-price">
                      <div className="sub-now">{B.fmtUsd(plan.promoMonthly)}<span>{BT("perMonth")}</span></div>
                      <div className="sub-was">{BT("wasPrice")(B.fmtUsd(plan.priceMonthly))}</div>
                    </div>
                  )}
                </div>
                <div className="sub-benefits">
                  <span><Bicon name="infinity" size={13} />{BT("unlimited")}</span>
                  <span><Bicon name="cpu" size={13} />{BT("allModelsB")}</span>
                  <span><Bicon name="gift" size={13} />{BT("giftMonthly")(B.fmt(plan.gift))}</span>
                </div>
                {subbed ? (
                  <div className="sub-active">
                    <div className="sub-meter">
                      <div className="sub-meter-top">
                        <span className="sub-days"><b>{days}</b> {window.RXI.lang === "en" ? "days left" : "天剩余"}</span>
                        <span className="sub-renew">{s.autoRenew ? BT("renewsOn")(fmtDate(s.expiresAt)) : BT("expiresOn")(fmtDate(s.expiresAt))}</span>
                      </div>
                      <div className="sub-bar"><div className="sub-fill" style={{ width: pct + "%" }} /></div>
                    </div>
                    <div className="sub-row">
                      <button className={"sub-toggle" + (s.autoRenew ? " on" : "")} onClick={() => B.setAutoRenew(id, !s.autoRenew)}>
                        <span className="st-knob" />{s.autoRenew ? BT("autoRenewOn") : BT("autoRenewOff")}
                      </button>
                      <button className="sub-renew-btn" onClick={() => onCheckout({ type: "sub", kolId: id, plan: s.plan })}>{BT("renewNow")}</button>
                    </div>
                  </div>
                ) : (
                  <button className="sub-cta" onClick={() => onCheckout({ type: "sub", kolId: id, plan: "promo" })}>
                    <Bicon name="crown" size={15} />{BT("subscribeCta")} {kol.display_name} · {B.fmtUsd(plan.promoMonthly)}{BT("perMonth")}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ===================== Usage detail page (用量明细) ===================== */
function UsagePage({ onClose, onCheckout, mobile }) {
  const a = useBilling(); const B = window.RXB;
  const lang = window.RXI.lang;
  const [range, setRange] = bS(7);
  const t0 = Date.now();
  const rows = a.consumption.filter((e) => e.ts >= t0 - range * 86400000);
  // Only count credits actually spent (exclude free + BYOK which cost $0 of platform credits).
  const spent = rows.reduce((s, e) => s + (e.byok || e.free ? 0 : (e.points || 0)), 0);
  const tin = rows.reduce((s, e) => s + (e.tokIn || 0), 0);
  const tout = rows.reduce((s, e) => s + (e.tokOut || 0), 0);
  const byokCount = rows.filter((e) => e.byok).length;
  const freeCount = rows.filter((e) => e.free).length;
  const mdl = (id) => B.model(id) || { name: id, color: "#8A8F98", badge: "··" };
  // 扣费方式: byok = 自有 API, free = 免费试用, system = 平台积分
  const chargeKind = (e) => e.byok ? "byok" : e.free ? "free" : "system";
  return (
    <div className={"bill-page" + (mobile ? " mob" : "")}>
      <div className="bill-head">
        {onClose && <button className="bill-back" onClick={onClose}><Bicon name="chevronRight" size={16} style={{ transform: "rotate(180deg)" }} /></button>}
        <h1>{BT("usageTitle")}</h1>
        <span className="usage-delay">{BT("usageDelay")}</span>
      </div>
      <div className="bill-scroll">
        <div className="usage-top">
          <div className="usage-stats">
            <div className="ust"><div className="ust-k">{BT("balance")}</div><div className="ust-v accent"><Bicon name="zap" size={15} color="var(--accent)" />{B.fmtPts(a.credits)}</div></div>
            <div className="ust"><div className="ust-k">{BT("usageSpent")}</div><div className="ust-v">−{B.fmtPts(spent)}</div></div>
            <div className="ust"><div className="ust-k">{BT("usageReq")}</div><div className="ust-v">{rows.length}</div></div>
            <div className="ust"><div className="ust-k">{BT("usageTokens")}</div><div className="ust-v mono sm">↓{B.fmtTok(tin)} ↑{B.fmtTok(tout)}</div></div>
          </div>
          <div className="usage-range">
            {[3, 7, 30].map((d) => <button key={d} className={"urg" + (range === d ? " on" : "")} onClick={() => setRange(d)}>{d}d</button>)}
          </div>
        </div>
        {/* charge-source legend so the user can tell which bucket a question landed in */}
        <div className="usage-legend">
          <span className="usage-legend-k">{BT("usageChargeFrom")}</span>
          <span className={"usage-chip sys"}><Bicon name="zap" size={11} />{BT("usageChipSystem")}{rows.length - byokCount - freeCount > 0 ? " · " + (rows.length - byokCount - freeCount) : ""}</span>
          <span className={"usage-chip free"}><Bicon name="gift" size={11} />{BT("mpFree")}{freeCount > 0 ? " · " + freeCount : ""}</span>
          <span className={"usage-chip byok"}><Bicon name="key" size={11} />{BT("byokTag")}{byokCount > 0 ? " · " + byokCount : ""}</span>
        </div>
        <div className="usage-table">
          <div className="utr utr-h">
            <span className="uc-id">{BT("colReq")}</span>
            <span className="uc-mdl">{BT("modelTitle")}</span>
            <span className="uc-tok">{BT("usageTokens")} <i>({BT("tokInOut")})</i></span>
            <span className="uc-pts">{BT("colPoints")}</span>
            <span className="uc-src">{BT("usageChargeFrom")}</span>
            <span className="uc-q">{BT("colPrompt")}</span>
          </div>
          {rows.length === 0
            ? <div className="usage-empty">{BT("ledgerEmpty")}</div>
            : rows.map((e, i) => {
                const m = mdl(e.model);
                const k = chargeKind(e);
                return (
                  <div className={"utr utr-" + k} key={e.id || i}>
                    <span className="uc-id mono">{e.id ? e.id + "…" : "—"}</span>
                    <span className="uc-mdl">
                      <span className="mp-badge" style={{ background: m.color, width: 18, height: 18, fontSize: 8 }}>{m.badge}</span>
                      <span className="uc-mn">{m.name}</span>
                    </span>
                    <span className="uc-tok mono"><i className="tin">↓ {B.fmtTok(e.tokIn)}</i><i className="tout">↑ {B.fmtTok(e.tokOut)}</i></span>
                    <span className={"uc-pts" + (e.free ? " free" : "")}>{e.free ? BT("mpFree") : "−" + B.fmtPts(e.points)}</span>
                    <span className={"uc-src chip " + k}>
                      {k === "byok" && (<><Bicon name="key" size={11} />{BT("byokTag")}</>)}
                      {k === "free" && (<><Bicon name="gift" size={11} />{BT("mpFree")}</>)}
                      {k === "system" && (<><Bicon name="zap" size={11} />{BT("usageChipSystem")}</>)}
                    </span>
                    <span className="uc-q">{e.q ? B.pick(e.q, lang) : "—"}</span>
                  </div>
                );
              })}
        </div>
        <div className="usage-foot"><Bicon name="gauge" size={13} color="var(--faint)" />{BT("formulaNote")(B.RATE.in, B.RATE.out)}</div>
      </div>
    </div>
  );
}

Object.assign(window, { useBilling, CreditBadge, FreeQuotaBar, Paywall, Checkout, WalletPage, SubsPage, UsagePage, AddModelModal });
