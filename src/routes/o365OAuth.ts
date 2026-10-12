// BF_SERVER_BLOCK_v_O365_OAUTH_v1 - durable O365 connect via server-side
// authorization-code flow. The portal's MSAL.js (SPA) can only hand the server
// a 1-hour access token and NO refresh token, so the server could never refresh
// and the user had to reconnect ~hourly. Here the server redeems an auth CODE
// with its client secret + offline_access, capturing a long-lived REFRESH token
// that graphClient.ts can renew indefinitely.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { pool } from "../db.js";
import { logWarnSwallowed } from "../lib/logWarnSwallowed.js";

const router = Router();
const AUTH_BASE = "https://login.microsoftonline.com";
const SCOPE = "User.Read Mail.ReadWrite Mail.Read.Shared Mail.Send Mail.Send.Shared Calendars.ReadWrite Calendars.Read.Shared Tasks.ReadWrite Contacts.ReadWrite MailboxSettings.ReadWrite People.Read Presence.Read Files.ReadWrite offline_access"; // BF_SERVER_BLOCK_v_O365_SCOPES_WAVE2_v1

function redirectUri(): string {
  return (process.env.O365_OAUTH_REDIRECT_URI || "https://server.boreal.financial/api/o365-oauth/callback").trim();
}
function returnUrl(suffix: string): string {
  const base = (process.env.O365_OAUTH_RETURN_URL || "https://staff.boreal.financial/communications").trim();
  return base + (base.includes("?") ? "&" : "?") + suffix;
}

// BF_SERVER_v789_O365_OAUTH_STATE - the state used to be a JWT naming the user,
// so anyone holding a valid state (or a code+state pair) could bind THEIR Microsoft
// account to that staff user (login CSRF). Now /start issues a random single-use
// nonce, stores sha256(nonce) with the user id and a 10-minute expiry, and sets the
// nonce in an HttpOnly, Secure, SameSite=Lax cookie. The state carries only the
// nonce. The callback requires the cookie to equal the state, consumes the row
// atomically (unused + unexpired), and saves tokens on the user who started it.
// Lax is enough: the callback is a top-level GET navigation from Microsoft.
const STATE_COOKIE = "o365_oauth_nonce";
const STATE_TTL_MS = 10 * 60 * 1000;
const COOKIE_PATH = "/api/o365-oauth";

function nonceHash(nonce: string): string {
  return createHash("sha256").update(nonce, "utf8").digest("hex");
}

function cookieValue(req: any, name: string): string {
  const parsed = req.cookies && typeof req.cookies[name] === "string" ? req.cookies[name] : null;
  if (parsed !== null) return parsed;
  const header = typeof req.headers?.cookie === "string" ? req.headers.cookie : "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return ""; }
  }
  return "";
}

