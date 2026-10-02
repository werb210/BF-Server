// BF_SERVER_CUSTOMER_MATCH_LISTS_v711
import { Router } from "express";
import { requireAuth } from "../../middleware/auth.js";
import { safeHandler } from "../../middleware/safeHandler.js";
import { customerMatchConfigured, listApplicants, listStatus, sendApplicants } from "../../services/customerMatchLists.js";

const router = Router();
router.use(requireAuth);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get("/customer-match/applicants", safeHandler(async (_req: any, res: any) => {
  const { listId, rows } = await listApplicants();
  res.json({ configured: customerMatchConfigured(), listId, rows });
}));

router.post("/customer-match/applicants/send", safeHandler(async (req: any, res: any) => {
  if (!customerMatchConfigured()) { res.status(400).json({ error: "google_ads_not_connected" }); return; }
  const raw: unknown[] = Array.isArray(req.body?.contactIds) ? req.body.contactIds : [];
  const ids = [...new Set(raw.map(String).map((v) => v.trim()).filter((v) => uuid.test(v)))];
  if (!ids.length) { res.status(400).json({ error: "contactIds_required" }); return; }
  if (ids.length > 5000) { res.status(400).json({ error: "too_many", max: 5000 }); return; }
  try { res.json({ ok: true, ...await sendApplicants(ids) }); }
  catch (err: any) { res.status(502).json({ error: "google_rejected", detail: String(err?.message ?? err).slice(0, 300) }); }
}));

router.get("/customer-match/status", safeHandler(async (_req: any, res: any) => {
  res.json({ configured: customerMatchConfigured(), lists: await listStatus() });
}));

export default router;
