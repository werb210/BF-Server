// BF_SERVER_v870_CRM_DATA_MODEL - /api/roles: custom roles and permissions (Settings > Users & roles), ported from
// KS-server #49 without Keystone's plan gate.
//   GET   /me              the caller's role, permission matrix and record visibility (every staff member)
//   GET   /                the built-in templates (read-only), the custom roles, the matrix labels (Admins)
//   POST  /                { name, description?, base_role, permissions, record_visibility } create (full Admin)
//   PATCH /:id             same fields, any subset (full Admin)
//   POST  /:id/archive     (full Admin) refused while people are still on the role
//   POST  /:id/unarchive   (full Admin)
// People are put on a role with PATCH /api/users/:id { custom_role_id } (or { role } for a built-in role), which keeps
// the token revocation of that route. Every change is written to audit_events.
import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { actorId, auditFor, type Q } from "../settingsPack/common.js";
import { clearVisibilityCache, isVisibility, type Visibility } from "../visibility/scope.js";
import { clearStaffUserCache } from "../auth/staffUserState.js";
import {
  ACTION_LABELS, ACTIONS, AREA_LABELS, AREAS, BASE_ROLES, isBaseRole, permissionList, templateFor, type BaseRole, type PermissionSet,
} from "../roles/permissions.js";
import {
  clearCustomRoleCache, cleanRoleInput, isUuid, listCustomRoles, loadCustomRole, rowToRole, ROLE_LIMITS, type CustomRole,
} from "../roles/customRoles.js";
import { isFullAdmin } from "../roles/enforce.js";

const router = Router();
router.use(requireAuth);
const db = () => pool as unknown as Q;

const BUILT_IN_DESCRIPTIONS: Record<BaseRole, string> = {
  Admin: "Everything, including settings, QuickBooks, users and roles. Sees every record.",
  Ops: "Everything except QuickBooks changes. Manages users.",
  Staff: "Contacts, companies, applications, lenders, documents, email, texts and calls.",
  Marketing: "The same as Staff, plus the Marketing tools.",
};

function isStaffRole(role: unknown): role is BaseRole {
  const r = String(role ?? "").trim().toLowerCase();
  return BASE_ROLES.some((b) => b.toLowerCase() === r);
}
function baseOf(role: unknown): BaseRole {
  const r = String(role ?? "").trim().toLowerCase();
  return BASE_ROLES.find((b) => b.toLowerCase() === r) ?? "Staff";
}

async function roleVisibility(base: BaseRole): Promise<Visibility> {
  if (base === "Admin") return "all";
  const r = await pool.query(`SELECT visibility FROM role_record_visibility WHERE role = $1`, [base]);
  return isVisibility(r.rows[0]?.visibility) ? r.rows[0].visibility : "all";
}

function fullAdminOnly(req: any, res: any, next: any) {
  if (isFullAdmin(req)) return next();
  return res.status(403).json({ ok: false, error: "full_admin_required", message: "Only an Admin can create or change roles." });
}
function adminOnly(req: any, res: any, next: any) {
  if (String(req.user?.role ?? "").toLowerCase() === "admin") return next();
  return res.status(403).json({ ok: false, error: "admin_only", message: "This action requires Admin role." });
}

router.get("/me", safeHandler(async (req: any, res: any) => {
  res.setHeader("Cache-Control", "no-store");
  const role = req.user?.role;
  if (!isStaffRole(role)) return res.status(403).json({ ok: false, error: "STAFF_ONLY" });
  const base = baseOf(role);
  const customId: string | null = req.user?.custom_role_id ?? null;
  const custom: CustomRole | null = (req as any).customRole ?? (customId ? await loadCustomRole(db(), customId) : null);
  const permissions: PermissionSet = custom ? custom.permissions : templateFor(base);
  res.json({
    ok: true,
    role: base,
    custom_role: custom ? { id: custom.id, name: custom.name, base_role: custom.base_role } : null,
    full_admin: base === "Admin" && !custom,
    permissions,
    granted: permissionList(permissions),
    record_visibility: custom ? custom.record_visibility : await roleVisibility(base),
  });
}));

