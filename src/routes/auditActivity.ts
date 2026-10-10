// BF_SERVER_AUDIT_ACTIVITY_v802 - POST /api/audit/activity. The portal logs staff actions here (a bulk move of
// several deals on the pipeline) but the address did not exist, so nothing was recorded.
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { recordAuditEvent } from "../modules/audit/audit.service.js";

const router = Router();

router.post("/activity", requireAuth, safeHandler(async (req: any, res: any) => {
  const userId = req.user?.id ?? req.user?.userId ?? req.user?.sub ?? null;
  const action = String(req.body?.action ?? "").trim().toLowerCase().replace(/[^a-z0-9_.:-]/g, "").slice(0, 64);
  if (!action) return res.status(400).json({ error: "missing_action" });
  const meta = req.body?.metadata;
  const metadata: Record<string, unknown> = meta && typeof meta === "object" && !Array.isArray(meta) ? { ...meta } : {};
  if (JSON.stringify(metadata).length > 20000) return res.status(413).json({ error: "metadata_too_large" });
  await recordAuditEvent({
    actorUserId: userId ? String(userId) : null,
    targetUserId: null,
    targetType: "portal_activity",
    action: "portal." + action,
    success: true,
    ip: req.ip ?? null,
    userAgent: String(req.headers?.["user-agent"] ?? "").slice(0, 300) || null,
    metadata,
  });
  return res.status(201).json({ ok: true });
}));

export default router;
