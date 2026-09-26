// BF_SERVER_BLOCK_v538_CREDIT_SUMMARY_V2 - staff routes.
import { Router } from "express";
import { requireAuth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
const svc = () => import("../services/credit/creditSummaryV2.js");
const router = Router();
const staff = [requireAuth, requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] })];
router.get("/:applicationId", ...staff, safeHandler(async (req: any, res: any) => {
  const { loadSummaryV2 } = await svc(); res.json({ summary: await loadSummaryV2(String(req.params.applicationId)) });
}));
router.post("/:applicationId/generate", ...staff, safeHandler(async (req: any, res: any) => {
  const id = String(req.params.applicationId); const { generateSummaryV2, loadSummaryV2, mergeKeepingEdits, saveSummaryV2 } = await svc();
  try { const prev = await loadSummaryV2(id); const doc = mergeKeepingEdits(req.query?.overwrite === "1" ? null : prev?.doc ?? null, await generateSummaryV2(id));
    await saveSummaryV2(id, doc); console.info("[credit-summary-v2] generated", { applicationId: id, dealType: doc.dealType, missing: doc.missing.length, warnings: doc.warnings.length });
    res.json({ summary: await loadSummaryV2(id) });
  } catch (e) { const msg = (e as Error)?.message ?? "failed"; console.error("[credit-summary-v2] generate_failed", { applicationId: id, message: msg });
    res.status(msg === "application_not_found" ? 404 : 502).json({ error: "generate_failed", message: msg }); }
}));
router.put("/:applicationId/sections/:key", ...staff, safeHandler(async (req: any, res: any) => {
  const id = String(req.params.applicationId); const { applyEdit, loadSummaryV2, saveSummaryV2 } = await svc(); const cur = await loadSummaryV2(id);
  if (!cur) return res.status(404).json({ error: "not_generated", message: "Generate the credit summary first." });
  try { await saveSummaryV2(id, applyEdit(cur.doc, String(req.params.key), req.body ?? {})); } catch { return res.status(400).json({ error: "unknown_section" }); }
  res.json({ summary: await loadSummaryV2(id) });
}));
// BF_SERVER_BLOCK_v540 - export the summary in Boreal's Word or PDF format.
router.get("/:applicationId/export.:format", ...staff, safeHandler(async (req: any, res: any) => {
  const format = String(req.params.format);
  if (format !== "docx" && format !== "pdf") return res.status(400).json({ error: "bad_format" });
  const { loadExport, renderDocx, renderPdf } = await import("../services/credit/creditSummaryExport.js");
  const value = await loadExport(String(req.params.applicationId), req.user?.id ? String(req.user.id) : null);
  if (!value) return res.status(404).json({ error: "not_generated", message: "Generate the credit summary first." });
  const name = String(value.doc.overview?.applicant_name ?? "").replace(/[^A-Za-z0-9 &.,-]+/g, "").trim() || "Application";
  const body = format === "docx" ? renderDocx(value.doc, value.meta) : await renderPdf(value.doc, value.meta);
  res.setHeader("Content-Type", format === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="Credit Summary - ${name}.${format}"`);
  res.send(body);
}));

router.post("/:applicationId/submit", ...staff, safeHandler(async (req: any, res: any) => {
  const id = String(req.params.applicationId); const { loadSummaryV2, submitSummaryV2 } = await svc(); const r = await submitSummaryV2(id, req.user?.id ? String(req.user.id) : null);
  if (!r) return res.status(404).json({ error: "not_generated", message: "Generate the credit summary first." });
  // BF_SERVER_BLOCK_v540 - submitted summaries become eligible for lender packages.
  const { markCreditSummaryCompleted } = await import("../modules/applications/applications.service.js");
  await markCreditSummaryCompleted({ applicationId: id });
  console.info("[credit-summary-v2] submitted", { applicationId: id, by: r.name }); res.json({ summary: await loadSummaryV2(id) });
}));
export default router;
