import { Request, Response } from "express";
import { db } from "../db.js";
import { z } from "zod";
import { AppError } from "../middleware/errors.js";
import { normalizeRole } from "../auth/roles.js";
import { createUserAccount } from "../modules/auth/auth.service.js";
import { setUserStatus } from "../modules/users/users.service.js";
import { clearStaffUserCache } from "../auth/staffUserState.js"; // BF_SERVER_v789_STAFF_USER_STATE
import { recordAuditEvent } from "../modules/audit/audit.service.js";
import { logger } from "../server/utils/logger.js";

import { clearVisibilityCache } from "../visibility/scope.js"; // BF_SERVER_v870_CRM_DATA_MODEL
/**
 * Schemas
 */
const updateMeSchema = z.object({
  email: z.string().email().optional(),
  first_name: z.string().min(1).optional(),
  last_name: z.string().min(1).optional(),
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  phone: z.string().optional(),
  profileImage: z.string().optional(),
});

const adminUpdateSchema = z.object({
  role: z.enum(["Admin", "Marketing", "Staff", "Lender", "Referrer"]).optional(),
  // BF_SERVER_v870_CRM_DATA_MODEL - a custom role (uuid) or null to put the person back on their built-in role.
  custom_role_id: z.string().uuid().nullable().optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  first_name: z.string().min(1).optional(),
  last_name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  silo: z.enum(["BF", "BI", "SLF", "KS"]).optional(), // BF_SERVER_v850_KS_CRM
  silos: z.array(z.enum(["BF", "BI", "SLF", "KS"])).optional(),
});

const createUserSchema = z.object({
  email: z.string().email().optional(),
  phone: z.string().min(1).optional(),
  role: z.string().min(1).optional(), // BF_SERVER_v870_CRM_DATA_MODEL - optional when custom_role_id names the role
  custom_role_id: z.string().uuid().optional(), // BF_SERVER_v870_CRM_DATA_MODEL
  lenderId: z.guid().optional(),
  silo: z.enum(["BF", "BI", "SLF", "KS"]).optional(), // BF_SERVER_v850_KS_CRM
  silos: z.array(z.enum(["BF", "BI", "SLF", "KS"])).optional(),
});

type UserRecord = {
  id: string;
  phone: string | null;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  role: string | null;
  status: string | null;
  silo: string | null;
  silos?: string[] | null;
  profile_image_url: string | null;
  o365_access_token: string | null;
  created_at: string | null;
  updated_at: string | null;
  last_login_at: string | null;
  // BF_SERVER_BLOCK_v104_USER_MGMT_FIX_v1 — surface enable/disable state
  // to the BF-portal UserManagement UI so the status label and toggle
  // button reflect the actual DB state.
  disabled: boolean | null;
  active: boolean | null;
  is_active: boolean | null;
};

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeUserRecord(row: UserRecord): UserRecord {
  return {
    ...row,
    phone: normalizeOptionalString(row.phone),
    email: normalizeOptionalString(row.email),
    role: normalizeOptionalString(row.role),
  };
}

function handleUserError(
  res: Response,
  err: unknown,
  requestId: string
): void {
  if (err instanceof AppError) {
    res.status(err.status).json({
      code: err.code,
      message: err.message,
      requestId,
    });
    return;
  }
  if (err instanceof z.ZodError) {
    res.status(400).json({
      code: "validation_error",
      message: "Invalid request payload.",
      requestId,
    });
    return;
  }
  res.status(500).json({
    code: "internal_error",
    message: err instanceof Error ? err.message : "Unexpected error",
    requestId,
  });
}

export type User = UserRecord;

/**
 * GET /api/users/me
 */
