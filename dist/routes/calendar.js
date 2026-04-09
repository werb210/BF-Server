import { Router } from "express";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { CAPABILITIES } from "../auth/capabilities.js";
import { safeHandler } from "../middleware/safeHandler.js";
const router = Router();
router.use(requireAuth);
router.use(requireCapability([CAPABILITIES.CALENDAR_READ]));
router.get("/", safeHandler((_req, res) => {
    res.status(200).json({ items: [] });
}));
router.get("/tasks", safeHandler((_req, res) => {
    res.status(200).json({ items: [] });
}));
router.get("/events", safeHandler((_req, res) => {
    res.status(200).json({ items: [] });
}));
export default router;
