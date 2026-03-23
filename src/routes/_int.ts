import { Router } from "express";
import { config } from "../config";
import packageJson from "../../package.json";
import { listRouteInventory } from "../debug/printRoutes";
import { readyHandler } from "./ready";
import { requireAuth, requireAuthorization } from "../middleware/auth";
import internalRoutes from "./internal";
import { intHealthHandler } from "./_int/health";
import { runtimeHandler } from "./_int/runtime";
import pwaInternalRoutes from "./_int/pwa";
import { ALL_ROLES } from "../auth/roles";

const router = Router();

router.get("/health", intHealthHandler);
router.get("/runtime", runtimeHandler);
router.get("/ready", readyHandler);
router.get("/build", (_req: any, res: any) => {
  const buildTimestamp = config.buildTimestamp;
  res.status(200).json({ buildTimestamp });
});

router.get("/version", (_req: any, res: any) => {
  const commitHash = config.commitSha;
  const buildTimestamp = config.buildTimestamp;
  res.status(200).json({
    version: packageJson.version ?? buildTimestamp ?? "unknown",
    commitHash,
  });
});

router.get("/routes", (req: any, res: any) => {
  const routes = listRouteInventory(req.app);
  res.status(200).json({ routes });
});

router.get("/env", (_req: any, res: any) =>
  res.json({
    twilioAvailable: Boolean(
      config.twilio.accountSid &&
        config.twilio.authToken &&
        config.twilio.verifyServiceSid
    ),
  })
);

router.post(
  "/twilio-test",
  requireAuth,
  requireAuthorization({ roles: ALL_ROLES }),
  async (_req: any, res: any) => {
  return res.json({ ok: true });
});

router.use(pwaInternalRoutes);
router.use(internalRoutes);

export default router;
