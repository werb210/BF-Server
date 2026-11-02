// BF_SERVER_v874_MARKETING_TOOLS - the website kit (src/marketing/websiteKit.ts), ported from KS-server #48 without the
// Marketing add-on, the form limit or the Marketing seat cap. Every silo (BF, BI, SLF) has its own kit.
//
// Staff (Admins and Marketing users), mounted at /api/website-kit, for the request's silo (X-Silo / ?silo=):
//   GET    /                     settings, forms and the snippet to copy
//   PUT    /settings             { allowed_origins, chat_enabled, tracking_enabled, consent_banner } (audited)
//   POST   /settings/new-key     replaces the public key (the old snippet stops working; audited)
//   POST   /forms                a lead form (audited)
//   PUT    /forms/:id, DELETE /forms/:id (audited)
//
// Public, mounted at /api/kit (answers only pages on the website addresses the Admin listed for that key's silo):
//   GET  /:key/kit.js            the script
//   POST /:key/forms/:formId     a form submission -> a CRM lead in the kit's silo (rotation, consent, staff notified)
//   POST /:key/chat              the AI chat widget -> Maya as a website visitor (when the chat is switched on)
//   POST /:key/track             page views, only sent after the visitor agreed to analytics cookies (when on)
//   POST /:key/consent           the visitor's cookie choice (recorded like the other consent banners)
// Bodies are JSON sent as text/plain so browsers send them without a preflight.
import express, { Router } from "express";
import rateLimit from "express-rate-limit";
import { pool } from "../db.js";
import { auth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { resolveSiloFromRequest } from "../middleware/silo.js";
import { clientIpFromRequest, rateLimitKeyFromRequest } from "../middleware/clientIp.js";
import { actorId, auditFor, UUID_RE, type Q } from "../settingsPack/common.js";
import {
  KIT_BRAND, createForm, deleteForm, kitConsentText, kitForKey, kitSettings, kitSnippet, listForms, liveForms, newKitKey,
  normalizeKitSettings, originAllowed, parseFormInput, parseSubmission, saveKitSettings, updateForm,
  type KitSettings, type KitSilo,
} from "../marketing/websiteKit.js";
import { kitScript } from "../marketing/kitScript.js";
import { logWarnSwallowed } from "../lib/logWarnSwallowed.js";

const db = (): Q => pool as unknown as Q;
const staff = [auth, requireAuthorization({ roles: [ROLES.ADMIN, ROLES.MARKETING] })];

/** Boreal's colour on the kit's buttons, per silo (white text passes contrast on each). */
const KIT_COLOR: Record<KitSilo, string> = { BF: "#0b3a6e", BI: "#14532d", SLF: "#3b2f7a" };

export function serverBase(): string {
  return String(process.env.SERVER_PUBLIC_URL ?? process.env.PUBLIC_SERVER_URL ?? "https://server.boreal.financial").replace(/\/+$/, "");
}

function siloOf(req: any): KitSilo | null {
  const s = resolveSiloFromRequest(req);
  return s === "BF" || s === "BI" || s === "SLF" ? s : null;
}

async function overview(silo: KitSilo) {
  const [settings, forms] = await Promise.all([kitSettings(db(), silo), listForms(db(), silo)]);
  return {
    ok: true,
    silo,
    brand: KIT_BRAND[silo],
    settings,
    forms: forms.map((f) => ({ ...f, live: f.active })),
    snippet: kitSnippet(serverBase(), settings.key, forms),
    consent_text: kitConsentText(KIT_BRAND[silo]),
  };
}

// ------------------------------------------------------------------------------------------------------- staff

export const websiteKitAdminRoutes = Router();

websiteKitAdminRoutes.use(...staff, (req: any, res: any, next: any) => {
  if (siloOf(req)) return next();
  return res.status(400).json({ ok: false, error: "silo_not_supported", message: "The website kit is set up in the BF, BI and SLF silos." });
});

websiteKitAdminRoutes.get("/", safeHandler(async (req: any, res: any) => {
  res.setHeader("Cache-Control", "no-store");
  return res.json(await overview(siloOf(req)!));
}));

websiteKitAdminRoutes.put("/settings", safeHandler(async (req: any, res: any) => {
  const silo = siloOf(req)!;
  const current = await kitSettings(db(), silo);
  const next: KitSettings = { ...normalizeKitSettings({ ...current, ...(req.body ?? {}) }), key: current.key };
  const raw = Array.isArray(req.body?.allowed_origins) ? req.body.allowed_origins.map((x: unknown) => String(x ?? "").trim()).filter(Boolean) : [];
  if (raw.length > next.allowed_origins.length) {
    return res.status(400).json({ ok: false, error: "invalid_origin", message: "Each website address must start with https:// (for example https://www.example.ca)." });
  }
  await saveKitSettings(db(), next, actorId(req), silo);
  await auditFor(req, "website_kit_settings_saved", {
    silo, allowed_origins: next.allowed_origins, chat_enabled: next.chat_enabled, tracking_enabled: next.tracking_enabled, consent_banner: next.consent_banner,
  });
  return res.json(await overview(silo));
}));

websiteKitAdminRoutes.post("/settings/new-key", safeHandler(async (req: any, res: any) => {
  const silo = siloOf(req)!;
  const current = await kitSettings(db(), silo);
  await saveKitSettings(db(), { ...current, key: newKitKey() }, actorId(req), silo);
  await auditFor(req, "website_kit_key_replaced", { silo });
  return res.json(await overview(silo));
}));

websiteKitAdminRoutes.post("/forms", safeHandler(async (req: any, res: any) => {
  const silo = siloOf(req)!;
  const parsed = parseFormInput(req.body);
  if (!parsed.ok) return res.status(400).json({ ok: false, error: "invalid_form", message: parsed.error });
  const form = await createForm(db(), silo, parsed.value, actorId(req));
  await auditFor(req, "website_kit_form_created", { silo, name: form.name }, { type: "website_kit_form", id: form.id });
  return res.status(201).json({ ...(await overview(silo)), form });
}));

websiteKitAdminRoutes.put("/forms/:id", safeHandler(async (req: any, res: any) => {
  const silo = siloOf(req)!;
  const id = String(req.params.id);
  if (!UUID_RE.test(id)) return res.status(404).json({ ok: false, error: "not_found" });
  const parsed = parseFormInput(req.body);
  if (!parsed.ok) return res.status(400).json({ ok: false, error: "invalid_form", message: parsed.error });
  const form = await updateForm(db(), silo, id, parsed.value);
  if (!form) return res.status(404).json({ ok: false, error: "not_found" });
  await auditFor(req, "website_kit_form_updated", { silo, name: form.name, active: form.active }, { type: "website_kit_form", id });
  return res.json({ ...(await overview(silo)), form });
}));

websiteKitAdminRoutes.delete("/forms/:id", safeHandler(async (req: any, res: any) => {
  const silo = siloOf(req)!;
  const id = String(req.params.id);
  if (!UUID_RE.test(id) || !(await deleteForm(db(), silo, id))) return res.status(404).json({ ok: false, error: "not_found" });
  await auditFor(req, "website_kit_form_deleted", { silo }, { type: "website_kit_form", id });
  return res.json(await overview(silo));
}));

// ------------------------------------------------------------------------------------------------------ public

export const websiteKitPublicRoutes = Router();
const publicLimiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false, keyGenerator: rateLimitKeyFromRequest });
const submitLimiter = rateLimit({ windowMs: 10 * 60_000, limit: 10, standardHeaders: true, legacyHeaders: false, keyGenerator: rateLimitKeyFromRequest });
websiteKitPublicRoutes.use(express.text({ type: "*/*", limit: "32kb" }));

