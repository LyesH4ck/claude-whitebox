// Injected into every page before page scripts run. Captures network-emitting APIs
// (fetch/XHR/WebSocket) for endpoint discovery — same idea as the crawler's hooks.
// It does NOT touch alert/confirm/prompt: native dialogs are caught at the Playwright
// layer (page.on('dialog')) so alert()-style XSS payloads still register.

export const INIT_SCRIPT = `
(() => {
  if (window.__probe_hooked__) return;
  window.__probe_hooked__ = true;
  const net = (window.__probe_net__ = []);
  const push = (e) => { try { if (net.length < 2000) net.push(e); } catch {} };
  const ser = (b) => {
    try {
      if (b == null) return null;
      if (typeof b === 'string') return b.slice(0, 2048);
      if (b instanceof URLSearchParams) return b.toString();
      if (b instanceof FormData) {
        const o = {};
        for (const [k, v] of b.entries()) o[k] = typeof v === 'string' ? v : '[file]';
        return JSON.stringify(o);
      }
    } catch {}
    return '[binary]';
  };

  const of = window.fetch;
  if (of) window.fetch = function (i, init) {
    try {
      const u = typeof i === 'string' ? i : (i && i.url) || '';
      push({ kind: 'fetch', url: u, method: (init && init.method) || 'GET', body: ser(init && init.body) });
    } catch {}
    return of.apply(this, arguments);
  };

  const X = window.XMLHttpRequest;
  if (X) {
    const open = X.prototype.open, send = X.prototype.send;
    X.prototype.open = function (m, u) { this.__m = m; this.__u = u; return open.apply(this, arguments); };
    X.prototype.send = function (b) {
      try { push({ kind: 'xhr', url: this.__u, method: this.__m, body: ser(b) }); } catch {}
      return send.apply(this, arguments);
    };
  }

  const W = window.WebSocket;
  if (W) {
    const P = function (u, p) { try { push({ kind: 'ws', url: String(u) }); } catch {} return new W(u, p); };
    P.prototype = W.prototype;
    window.WebSocket = P;
  }
})();
`;
