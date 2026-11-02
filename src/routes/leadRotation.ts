// BF_SERVER_v869_SETTINGS_PACK_LEAD_ROTATION - Settings > Lead rotation.
//   GET /api/lead-rotation                Admin: the settings, the people, recent assignments
//   PUT /api/lead-rotation { settings }   Admin: on/off, who is in it, which sources, who is away (audited)
//   GET /api/lead-rotation/me             staff: am I in the rotation, and am I away
//   PUT /api/lead-rotation/me { away }    staff: mark myself away / back (audited)
import { Router } from "express";
import { resolveSiloFromRequest } from "../middleware/silo.js"; // BF_SERVER_v869_SETTINGS_PACK - one rotation per silo
import { auth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { pool } from "../db.js";
import { actorId, auditFor, type Q } from "../settingsPack/common.js";
import { normalizeRotation, recentAssignments, rotationSettings, rotationSilo, saveRotationSettings } from "../leads/leadRotation.js";
import { activeMenuUsers } from "../phoneMenu/store.js";
import { displayName } from "../phoneMenu/menu.js";

const router = Router();
const staff = [auth, requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] })];
const adminOnly = [auth, requireAuthorization({ roles: [ROLES.ADMIN] })];
const db = (): Q => pool as unknown as Q;

router.get("/", ...adminOnly, safeHandler(async (req: any, res: any) => {
  const silo = rotationSilo(resolveSiloFromRequest(req));
  const [settings, users, recent] = await Promise.all([rotationSettings(db(), silo), activeMenuUsers(db()), recentAssignments(db(), 20, silo)]);
  res.setHeader("Cache-Control", "no-store");
  return res.json({ ok: true, silo, settings, users: users.map((u) => ({ id: u.id, name: displayName(u), role: u.role ?? null })), recent });
}));

router.put("/", ...adminOnly, safeHandler(async (req: any, res: any) => {
  const settings = normalizeRotation(req.body?.settings);
  const active = new Set((await activeMenuUsers(db())).map((u) => u.id));
  if (settings.user_ids.some((id) => !active.has(id))) {
    return res.status(400).json({ ok: false, error: "validation_error", errors: { user_ids: "Choose active team members only." } });
  }
  if (settings.enabled && !settings.user_ids.length) {
    return res.status(400).json({ ok: false, error: "validation_error", errors: { user_ids: "Choose at least one person to share new leads." } });
  }
  const silo = rotationSilo(resolveSiloFromRequest(req));
  await saveRotationSettings(db(), settings, actorId(req), silo);
  await auditFor(req, "lead_rotation.updated", { silo, enabled: settings.enabled, users: settings.user_ids.length, sources: settings.sources, away: settings.away_user_ids }, { type: "lead_rotation", id: "lead_rotation" });
  return res.json({ ok: true, settings });
}));

router.get("/me", ...staff, safeHandler(async (req: any, res: any) => {
  const silo = rotationSilo(resolveSiloFromRequest(req));
  const s = await rotationSettings(db(), silo);
  const me = String(actorId(req));
  return res.json({ ok: true, silo, enabled: s.enabled, member: s.user_ids.includes(me), away: s.away_user_ids.includes(me) });
}));

router.put("/me", ...staff, safeHandler(async (req: any, res: any) => {
  const silo = rotationSilo(resolveSiloFromRequest(req));
  const s = await rotationSettings(db(), silo);
  const me = String(actorId(req));
  const away = req.body?.away === true;
  const next = { ...s, away_user_ids: away ? Array.from(new Set([...s.away_user_ids, me])) : s.away_user_ids.filter((x) => x !== me) };
  await saveRotationSettings(db(), next, me, silo);
  await auditFor(req, away ? "lead_rotation.away" : "lead_rotation.back", { silo }, { type: "user", id: me, userId: me });
  return res.json({ ok: true, away });
}));

export default router;