router.get("/", adminOnly, safeHandler(async (_req: any, res: any) => {
  const counts = await pool.query(
    `SELECT role, count(*)::int AS n FROM users
      WHERE deleted_at IS NULL AND custom_role_id IS NULL AND lower(COALESCE(role, '')) IN ('admin', 'ops', 'staff', 'marketing')
      GROUP BY role`,
  );
  const n = (base: BaseRole) => counts.rows.filter((r: any) => String(r.role).toLowerCase() === base.toLowerCase()).reduce((t: number, r: any) => t + Number(r.n), 0);
  const templates = [];
  for (const base of BASE_ROLES) {
    templates.push({
      id: `builtin:${base}`,
      name: base,
      description: BUILT_IN_DESCRIPTIONS[base],
      base_role: base,
      built_in: true,
      read_only: true,
      permissions: templateFor(base),
      record_visibility: await roleVisibility(base),
      users: n(base),
    });
  }
  const roles = (await listCustomRoles(db())).map((r) => ({ ...r, built_in: false, read_only: false }));
  res.json({
    ok: true,
    templates,
    roles,
    areas: AREAS.map((key) => ({ key, label: AREA_LABELS[key] })),
    actions: ACTIONS.map((key) => ({ key, label: ACTION_LABELS[key] })),
    limits: ROLE_LIMITS,
  });
}));

async function roleOr404(req: any, res: any): Promise<CustomRole | null> {
  const id = String(req.params.id ?? "");
  if (!isUuid(id)) { res.status(404).json({ ok: false, error: "not_found" }); return null; }
  const r = await pool.query(
    `SELECT id::text AS id, name, description, base_role, permissions, record_visibility, archived_at FROM custom_roles WHERE id = $1`, [id],
  );
  if (!r.rows[0]) { res.status(404).json({ ok: false, error: "not_found" }); return null; }
  return rowToRole(r.rows[0]);
}

function changed(before: CustomRole | null, after: { permissions: PermissionSet; record_visibility: string; base_role: string; name: string }) {
  const was = new Set(before ? permissionList(before.permissions) : []);
  const now = new Set(permissionList(after.permissions));
  return {
    added: [...now].filter((p) => !was.has(p)),
    removed: [...was].filter((p) => !now.has(p)),
    ...(before && before.record_visibility !== after.record_visibility ? { record_visibility: { from: before.record_visibility, to: after.record_visibility } } : {}),
    ...(before && before.name !== after.name ? { name: { from: before.name, to: after.name } } : {}),
  };
}

function afterRoleChange(): void {
  clearCustomRoleCache();
  clearVisibilityCache();
}

router.post("/", fullAdminOnly, safeHandler(async (req: any, res: any) => {
  const c = cleanRoleInput(req.body, null);
  if (!c.ok) return res.status(400).json({ ok: false, error: "invalid_role", message: c.error });
  const n = await pool.query(`SELECT count(*)::int AS n FROM custom_roles WHERE archived_at IS NULL`);
  if (Number(n.rows[0]?.n ?? 0) >= ROLE_LIMITS.roles) {
    return res.status(409).json({ ok: false, error: "too_many_roles", message: `You can have at most ${ROLE_LIMITS.roles} custom roles.` });
  }
  const v = c.value;
  try {
    const r = await pool.query(
      `INSERT INTO custom_roles (name, description, base_role, permissions, record_visibility, created_by, updated_by)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $6)
       RETURNING id::text AS id, name, description, base_role, permissions, record_visibility, archived_at`,
      [v.name, v.description, v.base_role, JSON.stringify(v.permissions), v.record_visibility, actorId(req)],
    );
    const role = rowToRole(r.rows[0]);
    afterRoleChange();
    await auditFor(req, "custom_role.created", {
      name: role.name, base_role: role.base_role, record_visibility: role.record_visibility, permissions: permissionList(role.permissions),
      ...(v.dropped.length ? { dropped_beyond_base: v.dropped } : {}),
    }, { type: "custom_role", id: role.id });
    res.status(201).json({ ok: true, role: { ...role, users: 0 }, dropped: v.dropped });
  } catch (err) {
    if ((err as any)?.code === "23505") return res.status(409).json({ ok: false, error: "duplicate_name", message: "A role with that name already exists." });
    throw err;
  }
}));

