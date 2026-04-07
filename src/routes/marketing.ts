import { Router } from "express";
import { requireAuth, requireCapability } from "../middleware/auth";
import { CAPABILITIES } from "../auth/capabilities";
import { safeHandler } from "../middleware/safeHandler";
import { ok } from "../lib/response";

const router = Router();

router.use(requireAuth);
router.use(requireCapability([CAPABILITIES.MARKETING_READ]));

router.get("/", safeHandler((req: any) => {
  return ok({ status: "ok" }, req.rid);
}));

router.get("/campaigns", safeHandler((req: any) => {
  const page = Number(req.query.page) || 1;
  const pageSize = Number(req.query.pageSize) || 25;
  return ok({ campaigns: [], total: 0, page, pageSize }, req.rid);
}));

export default router;
