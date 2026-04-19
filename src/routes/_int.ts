import { Router } from "express";
import { config } from "../config/index.js";
import { listRouteInventory } from "../debug/printRoutes.js";
import { readyHandler } from "./ready.js";
import internalRoutes from "./internal.js";
import { runtimeHandler } from "./_int/runtime.js";
import pwaInternalRoutes from "./_int/pwa.js";
import twilio from "twilio";
import { internalOnly } from "../middleware/internalOnly.js";

const router = Router();

router.get("/runtime", internalOnly, runtimeHandler);
router.get("/ready", readyHandler);
router.get("/build", (_req: any, res: any) => {
  const buildTimestamp = config.buildTimestamp;
  res.status(200).json({ buildTimestamp });
});

router.get("/version", (_req: any, res: any) => {
  const commitHash = config.commitSha;
  const buildTimestamp = config.buildTimestamp;
  const packageVersion = process.env["npm_package_version"];
  res.status(200).json({
    version: packageVersion ?? buildTimestamp ?? "unknown",
    commitHash,
  });
});

router.get("/routes", (req: any, res: any) => {
  const routes = listRouteInventory(req.app);
  res.status(200).json({ routes });
});

router.get("/env", (_req: any, res: any) =>
  res["json"]({
    twilioAvailable: Boolean(
      config.twilio.accountSid &&
        config.twilio.authToken &&
        config.twilio.verifyServiceSid
    ),
  })
);

router.post(
  "/twilio-test",
  async (_req: any, res: any) => {
    const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SERVICE_SID, TWILIO_TEST_TO } = process.env;
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_VERIFY_SERVICE_SID) {
      console.error("❌ Twilio ENV missing for /api/_int/twilio-test");
      return res.status(500).json({ ok: false, error: "Twilio env missing" });
    }

    if (!TWILIO_VERIFY_SERVICE_SID.startsWith("VA")) {
      console.error("❌ Invalid TWILIO_VERIFY_SERVICE_SID for /api/_int/twilio-test");
      return res.status(500).json({
        ok: false,
        error: "Invalid TWILIO_VERIFY_SERVICE_SID. Expected SID starting with VA",
      });
    }

    if (!TWILIO_TEST_TO) {
      return res.status(400).json({
        ok: false,
        error: "TWILIO_TEST_TO missing; set a destination phone number in E.164 format",
      });
    }

    try {
      const client: any = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
      const verification = await client.verify.v2
        .services(TWILIO_VERIFY_SERVICE_SID)
        .verifications.create({
          to: TWILIO_TEST_TO,
          channel: "sms",
        });
      console.log("✅ /api/_int/twilio-test response:", verification.status);
      return res.status(200).json({ ok: true, status: verification.status, to: TWILIO_TEST_TO });
    } catch (err: any) {
      console.error("❌ /api/_int/twilio-test error:", err.message);
      console.error(err);
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
);

router.use(pwaInternalRoutes);
router.use(internalRoutes);

export default router;
