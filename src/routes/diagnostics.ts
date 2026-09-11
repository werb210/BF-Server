import { Router } from "express";
import { requireAuth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
// BF_SERVER_PUSH_CONFIG_DIAG_v153
import { pushConfigReport } from "../modules/diagnostics/pushConfig.js";

const router = Router();

// BF_SERVER_PUSH_CONFIG_DIAG_v153
// Startup logs only say "client_apns_not_configured", which is four variables
// deep and three of them are shared with Watch push. This names the missing
// ones. Admin-only and names-only: no value is ever returned.
router.get(
  "/push",
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN] }),
  safeHandler(async (_req: any, res: any) => {
    return res.status(200).json(pushConfigReport());
  }),
);

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
