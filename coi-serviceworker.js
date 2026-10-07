/*
 * coi-serviceworker.js
 *
 * GitHub Pages can't send the two security headers that let a page use all
 * CPU cores for the AI model ("cross-origin isolation"). This small service
 * worker adds them to this site's own pages. Without it everything still
 * works, just on one CPU core.
 */
if (typeof window === "undefined") {
  // ---------------- running as the service worker
  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
  self.addEventListener("fetch", (e) => {
    const req = e.request;
    if (new URL(req.url).origin !== self.location.origin) return; // leave other sites alone
    if (req.cache === "only-if-cached" && req.mode !== "same-origin") return;
    e.respondWith(
      fetch(req).then((res) => {
        if (res.status === 0) return res;
        const headers = new Headers(res.headers);
        headers.set("Cross-Origin-Embedder-Policy", "credentialless");
        headers.set("Cross-Origin-Opener-Policy", "same-origin");
        return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
      })
    );
  });
} else {
  // ---------------- running on the page: install the worker, reload once
  (() => {
    if (window.crossOriginIsolated || !window.isSecureContext || !("serviceWorker" in navigator)) return;
    let reloaded = false;
    try { reloaded = sessionStorage.getItem("coiReloaded") === "1"; } catch (e) { /* storage blocked */ }
    navigator.serviceWorker.register(document.currentScript.src).then((reg) => {
      const reloadOnce = () => {
        if (reloaded) return;
        try { sessionStorage.setItem("coiReloaded", "1"); } catch (e) { return; }
        window.location.reload();
      };
      if (navigator.serviceWorker.controller) reloadOnce();
      else navigator.serviceWorker.addEventListener("controllerchange", reloadOnce);
      reg.update();
    }).catch((err) => console.warn("Service worker not installed (still works, single core):", err));
  })();
}
