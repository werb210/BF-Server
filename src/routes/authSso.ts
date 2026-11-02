// BF_SERVER_v875_SSO (ported from KS-server #35) - "Sign in with Microsoft" for staff. Mounted under /api/auth/sso.
//   GET  /api/auth/sso/config               (public)  whether the sign-in page shows the Microsoft button
//   GET  /api/auth/sso/microsoft/start      (public)  sets the state cookie and redirects to Microsoft
//   GET  /api/auth/sso/microsoft/callback   (public, rate limited)  checks everything, then redirects to the portal
//                                                      with a one-time 60-second code in the URL fragment
//   POST /api/auth/sso/exchange { code }    (public, rate limited)  the code -> the same staff session the text-code
//                                                      and passkey sign-ins give: access token (with its session
//                                                      id) and refresh token (v868)
// The state is a random single-use value: its sha256, the PKCE verifier and the nonce are stored for 10 minutes and
// the value is also set in an HttpOnly, Secure, SameSite=Lax cookie; the callback needs both. The Microsoft account is
// matched by email to ONE existing, active staff user (Admin, Staff, Ops or Marketing); nobody is ever created, and
// lender, referrer and client accounts are refused. The session opened is a single sign-on session, which counts as a
// strong sign-in for "require a passkey or two-step sign-in" (v869). Every sign-in and refusal is audit-logged.
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { timingSafeEqual } from "node:crypto";
import { pool } from "../db.js";
import { signAccessToken } from "../auth/jwt.js";
import { fetchCapabilitiesForRole } from "../auth/capabilities.js";
import { isStaffRole, normalizeRole, ROLES } from "../auth/roles.js";
import { refreshFieldsForSignIn } from "../auth/staffRefresh.js";
import { findAuthUserById } from "../modules/auth/auth.repo.js";
import { recordAuditEvent } from "../modules/audit/audit.service.js";
import { clientIpFromRequest, rateLimitKeyFromRequest } from "../middleware/clientIp.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { logWarnSwallowed } from "../lib/logWarnSwallowed.js";
import type { Q } from "../settingsPack/common.js";
import {
  HANDOFF_TTL_MS, STATE_TTL_MS, SsoError, buildAuthorizeUrl, exchangeCodeForIdToken, isSsoProvider, providerConfig,
  randomToken, sha256Hex, ssoReturnUrl, verifyIdToken, type Fetcher, type KeyResolver,
} from "../sso/oidc.js";
import { loadSsoAvailability } from "../sso/settings.js";

const router = Router();
const db = () => pool as unknown as Q;

const STATE_COOKIE = "bf_sso_state";
const COOKIE_PATH = "/api/auth/sso";
const stateCookieOptions = { httpOnly: true, secure: true, sameSite: "lax" as const, path: COOKIE_PATH };

// Test hooks: the id_token signing-key lookup and the token endpoint call.
let keyResolver: KeyResolver | undefined;
let tokenFetcher: Fetcher | undefined;
export function setSsoKeyResolverForTests(r: KeyResolver | undefined): void {
  keyResolver = r;
}
export function setSsoFetcherForTests(f: Fetcher | undefined): void {
  tokenFetcher = f;
}

// Per address: a whole office signing in at 9am shares one address, so this is generous; the codes themselves are
// 256-bit random values and single-use, so the limit is about load and noise, not guessing.
function ssoLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: Number(process.env.SSO_RATE_LIMIT ?? "") || 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: rateLimitKeyFromRequest,
    message: { ok: false, error: "rate_limited", message: "Too many sign-in attempts. Try again in a few minutes." },
  });
}
const ssoCallbackLimiter = ssoLimiter();
const ssoExchangeLimiter = ssoLimiter();

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

function back(params: Record<string, string>, fragment = false): string {
  const base = ssoReturnUrl();
  const q = new URLSearchParams(params).toString();
  if (fragment) return `${base}#${q}`;
  return base + (base.includes("?") ? "&" : "?") + q;
}

function clientIp(req: any): string | null {
  try { return clientIpFromRequest(req) || null; } catch { return null; }
}

async function audit(req: any, success: boolean, details: Record<string, unknown>, userId: string | null = null) {
  try {
    await recordAuditEvent({
      action: success ? "sso_sign_in" : "sso_sign_in_refused",
      actorUserId: userId,
      targetUserId: userId,
      targetType: "user",
      targetId: userId,
      ip: clientIp(req),
      userAgent: String(req.headers?.["user-agent"] ?? "").slice(0, 300) || null,
      success,
      metadata: { provider: "microsoft", ...details },
    });
  } catch (err) {
    console.error("[sso] audit write failed", { success, message: (err as Error)?.message });
  }
}

