// BF_SERVER_v874_MARKETING_TOOLS - lead scoring (src/marketing/leadScoring.ts), ported from KS-server #48 without the
// Marketing add-on: every silo always has it.
//   POST /api/lead-scores/lookup { contact_ids }   staff: scores for the contacts on screen (refreshed now)
//   GET  /api/lead-scores/top?limit=50             staff: the highest scores
//   GET  /api/lead-scores/settings                 Admins and Marketing users: the rules and points
//   PUT  /api/lead-scores/settings { settings }    Admins and Marketing users (audited)
// Everything is per silo (X-Silo / ?silo=, resolved like every other route): a BI user sees BI contacts' scores scored
// by BI's rules. Record visibility (own / team / all) applies: a score is only returned for a contact the person may
// see. The custom-role matrix maps lookups and the list to contacts.view and the settings to marketing.
import { Router } from "express";
import { pool } from "../db.js";
import { auth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { resolveSiloFromRequest } from "../middleware/silo.js";
import { actorId, auditFor, type Q } from "../settingsPack/common.js";
import { ownerFilterSql, scopeForRequest, visibleIds } from "../visibility/scope.js";
import {
  DEFAULT_SCORING, ENGAGEMENT_LABELS, RULE_KINDS, normalizeScoring, saveScoringSettings, scoreContacts, scoringSettings,
  type ScoringSilo,
} from "../marketing/leadScoring.js";

const router = Router();
const db = (): Q => pool as unknown as Q;
const staff = [auth, requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF, ROLES.OPS, ROLES.MARKETING] })];
const editors = [auth, requireAuthorization({ roles: [ROLES.ADMIN, ROLES.MARKETING] })];

/** The request's marketing silo (BF, BI or SLF); null for a silo without marketing (Keystone operations). */
export function marketingSiloOf(req: any): ScoringSilo | null {
  const s = resolveSiloFromRequest(req);
  return s === "BF" || s === "BI" || s === "SLF" ? s : null;
}

router.post("/lookup", ...staff, safeHandler(async (req: any, res: any) => {
  res.setHeader("Cache-Control", "no-store");
  const silo = marketingSiloOf(req);
  if (!silo) return res.json({ ok: true, enabled: false, scores: {} });
  const asked = Array.isArray(req.body?.contact_ids) ? req.body.contact_ids.map(String).slice(0, 500) : [];
  const visible = await visibleIds(db(), await scopeForRequest(req, db()), "contact", asked);
  const settings = await scoringSettings(db(), silo);
  const scores = await scoreContacts(db(), [...visible], silo, settings);
  return res.json({ ok: true, enabled: true, silo, hot: settings.hot, warm: settings.warm, scores: Object.fromEntries(scores.map((s) => [s.contact_id, s])) });
}));

router.get("/top", ...staff, safeHandler(async (req: any, res: any) => {
  res.setHeader("Cache-Control", "no-store");
  const silo = marketingSiloOf(req);
  if (!silo) return res.json({ ok: true, enabled: false, contacts: [] });
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const params: unknown[] = [silo, limit];
  const scope = ownerFilterSql(await scopeForRequest(req, db()), "contact", "c", params);
  const r = await pool.query(
    `SELECT ls.contact_id::text AS contact_id, ls.score, ls.computed_at, c.name, c.email, c.phone, c.company_name
       FROM lead_scores ls JOIN contacts c ON c.id = ls.contact_id
      WHERE COALESCE(c.silo, 'BF') = $1 AND c.merged_into_id IS NULL AND ${scope}
      ORDER BY ls.score DESC, ls.computed_at DESC LIMIT $2`,
    params,
  );
  const s = await scoringSettings(db(), silo);
  return res.json({ ok: true, enabled: true, silo, hot: s.hot, warm: s.warm, contacts: r.rows });
}));

router.get("/settings", ...editors, safeHandler(async (req: any, res: any) => {
  res.setHeader("Cache-Control", "no-store");
  const silo = marketingSiloOf(req);
  if (!silo) return res.status(400).json({ ok: false, error: "silo_not_supported", message: "Lead scoring is set up in the BF, BI and SLF silos." });
  return res.json({ ok: true, silo, settings: await scoringSettings(db(), silo), defaults: DEFAULT_SCORING, rule_kinds: RULE_KINDS, engagement_labels: ENGAGEMENT_LABELS });
}));

router.put("/settings", ...editors, safeHandler(async (req: any, res: any) => {
  const silo = marketingSiloOf(req);
  if (!silo) return res.status(400).json({ ok: false, error: "silo_not_supported", message: "Lead scoring is set up in the BF, BI and SLF silos." });
  const settings = normalizeScoring(req.body?.settings);
  await saveScoringSettings(db(), settings, actorId(req), silo);
  await auditFor(req, "lead_scoring_saved", { silo, rules: settings.rules.length, hot: settings.hot, warm: settings.warm });
  return res.json({ ok: true, silo, settings });
}));

export default router;
