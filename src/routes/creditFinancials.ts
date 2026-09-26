// BF_SERVER_BLOCK_v535_FINANCIAL_EXTRACTION - staff routes.
import { Router } from "express";
import { ROLES } from "../auth/roles.js";
import { requireAuth, requireAuthorization } from "../middleware/auth.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { extractApplicationFinancials, loadFinancialTable, setFinancialCell } from "../services/credit/financials.js";

const router = Router();
const staff = [requireAuth, requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] })];

router.get("/:applicationId", ...staff, safeHandler(async (req: any, res: any) => {
  res.json({ table: await loadFinancialTable(String(req.params.applicationId)) });
}));

router.post("/:applicationId/extract", ...staff, safeHandler(async (req: any, res: any) => {
  const applicationId = String(req.params.applicationId);
  try {
    const result = await extractApplicationFinancials(applicationId);
    console.info("[credit-financials] extracted", { applicationId, ...result });
    res.json({ ...result, table: await loadFinancialTable(applicationId) });
  } catch (error) {
    console.error("[credit-financials] extract_failed", { applicationId, message: (error as Error)?.message });
    res.status(502).json({ error: "extract_failed", message: (error as Error)?.message ?? "failed" });
  }
}));

router.put("/:applicationId/cell", ...staff, safeHandler(async (req: any, res: any) => {
  const applicationId = String(req.params.applicationId);
  const body = req.body ?? {};
  const value = body.value === null || body.value === "" ? null : Number(String(body.value).replace(/[$,\s]/g, ""));
  if (value !== null && !Number.isFinite(value)) return res.status(400).json({ error: "bad_value", message: "Enter a number." });
  try {
    await setFinancialCell(applicationId, { period: body.period, kind: body.kind, periodEnd: body.periodEnd, item: body.item, value }, req.user?.id ? String(req.user.id) : null);
  } catch (error) {
    return res.status(400).json({ error: (error as Error).message, message: "Unknown period or line item." });
  }
  res.json({ table: await loadFinancialTable(applicationId) });
}));

export default router;
