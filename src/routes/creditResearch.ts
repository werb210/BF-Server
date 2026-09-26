// BF_SERVER_BLOCK_v537_RESEARCH_PACK - staff routes.
import { Router } from "express";
import { requireAuth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
// BF_SERVER_BLOCK_v544 - loaded on first use so tests can mock it.
const svc = () => import("../services/credit/research.js");

const router = Router();
const staff = [requireAuth, requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] })];

router.get("/:applicationId", ...staff, safeHandler(async (req: any, res: any) => {
  res.json(await (await svc()).loadResearch(String(req.params.applicationId)));
}));

router.post("/:applicationId/refresh", ...staff, safeHandler(async (req: any, res: any) => {
  const applicationId = String(req.params.applicationId);
  try {
    const result = await (await svc()).refreshApplicationResearch(applicationId, req.query?.force === "1");
    console.info("[credit-research] refreshed", { applicationId, ...result });
    res.json({ ...result, ...(await (await svc()).loadResearch(applicationId)) });
  } catch (error) {
    console.error("[credit-research] refresh_failed", { applicationId, message: (error as Error)?.message });
    res.status(502).json({ error: "research_failed", message: (error as Error)?.message ?? "failed" });
  }
}));

router.put("/:applicationId/facts/:factId", ...staff, safeHandler(async (req: any, res: any) => {
  const applicationId = String(req.params.applicationId);
  try {
    const updated = await (await svc()).setFactStatus(applicationId, String(req.params.factId), String(req.body?.status ?? ""), req.user?.id ? String(req.user.id) : null);
    if (!updated) return res.status(404).json({ error: "not_found" });
  } catch {
    return res.status(400).json({ error: "bad_status", message: "Status must be confirmed, rejected or unverified." });
  }
  res.json(await (await svc()).loadResearch(applicationId));
}));

export default router;
