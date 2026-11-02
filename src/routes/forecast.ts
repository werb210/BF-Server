// BF_SERVER_v872_FORECAST - weighted commission forecast (ported from KS-server #50 without the plan gate).
//   GET /api/forecast?granularity=month|quarter&from=YYYY-MM&periods=N&team_id=&user_id=
//        per rep and team: closed / commit / best case / pipeline / weighted, next to the Goals targets, in the
//        request's silo. Admins see everyone (team / person filter); everyone else sees their own files only.
//   GET /api/forecast/stages                 the chance each open lending stage funds (batch 3's pipeline probabilities)
//   PUT /api/forecast/stages                 Admin: { stages: { "Offer": 75, ... } } (saved as the lending probabilities)
//   GET /api/forecast/applications/:id       one file: expected close date, category, chance
//   PUT /api/forecast/applications/:id       staff: { expected_close_date?: "YYYY-MM-DD" | null, forecast_category?: ... | null }
// /applications/:id is record-guarded in routeRegistry (batch 3 record visibility).
import { Router } from "express";
import { pool } from "../db.js";
import { auth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { actorId, auditFor } from "../settingsPack/common.js";
import { resolveSiloFromRequest } from "../middleware/silo.js";
import { normalizeRole } from "../services/reports/catalog.js";
import { scopedRequest } from "../visibility/scopedDb.js";
import { OPEN_STAGES, fileForecast, forecast, loadProbabilities, saveProbabilities, setFileForecast, type Db } from "../forecast/forecast.js";

const router = Router();
const db = () => pool as unknown as Db;
router.use(auth, requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF, ROLES.OPS] }));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const viewer = (req: any) => ({ role: normalizeRole(req.user?.role), userId: String(req.user?.userId ?? req.user?.id ?? "") });
const stagesOut = (p: Record<string, number>) => OPEN_STAGES.map((stage) => ({ stage, probability: p[stage] ?? 0 }));

router.get("/", scopedRequest, safeHandler(async (req: any, res: any) => {
  res.setHeader("Cache-Control", "no-store");
  const silo = String(resolveSiloFromRequest(req) ?? "BF").toUpperCase();
  return res.json({ ok: true, ...(await forecast({ ...(req.query ?? {}), silo }, viewer(req), db())) });
}));

router.get("/stages", safeHandler(async (_req: any, res: any) => {
  return res.json({ ok: true, stages: stagesOut(await loadProbabilities(db())) });
}));

router.put("/stages", safeHandler(async (req: any, res: any) => {
  if (normalizeRole(req.user?.role) !== "Admin") return res.status(403).json({ ok: false, error: "admin_only", message: "Only an Admin can change the stage probabilities." });
  const r = await saveProbabilities(db(), req.body?.stages ?? {}, actorId(req));
  if (!r.ok) return res.status(400).json({ ok: false, error: "validation_error", message: r.error });
  await auditFor(req, "forecast.stage_probabilities", { stages: req.body?.stages ?? {} }, { type: "pipeline", id: "lending" });
  return res.json({ ok: true, stages: stagesOut(await loadProbabilities(db())) });
}));

router.get("/applications/:id", safeHandler(async (req: any, res: any) => {
  if (!UUID.test(String(req.params.id))) return res.status(400).json({ ok: false, error: "invalid_id" });
  const f = await fileForecast(db(), String(req.params.id));
  if (!f) return res.status(404).json({ ok: false, error: "not_found" });
  res.setHeader("Cache-Control", "no-store");
  return res.json({ ok: true, ...f });
}));

router.put("/applications/:id", safeHandler(async (req: any, res: any) => {
  if (!UUID.test(String(req.params.id))) return res.status(400).json({ ok: false, error: "invalid_id" });
  const r = await setFileForecast(db(), String(req.params.id), req.body ?? {});
  if (!r.ok) return res.status(r.status).json({ ok: false, error: r.error, message: r.error });
  return res.json({ ok: true, ...(await fileForecast(db(), String(req.params.id))) });
}));

export default router;
