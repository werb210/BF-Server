// BF_SERVER_v852_CALC_QBO - QuickBooks Online for the company, and the fee invoices of media deals.
//   GET  /api/quickbooks/status                         Admin: configured? (and what is missing), connected company, tax code
//   POST /api/quickbooks/connect                        Admin: { url } - the Intuit sign-in page, with a single-use state
//   GET  /api/quickbooks/oauth/callback                 PUBLIC (Intuit redirects the browser here): stores the tokens
//   POST /api/quickbooks/disconnect                     Admin: revokes the tokens at Intuit and forgets the connection
//   PUT  /api/quickbooks/settings                       Admin: { taxCode } - the QuickBooks tax code for the fee line
//   GET  /api/quickbooks/applications/:id/invoice       Admin, Staff: the file's fee invoice (number, amount, Open/Paid)
//   POST /api/quickbooks/applications/:id/retry         Admin, Staff: sync that file again now
// With QBO_CLIENT_ID / QBO_CLIENT_SECRET / QBO_TOKEN_ENCRYPTION_KEY unset everything answers "not configured" and
// nothing reaches Intuit. Application routes answer 404 for a file outside the caller's silo, like the neighbouring
// application routes; the invoice itself works the same in every silo.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { pool } from "../db.js";
import { auth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { getSilo } from "../middleware/silo.js";
import { rateLimitKeyFromRequest } from "../middleware/clientIp.js";
import { logWarnSwallowed } from "../lib/logWarnSwallowed.js";
import { qboConfigured, qboEnvironment, qboMissingSettings, qboReturnUrl } from "../services/quickbooks/qboConfig.js";
import { authorizeUrl, exchangeCodeAndConnect, getConnection, revokeAndDisconnect } from "../services/quickbooks/qboClient.js";
import { getInvoiceRow, getTaxCode, invoiceView, setTaxCode, syncFeeInvoice } from "../services/quickbooks/feeInvoices.js";

const router = Router();
const admin = [auth, requireAuthorization({ roles: [ROLES.ADMIN] })];
const staff = [auth, requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] })];
const userIdOf = (req: any) => String(req.user?.userId ?? req.user?.id ?? req.user?.sub ?? "");

const STATE_COOKIE = "qbo_oauth_state";
const STATE_TTL_MS = 10 * 60 * 1000;
const COOKIE_PATH = "/api/quickbooks";
const stateCookieOptions = { httpOnly: true, secure: true, sameSite: "lax" as const, path: COOKIE_PATH };

const callbackLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: rateLimitKeyFromRequest,
  message: { ok: false, error: "rate_limited" },
});

export function stateHash(state: string): string {
  return createHash("sha256").update(state, "utf8").digest("hex");
}

function cookieValue(req: any, name: string): string {
  const parsed = req.cookies && typeof req.cookies[name] === "string" ? req.cookies[name] : null;
  if (parsed !== null) return parsed;
  const header = typeof req.headers?.cookie === "string" ? req.headers.cookie : "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0 || part.slice(0, i).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return ""; }
  }
  return "";
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);

router.get("/status", ...admin, safeHandler(async (_req: any, res: any) => {
  res.setHeader("Cache-Control", "no-store");
  const configured = qboConfigured();
  if (!configured) {
    return res.json({ ok: true, configured: false, missing: qboMissingSettings(), environment: qboEnvironment(), connected: false, reason: "QuickBooks is not set up on the server. Missing: " + qboMissingSettings().join(", ") + "." });
  }
  const conn = await getConnection();
  const counts = await pool.query(
    `SELECT count(*) FILTER (WHERE status = 'open')::int AS open, count(*) FILTER (WHERE status = 'paid')::int AS paid,
            count(*) FILTER (WHERE sync_state = 'failed')::int AS failed
       FROM qbo_fee_invoices`,
    [],
  );
  let connectedByName: string | null = null;
  if (conn?.connected_by) {
    const u = await pool.query(`SELECT COALESCE(NULLIF(trim(coalesce(first_name,'') || ' ' || coalesce(last_name,'')), ''), email) AS name FROM users WHERE id::text = $1 LIMIT 1`, [conn.connected_by]);
    connectedByName = u.rows[0]?.name ?? null;
  }
  return res.json({
    ok: true, configured: true, missing: [], environment: qboEnvironment(), connected: Boolean(conn),
    connection: conn ? { realmId: conn.realm_id, companyName: conn.company_name, connectedAt: iso(conn.connected_at), connectedByName, refreshExpiresAt: iso(conn.refresh_expires_at), environment: conn.environment } : null,
    taxCode: await getTaxCode(),
    invoices: counts.rows[0] ?? { open: 0, paid: 0, failed: 0 },
  });
}));

router.post("/connect", ...admin, safeHandler(async (req: any, res: any) => {
  if (!qboConfigured()) return res.status(409).json({ ok: false, error: "not_configured", message: "QuickBooks is not set up on the server." });
  const userId = userIdOf(req);
  if (!userId) return res.status(401).json({ ok: false, error: "unauthorized" });
  const state = randomBytes(32).toString("base64url");
  await pool.query(`INSERT INTO qbo_oauth_states (state_hash, user_id, expires_at) VALUES ($1, $2, $3)`, [stateHash(state), userId, new Date(Date.now() + STATE_TTL_MS)]);
  // Housekeeping only; a failure here must not block the connect.
  await pool.query(`DELETE FROM qbo_oauth_states WHERE expires_at < now() - interval '1 day'`)
    .catch((err: unknown) => logWarnSwallowed(err, "qbo_oauth_states.prune"));
  res.cookie(STATE_COOKIE, state, { ...stateCookieOptions, maxAge: STATE_TTL_MS });
  return res.json({ ok: true, url: authorizeUrl(state) });
}));

