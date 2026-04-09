import { Router } from "express";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { CAPABILITIES } from "../auth/capabilities.js";
import { safeHandler } from "../middleware/safeHandler.js";
const router = Router();
router.use(requireAuth);
router.use(requireCapability([CAPABILITIES.STAFF_OVERVIEW]));
router.get("/overview", safeHandler((_req, res) => {
    res["json"]({ ok: true });
}));
export default router;