export async function fetchMe(req: Request): Promise<User | null> {
  const userId = req.user!.userId;

  try {
    const { rows } = await db.query(
      `
      SELECT
        id,
        phone,
        email,
        COALESCE(first_name, split_part(email, '@', 1)) AS first_name,
        COALESCE(last_name, '') AS last_name,
        role,
        status,
        silo,
        silos,
        profile_image_url,
        o365_access_token,
        -- BF_SERVER_BLOCK_v323_USERS_ME_O365_FIELDS_v1
        -- BF-portal ProfileSettings.tsx reads me.o365_connected (Boolean
        -- of "do we have a token in the DB") and me.o365_email. Pre-fix
        -- this SELECT only returned o365_access_token. The portal never
        -- got the derived o365_connected field, so Boolean(undefined)
        -- coerced to false, and the UI showed "Connect" even when the
        -- staff member was fully connected. Every page navigation back
        -- to /settings re-loaded /api/users/me, saw undefined, and
        -- rendered the disconnected state. The sibling endpoint
        -- /api/settings/me (settings.ts:44) DOES derive this correctly;
        -- /api/users/me did not. Mirror that derivation here. The
        -- Microsoft email column in the DB is o365_user_email (per
        -- migrations 027 / 028 / 102 / 110) -- alias it to o365_email
        -- for the portal, which reads the unprefixed form.
        o365_user_email AS o365_email,
        (o365_access_token IS NOT NULL AND length(trim(o365_access_token)) > 0) AS o365_connected,
        created_at,
        updated_at,
        last_login_at
      FROM users
      WHERE id = $1
      `,
      [userId]
    );

    const user = rows[0] as UserRecord | undefined;
    if (!user) {
      return null;
    }

    return normalizeUserRecord(user);
  } catch (error) {
    logger.error("users_fetch_me_failed", {
      userId,
      error: error instanceof Error ? error.message : "unknown_error",
    });
    return null;
  }
}

/**
 * PATCH /api/users/me
 */
export async function updateMe(req: Request, res: Response) {
  const requestId = res.locals.requestId ?? "unknown";
  try {
    const userId = req.user!.userId;
    const input = updateMeSchema.parse(req.body);

    const normalized: Record<string, any> = {};
    if (input.first_name) normalized.first_name = input.first_name;
    if (input.last_name) normalized.last_name = input.last_name;
    if ((input as any).firstName) normalized.first_name = (input as any).firstName;
    if ((input as any).lastName) normalized.last_name = (input as any).lastName;
    if (input.email) normalized.email = input.email;
    if ((input as any).phone) normalized.phone = (input as any).phone;
    // BF_SERVER_AVATAR_MAP_v1 — persist the profile image (data URL) the portal sends.
    if (input.profileImage) normalized.profile_image_url = input.profileImage;

    if (Object.keys(normalized).length === 0) {
      res["json"]({ ok: true });
      return;
    }

    const fields: string[] = [];
    const values: any[] = [];
    let idx = 1;
    for (const [k, v] of Object.entries(normalized)) {
      fields.push(`${k} = $${idx++}`);
      values.push(v);
    }
    values.push(userId);
    const updated = await db.query<UserRecord>(
      `UPDATE users
       SET ${fields.join(", ")}, updated_at = now()
       WHERE id = $${idx}
       RETURNING
         id,
         phone,
         email,
         COALESCE(first_name, split_part(email, '@', 1)) AS first_name,
         COALESCE(last_name, '') AS last_name,
         role,
         status,
         silo,
         profile_image_url,
         o365_access_token,
         created_at,
         updated_at,
         last_login_at`,
      values
    );
    res["json"]({ ok: true, data: normalizeUserRecord(updated.rows[0] as UserRecord) });
  } catch (err) {
    handleUserError(res, err, requestId);
  }
}

/**
 * GET /api/users
 */
