import { Router } from "express";
import { getBuildInfo } from "../server/config/env.compat";
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
  const { buildTimestamp } = getBuildInfo();
  res.status(200).json({ buildTimestamp });
});

router.get("/version", (_req: any, res: any) => {
  const { commitHash, buildTimestamp } = getBuildInfo();
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
      process.env.TWILIO_ACCOUNT_SID &&
        process.env.TWILIO_AUTH_TOKEN &&
        process.env.TWILIO_VERIFY_SERVICE_SID
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
