import { Router } from "express";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { CAPABILITIES } from "../auth/capabilities.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { respondOk } from "../utils/respondOk.js";
const router = Router();
router.use(requireAuth);
router.use(requireCapability([CAPABILITIES.SETTINGS_READ]));
router.get("/", safeHandler((_req, res) => {
    respondOk(res, { status: "ok" });
}));
router.get("/preferences", safeHandler((_req, res) => {
    respondOk(res, { preferences: {} });
}));
router.get("/me", safeHandler((req, res) => {
    respondOk(res, {
        userId: req.user?.userId ?? null,
        role: req.user?.role ?? null,
        phone: req.user?.phone ?? null,
    });
}));
export default router;
