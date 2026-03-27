import { Router, type Request } from "express";

import { requireAuth } from "../middleware/requireAuth";
import { send } from "../utils/contractResponse";

type AuthenticatedRequest = Request & {
  user?: {
    id?: string;
  };
};

const router = Router();

export function assertTwilioConfigured() {
  if (
    !process.env.TWILIO_ACCOUNT_SID
    || !process.env.TWILIO_AUTH_TOKEN
  ) {
    throw new Error("Twilio not configured");
  }
}

function isTwilioEnabled(): boolean {
  const hasTwilioCredentials = Boolean(
    process.env.TWILIO_ACCOUNT_SID
    && process.env.TWILIO_AUTH_TOKEN
    && process.env.TWILIO_VOICE_APP_SID
  );

  return process.env.ENABLE_TWILIO === undefined
    ? hasTwilioCredentials
    : process.env.ENABLE_TWILIO === "true" && hasTwilioCredentials;
}

router.get("/token", requireAuth, async (req, res) => {
  const userId = (req as AuthenticatedRequest).user?.id;
  if (!userId) {
    return send.error(res, 401, "unauthorized");
  }

  if (!isTwilioEnabled()) {
    return send.error(res, 503, "Telephony disabled");
  }

  const { generateVoiceToken } = await import("../telephony/services/tokenService");
  const token = generateVoiceToken(userId);
  return send.ok(res, { token });
});

export default router;