/** The JSON a kit request carries (sent as text/plain); {} when it is not JSON. */
export function kitBody(raw: unknown): Record<string, any> {
  if (raw && typeof raw === "object" && !Buffer.isBuffer(raw)) return raw as Record<string, any>;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** Finds the kit for :key and checks the page's website address. Sends the refusal and returns null. */
async function kitFor(req: any, res: any): Promise<{ silo: KitSilo; settings: KitSettings } | null> {
  const kit = await kitForKey(db(), req.params.key);
  if (!kit) { res.status(404).json({ ok: false, error: "not_found" }); return null; }
  const origin = req.headers?.origin;
  if (!originAllowed(kit.settings, origin)) {
    res.status(403).json({ ok: false, error: "website_not_allowed", message: "This website is not set up for this form. Please contact us by phone or email instead." });
    return null;
  }
  res.setHeader("Access-Control-Allow-Origin", String(origin));
  res.setHeader("Vary", "Origin");
  return kit;
}

websiteKitPublicRoutes.get("/:key/kit.js", publicLimiter, safeHandler(async (req: any, res: any) => {
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.setHeader("X-Content-Type-Options", "nosniff");
  const kit = await kitForKey(db(), req.params.key);
  if (!kit) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(404).send("/* This website kit is not available. */");
  }
  const forms = liveForms(await listForms(db(), kit.silo));
  const brand = KIT_BRAND[kit.silo];
  res.setHeader("Cache-Control", "public, max-age=300");
  return res.send(kitScript({
    base: serverBase(), key: kit.settings.key, brand, color: KIT_COLOR[kit.silo], consentText: kitConsentText(brand), assistant: "Maya",
    chat: kit.settings.chat_enabled, tracking: kit.settings.tracking_enabled, banner: kit.settings.consent_banner,
    forms: forms.map((f) => ({ id: f.id, fields: f.fields, button_label: f.button_label, thank_you: f.thank_you })),
  }));
}));

