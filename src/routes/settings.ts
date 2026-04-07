import { Router } from "express";
import { requireAuth, requireCapability } from "../middleware/auth";
import { CAPABILITIES } from "../auth/capabilities";
import { safeHandler } from "../middleware/safeHandler";
import { ok } from "../lib/response";

const router = Router();

router.use(requireAuth);
router.use(requireCapability([CAPABILITIES.SETTINGS_READ]));

router.get("/", safeHandler((req: any) => ok({ status: "ok" }, req.rid)));
router.get("/preferences", safeHandler((req: any) => ok({ preferences: {} }, req.rid)));
router.get("/me", safeHandler((req: any) => ok({
  userId: req.user?.userId ?? null,
  role: req.user?.role ?? null,
  phone: req.user?.phone ?? null,
}, req.rid)));

export default router;
