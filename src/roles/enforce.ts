// BF_SERVER_v870_CRM_DATA_MODEL - the server-side check of a custom role's matrix, run by both staff auth middlewares
// (middleware/auth.ts and middleware/requireAuth.ts) right after the user is loaded, so it covers every staff route
// without touching each router.
//
//   - A person on a built-in role (users.custom_role_id NULL), a service principal or a client token: nothing is
//     checked and no query runs. Their access is exactly what it was before custom roles.
//   - A person on a custom role: the request's area and action (src/roles/permissions.ts requiredPermission) must
//     be in the role's matrix, else 403 { error: "permission_denied" } in plain words.
//   - Changing anyone's role, and creating or editing roles, needs a full Admin (the built-in Admin role). A custom
//     role built from Admin can manage users, but never hand out roles, so it cannot widen itself.
// Silo rules are unchanged: the matrix is checked on top of them, never instead.
import type { Request, Response } from "express";
import { pool } from "../db.js";
import { logError } from "../observability/logger.js";
import type { Q } from "../settingsPack/common.js";
import { loadCustomRole, type CustomRole } from "./customRoles.js";
import { allows, deniedMessage, requiredPermission, type RequiredPermission } from "./permissions.js";

/** The custom role id the auth middleware found on the users row, or null. */
export function customRoleIdOf(req: Request): string | null {
  const u = (req as any).user ?? {};
  const id = u.custom_role_id ?? u.customRoleId ?? null;
  return typeof id === "string" && id ? id : null;
}

/** A full Admin: the built-in Admin role with no custom role on top. */
export function isFullAdmin(req: Request): boolean {
  const u = (req as any).user ?? {};
  return String(u.role ?? "").toLowerCase() === "admin" && !customRoleIdOf(req);
}

/** The path under /api for a request (originalUrl without the query string). */
export function apiPath(req: Request): string {
  const url = String(req.originalUrl || req.url || "").split("?")[0] ?? "";
  return url.replace(/^\/api(?=\/|$)/, "") || "/";
}

const ROLE_FIELD = /^(role|custom_role_id|customRoleId|role_id|roleId)$/;

/** Does this request change someone's role (or the roles themselves)? Only full Admins may. */
export function changesRoles(method: string, path: string, body: unknown): boolean {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return false;
  if (/^\/roles(\/|$)/.test(path) && !/^\/roles\/me$/.test(path)) return true;
  if (/^\/users\/[^/]+\/role$/.test(path)) return true;
  const hasRoleField = Boolean(body && typeof body === "object" && Object.keys(body as object).some((k) => ROLE_FIELD.test(k)));
  if (!hasRoleField) return false;
  return /^\/(users|admin\/users)(\/[^/]+)?\/?$/.test(path) && !/^\/users\/me(\/|$)/.test(path);
}

export type EnforceResult =
  | { ok: true; role: CustomRole | null }
  | { ok: false; status: 403 | 503; body: Record<string, unknown> };

/** The decision for one request (pure apart from loading the role). */
export async function checkRolePermissions(
  req: Request,
  db: Q = pool as unknown as Q,
): Promise<EnforceResult> {
  const u = (req as any).user;
  if (!u || u.isServicePrincipal) return { ok: true, role: null };
  const roleId = customRoleIdOf(req);
  if (!roleId) return { ok: true, role: null };
  let role: CustomRole | null;
  try {
    role = await loadCustomRole(db, roleId);
  } catch (err) {
    // Fail closed: a restricted person must not get through because the roles table could not be read.
    logError("custom_role_lookup_failed", { userId: u.userId ?? null, roleId, message: err instanceof Error ? err.message : String(err) });
    return { ok: false, status: 503, body: { ok: false, error: "AUTH_UNAVAILABLE", message: "Sign-in is briefly unavailable. Try again in a moment." } };
  }
  // A role id that names no role (deleted by hand): treat the person as having no permissions in any area.
  const path = apiPath(req);
  if (changesRoles(req.method, path, req.body)) {
    return { ok: false, status: 403, body: { ok: false, error: "full_admin_required", message: "Only an Admin can change roles." } };
  }
  const need: RequiredPermission | null = requiredPermission(req.method, path);
  if (!need) return { ok: true, role };
  if (role && allows(role.permissions, need.area, need.action)) return { ok: true, role };
  return {
    ok: false,
    status: 403,
    body: { ok: false, error: "permission_denied", area: need.area, action: need.action, message: deniedMessage(need) },
  };
}

/** For the auth middlewares: true when the request may go on; otherwise the refusal has been sent. */
export async function enforceRolePermissions(req: Request, res: Response): Promise<boolean> {
  const r = await checkRolePermissions(req);
  if (r.ok) {
    if (r.role) (req as any).customRole = r.role;
    return true;
  }
  res.status(r.status).json(r.body);
  return false;
}
