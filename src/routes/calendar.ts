import { Router } from "express";
import { requireAuth, requireCapability } from "../middleware/auth";
import { CAPABILITIES } from "../auth/capabilities";
import { safeHandler } from "../middleware/safeHandler";

const router = Router();

router.use(requireAuth);
router.use(requireCapability([CAPABILITIES.CALENDAR_READ]));
router.get("/", safeHandler((_req: any, res: any) => {
  res.status(200).json({ items: [] });
}));

router.get("/tasks", safeHandler((_req: any, res: any) => {
  res.status(200).json({ items: [] });
}));

router.get("/events", safeHandler((_req: any, res: any) => {
  res.status(200).json({ items: [] });
}));

export default router;
