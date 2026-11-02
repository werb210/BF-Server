// BF_SERVER_v867_BROKER_TOOLS_SCORECARDS - /api/deal-desk: credit scorecard and pre-decision rules (credit_scorecards, Growth and Pro).
//   GET  /scorecard                      the weights, bands, grades and rules (staff look, the default until an Admin saves)
//   PUT  /scorecard                      Admin: save { factors, grades, rules, lender_min_grade }
//   POST /scorecard/reset                Admin: back to the default
//   GET  /applications/:id/scorecard     the last result on the file
//   POST /applications/:id/scorecard     score now: score, grade, rule hits, lender ranking (signals only)
import { Router, type Request, type Response } from "express";
import { safeHandler } from "../../middleware/safeHandler.js";
import { actorId, audit, db } from "../../brokerTools/common.js";
import { gate } from "../../brokerTools/platform.js";
import { admin, appGuard, bad, staff } from "../../brokerTools/http.js";
import { DEFAULT_CONFIG, FACTORS, loadConfig, parseConfig, saveConfig, scoreApplication } from "../../brokerTools/scorecards.js";

const router = Router();
const sc = [...staff, gate("credit_scorecards")];
const scAdmin = [...admin, gate("credit_scorecards")];

router.get("/scorecard", ...sc, safeHandler(async (_req: Request, res: Response) => {
  res.json({ ok: true, config: await loadConfig(db()), factors: FACTORS });
}));

router.put("/scorecard", ...scAdmin, safeHandler(async (req: Request, res: Response) => {
  const p = parseConfig(req.body ?? {});
  if (!p.ok) return bad(res, p.error);
  await saveConfig(db(), p.config, actorId(req));
  await audit(req, "credit_scorecard.saved", { factors: p.config.factors.map((f) => `${f.key}:${f.weight}`), rules: p.config.rules.length }, { type: "credit_scorecard", id: "1" });
  res.json({ ok: true, config: p.config });
}));

router.post("/scorecard/reset", ...scAdmin, safeHandler(async (req: Request, res: Response) => {
  await saveConfig(db(), DEFAULT_CONFIG, actorId(req));
  await audit(req, "credit_scorecard.reset", {}, { type: "credit_scorecard", id: "1" });
  res.json({ ok: true, config: DEFAULT_CONFIG });
}));

router.get("/applications/:id/scorecard", ...sc, appGuard, safeHandler(async (req: Request, res: Response) => {
  const r = await db().query(`SELECT result, computed_at FROM application_scorecards WHERE application_id = $1 LIMIT 1`, [String(req.params.id)]);
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true, result: r.rows[0]?.result ?? null });
}));

router.post("/applications/:id/scorecard", ...sc, appGuard, safeHandler(async (req: Request, res: Response) => {
  const result = await scoreApplication(db(), res.locals.app, actorId(req));
  await audit(req, "credit_scorecard.scored", { application_id: req.params.id, score: result.score, grade: result.grade, outcome: result.outcome }, { type: "application", id: String(req.params.id) });
  res.json({ ok: true, result });
}));

export default router;