export async function listUsers(req: Request, res: Response) {
  // BF_SERVER_BLOCK_v156_SILO_LEAK_FIX_v1 — scope the user list to the
  // active silo. Match on primary silo OR multi-silo allowlist so a
  // user assigned to multiple silos shows in each. Admins can override
  // via X-Silo header per existing siloMiddleware rules.
  const { role, status } = req.query;
  const { getSilo } = await import("../middleware/silo.js");
  const silo = getSilo(res);

  const filters: string[] = [];
  const values: any[] = [];
  let idx = 1;

  filters.push(`(silo = $${idx} OR $${idx} = ANY(silos))`);
  values.push(silo);
  idx++;

  if (role) {
    filters.push(`role = $${idx++}`);
    values.push(role);
  }

  if (status) {
    filters.push(`status = $${idx++}`);
    values.push(status);
  }

  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

  const { rows } = await db.query<UserRecord>(
    `
    SELECT
      id,
      phone,
      email,
      COALESCE(first_name, split_part(email, '@', 1)) AS first_name,
      COALESCE(last_name, '') AS last_name,
      role,
      status,
      silo,
      silos,
      profile_image_url,
      o365_access_token,
      created_at,
      updated_at,
      last_login_at,
      -- BF_SERVER_BLOCK_v104_USER_MGMT_FIX_v1
      disabled,
      active,
      is_active,
      -- BF_SERVER_v870_CRM_DATA_MODEL
      custom_role_id::text AS custom_role_id,
      (SELECT r.name FROM custom_roles r WHERE r.id = users.custom_role_id) AS custom_role_name
    FROM users
    ${where}
    ORDER BY created_at DESC
    `,
    values
  );

  const users = Array.isArray(rows) ? rows.map(normalizeUserRecord) : [];
  res["json"]({ users });
}

/**
 * PATCH /api/users/:id
 */
export async function adminUpdateUser(req: Request, res: Response) {
  const requestId = res.locals.requestId ?? "unknown";
  try {
    const targetId = req.params.id;
    const input = adminUpdateSchema.parse(req.body);

    if (Object.keys(input).length === 0) {
      res["json"]({ ok: true });
      return;
    }

    const normalized: Record<string, any> = {};
    if (input.role) normalized.role = input.role;
    // BF_SERVER_v870_CRM_DATA_MODEL - a custom role sets the person's role to the custom role's base (so every existing role
    // check, and the Marketing seat count, sees the base role) and records the custom role on top. Naming only a
    // built-in role puts the person back on it.
    const roleChange = await resolveRoleAssignment(input.role, input.custom_role_id);
    if (roleChange.role) normalized.role = roleChange.role;
    if (input.status) normalized.status = input.status;
    if (input.silo) normalized.silo = input.silo;
    if (Array.isArray((input as any).silos)) {
      normalized.silos = (input as any).silos.length > 0
        ? (input as any).silos
        : (input.silo ? [input.silo] : undefined);
    }
    if (input.phone) normalized.phone = input.phone;
    if ((input as any).email) normalized.email = (input as any).email;
    if (input.first_name) normalized.first_name = input.first_name;
    if (input.last_name) normalized.last_name = input.last_name;
    if ((input as any).firstName) normalized.first_name = (input as any).firstName;
    if ((input as any).lastName) normalized.last_name = (input as any).lastName;
    if (roleChange.customRoleId !== undefined) normalized.custom_role_id = roleChange.customRoleId; // BF_SERVER_v870_CRM_DATA_MODEL
    const changesRole = Boolean(roleChange.role) || roleChange.customRoleId !== undefined; // BF_SERVER_v870_CRM_DATA_MODEL
    const before = changesRole ? await currentRoleOf(targetId) : null; // BF_SERVER_v870_CRM_DATA_MODEL - for the audit log

    const fields: string[] = [];
    const values: any[] = [];
    let idx = 1;
    for (const [k, v] of Object.entries(normalized)) {
      fields.push(`${k} = $${idx++}`);
      values.push(v);
    }
    // BF_SERVER_v789_STAFF_USER_STATE - a role change or a deactivation revokes the
    // user's existing tokens (token_version bump; for role, only when it really
    // changes), and status keeps active / is_active / disabled in step so sign-in
    // and the staff middleware agree with the admin screen.
    const keys = Object.keys(normalized);
    const revokeIf: string[] = [];
    if (keys.includes("role")) revokeIf.push(`role IS DISTINCT FROM $${keys.indexOf("role") + 1}`);
    if (keys.includes("status")) {
      const p = `$${keys.indexOf("status") + 1}`;
      fields.push(`active = (${p} = 'ACTIVE')`, `is_active = (${p} = 'ACTIVE')`, `disabled = (${p} <> 'ACTIVE')`);
      revokeIf.push(`${p} <> 'ACTIVE'`);
    }
    if (revokeIf.length > 0) {
      fields.push(`token_version = token_version + CASE WHEN ${revokeIf.join(" OR ")} THEN 1 ELSE 0 END`);
    }

    values.push(targetId);

    const result = await db.query<UserRecord>(
      `
      UPDATE users
      SET ${fields.join(", ")}, updated_at = now()
      WHERE id = $${idx}
      RETURNING
        id,
        phone,
        email,
        COALESCE(first_name, split_part(email, '@', 1)) AS first_name,
        COALESCE(last_name, '') AS last_name,
        role,
        status,
        silo,
        silos,
        profile_image_url,
        o365_access_token,
        created_at,
        updated_at,
        last_login_at
      `,
      values
    );

    if (result.rowCount === 0) {
      throw new AppError("not_found", "User not found.", 404);
    }

    const updated = result.rows[0] as UserRecord;
    clearStaffUserCache(targetId); // BF_SERVER_v789_STAFF_USER_STATE

    await recordAuditEvent({
      actorUserId: req.user?.userId ?? null,
      targetUserId: targetId,
      targetType: "user",
      targetId,
      action: "user_admin_update",
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
      success: true,
      metadata: normalized,
    }).catch((err: unknown) => logger.warn("user_admin_update_audit_failed", { message: err instanceof Error ? err.message : String(err) }));

    // BF_SERVER_v870_CRM_DATA_MODEL - role changes get their own audit row with the before and after.
    if (changesRole) {
      await auditRoleChange(req, targetId, before, { role: roleChange.role ?? before?.role ?? null, custom_role_id: roleChange.customRoleId ?? null, custom_role_name: roleChange.customRoleName ?? null });
      clearVisibilityCache();
    }

    res["json"]({ ...normalizeUserRecord(updated), custom_role_id: changesRole ? roleChange.customRoleId ?? null : (updated as any).custom_role_id ?? null });
  } catch (err) {
    handleUserError(res, err, requestId);
  }
}

