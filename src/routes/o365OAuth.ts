// BF_SERVER_BLOCK_v_O365_OAUTH_v1 - durable O365 connect via server-side
// authorization-code flow. The portal's MSAL.js (SPA) can only hand the server
// a 1-hour access token and NO refresh token, so the server could never refresh
// and the user had to reconnect ~hourly. Here the server redeems an auth CODE
// with its client secret + offline_access, capturing a long-lived REFRESH token
// that graphClient.ts can renew indefinitely.
import { Router } from "express";
import jwt from "jsonwebtoken";
import { requireAuth } from "../middleware/auth.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { pool } from "../db.js";

const router = Router();
const AUTH_BASE = "https://login.microsoftonline.com";
const SCOPE = "User.Read Mail.ReadWrite Mail.Read.Shared Mail.Send Mail.Send.Shared Calendars.ReadWrite Tasks.ReadWrite offline_access";

function redirectUri(): string {
  return (process.env.O365_OAUTH_REDIRECT_URI || "https://server.boreal.financial/api/o365-oauth/callback").trim();
}
function returnUrl(suffix: string): string {
  const base = (process.env.O365_OAUTH_RETURN_URL || "https://staff.boreal.financial/communications").trim();
  return base + (base.includes("?") ? "&" : "?") + suffix;
}

// GET /api/o365-oauth/start - authed via header (fetched by the portal); returns
// the Microsoft authorize URL. The portal then sets window.location to it.
router.get("/start", requireAuth, safeHandler(async (req: any, res: any) => {
  const userId = req.user?.id ?? req.user?.userId ?? req.user?.sub;
  const tenant = process.env.MSAL_TENANT_ID;
  const client = process.env.MSAL_CLIENT_ID;
  const secret = process.env.JWT_SECRET;
  if (!userId || !tenant || !client || !secret) {
    return res.status(500).json({ error: "o365_oauth_not_configured" });
  }
  const state = jwt.sign({ uid: String(userId) }, secret, { expiresIn: "10m" });
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
  if (typeof req.query.error === "string" && req.query.error) return res.redirect(returnUrl("o365=error"));

  const secret = process.env.JWT_SECRET;
  const tenant = process.env.MSAL_TENANT_ID;
  const client = process.env.MSAL_CLIENT_ID;
  const clientSecret = process.env.MSAL_CLIENT_SECRET;
  if (!code || !stateRaw || !secret || !tenant || !client || !clientSecret) return res.redirect(returnUrl("o365=error"));

  let uid = "";
  try { uid = String((jwt.verify(stateRaw, secret) as any).uid ?? ""); } catch { return res.redirect(returnUrl("o365=error")); }
  if (!uid) return res.redirect(returnUrl("o365=error"));

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
    console.error("o365_oauth_exchange_failed", { status: tokRes.status, detail: (await tokRes.text().catch(() => "")).slice(0, 300) });
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

export default router;