router.patch("/:id", fullAdminOnly, safeHandler(async (req: any, res: any) => {
  const current = await roleOr404(req, res);
  if (!current) return;
  if (req.body?.base_role !== undefined && req.body.base_role !== current.base_role) {
    // The base decides users.role for everyone on the role; changing it would silently change their built-in role.
    if (!isBaseRole(req.body.base_role)) return res.status(400).json({ ok: false, error: "invalid_role", message: "Start from Admin, Ops, Staff or Marketing." });
    const people = await pool.query(`SELECT count(*)::int AS n FROM users WHERE custom_role_id = $1`, [current.id]);
    if (Number(people.rows[0]?.n ?? 0) > 0) {
      return res.status(409).json({ ok: false, error: "role_in_use", message: "People are on this role, so it cannot start from a different built-in role. Create a new role instead." });
    }
  }
  const c = cleanRoleInput(req.body, current);
  if (!c.ok) return res.status(400).json({ ok: false, error: "invalid_role", message: c.error });
  const v = c.value;
  try {
    const r = await pool.query(
      `UPDATE custom_roles SET name = $2, description = $3, base_role = $4, permissions = $5::jsonb, record_visibility = $6,
              updated_by = $7, updated_at = now()
        WHERE id = $1
        RETURNING id::text AS id, name, description, base_role, permissions, record_visibility, archived_at`,
      [current.id, v.name, v.description, v.base_role, JSON.stringify(v.permissions), v.record_visibility, actorId(req)],
    );
    const role = rowToRole(r.rows[0]);
    afterRoleChange();
    // People on the role pick the change up on their next request (the user cache holds only the role id).
    const people = await pool.query(`SELECT id::text AS id FROM users WHERE custom_role_id = $1`, [role.id]);
    for (const p of people.rows) clearStaffUserCache(String(p.id));
    await auditFor(req, "custom_role.updated", {
      name: role.name, base_role: role.base_role, ...changed(current, role), people: people.rows.length,
      ...(v.dropped.length ? { dropped_beyond_base: v.dropped } : {}),
    }, { type: "custom_role", id: role.id });
    res.json({ ok: true, role: { ...role, users: people.rows.length }, dropped: v.dropped });
  } catch (err) {
    if ((err as any)?.code === "23505") return res.status(409).json({ ok: false, error: "duplicate_name", message: "A role with that name already exists." });
    throw err;
  }
}));

router.post("/:id/archive", fullAdminOnly, safeHandler(async (req: any, res: any) => {
  const role = await roleOr404(req, res);
  if (!role) return;
  const people = await pool.query(`SELECT count(*)::int AS n FROM users WHERE custom_role_id = $1 AND deleted_at IS NULL`, [role.id]);
  const n = Number(people.rows[0]?.n ?? 0);
  if (n > 0) {
    return res.status(409).json({ ok: false, error: "role_in_use", message: `${n} ${n === 1 ? "person is" : "people are"} on this role. Move them to another role first.` });
  }
  await pool.query(`UPDATE custom_roles SET archived_at = COALESCE(archived_at, now()), updated_by = $2, updated_at = now() WHERE id = $1`, [role.id, actorId(req)]);
  afterRoleChange();
  await auditFor(req, "custom_role.archived", { name: role.name }, { type: "custom_role", id: role.id });
  res.json({ ok: true });
}));

router.post("/:id/unarchive", fullAdminOnly, safeHandler(async (req: any, res: any) => {
  const role = await roleOr404(req, res);
  if (!role) return;
  try {
    await pool.query(`UPDATE custom_roles SET archived_at = NULL, updated_by = $2, updated_at = now() WHERE id = $1`, [role.id, actorId(req)]);
  } catch (err) {
    if ((err as any)?.code === "23505") return res.status(409).json({ ok: false, error: "duplicate_name", message: "An active role already has that name." });
    throw err;
  }
  afterRoleChange();
  await auditFor(req, "custom_role.unarchived", { name: role.name }, { type: "custom_role", id: role.id });
  res.json({ ok: true });
}));

export default router;
