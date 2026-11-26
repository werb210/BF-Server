// BF_SERVER_TV_SCOREBOARD_v1 - the sales scoreboard (src/scoreboard).
//   GET    /api/scoreboard/board?team_id=      staff: the Leaderboard report (this month, CAD)
//   GET    /api/scoreboard/screens             Admin: paired TVs
//   POST   /api/scoreboard/screens/pair        Admin: { code, name, team_ids?, slides?, rotate_seconds? }
//   PATCH  /api/scoreboard/screens/:id         Admin: { name?, team_ids?, slides?, rotate_seconds? }
//   POST   /api/scoreboard/screens/:id/remove  Admin: the TV's token stops working at once
//   GET    /api/scoreboard/tv                  the TV itself (Authorization: Bearer tvs_...): its settings and the board
import { Router } from "express";
import { pool } from "../db.js";
import { auth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { actorId, auditFor } from "../settingsPack/common.js";
import { brokerageTimeZone } from "../settingsPack/boreal.js";
import { DEAL_CURRENCY_SQL } from "./dashboard.js";
import { loadBoard } from "../scoreboard/scoreboard.js";
import { bfClaim, cleanSettings, listScreens, pairScreen, SCREEN_COLS, screenForToken } from "../scoreboard/screens.js";

const router = Router();
const db = () => pool as any;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const opsUrl = () => process.env.KS_OPS_URL || "https://ops.keystonecrm.online";
const COMPANY = "Boreal Financial";

router.get("/tv", safeHandler(async (req: any, res: any) => {
  res.setHeader("Cache-Control", "no-store");
  const screen = await screenForToken(db(), req.headers.authorization);
  if (!screen) return res.status(401).json({ error: "screen_removed", message: "This TV is no longer paired. Pair it again in Settings > Screens." });
  const board = await loadBoard(db(), { tz: brokerageTimeZone(), teamIds: screen.team_ids, dealCurrencySql: DEAL_CURRENCY_SQL });
  return res.json({ ok: true, company: { name: COMPANY, logo_url: null, primary_color: null }, screen: { name: screen.name, slides: screen.slides, rotate_seconds: screen.rotate_seconds }, ...board });
}));

router.get("/board", auth, requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF, ROLES.OPS] }), safeHandler(async (req: any, res: any) => {
  res.setHeader("Cache-Control", "no-store");
  const team = typeof req.query?.team_id === "string" && UUID.test(req.query.team_id) ? [req.query.team_id] : null;
  return res.json({ ok: true, ...(await loadBoard(db(), { tz: brokerageTimeZone(), teamIds: team, dealCurrencySql: DEAL_CURRENCY_SQL })) });
}));

const admin = [auth, requireAuthorization({ roles: [ROLES.ADMIN] })];

router.get("/screens", ...admin, safeHandler(async (_req: any, res: any) => {
  res.json({ ok: true, screens: await listScreens(db()) });
}));

router.post("/screens/pair", ...admin, safeHandler(async (req: any, res: any) => {
  const settings = cleanSettings(req.body);
  if ("error" in settings) return res.status(400).json({ error: "invalid", message: settings.error });
  const out = await pairScreen(db(), { code: req.body?.code, settings, createdBy: actorId(req), claim: bfClaim(opsUrl(), String(req.headers.authorization ?? "")) });
  if (!out.ok) return res.status(out.status).json({ error: "pair_failed", message: out.message });
  await auditFor(req, "tv_screen.paired", { screen_id: out.screen.id, name: out.screen.name });
  return res.status(201).json({ ok: true, screen: out.screen });
}));

router.patch("/screens/:id", ...admin, safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id);
  if (!UUID.test(id)) return res.status(404).json({ error: "not_found" });
  const cur = (await pool.query(`SELECT ${SCREEN_COLS} FROM tv_screens WHERE id = $1 AND removed_at IS NULL`, [id])).rows[0];
  if (!cur) return res.status(404).json({ error: "not_found", message: "That TV was not found." });
  const s = cleanSettings(req.body, cur);
  if ("error" in s) return res.status(400).json({ error: "invalid", message: s.error });
  const row = (await pool.query(
    `UPDATE tv_screens SET name = $2, team_ids = $3::uuid[], slides = $4::text[], rotate_seconds = $5, updated_at = now() WHERE id = $1 RETURNING ${SCREEN_COLS}`,
    [id, s.name, s.team_ids, s.slides, s.rotate_seconds])).rows[0];
  return res.json({ ok: true, screen: row });
}));

router.post("/screens/:id/remove", ...admin, safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id);
  if (!UUID.test(id)) return res.status(404).json({ error: "not_found" });
  const r = await pool.query(`UPDATE tv_screens SET removed_at = now() WHERE id = $1 AND removed_at IS NULL RETURNING id`, [id]);
  if (!r.rowCount) return res.status(404).json({ error: "not_found", message: "That TV was not found." });
  await auditFor(req, "tv_screen.removed", { screen_id: id });
  return res.json({ ok: true });
}));

export default router;