websiteKitPublicRoutes.post("/:key/forms/:formId", submitLimiter, safeHandler(async (req: any, res: any) => {
  const kit = await kitFor(req, res);
  if (!kit) return;
  const body = kitBody(req.body);
  if (String(body.company_website ?? "").trim()) return res.json({ ok: true }); // the hidden field people never fill in
  const form = liveForms(await listForms(db(), kit.silo)).find((f) => f.id === String(req.params.formId));
  if (!form) return res.status(404).json({ ok: false, error: "form_not_available", message: "This form is not taking submissions right now. Please call or email us instead." });
  const parsed = parseSubmission(form, body);
  if (!parsed.ok) return res.status(400).json({ ok: false, error: "invalid_submission", field: parsed.field, message: parsed.error });
  const { submitKitLead } = await import("../marketing/kitLead.js");
  const lead = await submitKitLead(pool, kit.silo, form, parsed.value);
  return res.json({ ok: true, message: form.thank_you, contact: lead.created ? "created" : "updated" });
}));

websiteKitPublicRoutes.post("/:key/chat", publicLimiter, safeHandler(async (req: any, res: any) => {
  const kit = await kitFor(req, res);
  if (!kit) return;
  if (!kit.settings.chat_enabled) return res.status(404).json({ ok: false, error: "chat_not_available", message: "Chat is not available right now." });
  const body = kitBody(req.body);
  const message = String(body.message ?? "").trim().slice(0, 2000);
  if (!message) return res.status(400).json({ ok: false, error: "message_required", message: "Type a question first." });
  const sessionId = /^[A-Za-z0-9_.:-]{6,100}$/.test(String(body.sessionId ?? "")) ? String(body.sessionId) : null;
  const { proxyMayaToAgent } = await import("./maya.js");
  // Maya talks to the person as a website visitor of the kit's silo; nothing from the page's own headers is forwarded.
  await proxyMayaToAgent("/api/maya/message", "POST", { message, sessionId }, res, { headers: { "x-silo": kit.silo } } as any);
}));

websiteKitPublicRoutes.post("/:key/track", publicLimiter, safeHandler(async (req: any, res: any) => {
  const kit = await kitFor(req, res);
  if (!kit) return;
  if (!kit.settings.tracking_enabled) return res.json({ ok: true, skipped: "tracking_off" });
  try {
    const { recordJourney } = await import("./visitorTrack.js");
    const out = await recordJourney(kitBody(req.body), req.headers?.["user-agent"]);
    return res.json({ ok: true, ...out });
  } catch (err) {
    // Tracking must never surface an error to the visitor's browser.
    logWarnSwallowed(err, "routes/websiteKit.ts:track");
    return res.json({ ok: true, skipped: "error" });
  }
}));

websiteKitPublicRoutes.post("/:key/consent", publicLimiter, safeHandler(async (req: any, res: any) => {
  const kit = await kitFor(req, res);
  if (!kit) return;
  const { parseConsent, recordConsent } = await import("../privacy/privacy.js");
  const parsed = parseConsent({ ...kitBody(req.body), surface: "website_kit" });
  if (!parsed.ok) return res.status(400).json({ ok: false, error: parsed.error });
  await recordConsent(db(), parsed.value, { ip: safeIp(req), userAgent: String(req.headers?.["user-agent"] ?? "") });
  return res.status(201).json({ ok: true });
}));

function safeIp(req: any): string {
  try { return clientIpFromRequest(req) || ""; } catch (err) { return logWarnSwallowed(err, "routes/websiteKit.ts:ip", ""); }
}
