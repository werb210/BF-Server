import { Router } from "express";
import { requireAuth, requireCapability } from "../middleware/auth";
import { CAPABILITIES } from "../auth/capabilities";
import { safeHandler } from "../middleware/safeHandler";
import { respondOk } from "../utils/respondOk";

const router = Router();

router.use(requireAuth);
router.use(requireCapability([CAPABILITIES.COMMUNICATIONS_READ]));

router.get("/", safeHandler((_req: any, res: any) => {
  respondOk(res, { status: "ok" });
}));

router.get("/messages", safeHandler((req: any, res: any) => {
  const page = Number(req.query.page) || 1;
  const pageSize = Number(req.query.pageSize) || 25;
  respondOk(
    res,
    {
      messages: [],
      total: 0,
    },
    {
      page,
      pageSize,
    }
  );
}));

export default router;
