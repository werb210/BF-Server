import { Request, Response } from "express";
import { db } from "../db.js";
import { z } from "zod";
import { AppError } from "../middleware/errors.js";
import { normalizeRole } from "../auth/roles.js";
import { createUserAccount } from "../modules/auth/auth.service.js";
import { setUserStatus } from "../modules/users/users.service.js";
import { recordAuditEvent } from "../modules/audit/audit.service.js";
import { logger } from "../server/utils/logger.js";

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
  role: z.enum(["Admin", "Staff", "Lender", "Referrer"]).optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  first_name: z.string().min(1).optional(),
  last_name: z.string().min(1).optional(),
  phone: z.string().optional(),
  silo: z.enum(["BF", "BI", "SLF"]).optional(),
  silos: z.array(z.enum(["BF", "BI", "SLF"])).optional(),
});

const createUserSchema = z.object({
  email: z.string().email().optional(),
  phone: z.string().min(1).optional(),
  role: z.string().min(1),
  lenderId: z.string().uuid().optional(),
  silo: z.enum(["BF", "BI", "SLF"]).optional(),
  silos: z.array(z.enum(["BF", "BI", "SLF"])).optional(),
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
  const { role, status } = req.query;

  const filters: string[] = [];
  const values: any[] = [];
  let idx = 1;

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
      last_login_at
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
    if (input.status) normalized.status = input.status;
    if (input.silo) normalized.silo = input.silo;
    if (Array.isArray((input as any).silos)) {
      normalized.silos = (input as any).silos.length > 0
        ? (input as any).silos
        : (input.silo ? [input.silo] : undefined);
    }
    if (input.phone) normalized.phone = input.phone;
    if (input.first_name) normalized.first_name = input.first_name;
    if (input.last_name) normalized.last_name = input.last_name;
    if ((input as any).firstName) normalized.first_name = (input as any).firstName;
    if ((input as any).lastName) normalized.last_name = (input as any).lastName;

    const fields: string[] = [];
    const values: any[] = [];
    let idx = 1;
    for (const [k, v] of Object.entries(normalized)) {
      fields.push(`${k} = $${idx++}`);
      values.push(v);
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
    }).catch(() => undefined);

    res["json"](normalizeUserRecord(updated));
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
    const normalizedRole = normalizeRole(parsed.role);
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
