import express from "express";
import { pool } from "../db.js";
import { safeHandler } from "../middleware/safeHandler.js";

const router = express.Router();

async function refreshMicrosoftAccessToken(refresh: string): Promise<{ accessToken: string; refreshToken: string | null; expiresAt: Date } | null> {
  const tenant = process.env.MSAL_TENANT_ID;
  const client = process.env.MSAL_CLIENT_ID;
  const secret = process.env.MSAL_CLIENT_SECRET;
  if (!tenant || !client || !secret) return null;
  const body = new URLSearchParams({
    client_id: client,
    client_secret: secret,
    refresh_token: refresh,
    grant_type: "refresh_token",
    scope: "User.Read Mail.Send Mail.ReadWrite Mail.Send.Shared Calendars.ReadWrite Tasks.ReadWrite offline_access",
  });
  const r = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) return null;
  const tok = await r.json();
  return {
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token ?? null,
    expiresAt: new Date(Date.now() + (tok.expires_in ?? 3600) * 1000),
  };
}

// POST /api/users/me/o365-tokens
// Body: { access_token, refresh_token?, expires_in?, account_id? }
router.post("/o365-tokens", safeHandler(async (req: any, res: any) => {
  const userId = req.user?.id ?? req.user?.userId;
  if (!userId) return res.status(401).json({ error: "unauthenticated" });
  const { access_token, refresh_token, expires_in, account_id } = req.body ?? {};
  if (!access_token) return res.status(400).json({ error: "access_token required" });

  const expiresAt = typeof expires_in === "number"
    ? new Date(Date.now() + expires_in * 1000)
    : null;

  await pool.query(
    `UPDATE users SET
       o365_access_token = $1,
       o365_refresh_token = COALESCE($2, o365_refresh_token),
       o365_access_token_expires_at = $3,
       o365_account_id = COALESCE($4, o365_account_id)
     WHERE id = $5`,
    [access_token, refresh_token ?? null, expiresAt, account_id ?? null, userId],
  );
  res.json({ ok: true });
}));

// GET /api/users/me/o365-status
router.get("/o365-status", safeHandler(async (req: any, res: any) => {
  const userId = req.user?.id ?? req.user?.userId;
  if (!userId) return res.status(401).json({ error: "unauthenticated" });
  const { rows } = await pool.query(
    `SELECT email, o365_account_id, o365_access_token, o365_refresh_token, o365_access_token_expires_at,
       (o365_access_token IS NOT NULL) AS has_access,
       (o365_refresh_token IS NOT NULL) AS has_refresh
     FROM users WHERE id = $1`,
    [userId],
  );
  const r = rows[0];
  if (!r) return res.status(404).json({ error: "user_not_found" });
  if (!r.has_access) return res.status(200).json({ connected: false, reason: "no_tokens" });

  const expiresAt = r.o365_access_token_expires_at ? new Date(r.o365_access_token_expires_at) : null;
  const expired = !expiresAt || expiresAt.getTime() <= Date.now();
  if (!expired) {
    return res.status(200).json({ connected: true, email: r.email ?? null, expiresAt });
  }

  if (!r.o365_refresh_token) {
    await pool.query(
      `UPDATE users
       SET o365_access_token = NULL, o365_refresh_token = NULL, o365_access_token_expires_at = NULL
       WHERE id = $1`,
      [userId]
    );
    return res.status(200).json({ connected: false, reason: "refresh_failed" });
  }

  const refreshed = await refreshMicrosoftAccessToken(r.o365_refresh_token);
  if (!refreshed) {
    await pool.query(
      `UPDATE users
       SET o365_access_token = NULL, o365_refresh_token = NULL, o365_access_token_expires_at = NULL
       WHERE id = $1`,
      [userId]
    );
    return res.status(200).json({ connected: false, reason: "refresh_failed" });
  }

  await pool.query(
    `UPDATE users SET
       o365_access_token = $1,
       o365_refresh_token = COALESCE($2, o365_refresh_token),
       o365_access_token_expires_at = $3
     WHERE id = $4`,
    [refreshed.accessToken, refreshed.refreshToken, refreshed.expiresAt, userId],
  );
  return res.status(200).json({ connected: true, email: r.email ?? null, expiresAt: refreshed.expiresAt });
}));

// POST /api/users/me/o365-refresh — exchanges stored refresh_token for fresh access_token
router.post("/o365-refresh", safeHandler(async (req: any, res: any) => {
  const userId = req.user?.id ?? req.user?.userId;
  if (!userId) return res.status(401).json({ error: "unauthenticated" });
  const { rows } = await pool.query(
    `SELECT o365_refresh_token FROM users WHERE id = $1`, [userId],
  );
  const refresh = rows[0]?.o365_refresh_token;
  if (!refresh) return res.status(412).json({ error: "no_refresh_token" });

  const refreshed = await refreshMicrosoftAccessToken(refresh);
  if (!refreshed) {
    return res.status(503).json({ error: "msal_not_configured" });
  }
  await pool.query(
    `UPDATE users SET
       o365_access_token = $1,
       o365_refresh_token = COALESCE($2, o365_refresh_token),
       o365_access_token_expires_at = $3
     WHERE id = $4`,
    [refreshed.accessToken, refreshed.refreshToken, refreshed.expiresAt, userId],
  );
  res.json({ ok: true, accessToken: refreshed.accessToken, expiresAt: refreshed.expiresAt });
}));

export default router;
