// BF_SERVER_v855_RETENTION - record retention and legal holds (src/retention/).
//   GET  /api/retention/status?type=application|document|contact|company&id=   staff: may it be deleted, and if not why
//   GET  /api/retention/applications/:id      staff: the application's status and every document's (delete buttons)
//   GET  /api/retention/holds[?include_released=1]   Admin: legal holds
//   POST /api/retention/holds { target_type, target_id, reason }   Admin: place a hold (audited)
//   POST /api/retention/holds/:id/release { reason? }              Admin: release a hold (audited)
//   GET  /api/retention/report                Admin: records eligible for deletion (nothing is deleted automatically)
// The same rules apply in every silo (BF, BI, SLF, KS); holds and the report are listed for the caller's silo
// (X-Silo / ?silo=), and a hold blocks deleting its record from any silo.
import { Router } from "express";
import { auth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { resolveSiloFromRequest } from "../middleware/silo.js";
import { isHoldTarget, RETENTION_YEARS } from "../retention/policy.js";
import {
  applicationRetention, documentRetentionForApplication, listHolds, placeHold, releaseHold, retentionFor, retentionReport,
  type RetentionTarget,
} from "../retention/retention.js";

const router = Router();
const staff = [auth, requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF, ROLES.OPS] })];
const adminOnly = [auth, requireAuthorization({ roles: [ROLES.ADMIN] })];
const TYPES: RetentionTarget[] = ["application", "document", "contact", "company"];
const ID_RE = /^[0-9A-Za-z-]{1,64}$/;

router.get("/status", ...staff, safeHandler(async (req: any, res: any) => {
  const type = String(req.query?.type ?? "") as RetentionTarget;
  const id = String(req.query?.id ?? "").trim();
  if (!TYPES.includes(type)) return res.status(400).json({ ok: false, error: "invalid_type" });
  if (!ID_RE.test(id)) return res.status(400).json({ ok: false, error: "invalid_id" });
  const s = await retentionFor(type, id);
  if (!s) return res.status(404).json({ ok: false, error: "not_found" });
  res.setHeader("Cache-Control", "no-store");
  return res.json({ ok: true, type, id, retention_years: RETENTION_YEARS, ...s });
}));

router.get("/applications/:id", ...staff, safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id ?? "").trim();
  if (!ID_RE.test(id)) return res.status(400).json({ ok: false, error: "invalid_id" });
  const application = await applicationRetention(id);
  if (!application) return res.status(404).json({ ok: false, error: "not_found" });
  res.setHeader("Cache-Control", "no-store");
  return res.json({ ok: true, retention_years: RETENTION_YEARS, application, documents: await documentRetentionForApplication(id) });
}));

router.get("/holds", ...adminOnly, safeHandler(async (req: any, res: any) => {
  const includeReleased = ["1", "true", "yes"].includes(String(req.query?.include_released ?? "").toLowerCase());
  res.setHeader("Cache-Control", "no-store");
  return res.json({ ok: true, silo: resolveSiloFromRequest(req), holds: await listHolds({ includeReleased, silo: resolveSiloFromRequest(req) }) });
}));

router.post("/holds", ...adminOnly, safeHandler(async (req: any, res: any) => {
  const type = String(req.body?.target_type ?? "").trim();
  const id = String(req.body?.target_id ?? "").trim();
  const reason = String(req.body?.reason ?? "").trim();
  const errors: Record<string, string> = {};
  if (!isHoldTarget(type)) errors.target_type = "Choose an application, contact or company.";
  if (!ID_RE.test(id)) errors.target_id = "Enter the record's id.";
  if (reason.length < 3) errors.reason = "Give a reason for the hold.";
  if (reason.length > 1000) errors.reason = "Keep the reason under 1,000 characters.";
  if (Object.keys(errors).length) return res.status(400).json({ ok: false, error: "validation_error", errors });
  const r = await placeHold(req, type as any, id, reason, undefined, resolveSiloFromRequest(req));
  if (!r.ok) return res.status(r.status).json({ ok: false, error: r.error, message: r.message });
  return res.status(201).json({ ok: true, hold: r.hold });
}));

router.post("/holds/:id/release", ...adminOnly, safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(404).json({ ok: false, error: "not_found" });
  const reason = String(req.body?.reason ?? "").trim().slice(0, 1000);
  const r = await releaseHold(req, id, reason);
  if (!r.ok) return res.status(r.status).json({ ok: false, error: r.error, message: r.message });
  return res.json({ ok: true, hold: r.hold });
}));

router.get("/report", ...adminOnly, safeHandler(async (req: any, res: any) => {
  res.setHeader("Cache-Control", "no-store");
  const silo = resolveSiloFromRequest(req);
  return res.json({ ok: true, silo, ...(await retentionReport(undefined, undefined, undefined, silo)) });
}));

export default router;