export type SsoStaffUser = { id: string; role: string | null; active: boolean | null; disabled: boolean | null; deleted_at: unknown; status: string | null };

/** Why this user may not sign in, or null when they may. */
export function staffRefusal(user: SsoStaffUser | undefined): string | null {
  if (!user) return "no_user";
  if (!isStaffRole(user.role)) return "not_staff";
  if (user.active === false || user.disabled === true || user.deleted_at || String(user.status ?? "ACTIVE").toUpperCase() === "INACTIVE") return "user_inactive";
  return null;
}

/** The one staff user for this email, or why there is none. Lender / referrer / client accounts never match. */
export function pickStaffUser(rows: SsoStaffUser[]): { user: SsoStaffUser } | { refusal: string; user?: SsoStaffUser } {
  const staff = rows.filter((u) => isStaffRole(u.role) && !u.deleted_at);
  if (staff.length > 1) return { refusal: "ambiguous_email" };
  if (staff.length === 1) {
    const why = staffRefusal(staff[0]);
    return why ? { refusal: why, user: staff[0] } : { user: staff[0]! };
  }
  return { refusal: rows.length ? "not_staff" : "no_user" };
}

const USER_COLS = `id::text AS id, role, active, disabled, deleted_at, status`;

router.get("/config", safeHandler(async (_req: any, res: any) => {
  const a = await loadSsoAvailability(db());
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true, microsoft: a.microsoft.available });
}));

router.get("/:provider/start", safeHandler(async (req: any, res: any) => {
  const provider = String(req.params.provider ?? "");
  if (!isSsoProvider(provider)) return res.status(404).json({ ok: false, error: "not_found" });
  const cfg = providerConfig(provider);
  const a = await loadSsoAvailability(db());
  res.setHeader("Cache-Control", "no-store");
  if (!cfg || !a.microsoft.available) return res.redirect(back({ sso_error: "sso_off" }));
  const state = randomToken();
  const nonce = randomToken();
  const verifier = randomToken();
  await pool.query(
    `INSERT INTO sso_login_states (state_hash, provider, code_verifier, nonce, expires_at) VALUES ($1, $2, $3, $4, $5)`,
    [sha256Hex(state), provider, verifier, nonce, new Date(Date.now() + STATE_TTL_MS)],
  );
  await pool.query(`DELETE FROM sso_login_states WHERE expires_at < now() - interval '1 day'`)
    .catch((err: unknown) => logWarnSwallowed(err, "sso_login_states.prune"));
  res.cookie(STATE_COOKIE, state, { ...stateCookieOptions, maxAge: STATE_TTL_MS });
  const hint = typeof req.query.login_hint === "string" && /^[^\s@]+@[^\s@]+$/.test(req.query.login_hint) ? req.query.login_hint.slice(0, 200) : undefined;
  return res.redirect(buildAuthorizeUrl(cfg, { state, nonce, verifier, loginHint: hint }));
}));

router.get("/:provider/callback", ssoCallbackLimiter, safeHandler(async (req: any, res: any) => {
  const provider = String(req.params.provider ?? "");
  if (!isSsoProvider(provider)) return res.status(404).json({ ok: false, error: "not_found" });
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const cookieState = cookieValue(req, STATE_COOKIE);
  res.clearCookie(STATE_COOKIE, stateCookieOptions);
  res.setHeader("Cache-Control", "no-store");
  const refuse = async (reason: string, details: Record<string, unknown> = {}, userId: string | null = null) => {
    await audit(req, false, { reason, ...details }, userId);
    return res.redirect(back({ sso_error: reason }));
  };

  if (typeof req.query.error === "string" && req.query.error) return refuse("provider_error", { provider_error: String(req.query.error).slice(0, 60) });
  const cfg = providerConfig(provider);
  const a = await loadSsoAvailability(db());
  if (!cfg || !a.microsoft.available) return refuse("sso_off");
  if (!code || !state) return refuse("missing_code");
  if (!cookieState || !same(cookieState, state)) return refuse("state");
  const consumed = await pool.query(
    `UPDATE sso_login_states SET consumed_at = now()
      WHERE state_hash = $1 AND provider = $2 AND consumed_at IS NULL AND expires_at > now()
      RETURNING code_verifier, nonce`,
    [sha256Hex(state), provider],
  );
  const row = consumed.rows[0] as { code_verifier?: string; nonce?: string } | undefined;
  if (!row?.code_verifier || !row.nonce) return refuse("state");

  let identity;
  try {
    const idToken = await exchangeCodeForIdToken(cfg, code, row.code_verifier, tokenFetcher);
    identity = await verifyIdToken(idToken, { clientId: cfg.clientId, nonce: row.nonce, tenantId: cfg.tenantId }, keyResolver);
  } catch (err) {
    const reason = err instanceof SsoError ? err.reason : "bad_token";
    console.warn("[sso] sign-in refused", { reason, message: (err as Error)?.message });
    return refuse(reason);
  }

  const users = await pool.query(`SELECT ${USER_COLS} FROM users WHERE lower(email) = $1 LIMIT 10`, [identity.email]);
  const domain = identity.email.split("@")[1] ?? "";
  const pick = pickStaffUser(users.rows as SsoStaffUser[]);
  if ("refusal" in pick) return refuse(pick.refusal, { email: identity.email, email_domain: domain }, pick.user?.id ?? null);

  const handoff = randomToken();
  await pool.query(
    `INSERT INTO sso_login_handoffs (code_hash, user_id, provider, email, expires_at) VALUES ($1, $2::uuid, $3, $4, $5)`,
    [sha256Hex(handoff), pick.user.id, provider, identity.email, new Date(Date.now() + HANDOFF_TTL_MS)],
  );
  await pool.query(`DELETE FROM sso_login_handoffs WHERE expires_at < now() - interval '1 day'`)
    .catch((err: unknown) => logWarnSwallowed(err, "sso_login_handoffs.prune"));
  await audit(req, true, { email: identity.email, tenant_id: identity.tenantId, stage: "callback" }, pick.user.id);
  return res.redirect(back({ sso_code: handoff }, true));
}));

