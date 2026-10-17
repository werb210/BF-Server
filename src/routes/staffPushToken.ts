// BF_SERVER_v820_WATCH_CALLS - the staff iPhone dialler registers its APNs (alert) device token here so missed
// calls, voicemails, client messages, SMS and Maya handoffs reach the lock screen. Staff JWT only.
//   POST   /api/staff/push-token { token: hex 64-200, environment: "production" | "sandbox", app?: "dialer-ios" }
//   DELETE /api/staff/push-token { token }
// A token belongs to whoever registered it last (a shared/reassigned phone moves with the sign-in).
import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { STAFF_PUSH_APPS } from "../services/notifications/staffAlerts.js";

const router = Router();
router.use(requireAuth);
router.use(requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF, ROLES.OPS, ROLES.MARKETING] }));

const TOKEN = /^[0-9a-f]{64,200}$/;

function userIdOf(req: any): string {
  return String(req.user?.id ?? req.user?.userId ?? req.user?.sub ?? "").trim();
}

function tokenOf(req: any): string | null {
  const raw = typeof req.body?.token === "string" ? req.body.token.trim().toLowerCase() : "";
  return TOKEN.test(raw) ? raw : null;
}

router.post("/", safeHandler(async (req: any, res: any) => {
  const userId = userIdOf(req);
  if (!userId) return res.status(401).json({ error: { code: "unauthenticated" } });
  const token = tokenOf(req);
  if (!token) return res.status(400).json({ error: { code: "invalid_token", message: "token must be 64-200 hex characters" } });
  const environment = req.body?.environment === undefined ? "production" : req.body.environment;
  if (environment !== "production" && environment !== "sandbox")
    return res.status(400).json({ error: { code: "invalid_environment", message: "environment must be production or sandbox" } });
  const app = req.body?.app === undefined ? "dialer-ios" : req.body.app;
  if (!(STAFF_PUSH_APPS as readonly string[]).includes(app))
    return res.status(400).json({ error: { code: "invalid_app", message: "app must be dialer-ios" } });
  const { rows } = await pool.query(
    `INSERT INTO staff_push_tokens (user_id, token, environment, app, created_at, updated_at, last_error)
     VALUES ($1::uuid, $2, $3, $4, now(), now(), NULL)
     ON CONFLICT (token) DO UPDATE
       SET user_id = EXCLUDED.user_id, environment = EXCLUDED.environment, app = EXCLUDED.app,
           updated_at = now(), last_error = NULL
     RETURNING id::text AS id, environment, app, updated_at`,
    [userId, token, environment, app],
  );
  return res.status(200).json({ ok: true, registration: rows[0] ?? null });
}));

router.delete("/", safeHandler(async (req: any, res: any) => {
  const userId = userIdOf(req);
  if (!userId) return res.status(401).json({ error: { code: "unauthenticated" } });
  const token = tokenOf(req);
  if (!token) return res.status(400).json({ error: { code: "invalid_token", message: "token must be 64-200 hex characters" } });
  const result = await pool.query(`DELETE FROM staff_push_tokens WHERE token = $1 AND user_id::text = $2`, [token, userId]);
  return res.status(200).json({ ok: true, removed: Number(result.rowCount ?? 0) });
}));

export default router;
