// BF_SERVER_REPORTS_SECTION_v714 - drag-and-drop Reports.
import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { catalogFor, reportByKey, canSee, normalizeRole } from "../services/reports/catalog.js";
import { DATA } from "../services/reports/data.js";

const router = Router();
const SILOS = new Set(["BF", "BI", "SLF"]);
const siloOf = (v: unknown) => (SILOS.has(String(v ?? "").toUpperCase()) ? String(v).toUpperCase() : "BF");
const uid = (req: any) => String(req.user?.userId ?? req.user?.id ?? "");
type Card = { id: string; report: string; size: "third" | "half" | "full"; days?: number }; // BF_SERVER_DASHBOARD_BOARD_v730 third = Small
export function cleanCards(role: unknown, raw: unknown): Card[] {
  if (!Array.isArray(raw)) return [];
  const out: Card[] = [];
  for (const c of raw.slice(0, 40)) {
    const def = reportByKey(String((c as any)?.report ?? ""));
    if (!def || !canSee(role, def.group)) continue;
    const days = Number((c as any)?.days);
    out.push({ id: String((c as any)?.id ?? "").slice(0, 60) || Math.random().toString(36).slice(2, 10), report: def.key,
      size: (c as any)?.size === "third" ? "third" : (c as any)?.size === "half" ? "half" : (c as any)?.size === "full" ? "full" : def.size,
      ...(Number.isFinite(days) && days > 0 ? { days: Math.min(Math.round(days), 365) } : {}) });
  }
  return out;
}

router.get("/catalog", requireAuth, safeHandler(async (req: any, res: any) => {
  const silo = siloOf(req.query?.silo);
  // BF_SERVER_DASHBOARD_BOARD_v730 - the standard Dashboard sections are only offered on the Dashboard.
  const forDashboard = req.query?.for === "dashboard";
  res.json({ role: normalizeRole(req.user?.role), reports: catalogFor(req.user?.role).filter((r) => r.silo === silo && (forDashboard || r.source !== "dashboard")) });
}));
router.get("/layouts", requireAuth, safeHandler(async (req: any, res: any) => {
  const silo = siloOf(req.query?.silo);
  const role = req.user?.role;
  const mine = await pool.query("SELECT id::text, kind, name, position, cards FROM report_layouts WHERE owner_user_id = $1 AND silo = $2 AND team = false ORDER BY kind, position", [uid(req), silo]);
  const team = await pool.query("SELECT id::text, name, position, cards FROM report_layouts WHERE team = true AND silo = $1 ORDER BY position", [silo]);
  const dash = mine.rows.find((r: any) => r.kind === "dashboard");
  res.json({ silo, canPublishTeamTabs: normalizeRole(role) === "Admin",
    tabs: mine.rows.filter((r: any) => r.kind === "tab").map((r: any) => ({ id: r.id, name: r.name, cards: cleanCards(role, r.cards) })),
    dashboard: dash ? { cards: cleanCards(role, dash.cards) } : null,
    teamTabs: team.rows.map((r: any) => ({ id: r.id, name: r.name, cards: cleanCards(role, r.cards) })) });
}));
router.put("/layouts", requireAuth, safeHandler(async (req: any, res: any) => {
  const silo = siloOf(req.body?.silo); const owner = uid(req);
  if (!owner) { res.status(400).json({ error: "no_user" }); return; }
  const role = req.user?.role; const tabs = Array.isArray(req.body?.tabs) ? req.body.tabs.slice(0, 20) : [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM report_layouts WHERE owner_user_id = $1 AND silo = $2 AND team = false", [owner, silo]);
    let pos = 0;
    for (const t of tabs) await client.query("INSERT INTO report_layouts (owner_user_id, kind, silo, name, position, cards) VALUES ($1, 'tab', $2, $3, $4, $5)", [owner, silo, String(t?.name ?? "Tab").slice(0, 60) || "Tab", pos++, JSON.stringify(cleanCards(role, t?.cards))]);
    if (req.body?.dashboard) await client.query("INSERT INTO report_layouts (owner_user_id, kind, silo, name, position, cards) VALUES ($1, 'dashboard', $2, 'Dashboard', 0, $3)", [owner, silo, JSON.stringify(cleanCards(role, req.body.dashboard.cards))]);
    await client.query("COMMIT");
  } catch (err) { await client.query("ROLLBACK"); throw err; } finally { client.release(); }
  res.json({ ok: true });
}));
router.put("/team-tabs", requireAuth, safeHandler(async (req: any, res: any) => {
  if (normalizeRole(req.user?.role) !== "Admin") { res.status(403).json({ error: "admin_only" }); return; }
  const silo = siloOf(req.body?.silo); const tabs = Array.isArray(req.body?.tabs) ? req.body.tabs.slice(0, 20) : [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN"); await client.query("DELETE FROM report_layouts WHERE team = true AND silo = $1", [silo]);
    let pos = 0;
    for (const t of tabs) await client.query("INSERT INTO report_layouts (owner_user_id, kind, silo, name, position, team, cards) VALUES (NULL, 'tab', $1, $2, $3, true, $4)", [silo, String(t?.name ?? "Team").slice(0, 60) || "Team", pos++, JSON.stringify(cleanCards("Admin", t?.cards))]);
    await client.query("COMMIT");
  } catch (err) { await client.query("ROLLBACK"); throw err; } finally { client.release(); }
  res.json({ ok: true });
}));
router.get("/data/:key", requireAuth, safeHandler(async (req: any, res: any) => {
  const def = reportByKey(String(req.params?.key ?? "")); const run = def ? DATA[def.key] : undefined;
  if (!def || !run) { res.status(404).json({ error: "unknown_report" }); return; }
  if (!canSee(req.user?.role, def.group)) { res.status(403).json({ error: "not_allowed" }); return; }
  res.json(await run(req.query ?? {}, { role: normalizeRole(req.user?.role), userId: uid(req) })); // BF_SERVER_REPORTS_BATCH2_v719
}));
export default router;
