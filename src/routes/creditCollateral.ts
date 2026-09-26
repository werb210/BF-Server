// BF_SERVER_BLOCK_v536_COLLATERAL_EXTRACTION - staff routes.
import { Router } from "express";
import { ROLES } from "../auth/roles.js";
import { requireAuth, requireAuthorization } from "../middleware/auth.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { extractApplicationCollateral, loadCollateral, saveCollateralRow } from "../services/credit/collateral.js";

const router = Router();
const staff = [requireAuth, requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] })];

router.get("/:applicationId", ...staff, safeHandler(async (req: any, res: any) => {
  res.json(await loadCollateral(String(req.params.applicationId)));
}));
router.post("/:applicationId/extract", ...staff, safeHandler(async (req: any, res: any) => {
  const id = String(req.params.applicationId);
  try {
    const result = await extractApplicationCollateral(id);
    console.info("[credit-collateral] extracted", { applicationId: id, ...result });
    res.json({ ...result, ...(await loadCollateral(id)) });
  } catch (error) {
    console.error("[credit-collateral] extract_failed", { applicationId: id, message: (error as Error)?.message });
    res.status(502).json({ error: "extract_failed", message: (error as Error)?.message ?? "failed" });
  }
}));
router.put("/:applicationId/rows/:rowId", ...staff, safeHandler(async (req: any, res: any) => {
  const id = String(req.params.applicationId);
  const ok = await saveCollateralRow(id, String(req.params.rowId), req.body?.data ?? {}, req.user?.id ? String(req.user.id) : null);
  if (!ok) return res.status(404).json({ error: "not_found" });
  res.json(await loadCollateral(id));
}));

export default router;
