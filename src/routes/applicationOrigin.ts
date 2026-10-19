// BF_SERVER_v828_APPLICATION_ORIGIN - where an application came from (lender, broker or referrer), for the
// "Where this came from" panel at the top of the application.
//   GET /api/application-origin/:applicationId   (Admin / Staff)  -> { origin: null | {...} }
import { Router, type Request, type Response } from "express";
import { ROLES } from "../auth/roles.js";
import { requireAuth, requireAuthorization } from "../middleware/auth.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { applicationOrigin } from "../services/applicationOrigin.js";

const router = Router();

router.get("/:applicationId", requireAuth, requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }), safeHandler(async (req: Request, res: Response) => {
  res.json({ origin: await applicationOrigin(String(req.params.applicationId)) });
}));

export default router;