/**
 * POST /api/users
 */
export async function createUser(req: Request, res: Response) {
  const requestId = res.locals.requestId ?? "unknown";
  try {
    const parsed = createUserSchema.parse(req.body ?? {});
    // BF_SERVER_v870_CRM_DATA_MODEL - a new person can start on a custom role: they are created with its base role.
    const assigned = parsed.custom_role_id ? await resolveRoleAssignment(undefined, parsed.custom_role_id) : null;
    if (assigned?.role) parsed.role = assigned.role;
    const normalizedRole = normalizeRole(String(parsed.role ?? ""));
    if (!normalizedRole) {
      throw new AppError("validation_error", "Role is invalid.", 400);
    }

    const requestedSilo = parsed.silo ?? "BF";
    const requestedSilos = Array.isArray(parsed.silos) && parsed.silos.length > 0
      ? parsed.silos
      : [requestedSilo];

    const userAgent = req.get("user-agent");
    const createPayload = {
      email: parsed.email ?? null,
      phoneNumber: parsed.phone ?? null,
      role: normalizedRole,
      lenderId: parsed.lenderId ?? null,
      actorUserId: req.user?.userId ?? null,
      ...(req.ip ? { ip: req.ip } : {}),
      ...(userAgent ? { userAgent } : {}),
    };
    const user = await createUserAccount(createPayload);

    await db.query(`UPDATE users SET silo = $1, silos = $2 WHERE id = $3`, [requestedSilo, requestedSilos, (user as any).id]);
    if (assigned?.customRoleId) {
      // BF_SERVER_v870_CRM_DATA_MODEL
      await db.query(`UPDATE users SET custom_role_id = $1 WHERE id = $2`, [assigned.customRoleId, (user as any).id]);
      await auditRoleChange(req, String((user as any).id), null, { role: normalizedRole, custom_role_id: assigned.customRoleId, custom_role_name: assigned.customRoleName ?? null });
    }

    res.status(201).json({
      ok: true,
      user,
    });
  } catch (err) {
    handleUserError(res, err, requestId);
  }
}