router.get("/oauth/callback", callbackLimiter, safeHandler(async (req: any, res: any) => {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const realmId = typeof req.query.realmId === "string" ? req.query.realmId.trim() : "";
  const cookieState = cookieValue(req, STATE_COOKIE);
  res.clearCookie(STATE_COOKIE, stateCookieOptions);
  if (!qboConfigured()) return res.redirect(qboReturnUrl("error"));
  if (typeof req.query.error === "string" && req.query.error) {
    console.warn("[quickbooks] connect declined", { error: String(req.query.error).slice(0, 80) });
    return res.redirect(qboReturnUrl("error"));
  }
  if (!code || !state || !/^[0-9]{1,32}$/.test(realmId)) return res.redirect(qboReturnUrl("error"));
  // The browser finishing the flow must be the one that started it.
  if (!cookieState || !same(cookieState, state)) {
    console.warn("[quickbooks] state cookie mismatch", { hasCookie: Boolean(cookieState) });
    return res.redirect(qboReturnUrl("error"));
  }
  const consumed = await pool.query(
    `UPDATE qbo_oauth_states SET consumed_at = now()
      WHERE state_hash = $1 AND consumed_at IS NULL AND expires_at > now()
      RETURNING user_id`,
    [stateHash(state)],
  );
  const userId = consumed.rows[0]?.user_id ? String(consumed.rows[0].user_id) : "";
  if (!userId) {
    console.warn("[quickbooks] state unknown, used or expired");
    return res.redirect(qboReturnUrl("error"));
  }
  try {
    await exchangeCodeAndConnect(code, realmId, userId);
  } catch (err) {
    console.error("[quickbooks] connect failed", { message: (err as Error)?.message });
    return res.redirect(qboReturnUrl("error"));
  }
  console.info({ event: "qbo_connected", realmId, userId });
  return res.redirect(qboReturnUrl("connected"));
}));

router.post("/disconnect", ...admin, safeHandler(async (req: any, res: any) => {
  if (!qboConfigured()) return res.status(409).json({ ok: false, error: "not_configured", message: "QuickBooks is not set up on the server." });
  const out = await revokeAndDisconnect();
  console.info({ event: "qbo_disconnected", userId: userIdOf(req), revoked: out.revoked });
  return res.json({ ok: true, revoked: out.revoked });
}));

router.put("/settings", ...admin, safeHandler(async (req: any, res: any) => {
  const raw = req.body?.taxCode;
  if (raw !== null && raw !== undefined && typeof raw !== "string") return res.status(400).json({ ok: false, error: "invalid_tax_code" });
  const code = typeof raw === "string" ? raw.trim() : "";
  if (code && !/^[A-Za-z0-9_-]{1,40}$/.test(code)) return res.status(400).json({ ok: false, error: "invalid_tax_code", message: "Use the QuickBooks tax code id (letters and numbers)." });
  await setTaxCode(code || null);
  return res.json({ ok: true, taxCode: code || null });
}));

/** The application, when it exists in the caller's silo. */
async function appInSilo(id: string, res: any): Promise<string | null> {
  const silo = getSilo(res) ?? null;
  const r = await pool.query(
    `SELECT id::text AS id FROM applications
      WHERE id::text = $1 AND ($2::text IS NULL OR silo IS NULL OR upper(silo) = upper($2::text)) LIMIT 1`,
    [id, silo],
  );
  return r.rows[0]?.id ?? null;
}

router.get("/applications/:id/invoice", ...staff, safeHandler(async (req: any, res: any) => {
  res.setHeader("Cache-Control", "no-store");
  if (!qboConfigured()) return res.json({ ok: true, configured: false, invoice: null });
  const id = await appInSilo(String(req.params.id ?? "").trim(), res);
  if (!id) return res.status(404).json({ ok: false, error: "not_found" });
  return res.json({ ok: true, configured: true, invoice: invoiceView(await getInvoiceRow(id)) });
}));

router.post("/applications/:id/retry", ...staff, safeHandler(async (req: any, res: any) => {
  if (!qboConfigured()) return res.status(409).json({ ok: false, error: "not_configured", message: "QuickBooks is not set up on the server." });
  const id = await appInSilo(String(req.params.id ?? "").trim(), res);
  if (!id) return res.status(404).json({ ok: false, error: "not_found" });
  await pool.query(`UPDATE qbo_fee_invoices SET attempts = 0, sync_state = 'queued', next_attempt_at = now(), updated_at = now() WHERE application_id = $1 AND status <> 'paid'`, [id]);
  const outcome = await syncFeeInvoice(id);
  console.info({ event: "qbo_fee_invoice_retry", applicationId: id, userId: userIdOf(req), action: outcome.action });
  return res.json({ ok: outcome.ok, action: outcome.action, error: outcome.error ?? null, invoice: invoiceView(await getInvoiceRow(id)) });
}));

export default router;
