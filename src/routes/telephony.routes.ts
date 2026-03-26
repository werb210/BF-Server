import { Router, type Request } from "express";

import { config } from "../config";
import { requireAuth } from "../middleware/requireAuth";
import { generateVoiceToken } from "../telephony/services/tokenService";
import { send } from "../utils/contractResponse";

type AuthenticatedRequest = Request & {
  user?: {
    id?: string;
  };
};

const router = Router();

router.get("/token", requireAuth, (req, res) => {
  const userId = (req as AuthenticatedRequest).user?.id;
  if (!userId) {
    return send.error(res, 401, "unauthorized");
  }

  if (!config.twilio.enabled) {
    return send.error(res, 503, "Telephony disabled");
  }

  const token = generateVoiceToken(userId);
  return send.ok(res, { token });
});

export default router;
