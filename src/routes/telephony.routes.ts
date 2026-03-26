import { Router, type Request } from "express";

import { requireAuth } from "../middleware/requireAuth";
import { generateVoiceToken } from "../telephony/services/tokenService";

const router = Router();

function resolveIdentity(req: Request & { user?: string | { sub?: string; id?: string } }): string {
  if (req.user && typeof req.user === "object") {
    if (typeof req.user.id === "string" && req.user.id.trim().length > 0) return req.user.id;
    if (typeof req.user.sub === "string" && req.user.sub.trim().length > 0) return req.user.sub;
  }
  return "telephony-user";
}

router.get("/token", requireAuth, (req, res) => {
  const token = generateVoiceToken(resolveIdentity(req as Request & { user?: string | { sub?: string; id?: string } }));
  return res.status(200).json({ token });
});

export default router;
