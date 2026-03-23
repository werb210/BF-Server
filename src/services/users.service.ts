import { Request, Response } from "express";
import { db } from "../db";
import { z } from "zod";
import { AppError } from "../middleware/errors";
import { normalizeRole } from "../auth/roles";
import { createUserAccount } from "../modules/auth/auth.service";
import { setUserStatus } from "../modules/users/users.service";

/**
 * Schemas
 */
const updateMeSchema = z.object({
  email: z.string().email().optional(),
  first_name: z.string().min(1).optional(),
  last_name: z.string().min(1).optional(),
});

const adminUpdateSchema = z.object({
  role: z.enum(["Admin", "Staff", "Lender", "Referrer"]).optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
});

const createUserSchema = z.object({
  email: z.string().email().optional(),
  phone: z.string().min(1).optional(),
  role: z.string().min(1),
  lenderId: z.string().uuid().optional(),
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

/**
 * GET /api/users/me
 */
export async function fetchMe(req: Request, res: Response) {
  const userId = req.user!.userId;

  const { rows } = await db.query(
    `
    SELECT
      id,
      phone,
      email,
      first_name,
      last_name,
      role,
      status,
      silo,
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
    return res.status(404).json({ ok: false, error: "user_not_found" });
  }

  res.json({ ok: true, user: normalizeUserRecord(user) });
}

/**
 * PATCH /api/users/me
 */
export async function updateMe(req: Request, res: Response) {
  const requestId = res.locals.requestId ?? "unknown";
  try {
    const userId = req.user!.userId;
    const input = updateMeSchema.parse(req.body);

    if (Object.keys(input).length === 0) {
      res.json({ ok: true });
      return;
    }

    const fields = [];
    const values: any[] = [];
    let idx = 1;

    for (const [k, v] of Object.entries(input)) {
      fields.push(`${k} = $${idx++}`);
      values.push(v);
    }

    values.push(userId);

    await db.query(
      `
      UPDATE users
      SET ${fields.join(", ")}, updated_at = now()
      WHERE id = $${idx}
      `,
      values
    );

    res.json({ ok: true });
  } catch (err) {
    handleUserError(res, err, requestId);
  }
}

/**
 * GET /api/users
 */
export async function listUsers(req: Request, res: Response) {
  const { role, status } = req.query;

  const filters = [];
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
      first_name,
      last_name,
      role,
      status,
      silo,
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
  res.json({ ok: true, users });
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
      res.json({ ok: true });
      return;
    }

    const fields = [];
    const values: any[] = [];
    let idx = 1;

    for (const [k, v] of Object.entries(input)) {
      fields.push(`${k} = $${idx++}`);
      values.push(v);
    }

    values.push(targetId);

    const result = await db.query(
      `
      UPDATE users
      SET ${fields.join(", ")}, updated_at = now()
      WHERE id = $${idx}
      `,
      values
    );

    if (result.rowCount === 0) {
      throw new AppError("not_found", "User not found.", 404);
    }

    res.json({ ok: true });
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