router.post("/exchange", ssoExchangeLimiter, safeHandler(async (req: any, res: any) => {
  const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
  res.setHeader("Cache-Control", "no-store");
  if (!code || code.length > 200) return res.status(400).json({ ok: false, error: "code_required" });
  const consumed = await pool.query(
    `UPDATE sso_login_handoffs SET consumed_at = now()
      WHERE code_hash = $1 AND consumed_at IS NULL AND expires_at > now()
      RETURNING user_id::text AS user_id, provider`,
    [sha256Hex(code)],
  );
  const row = consumed.rows[0] as { user_id?: string; provider?: string } | undefined;
  if (!row?.user_id) return res.status(401).json({ ok: false, error: "sso_code_invalid", message: "That sign-in link has expired. Please sign in again." });
  // Re-checked here: the user could have been switched off in the seconds since the callback.
  const check = await pool.query(`SELECT ${USER_COLS} FROM users WHERE id = $1::uuid LIMIT 1`, [row.user_id]);
  const user: any = await findAuthUserById(row.user_id);
  const why = staffRefusal(check.rows[0] as SsoStaffUser | undefined) ?? (user ? null : "no_user");
  if (why) {
    await audit(req, false, { reason: why, stage: "exchange" }, row.user_id);
    return res.status(403).json({ ok: false, error: "user_inactive", message: "This account can't sign in. Ask an Admin." });
  }
  const role = normalizeRole(user.role ?? "") ?? ROLES.STAFF;
  const userSilos = Array.isArray(user.silos) ? (user.silos as string[]) : [];
  const userSilo = user.silo as string | undefined;
  // BF_SERVER_v869_SECURITY - a single sign-on session is a strong session.
  const { openSession } = await import("../security/sessions.js");
  const ksid = await openSession(pool as any, { userId: String(user.id), method: "sso", ip: clientIp(req), userAgent: String(req.headers?.["user-agent"] ?? "") });
  const token = signAccessToken({
    ...(ksid ? { ksid } : {}),
    sub: String(user.id),
    role,
    tokenVersion: user.tokenVersion ?? 0,
    capabilities: fetchCapabilitiesForRole(role),
    ...(user.phoneNumber ? { phone: user.phoneNumber } : {}),
    ...(userSilo ? { silo: userSilo } : {}),
    ...(userSilos.length ? { silos: userSilos } : {}),
  } as any);
  // BF_SERVER_v868_SLIDING_REFRESH - the same refresh token the other staff sign-ins get.
  const refreshFields = await refreshFieldsForSignIn(pool as any, { userId: String(user.id), tokenVersion: user.tokenVersion ?? 0, ksid });
  await pool.query(`UPDATE users SET last_login_at = now() WHERE id = $1::uuid`, [user.id])
    .catch((err: unknown) => logWarnSwallowed(err, "authSso.ts:last_login_at"));
  await audit(req, true, { stage: "exchange", session: ksid ? "opened" : "none" }, String(user.id));
  return res.status(200).json({ status: "ok", data: { token, ...refreshFields } });
}));

export default router;
