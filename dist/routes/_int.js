import { Router } from "express";
import { config } from "../config/index.js";
import { listRouteInventory } from "../debug/printRoutes.js";
import { readyHandler } from "./ready.js";
import { requireAuth, requireAuthorization } from "../middleware/auth.js";
import internalRoutes from "./internal.js";
import { runtimeHandler } from "./_int/runtime.js";
import pwaInternalRoutes from "./_int/pwa.js";
import { ALL_ROLES } from "../auth/roles.js";
const router = Router();
router.get("/runtime", runtimeHandler);
router.get("/ready", readyHandler);
router.get("/build", (_req, res) => {
    const buildTimestamp = config.buildTimestamp;
    res.status(200).json({ buildTimestamp });
});
router.get("/version", (_req, res) => {
    const commitHash = config.commitSha;
    const buildTimestamp = config.buildTimestamp;
    const packageVersion = process.env["npm_package_version"];
    res.status(200).json({
        version: packageVersion ?? buildTimestamp ?? "unknown",
        commitHash,
    });
});
router.get("/routes", (req, res) => {
    const routes = listRouteInventory(req.app);
    res.status(200).json({ routes });
});
router.get("/env", (_req, res) => res["json"]({
    twilioAvailable: Boolean(config.twilio.accountSid &&
        config.twilio.authToken &&
        config.twilio.verifyServiceSid),
}));
router.post("/twilio-test", requireAuth, requireAuthorization({ roles: ALL_ROLES }), async (_req, res) => {
    return res["json"]({ ok: true });
});
router.use(pwaInternalRoutes);
router.use(internalRoutes);
export default router;