function sameNonce(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

const stateCookieOptions = { httpOnly: true, secure: true, sameSite: "lax" as const, path: COOKIE_PATH };

// GET /api/o365-oauth/start - authed via header (fetched by the portal with
// credentials so the nonce cookie is stored); returns the Microsoft authorize URL.
// The portal then sets window.location to it.
router.get("/start", requireAuth, safeHandler(async (req: any, res: any) => {
  const userId = req.user?.id ?? req.user?.userId ?? req.user?.sub;
  const tenant = process.env.MSAL_TENANT_ID;
  const client = process.env.MSAL_CLIENT_ID;
  if (!userId || !tenant || !client) {
    return res.status(500).json({ error: "o365_oauth_not_configured" });
  }
  const nonce = randomBytes(32).toString("base64url");
  await pool.query(
    `INSERT INTO o365_oauth_states (nonce_hash, user_id, expires_at) VALUES ($1, $2, $3)`,
    [nonceHash(nonce), String(userId), new Date(Date.now() + STATE_TTL_MS)],
  );
  // Housekeeping only; a failure here must not block the connect.
  await pool.query(`DELETE FROM o365_oauth_states WHERE expires_at < now() - interval '1 day'`)
    .catch((err: unknown) => logWarnSwallowed(err, "o365_oauth_states.prune"));
  res.cookie(STATE_COOKIE, nonce, { ...stateCookieOptions, maxAge: STATE_TTL_MS });
  const state = nonce;
  const params = new URLSearchParams({
    client_id: client,
    response_type: "code",
    redirect_uri: redirectUri(),
    response_mode: "query",
    scope: SCOPE,
    state,
    prompt: "select_account",
  });
  res.json({ url: `${AUTH_BASE}/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize?${params.toString()}` });
}));

// GET /api/o365-oauth/callback - PUBLIC. Microsoft redirects the browser here
// with ?code&state. Exchange the code -> access + refresh + expiry, store, bounce
// back to the portal.
router.get("/callback", safeHandler(async (req: any, res: any) => {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const stateRaw = typeof req.query.state === "string" ? req.query.state : "";
  // BF_SERVER_v789_O365_OAUTH_STATE - the nonce cookie is single-use: clear it now.
  const cookieNonce = cookieValue(req, STATE_COOKIE);
  res.clearCookie(STATE_COOKIE, stateCookieOptions);
  if (typeof req.query.error === "string" && req.query.error) return res.redirect(returnUrl("o365=error"));

  const tenant = process.env.MSAL_TENANT_ID;
  const client = process.env.MSAL_CLIENT_ID;
  const clientSecret = process.env.MSAL_CLIENT_SECRET;
  if (!code || !stateRaw || !tenant || !client || !clientSecret) return res.redirect(returnUrl("o365=error"));

  // The browser finishing the flow must be the one that started it.
  if (!cookieNonce || !sameNonce(cookieNonce, stateRaw)) {
    console.warn("o365_oauth_state_cookie_mismatch", { hasCookie: Boolean(cookieNonce) });
    return res.redirect(returnUrl("o365=error"));
  }
  // Consume atomically: only an unused, unexpired nonce yields its user.
  const consumed = await pool.query<{ user_id: string }>(
    `UPDATE o365_oauth_states
        SET consumed_at = now()
      WHERE nonce_hash = $1 AND consumed_at IS NULL AND expires_at > now()
      RETURNING user_id::text AS user_id`,
    [nonceHash(stateRaw)],
  );
  const uid = consumed.rows[0]?.user_id ?? "";
  if (!uid) {
    console.warn("o365_oauth_state_invalid", { reason: "unknown_used_or_expired" });
    return res.redirect(returnUrl("o365=error"));
  }

  const body = new URLSearchParams({
    client_id: client,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri(),
    grant_type: "authorization_code",
    scope: SCOPE,
  });
  const tokRes = await fetch(`${AUTH_BASE}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!tokRes.ok) {
    const detail = await tokRes.text().catch((err: unknown) => { console.warn("o365_oauth_exchange_body_unreadable", { message: (err as Error)?.message }); return ""; });
    console.error("o365_oauth_exchange_failed", { status: tokRes.status, detail: detail.slice(0, 300) });
    return res.redirect(returnUrl("o365=error"));
  }
  const tok = (await tokRes.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  const accessToken = tok.access_token ?? "";
  const refreshToken = tok.refresh_token ?? null;
  const expiresAt = new Date(Date.now() + (tok.expires_in ?? 3600) * 1000);
  if (!accessToken) return res.redirect(returnUrl("o365=error"));

  let email = "";
  try {
    const me = await fetch("https://graph.microsoft.com/v1.0/me", { headers: { Authorization: `Bearer ${accessToken}` } });
    if (me.ok) { const p = (await me.json()) as { mail?: string; userPrincipalName?: string }; email = p.mail ?? p.userPrincipalName ?? ""; }
  } catch { /* non-fatal */ }

  await pool.query(
    `UPDATE users SET
        o365_access_token = $1,
        o365_refresh_token = COALESCE($2, o365_refresh_token),
        o365_access_token_expires_at = $3,
        o365_token_expires_at        = $3,
        o365_user_email = COALESCE(NULLIF($4, ''), o365_user_email)
      WHERE id = $5`,
    [accessToken, refreshToken, expiresAt, email, uid],
  );
  return res.redirect(returnUrl("o365=connected"));
}));

// BF_SERVER_O365_DISCONNECT_v802 - POST /api/o365-oauth/disconnect. The portal's Disconnect button only
// cleared the screen; the stored Microsoft tokens stayed, so mail and calendar kept using the account.
router.post("/disconnect", requireAuth, safeHandler(async (req: any, res: any) => {
  const userId = req.user?.id ?? req.user?.userId ?? req.user?.sub;
  if (!userId) return res.status(401).json({ error: "unauthorized" });
  await pool.query(
    "UPDATE users SET o365_access_token = NULL, o365_refresh_token = NULL, o365_access_token_expires_at = NULL, o365_token_expires_at = NULL, o365_user_email = NULL, o365_account_id = NULL WHERE id = $1",
    [String(userId)],
  );
  return res.json({ ok: true, connected: false });
}));

export default router;
