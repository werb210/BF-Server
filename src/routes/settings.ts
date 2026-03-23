import { Router } from "express";
import { requireAuth, requireCapability } from "../middleware/auth";
import { CAPABILITIES } from "../auth/capabilities";
import { safeHandler } from "../middleware/safeHandler";
import { respondOk } from "../utils/respondOk";

const router = Router();

router.use(requireAuth);
router.use(requireCapability([CAPABILITIES.SETTINGS_READ]));

router.get("/", safeHandler((_req, res) => {
  respondOk(res, { status: "ok" });
}));

router.get("/preferences", safeHandler((_req, res) => {
  respondOk(res, { preferences: {} });
}));

router.get("/me", safeHandler((req: any, res: any) => {
  respondOk(res, {
    userId: req.user?.userId ?? null,
    role: req.user?.role ?? null,
    phone: req.user?.phone ?? null,
  });
}));

export default router;
