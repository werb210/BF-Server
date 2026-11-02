// BF_SERVER_v870_CRM_DATA_MODEL - /api/teams: teams and record visibility (ported from KS-server #39, plan gate
// removed). Not the team chat (/api/team).
//   GET    /me                          the caller's visibility and teams (every staff member)
//   GET    /options                     active teams for the Team filter (staff)
//   GET    /                            teams, members, users and the role settings (Admin)
//   POST   /                            { name, description? } (Admin)
//   PATCH  /:id                         { name?, description? } (Admin)
//   POST   /:id/archive | /unarchive    (Admin) archived teams no longer widen anyone's visibility
//   PUT    /:id/members                 { user_ids: [...] } the whole member list (Admin)
//   PUT    /users/:userId               { primary_team_id?, record_visibility?: all|team|own|null, team_ids? } (Admin)
//   PUT    /visibility/roles            { Staff?: v, Ops?: v, Marketing?: v } (Admin). Admins always see everything.
import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { actorId, auditFor, type Q } from "../settingsPack/common.js";
import { CONFIGURABLE_ROLES, clearVisibilityCache, isVisibility, scopeForRequest } from "../visibility/scope.js";

const router = Router();
router.use(requireAuth);
const db = () => pool as unknown as Q;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const TEAM_LIMITS = { teams: 200, nameChars: 80, descriptionChars: 300 };

router.get("/me", safeHandler(async (req: any, res: any) => {
  const scope = await scopeForRequest(req, db());
  const uid = actorId(req);
  const teams = uid
    ? (await pool.query(
      `SELECT t.id::text AS id, t.name, (u.primary_team_id = t.id) AS is_primary
         FROM sales_team_members m JOIN sales_teams t ON t.id = m.team_id AND t.archived_at IS NULL
         JOIN users u ON u.id = m.user_id
        WHERE m.user_id = $1 ORDER BY lower(t.name)`, [uid])).rows
    : [];
  res.json({ ok: true, visibility: scope.visibility, teams });
}));

router.get("/options", safeHandler(async (_req: any, res: any) => {
  const r = await pool.query(`SELECT id::text AS id, name FROM sales_teams WHERE archived_at IS NULL ORDER BY lower(name)`);
  res.json({ ok: true, teams: r.rows });
}));

router.get("/", requireAdmin, safeHandler(async (_req: any, res: any) => {
  const teams = await pool.query(
    `SELECT t.id::text AS id, t.name, t.description, t.archived_at, t.created_at,
            COALESCE(json_agg(json_build_object('user_id', m.user_id::text) ORDER BY m.added_at) FILTER (WHERE m.user_id IS NOT NULL), '[]') AS members
       FROM sales_teams t LEFT JOIN sales_team_members m ON m.team_id = t.id
      GROUP BY t.id ORDER BY t.archived_at IS NOT NULL, lower(t.name)`,
  );
  const users = await pool.query(
    `SELECT u.id::text AS id, u.email, u.role, u.first_name, u.last_name, u.primary_team_id::text AS primary_team_id,
            u.record_visibility,
            COALESCE((SELECT array_agg(m.team_id::text) FROM sales_team_members m WHERE m.user_id = u.id), ARRAY[]::text[]) AS team_ids
       FROM users u
      WHERE u.deleted_at IS NULL AND COALESCE(u.disabled, false) = false
        AND lower(COALESCE(u.role, '')) IN ('admin', 'staff', 'ops', 'marketing')
      ORDER BY lower(COALESCE(u.first_name, '')), lower(u.email)`,
  );
  const roles = await pool.query(`SELECT role, visibility FROM role_record_visibility`);
  const roleVisibility: Record<string, string> = Object.fromEntries(CONFIGURABLE_ROLES.map((r) => [r, "all"]));
  for (const r of roles.rows) if (roleVisibility[r.role] !== undefined) roleVisibility[r.role] = r.visibility;
  res.json({ ok: true, teams: teams.rows, users: users.rows, role_visibility: roleVisibility, roles: CONFIGURABLE_ROLES, limits: TEAM_LIMITS });
}));

function cleanTeam(body: any, partial: boolean): { ok: true; name?: string; description?: string | null } | { ok: false; error: string } {
  const out: { name?: string; description?: string | null } = {};
  if (!partial || body?.name !== undefined) {
    const name = String(body?.name ?? "").trim();
    if (!name) return { ok: false, error: "Give the team a name." };
    if (name.length > TEAM_LIMITS.nameChars) return { ok: false, error: `The name can be at most ${TEAM_LIMITS.nameChars} characters.` };
    out.name = name;
  }
  if (body?.description !== undefined) {
    const d = String(body.description ?? "").trim();
    if (d.length > TEAM_LIMITS.descriptionChars) return { ok: false, error: `The description can be at most ${TEAM_LIMITS.descriptionChars} characters.` };
    out.description = d || null;
  }
  return { ok: true, ...out };
}

