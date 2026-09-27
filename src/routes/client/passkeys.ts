// BF_SERVER_BLOCK_v599 - /api/client/passkeys/*
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { safeKeyGenerator } from "../../middleware/rateLimit.js";
import { safeHandler } from "../../middleware/safeHandler.js";
import { dbQuery } from "../../db.js";
import { clientPhoneFromAuth } from "../../services/clientDeviceSignIn.js";
import { listPasskeys, loginOptions, loginWithPasskey, registerPasskey, registrationOptions, removePasskey } from "../../services/clientPasskeys.js";

const router = Router();
const query = (sql: string, params: unknown[]) => dbQuery(sql, params as any[]) as any;
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false, message: { error: "RATE_LIMITED" }, keyGenerator: safeKeyGenerator, validate: { xForwardedForHeader: false, trustProxy: false } });
const phoneOf = (req: any) => clientPhoneFromAuth(req.headers?.authorization, process.env.JWT_SECRET);

router.post("/passkeys/register/options", safeHandler(async (req: any, res: any) => {
  const phone = phoneOf(req);
  if (!phone) return res.status(401).json({ error: "client_session_required" });
  return res.json(await registrationOptions(query, phone));
}));

router.post("/passkeys/register/verify", safeHandler(async (req: any, res: any) => {
  const phone = phoneOf(req);
  if (!phone) return res.status(401).json({ error: "client_session_required" });
  const r = await registerPasskey(query, phone, req.body);
  return r.ok ? res.status(201).json({ ok: true }) : res.status(400).json({ error: r.error });
}));

router.post("/passkeys/login/options", limiter as any, safeHandler(async (_req: any, res: any) => {
  return res.json(await loginOptions(query));
}));

router.post("/passkeys/login/verify", limiter as any, safeHandler(async (req: any, res: any) => {
  const secret = process.env.JWT_SECRET;
  if (!secret) return res.status(500).json({ error: "auth_not_configured" });
  const r = await loginWithPasskey(query, req.body, secret);
  if (!r.ok) {
    console.warn(JSON.stringify({ event: "client_passkey_login_rejected", reason: r.error }));
    return res.status(401).json({ error: r.error });
  }
  return res.json({ status: "ok", data: { token: r.token, hasSubmittedApplication: r.hasSubmittedApplication, submittedApplicationId: r.submittedApplicationId } });
}));

router.get("/passkeys", safeHandler(async (req: any, res: any) => {
  const phone = phoneOf(req);
  if (!phone) return res.status(401).json({ error: "client_session_required" });
  return res.json({ passkeys: await listPasskeys(query, phone) });
}));

router.delete("/passkeys/:id", safeHandler(async (req: any, res: any) => {
  const phone = phoneOf(req);
  if (!phone) return res.status(401).json({ error: "client_session_required" });
  return res.json({ removed: await removePasskey(query, phone, String(req.params.id)) });
}));

export default router;
