import { Router } from "express";
import { requireAuth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";

const router = Router();

router.get(
  "/twilio",
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN] }),
  safeHandler(async (_req: any, res: any) => {
    return res.status(200).json({
      accountSidPresent: !!process.env.TWILIO_ACCOUNT_SID,
      authTokenPresent: !!process.env.TWILIO_AUTH_TOKEN,
      apiKeyPresent: !!process.env.TWILIO_API_KEY,
      apiSecretPresent: !!process.env.TWILIO_API_SECRET,
      fromNumberSource: process.env.TWILIO_FROM_NUMBER
        ? "TWILIO_FROM_NUMBER"
        : process.env.TWILIO_PHONE_NUMBER
          ? "TWILIO_PHONE_NUMBER"
          : process.env.TWILIO_FROM
            ? "TWILIO_FROM"
            : process.env.TWILIO_PHONE
              ? "TWILIO_PHONE"
              : process.env.TWILIO_NUMBER
                ? "TWILIO_NUMBER"
                : null,
      voiceAppSidPresent: !!process.env.TWILIO_VOICE_APP_SID,
      verifyServiceSidPresent: !!process.env.TWILIO_VERIFY_SERVICE_SID,
    });
  })
);

export default router;
