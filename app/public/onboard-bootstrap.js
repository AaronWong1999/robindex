(() => {
  const path = window.location.pathname.replace(/\/+$/, "");
  const match = path.match(/^\/add-kol\/([^/]+)$/);
  if (!match && path !== "/add-kol") return;
  document.documentElement.style.visibility = "hidden";
  const fail = () => window.location.replace("/");
  if (match) {
    fetch(`/api/onboarding/invite?token=${encodeURIComponent(match[1])}`, {
      credentials: "same-origin",
      redirect: "manual",
      cache: "no-store",
    }).then((res) => {
      if (res.status !== 302 && res.type !== "opaqueredirect") throw new Error("invalid invite");
      window.location.replace("/api/onboarding/page");
    }).catch(fail);
    return;
  }
  window.location.replace("/api/onboarding/page");
})();
