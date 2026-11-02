// BF_SERVER_v870_CRM_DATA_MODEL - the custom_roles table (ported from KS-server #49): read (cached), list, create, update, archive, assign.
import type { Q } from "../settingsPack/common.js";
import { isVisibility, type Visibility } from "../visibility/scope.js";
import {
  BASE_ROLES, beyondBase, clampToBase, isBaseRole, normalizePermissions, templateFor, type BaseRole, type PermissionSet,
} from "./permissions.js";

export const ROLE_LIMITS = { roles: 100, nameChars: 60, descriptionChars: 300 };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CustomRole = {
  id: string;
  name: string;
  description: string | null;
  base_role: BaseRole;
  permissions: PermissionSet;
  record_visibility: Visibility;
  archived_at: string | null;
};

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

export function isMissingRelation(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "42P01" || code === "42703";
}

export function rowToRole(row: Record<string, any>): CustomRole {
  const base: BaseRole = isBaseRole(row.base_role) ? row.base_role : "Staff";
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    description: row.description ?? null,
    base_role: base,
    // Clamped on read too, so a hand-edited row can never widen its base.
    permissions: clampToBase(normalizePermissions(row.permissions), base),
    record_visibility: isVisibility(row.record_visibility) ? row.record_visibility : "all",
    archived_at: row.archived_at ? new Date(row.archived_at).toISOString() : null,
  };
}

const CACHE_MS = 15_000;
const cache = new Map<string, { at: number; role: CustomRole | null }>();
/** Called after any role change. Other instances catch up within 15 s. */
export function clearCustomRoleCache(): void {
  cache.clear();
}

/**
 * The custom role by id (archived roles included: a person still assigned to one keeps its restrictions until an
 * Admin moves them). null when the id names no role. Throws on a database error: the caller fails closed.
 */
export async function loadCustomRole(db: Q, id: string, nowMs = Date.now()): Promise<CustomRole | null> {
  if (!isUuid(id)) return null;
  const hit = cache.get(id);
  if (hit && nowMs - hit.at < CACHE_MS) return hit.role;
  const r = await db.query(
    `SELECT id::text AS id, name, description, base_role, permissions, record_visibility, archived_at FROM custom_roles WHERE id = $1`,
    [id],
  );
  const role = r.rows[0] ? rowToRole(r.rows[0]) : null;
  cache.set(id, { at: nowMs, role });
  return role;
}

export type RoleInput = { name: string; description: string | null; base_role: BaseRole; permissions: PermissionSet; record_visibility: Visibility; dropped: string[] };

/** Validates a create / update body. partial: only the fields present are checked (base_role comes from `current`). */
export function cleanRoleInput(body: any, current: CustomRole | null): { ok: true; value: RoleInput } | { ok: false; error: string } {
  const name = body?.name !== undefined ? String(body.name ?? "").trim() : current?.name ?? "";
  if (!name) return { ok: false, error: "Give the role a name." };
  if (name.length > ROLE_LIMITS.nameChars) return { ok: false, error: `The name can be at most ${ROLE_LIMITS.nameChars} characters.` };
  if (BASE_ROLES.some((b) => b.toLowerCase() === name.toLowerCase())) {
    return { ok: false, error: `"${name}" is a built-in role. Pick another name.` };
  }
  let description: string | null = current?.description ?? null;
  if (body?.description !== undefined) {
    const d = String(body.description ?? "").trim();
    if (d.length > ROLE_LIMITS.descriptionChars) return { ok: false, error: `The description can be at most ${ROLE_LIMITS.descriptionChars} characters.` };
    description = d || null;
  }
  const baseRaw = body?.base_role ?? current?.base_role ?? "Staff";
  if (!isBaseRole(baseRaw)) return { ok: false, error: "Start from Admin, Ops, Staff or Marketing." };
  const base: BaseRole = baseRaw;
  const requested = body?.permissions !== undefined ? normalizePermissions(body.permissions) : current?.permissions ?? templateFor(base);
  const dropped = beyondBase(requested, base);
  const permissions = clampToBase(requested, base);
  const visRaw = body?.record_visibility ?? current?.record_visibility ?? "all";
  if (!isVisibility(visRaw)) return { ok: false, error: "Record visibility must be all, team or own." };
  return { ok: true, value: { name, description, base_role: base, permissions, record_visibility: visRaw, dropped } };
}

export async function listCustomRoles(db: Q): Promise<Array<CustomRole & { users: number }>> {
  const r = await db.query(
    `SELECT r.id::text AS id, r.name, r.description, r.base_role, r.permissions, r.record_visibility, r.archived_at,
            (SELECT count(*)::int FROM users u WHERE u.custom_role_id = r.id AND u.deleted_at IS NULL) AS users
       FROM custom_roles r
      ORDER BY r.archived_at IS NOT NULL, lower(r.name)`,
  );
  return r.rows.map((row: any) => ({ ...rowToRole(row), users: Number(row.users ?? 0) }));
}
