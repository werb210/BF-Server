// BF_SERVER_v869_SETTINGS_PACK_NPS - the post-funding survey.
//   GET  /api/surveys/r/:token                   public: the question (the client's link)
//   POST /api/surveys/r/:token { score, comment } public: the answer; 9-10 get the review link when one is set
//   GET  /api/surveys/settings                   Admin: on/off, delay, wording, review link
//   PUT  /api/surveys/settings { settings }      Admin (audited)
//   GET  /api/surveys/report?days=365            Admin/Staff: NPS, counts, by month, recent comments
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { auth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { rateLimitKeyFromRequest } from "../middleware/clientIp.js";
import { pool } from "../db.js";
import { brandName } from "../settingsPack/boreal.js";
import { actorId, auditFor, type Q } from "../settingsPack/common.js";
import { npsReport, npsSettings, recordAnswer, saveNps, surveyByToken, validateNps } from "../surveys/nps.js";

const router = Router();
const adminOnly = [auth, requireAuthorization({ roles: [ROLES.ADMIN] })];
const staff = [auth, requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] })];
const db = (): Q => pool as unknown as Q;
const answerLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false, keyGenerator: rateLimitKeyFromRequest });

router.get("/r/:token", answerLimiter, safeHandler(async (req: any, res: any) => {
  const survey = await surveyByToken(db(), String(req.params.token ?? ""));
  if (!survey) return res.status(404).json({ ok: false, error: "not_found" });
  const s = await npsSettings(db());
  res.setHeader("Cache-Control", "no-store");
  return res.json({ ok: true, company: brandName(), question: s.question, comment_prompt: s.comment_prompt, answered: survey.status === "responded", score: survey.score });
}));

router.post("/r/:token", answerLimiter, safeHandler(async (req: any, res: any) => {
  const score = Number(req.body?.score);
  const comment = String(req.body?.comment ?? "").trim().slice(0, 2000) || null;
  const r = await recordAnswer(db(), await npsSettings(db()), String(req.params.token ?? ""), score, comment);
  if (!r.ok) return res.status(r.status).json({ ok: false, error: r.error });
  return res.json({ ok: true, review_url: r.review_url });
}));

router.get("/settings", ...adminOnly, safeHandler(async (_req: any, res: any) => {
  res.setHeader("Cache-Control", "no-store");
  return res.json({ ok: true, settings: await npsSettings(db()) });
}));

router.put("/settings", ...adminOnly, safeHandler(async (req: any, res: any) => {
  const v = validateNps(req.body?.settings);
  if (!v.ok) return res.status(400).json({ ok: false, error: "validation_error", errors: v.errors });
  const settings = await saveNps(db(), req.body?.settings, actorId(req));
  await auditFor(req, "nps_settings.updated", { enabled: settings.enabled, delay_days: settings.delay_days, review_link: Boolean(settings.review_url) }, { type: "nps_settings", id: "nps" });
  return res.json({ ok: true, settings });
}));

router.get("/report", ...staff, safeHandler(async (req: any, res: any) => {
  const days = Math.min(1825, Math.max(7, Number(req.query?.days ?? 365) || 365));
  res.setHeader("Cache-Control", "no-store");
  return res.json({ ok: true, days, ...(await npsReport(db(), days)) });
}));

export default router;
