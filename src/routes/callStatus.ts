import { Router } from "express";
import { requireAuth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";

const router = Router();

router.post(
  "/status",
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  async (req: any, res: any, next: any) => {
    const { callSid, status } = req.body as { callSid?: string; status?: string };

    if (!callSid) {
      return res.status(400).json({ error: "callSid required" });
    }

    return res["json"]({ success: true, callSid, status: status ?? null });
  }
);

export default router;
