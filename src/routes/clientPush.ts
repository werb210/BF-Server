// BF_SERVER_CLIENT_PUSH_TOKEN_v1 - applicant device push-token registration.
import express from "express";
import { pool } from "../db.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { respondOk } from "../utils/respondOk.js";

const router = express.Router();

router.post("/register-token", safeHandler(async (req: any, res: any) => {
  const userId = String(req.user?.id ?? req.user?.userId ?? "");
  const token = String(req.body?.token ?? "").trim();
  const platform = req.body?.platform ? String(req.body.platform) : null;
  if (!token) return res.status(400).json({ error: { code: "token_required" } });
  await pool.query(
    `INSERT INTO client_push_tokens (user_id, token, platform, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (token) DO UPDATE SET user_id = $1, platform = $3, updated_at = now()`,
    [userId || null, token, platform]);
  respondOk(res, { ok: true });
}));

export default router;