router.post("/", requireAdmin, safeHandler(async (req: any, res: any) => {
  const c = cleanTeam(req.body, false);
  if (!c.ok) return res.status(400).json({ ok: false, error: "invalid_team", message: c.error });
  const n = await pool.query(`SELECT count(*)::int AS n FROM sales_teams WHERE archived_at IS NULL`);
  if (Number(n.rows[0]?.n ?? 0) >= TEAM_LIMITS.teams) return res.status(409).json({ ok: false, error: "too_many_teams", message: `You can have at most ${TEAM_LIMITS.teams} teams.` });
  try {
    const r = await pool.query(
      `INSERT INTO sales_teams (name, description, created_by) VALUES ($1, $2, $3) RETURNING id::text AS id, name, description, archived_at, created_at`,
      [c.name, c.description ?? null, actorId(req)],
    );
    await auditFor(req, "sales_team.created", { name: c.name }, { type: "sales_team", id: r.rows[0].id });
    res.status(201).json({ ok: true, team: { ...r.rows[0], members: [] } });
  } catch (err) {
    if ((err as any)?.code === "23505") return res.status(409).json({ ok: false, error: "duplicate_name", message: "A team with that name already exists." });
    throw err;
  }
}));

async function teamOr404(req: any, res: any) {
  const id = String(req.params.id ?? "");
  if (!UUID_RE.test(id)) { res.status(404).json({ ok: false, error: "not_found" }); return null; }
  const r = await pool.query(`SELECT id::text AS id, name, archived_at FROM sales_teams WHERE id = $1`, [id]);
  if (!r.rows[0]) { res.status(404).json({ ok: false, error: "not_found" }); return null; }
  return r.rows[0];
}

router.patch("/:id", requireAdmin, safeHandler(async (req: any, res: any) => {
  const team = await teamOr404(req, res);
  if (!team) return;
  const c = cleanTeam(req.body, true);
  if (!c.ok) return res.status(400).json({ ok: false, error: "invalid_team", message: c.error });
  try {
    const r = await pool.query(
      `UPDATE sales_teams SET name = COALESCE($2, name), description = CASE WHEN $4 THEN $3 ELSE description END, updated_at = now()
        WHERE id = $1 RETURNING id::text AS id, name, description, archived_at`,
      [team.id, c.name ?? null, c.description ?? null, c.description !== undefined],
    );
    await auditFor(req, "sales_team.updated", { name: r.rows[0].name }, { type: "sales_team", id: team.id });
    res.json({ ok: true, team: r.rows[0] });
  } catch (err) {
    if ((err as any)?.code === "23505") return res.status(409).json({ ok: false, error: "duplicate_name", message: "A team with that name already exists." });
    throw err;
  }
}));

for (const [path, archived] of [["archive", true], ["unarchive", false]] as const) {
  router.post(`/:id/${path}`, requireAdmin, safeHandler(async (req: any, res: any) => {
    const team = await teamOr404(req, res);
    if (!team) return;
    try {
      await pool.query(`UPDATE sales_teams SET archived_at = ${archived ? "COALESCE(archived_at, now())" : "NULL"}, updated_at = now() WHERE id = $1`, [team.id]);
    } catch (err) {
      if ((err as any)?.code === "23505") return res.status(409).json({ ok: false, error: "duplicate_name", message: "An active team already has that name." });
      throw err;
    }
    if (archived) await pool.query(`UPDATE users SET primary_team_id = NULL WHERE primary_team_id = $1`, [team.id]);
    clearVisibilityCache();
    await auditFor(req, archived ? "sales_team.archived" : "sales_team.unarchived", { name: team.name }, { type: "sales_team", id: team.id });
    res.json({ ok: true });
  }));
}

async function staffUserIds(ids: string[]): Promise<string[]> {
  const clean = [...new Set(ids.filter((x) => UUID_RE.test(x)))];
  if (!clean.length) return [];
  const r = await pool.query(
    `SELECT id::text AS id FROM users WHERE id = ANY($1::uuid[]) AND lower(COALESCE(role, '')) IN ('admin', 'staff', 'ops', 'marketing')`, [clean],
  );
  return r.rows.map((x: any) => String(x.id));
}

