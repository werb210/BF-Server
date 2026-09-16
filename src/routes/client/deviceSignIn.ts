// BF_SERVER_CLIENT_FACE_ID_v296 - enroll / sign in / revoke for Face ID sign-in.
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { safeKeyGenerator } from "../../middleware/rateLimit.js"; // BF_SERVER_DEVICE_SIGN_IN_KEYGEN_v304
import { safeHandler } from "../../middleware/safeHandler.js";
import { dbQuery } from "../../db.js";
import { clientPhoneFromAuth, enrollDevice, revokeDevices, signInWithDevice } from "../../services/clientDeviceSignIn.js";

const router = Router();
const query = (sql: string, params: unknown[]) => dbQuery(sql, params as any[]) as any;
const signInLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false, message: { error: "RATE_LIMITED" }, keyGenerator: safeKeyGenerator, validate: { xForwardedForHeader: false, trustProxy: false } });

router.post("/device-sign-in/enroll", safeHandler(async (req: any, res: any) => {
  const phone = clientPhoneFromAuth(req.headers?.authorization, process.env.JWT_SECRET);
  if (!phone) return res.status(401).json({ error: "client_session_required" });
  const label = typeof req.body?.deviceLabel === "string" ? req.body.deviceLabel : null;
  return res.status(201).json(await enrollDevice(query, phone, label));
}));

router.post("/device-sign-in", signInLimiter as any, safeHandler(async (req: any, res: any) => {
  const secret = process.env.JWT_SECRET;
  if (!secret) return res.status(500).json({ error: "auth_not_configured" });
  const result = await signInWithDevice(query, String(req.body?.credentialId ?? ""), String(req.body?.secret ?? ""), secret);
  if (!result.ok) {
    console.warn(JSON.stringify({ event: "client_device_sign_in_rejected", reason: result.reason }));
    return res.status(401).json({ error: result.reason === "expired" ? "device_sign_in_expired" : "device_sign_in_invalid" });
  }
  return res.status(200).json({ status: "ok", data: { token: result.token, secret: result.secret, hasSubmittedApplication: result.hasSubmittedApplication, submittedApplicationId: result.submittedApplicationId } });
}));

router.post("/device-sign-in/revoke", safeHandler(async (req: any, res: any) => {
  const phone = clientPhoneFromAuth(req.headers?.authorization, process.env.JWT_SECRET);
  if (!phone) return res.status(401).json({ error: "client_session_required" });
  const credentialId = typeof req.body?.credentialId === "string" ? req.body.credentialId : null;
  return res.json({ revoked: await revokeDevices(query, phone, credentialId) });
}));

export default router;
