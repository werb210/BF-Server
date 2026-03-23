import { Router } from "express";
import { requireAuth, requireCapability } from "../middleware/auth";
import { CAPABILITIES } from "../auth/capabilities";
import { safeHandler } from "../middleware/safeHandler";

const router = Router();

router.use(requireAuth);
router.use(requireCapability([CAPABILITIES.STAFF_OVERVIEW]));

router.get("/overview", safeHandler((_req: any, res: any) => {
  res.json({ ok: true });
}));

export default router;