/**
 * DELETE /api/users/:id (soft delete)
 */
export async function deleteUser(req: Request, res: Response) {
  const requestId = res.locals.requestId ?? "unknown";
  try {
    const targetId = req.params.id;
    if (!targetId || typeof targetId !== "string") {
      throw new AppError("validation_error", "id is required.", 400);
    }
    const actorId = req.user?.userId;
    if (!actorId) {
      throw new AppError("missing_token", "Authorization token is required.", 401);
    }

    const userAgent = req.get("user-agent");
    const statusPayload = {
      userId: targetId,
      active: false,
      actorId,
      ...(req.ip ? { ip: req.ip } : {}),
      ...(userAgent ? { userAgent } : {}),
    };
    await setUserStatus(statusPayload);

    res.status(200).json({ ok: true });
  } catch (err) {
    handleUserError(res, err, requestId);
  }
}

// BF_SERVER_v870_CRM_DATA_MODEL ------------------------------------------------------------------------------------------

type RoleAssignment = { role?: string; customRoleId?: string | null; customRoleName?: string | null };

/**
 * What a role field in a user update means. custom_role_id (uuid): that role's base role plus the custom role (the
 * role must not be archived). custom_role_id null, or a built-in role alone:
 * the built-in role, no custom role. Nothing: no change.
 */
export async function resolveRoleAssignment(role: string | undefined, customRoleId: string | null | undefined): Promise<RoleAssignment> {
  if (typeof customRoleId === "string") {
    const { rows } = await db.query<{ id: string; name: string; base_role: string; archived_at: string | null }>(
      `SELECT id::text AS id, name, base_role, archived_at FROM custom_roles WHERE id = $1`, [customRoleId],
    );
    const r = rows[0];
    if (!r) throw new AppError("role_not_found", "That role does not exist.", 404);
    if (r.archived_at) throw new AppError("role_archived", "That role is archived. Pick another role.", 409);
    return { role: r.base_role, customRoleId: r.id, customRoleName: r.name };
  }
  if (role) return { role, customRoleId: null };
  if (customRoleId === null) return { customRoleId: null }; // back to their base role, which stays as it is
  return {};
}

async function currentRoleOf(userId: string): Promise<{ role: string | null; custom_role_id: string | null; custom_role_name: string | null } | null> {
  try {
    const { rows } = await db.query<{ role: string | null; custom_role_id: string | null; custom_role_name: string | null }>(
      `SELECT u.role, u.custom_role_id::text AS custom_role_id, r.name AS custom_role_name
         FROM users u LEFT JOIN custom_roles r ON r.id = u.custom_role_id WHERE u.id = $1`, [userId],
    );
    return rows[0] ?? null;
  } catch (err) {
    logger.warn("user_role_before_lookup_failed", { userId, message: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

async function auditRoleChange(
  req: Request, targetId: string, before: Record<string, unknown> | null, after: Record<string, unknown>,
): Promise<void> {
  await recordAuditEvent({
    actorUserId: req.user?.userId ?? null,
    targetUserId: targetId,
    targetType: "user",
    targetId,
    action: "user_role_changed",
    eventType: "custom_role",
    eventAction: "assigned",
    ip: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
    success: true,
    metadata: { before, after },
  }).catch((err: unknown) => logger.warn("user_role_audit_failed", { targetId, message: err instanceof Error ? err.message : String(err) }));
}
