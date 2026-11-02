// BF_SERVER_v874_MARKETING_TOOLS - the website kit's script (GET /api/kit/:key/kit.js), ported from KS-server #48. Plain
// ES2017 that runs on the website the kit is placed on. It builds every element with DOM methods (never innerHTML with
// visitor or staff text), sends JSON as text/plain (a "simple" request, so no preflight), and tracks nothing until the
// visitor agreed to analytics cookies: through the kit's banner, or the website's own banner calling
// window.WebsiteKit.consent(true). The consent box next to a form is never pre-ticked.
export type KitScriptConfig = {
  base: string;
  key: string;
  brand: string;
  color: string;
  /** The CASL wording next to the consent box (websiteKit.kitConsentText). */
  consentText: string;
  assistant: string;
  chat: boolean;
  tracking: boolean;
  banner: boolean;
  forms: Array<{
    id: string;
    fields: Array<{ key: string; label: string; required: boolean }>;
    button_label: string;
    thank_you: string;
  }>;
};

/** A colour the kit can put on a button with white text; anything else falls back to a dark blue. */
export function safeColor(c: string): string {
  return /^#[0-9a-f]{6}$/i.test(c) ? c : "#0b3a6e";
}

export function kitScript(cfg: KitScriptConfig): string {
  const config = JSON.stringify({ ...cfg, color: safeColor(cfg.color) }).replace(/</g, "\\u003c");
  return `/* Boreal website kit */
(function () {
  "use strict";
  if (window.WebsiteKit && window.WebsiteKit.loaded) return;
  var C = ${config};
  var API = C.base + "/api/kit/" + C.key;
  var store = {
    get: function (k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* storage blocked: choice kept for this page only */ } }
  };
  function post(path, body) {
    return fetch(API + path, { method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8" }, body: JSON.stringify(body), credentials: "omit", keepalive: true })
      .then(function (r) { return r.json().catch(function () { return { ok: r.ok }; }).then(function (j) { j.__status = r.status; return j; }); });
  }
  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) {
      if (k === "style") e.style.cssText = attrs[k]; else e.setAttribute(k, attrs[k]);
    }
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function rid() { return "kit-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10); }

  /* ---------------- consent and tracking ---------------- */
  var CONSENT_KEY = "boreal_kit_consent_" + C.key;
  var consent = store.get(CONSENT_KEY);
  var sessionId = null;
  var started = false;
  var pageStart = Date.now();
  function visitorId() {
    var v = store.get("boreal_kit_vid");
    if (!v) { v = rid(); store.set("boreal_kit_vid", v); }
    return v;
  }
  function attribution() {
    var q = new URLSearchParams(window.location.search), a = { landing_page: window.location.pathname, referrer: document.referrer || null };
    ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "gbraid", "wbraid"].forEach(function (k) { var v = q.get(k); if (v) a[k] = v; });
    return a;
  }
  function startTracking() {
    if (started || !C.tracking || consent !== "granted") return;
    started = true;
    sessionId = sessionStorage.getItem("boreal_kit_sid") || rid();
    try { sessionStorage.setItem("boreal_kit_sid", sessionId); } catch (e) { /* private mode: one session per page */ }
    post("/track", { sessionId: sessionId, attribution: attribution(), events: [{ type: "pageview", path: window.location.pathname, title: document.title }] });
    window.addEventListener("pagehide", function () {
      var body = JSON.stringify({ sessionId: sessionId, events: [{ type: "page_leave", path: window.location.pathname, dwellMs: Date.now() - pageStart }] });
      if (navigator.sendBeacon) navigator.sendBeacon(API + "/track", new Blob([body], { type: "text/plain" }));
    });
  }
  function setConsent(granted, fromBanner) {
    consent = granted ? "granted" : "denied";
    store.set(CONSENT_KEY, consent);
    post("/consent", { visitorId: visitorId(), choice: consent, categories: { analytics: !!granted, session_replay: false, advertising: false }, source: fromBanner ? "kit_banner" : "site" });
    var b = document.getElementById("boreal-kit-banner"); if (b) b.parentNode.removeChild(b);
    if (granted) startTracking();
  }
  function showBanner() {
    if (!C.tracking || !C.banner || consent || document.getElementById("boreal-kit-banner")) return;
    var box = el("div", { id: "boreal-kit-banner", role: "dialog", "aria-label": "Cookie choice", style: "position:fixed;left:16px;right:16px;bottom:16px;max-width:560px;margin:0 auto;z-index:2147483000;background:#ffffff;color:#111827;border:1px solid #9ca3af;border-radius:10px;padding:14px 16px;font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.18)" });
    box.appendChild(el("p", { style: "margin:0 0 10px" }, C.brand + " would like to use analytics cookies to see which pages are useful. Nothing is tracked unless you agree."));
    var row = el("div", { style: "display:flex;gap:8px;flex-wrap:wrap" });
    var yes = el("button", { type: "button", style: "background:" + C.color + ";color:#ffffff;border:0;border-radius:8px;padding:8px 14px;font-weight:600;cursor:pointer" }, "Accept");
    var no = el("button", { type: "button", style: "background:#ffffff;color:#111827;border:1px solid #6b7280;border-radius:8px;padding:8px 14px;cursor:pointer" }, "Decline");
    yes.onclick = function () { setConsent(true, true); };
    no.onclick = function () { setConsent(false, true); };
    row.appendChild(yes); row.appendChild(no); box.appendChild(row);
    document.body.appendChild(box);
  }

  /* ---------------- lead forms ---------------- */
  var FIELD_TYPES = { email: "email", phone: "tel", amount: "text" };
  function renderForm(host, f) {
    if (host.getAttribute("data-boreal-ready")) return;
    host.setAttribute("data-boreal-ready", "1");
    var form = el("form", { novalidate: "novalidate", style: "display:grid;gap:10px;max-width:520px;font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111827" });
    f.fields.forEach(function (fd) {
      var id = "boreal-" + f.id.slice(0, 8) + "-" + fd.key;
      var wrap = el("div", { style: "display:grid;gap:4px" });
      wrap.appendChild(el("label", { "for": id, style: "font-weight:600;color:#111827" }, fd.label + (fd.required ? " *" : "")));
      var input = fd.key === "message" ? el("textarea", { id: id, name: fd.key, rows: "4" }) : el("input", { id: id, name: fd.key, type: FIELD_TYPES[fd.key] || "text" });
      if (fd.required) input.setAttribute("required", "required");
      input.setAttribute("style", "padding:9px 10px;border:1px solid #6b7280;border-radius:8px;background:#ffffff;color:#111827;font:inherit");
      wrap.appendChild(input); form.appendChild(wrap);
    });
    var trap = el("input", { name: "company_website", tabindex: "-1", autocomplete: "off", "aria-hidden": "true", style: "position:absolute;left:-9999px;width:1px;height:1px" });
    form.appendChild(trap);
    var consentId = "boreal-" + f.id.slice(0, 8) + "-consent";
    var consentText = C.consentText;
    var cw = el("div", { style: "display:flex;gap:8px;align-items:flex-start" });
    var cb = el("input", { id: consentId, type: "checkbox", style: "margin-top:4px" });
    cw.appendChild(cb); cw.appendChild(el("label", { "for": consentId, style: "color:#111827" }, consentText)); form.appendChild(cw);
    var btn = el("button", { type: "submit", style: "justify-self:start;background:" + C.color + ";color:#ffffff;border:0;border-radius:8px;padding:10px 18px;font:inherit;font-weight:600;cursor:pointer" }, f.button_label);
    form.appendChild(btn);
    var msg = el("p", { role: "status", "aria-live": "polite", style: "margin:0;color:#111827" });
    form.appendChild(msg);
    form.onsubmit = function (ev) {
      ev.preventDefault();
      if (trap.value) return;
      var values = {};
      f.fields.forEach(function (fd) { var i = form.elements.namedItem(fd.key); values[fd.key] = i ? i.value : ""; });
      btn.disabled = true; msg.textContent = "Sending...";
      post("/forms/" + f.id, { fields: values, consent: cb.checked, consentText: cb.checked ? consentText : null, sessionId: consent === "granted" ? sessionId : null, page: window.location.href })
        .then(function (r) {
          btn.disabled = false;
          if (r && r.ok) { form.replaceWith(el("p", { role: "status", style: "font:16px/1.5 system-ui,sans-serif;color:#111827" }, f.thank_you)); return; }
          msg.textContent = (r && r.message) || "Sorry, that did not send. Please try again.";
        })
        .catch(function () { btn.disabled = false; msg.textContent = "Sorry, that did not send. Please check your connection and try again."; });
    };
    host.appendChild(form);
  }
  function renderForms() {
    var hosts = document.querySelectorAll("[data-boreal-form]");
    for (var i = 0; i < hosts.length; i++) {
      var id = hosts[i].getAttribute("data-boreal-form");
      var f = C.forms.filter(function (x) { return x.id === id; })[0];
      if (f) renderForm(hosts[i], f);
    }
  }

  /* ---------------- AI chat widget ---------------- */
  function renderChat() {
    if (!C.chat || document.getElementById("boreal-kit-chat")) return;
    var chatId = sessionStorage.getItem("boreal_kit_chat") || rid();
    try { sessionStorage.setItem("boreal_kit_chat", chatId); } catch (e) { /* private mode: one chat per page */ }
    var open = el("button", { id: "boreal-kit-chat", type: "button", "aria-expanded": "false", style: "position:fixed;right:16px;bottom:16px;z-index:2147482000;background:" + C.color + ";color:#ffffff;border:0;border-radius:999px;padding:12px 18px;font:600 15px system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.2);cursor:pointer" }, "Chat with " + C.assistant);
    var panel = el("div", { role: "dialog", "aria-label": "Chat with " + C.assistant, style: "display:none;position:fixed;right:16px;bottom:72px;z-index:2147482000;width:340px;max-width:calc(100vw - 32px);height:440px;max-height:calc(100vh - 100px);background:#ffffff;color:#111827;border:1px solid #9ca3af;border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.22);font:14px/1.5 system-ui,sans-serif;flex-direction:column" });
    var head = el("div", { style: "padding:10px 14px;background:" + C.color + ";color:#ffffff;border-radius:12px 12px 0 0;font-weight:600" }, C.assistant + " - " + C.brand);
    var log = el("div", { style: "flex:1;overflow:auto;padding:10px 14px;display:flex;flex-direction:column;gap:8px" });
    var formRow = el("form", { style: "display:flex;gap:6px;padding:10px;border-top:1px solid #d1d5db" });
    var input = el("input", { type: "text", "aria-label": "Your message", placeholder: "Type your question", style: "flex:1;padding:8px;border:1px solid #6b7280;border-radius:8px;color:#111827;background:#ffffff;font:inherit" });
    var send = el("button", { type: "submit", style: "background:" + C.color + ";color:#ffffff;border:0;border-radius:8px;padding:8px 12px;font:inherit;font-weight:600;cursor:pointer" }, "Send");
    formRow.appendChild(input); formRow.appendChild(send);
    panel.appendChild(head); panel.appendChild(log); panel.appendChild(formRow);
    function say(who, text) {
      var mine = who === "me";
      log.appendChild(el("div", { style: "align-self:" + (mine ? "flex-end" : "flex-start") + ";max-width:85%;padding:8px 10px;border-radius:10px;white-space:pre-wrap;" + (mine ? "background:#e5e7eb;color:#111827" : "background:#eff6ff;color:#111827;border:1px solid #bfdbfe") }, text));
      log.scrollTop = log.scrollHeight;
    }
    open.onclick = function () {
      var shown = panel.style.display !== "none";
      panel.style.display = shown ? "none" : "flex";
      open.setAttribute("aria-expanded", shown ? "false" : "true");
      if (!shown && !log.childNodes.length) say("ai", "Hi, I'm " + C.assistant + ". How can I help?");
      if (!shown) input.focus();
    };
    formRow.onsubmit = function (ev) {
      ev.preventDefault();
      var text = input.value.trim(); if (!text) return;
      input.value = ""; say("me", text); send.disabled = true;
      post("/chat", { message: text, sessionId: chatId })
        .then(function (r) { send.disabled = false; say("ai", (r && (r.reply || r.message)) || "Sorry, I could not answer that. Please try again."); })
        .catch(function () { send.disabled = false; say("ai", "Sorry, I could not reach the assistant. Please try again."); });
    };
    document.body.appendChild(panel); document.body.appendChild(open);
  }

  function boot() { renderForms(); renderChat(); showBanner(); startTracking(); }
  window.WebsiteKit = {
    loaded: true,
    /** Call from the website's own cookie banner: WebsiteKit.consent(true) or WebsiteKit.consent(false). */
    consent: function (granted) { setConsent(!!granted, false); },
    /** Render forms added to the page after it loaded. */
    refresh: renderForms
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
`;
}