router.put("/:id/members", requireAdmin, safeHandler(async (req: any, res: any) => {
  const team = await teamOr404(req, res);
  if (!team) return;
  const want: string[] = Array.isArray(req.body?.user_ids) ? req.body.user_ids.map(String) : [];
  const ids = await staffUserIds(want);
  if (ids.length !== new Set(want).size) return res.status(400).json({ ok: false, error: "unknown_user", message: "Only staff users can be on a team." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM sales_team_members WHERE team_id = $1 AND NOT (user_id = ANY($2::uuid[]))`, [team.id, ids]);
    await client.query(
      `INSERT INTO sales_team_members (team_id, user_id, added_by) SELECT $1, x, $3 FROM unnest($2::uuid[]) x ON CONFLICT DO NOTHING`,
      [team.id, ids, actorId(req)],
    );
    // A user taken off their primary team loses it as primary; a user whose only team this is gets it as primary.
    await client.query(`UPDATE users SET primary_team_id = NULL WHERE primary_team_id = $1 AND NOT (id = ANY($2::uuid[]))`, [team.id, ids]);
    await client.query(`UPDATE users SET primary_team_id = $1 WHERE id = ANY($2::uuid[]) AND primary_team_id IS NULL`, [team.id, ids]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch((e: unknown) => console.error("[teams] rollback failed", (e as Error)?.message));
    throw err;
  } finally {
    client.release();
  }
  clearVisibilityCache();
  await auditFor(req, "sales_team.members_set", { name: team.name, members: ids.length }, { type: "sales_team", id: team.id });
  res.json({ ok: true, user_ids: ids });
}));

router.put("/users/:userId", requireAdmin, safeHandler(async (req: any, res: any) => {
  const uid = String(req.params.userId ?? "");
  const [found] = await staffUserIds([uid]);
  if (!found) return res.status(404).json({ ok: false, error: "not_found" });
  const b = req.body ?? {};
  if (b.record_visibility !== undefined && b.record_visibility !== null && !isVisibility(b.record_visibility)) {
    return res.status(400).json({ ok: false, error: "invalid_visibility", message: "Visibility is all, team or own (or null to follow the role)." });
  }
  if (Array.isArray(b.team_ids)) {
    const teamIds = [...new Set(b.team_ids.map(String).filter((x: string) => UUID_RE.test(x)))];
    const ok = await pool.query(`SELECT id::text AS id FROM sales_teams WHERE id = ANY($1::uuid[]) AND archived_at IS NULL`, [teamIds]);
    if (ok.rows.length !== teamIds.length || teamIds.length !== b.team_ids.length) return res.status(400).json({ ok: false, error: "unknown_team" });
    await pool.query(`DELETE FROM sales_team_members WHERE user_id = $1 AND NOT (team_id = ANY($2::uuid[]))`, [uid, teamIds]);
    await pool.query(`INSERT INTO sales_team_members (team_id, user_id, added_by) SELECT x, $1, $3 FROM unnest($2::uuid[]) x ON CONFLICT DO NOTHING`, [uid, teamIds, actorId(req)]);
  }
  if (b.primary_team_id !== undefined) {
    const p = b.primary_team_id === null || b.primary_team_id === "" ? null : String(b.primary_team_id);
    if (p && !UUID_RE.test(p)) return res.status(400).json({ ok: false, error: "unknown_team" });
    if (p) {
      const member = await pool.query(`SELECT 1 FROM sales_team_members m JOIN sales_teams t ON t.id = m.team_id AND t.archived_at IS NULL WHERE m.team_id = $1::uuid AND m.user_id = $2`, [p, uid]);
      if (!member.rows.length) return res.status(400).json({ ok: false, error: "not_a_member", message: "The primary team must be one of the user's teams." });
    }
    await pool.query(`UPDATE users SET primary_team_id = $2 WHERE id = $1`, [uid, p]);
  } else if (Array.isArray(b.team_ids)) {
    await pool.query(
      `UPDATE users SET primary_team_id = CASE WHEN primary_team_id = ANY($2::uuid[]) THEN primary_team_id ELSE $3::uuid END WHERE id = $1`,
      [uid, b.team_ids, b.team_ids[0] ?? null],
    );
  }
  if (b.record_visibility !== undefined) await pool.query(`UPDATE users SET record_visibility = $2 WHERE id = $1`, [uid, b.record_visibility ?? null]);
  clearVisibilityCache();
  await auditFor(req, "record_visibility.user_updated", { record_visibility: b.record_visibility, primary_team_id: b.primary_team_id, team_ids: b.team_ids }, { type: "user", id: uid });
  const r = await pool.query(
    `SELECT id::text AS id, primary_team_id::text AS primary_team_id, record_visibility,
            COALESCE((SELECT array_agg(m.team_id::text) FROM sales_team_members m WHERE m.user_id = users.id), ARRAY[]::text[]) AS team_ids
       FROM users WHERE id = $1`, [uid]);
  res.json({ ok: true, user: r.rows[0] });
}));

router.put("/visibility/roles", requireAdmin, safeHandler(async (req: any, res: any) => {
  const b = req.body ?? {};
  const changes: Record<string, string> = {};
  for (const role of CONFIGURABLE_ROLES) {
    if (b[role] === undefined) continue;
    if (!isVisibility(b[role])) return res.status(400).json({ ok: false, error: "invalid_visibility", message: `${role}: choose all, team or own.` });
    changes[role] = b[role];
  }
  for (const [role, v] of Object.entries(changes)) {
    await pool.query(
      `INSERT INTO role_record_visibility (role, visibility, updated_by, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (role) DO UPDATE SET visibility = EXCLUDED.visibility, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [role, v, actorId(req)],
    );
  }
  clearVisibilityCache();
  await auditFor(req, "record_visibility.roles_updated", changes, { type: "role_record_visibility" });
  res.json({ ok: true, role_visibility: changes });
}));

export default router;
