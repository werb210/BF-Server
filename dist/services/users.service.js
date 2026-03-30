"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchMe = fetchMe;
exports.updateMe = updateMe;
exports.listUsers = listUsers;
exports.adminUpdateUser = adminUpdateUser;
exports.createUser = createUser;
exports.deleteUser = deleteUser;
const db_1 = require("../db");
const zod_1 = require("zod");
const errors_1 = require("../middleware/errors");
const roles_1 = require("../auth/roles");
const auth_service_1 = require("../modules/auth/auth.service");
const users_service_1 = require("../modules/users/users.service");
/**
 * Schemas
 */
const updateMeSchema = zod_1.z.object({
    email: zod_1.z.string().email().optional(),
    first_name: zod_1.z.string().min(1).optional(),
    last_name: zod_1.z.string().min(1).optional(),
});
const adminUpdateSchema = zod_1.z.object({
    role: zod_1.z.enum(["Admin", "Staff", "Lender", "Referrer"]).optional(),
    status: zod_1.z.enum(["ACTIVE", "INACTIVE"]).optional(),
});
const createUserSchema = zod_1.z.object({
    email: zod_1.z.string().email().optional(),
    phone: zod_1.z.string().min(1).optional(),
    role: zod_1.z.string().min(1),
    lenderId: zod_1.z.string().uuid().optional(),
});
function normalizeOptionalString(value) {
    if (typeof value !== "string") {
        return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}
function normalizeUserRecord(row) {
    return {
        ...row,
        phone: normalizeOptionalString(row.phone),
        email: normalizeOptionalString(row.email),
        role: normalizeOptionalString(row.role),
    };
}
function handleUserError(res, err, requestId) {
    if (err instanceof errors_1.AppError) {
        res.status(err.status).json({
            code: err.code,
            message: err.message,
            requestId,
        });
        return;
    }
    if (err instanceof zod_1.z.ZodError) {
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
async function fetchMe(req, res) {
    const userId = req.user.userId;
    const { rows } = await db_1.db.query(`
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
    `, [userId]);
    const user = rows[0];
    if (!user) {
        return res.status(404).json({ ok: false, error: "user_not_found" });
    }
    res["json"]({ ok: true, user: normalizeUserRecord(user) });
}
/**
 * PATCH /api/users/me
 */
async function updateMe(req, res) {
    const requestId = res.locals.requestId ?? "unknown";
    try {
        const userId = req.user.userId;
        const input = updateMeSchema.parse(req.body);
        if (Object.keys(input).length === 0) {
            res["json"]({ ok: true });
            return;
        }
        const fields = [];
        const values = [];
        let idx = 1;
        for (const [k, v] of Object.entries(input)) {
            fields.push(`${k} = $${idx++}`);
            values.push(v);
        }
        values.push(userId);
        await db_1.db.query(`
      UPDATE users
      SET ${fields.join(", ")}, updated_at = now()
      WHERE id = $${idx}
      `, values);
        res["json"]({ ok: true });
    }
    catch (err) {
        handleUserError(res, err, requestId);
    }
}
/**
 * GET /api/users
 */
async function listUsers(req, res) {
    const { role, status } = req.query;
    const filters = [];
    const values = [];
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
    const { rows } = await db_1.db.query(`
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
    `, values);
    const users = Array.isArray(rows) ? rows.map(normalizeUserRecord) : [];
    res["json"]({ ok: true, users });
}
/**
 * PATCH /api/users/:id
 */
async function adminUpdateUser(req, res) {
    const requestId = res.locals.requestId ?? "unknown";
    try {
        const targetId = req.params.id;
        const input = adminUpdateSchema.parse(req.body);
        if (Object.keys(input).length === 0) {
            res["json"]({ ok: true });
            return;
        }
        const fields = [];
        const values = [];
        let idx = 1;
        for (const [k, v] of Object.entries(input)) {
            fields.push(`${k} = $${idx++}`);
            values.push(v);
        }
        values.push(targetId);
        const result = await db_1.db.query(`
      UPDATE users
      SET ${fields.join(", ")}, updated_at = now()
      WHERE id = $${idx}
      `, values);
        if (result.rowCount === 0) {
            throw new errors_1.AppError("not_found", "User not found.", 404);
        }
        res["json"]({ ok: true });
    }
    catch (err) {
        handleUserError(res, err, requestId);
    }
}
/**
 * POST /api/users
 */
async function createUser(req, res) {
    const requestId = res.locals.requestId ?? "unknown";
    try {
        const parsed = createUserSchema.parse(req.body ?? {});
        const normalizedRole = (0, roles_1.normalizeRole)(parsed.role);
        if (!normalizedRole) {
            throw new errors_1.AppError("validation_error", "Role is invalid.", 400);
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
        const user = await (0, auth_service_1.createUserAccount)(createPayload);
        res.status(201).json({
            ok: true,
            user,
        });
    }
    catch (err) {
        handleUserError(res, err, requestId);
    }
}
/**
 * DELETE /api/users/:id (soft delete)
 */
async function deleteUser(req, res) {
    const requestId = res.locals.requestId ?? "unknown";
    try {
        const targetId = req.params.id;
        if (!targetId || typeof targetId !== "string") {
            throw new errors_1.AppError("validation_error", "id is required.", 400);
        }
        const actorId = req.user?.userId;
        if (!actorId) {
            throw new errors_1.AppError("missing_token", "Authorization token is required.", 401);
        }
        const userAgent = req.get("user-agent");
        const statusPayload = {
            userId: targetId,
            active: false,
            actorId,
            ...(req.ip ? { ip: req.ip } : {}),
            ...(userAgent ? { userAgent } : {}),
        };
        await (0, users_service_1.setUserStatus)(statusPayload);
        res.status(200).json({ ok: true });
    }
    catch (err) {
        handleUserError(res, err, requestId);
    }
}
