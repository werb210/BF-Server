"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const errors_1 = require("../../middleware/errors");
const auth_service_1 = require("../auth/auth.service");
const users_service_1 = require("./users.service");
const roles_1 = require("../../auth/roles");
const router = (0, express_1.Router)();
function buildRequestMetadata(req) {
    const metadata = {};
    if (req.ip) {
        metadata.ip = req.ip;
    }
    const userAgent = req.get("user-agent");
    if (userAgent) {
        metadata.userAgent = userAgent;
    }
    return metadata;
}
router.post("/", async (req, res, next) => {
    try {
        const { email, phoneNumber, role, lenderId } = req.body;
        const normalizedRole = typeof role === "string" ? (0, roles_1.normalizeRole)(role) : null;
        const normalizedEmail = typeof email === "string" && email.trim().length > 0
            ? email.trim()
            : null;
        if (!normalizedEmail || role === undefined || role === null) {
            throw new errors_1.AppError("missing_fields", "email and role are required.", 400);
        }
        if (!normalizedRole) {
            throw new errors_1.AppError("invalid_role", "Role is invalid.", 400);
        }
        const user = await (0, auth_service_1.createUserAccount)({
            email: normalizedEmail,
            phoneNumber,
            role: normalizedRole,
            lenderId,
            actorUserId: req.user?.userId ?? null,
            ...buildRequestMetadata(req),
        });
        res.status(201).json({ user });
    }
    catch (err) {
        next(err);
    }
});
router.post("/:id/role", async (req, res, next) => {
    try {
        const actorId = req.user?.userId;
        if (!actorId) {
            throw new errors_1.AppError("missing_token", "Authorization token is required.", 401);
        }
        const { role } = req.body ?? {};
        const normalizedRole = typeof role === "string" ? (0, roles_1.normalizeRole)(role) : null;
        if (!normalizedRole) {
            throw new errors_1.AppError("invalid_role", "Role is invalid.", 400);
        }
        await (0, users_service_1.changeUserRole)({
            userId: req.params.id,
            role: normalizedRole,
            actorId,
            ...buildRequestMetadata(req),
        });
        res["json"]({ ok: true });
    }
    catch (err) {
        next(err);
    }
});
router.post("/:id/disable", async (req, res, next) => {
    try {
        const actorId = req.user?.userId;
        if (!actorId) {
            throw new errors_1.AppError("missing_token", "Authorization token is required.", 401);
        }
        const targetId = req.params.id;
        if (!targetId) {
            throw new errors_1.AppError("validation_error", "id is required.", 400);
        }
        await (0, users_service_1.setUserStatus)({
            userId: targetId,
            active: false,
            actorId,
            ...buildRequestMetadata(req),
        });
        res["json"]({ ok: true });
    }
    catch (err) {
        next(err);
    }
});
router.post("/:id/enable", async (req, res, next) => {
    try {
        const actorId = req.user?.userId;
        if (!actorId) {
            throw new errors_1.AppError("missing_token", "Authorization token is required.", 401);
        }
        const targetId = req.params.id;
        if (!targetId) {
            throw new errors_1.AppError("validation_error", "id is required.", 400);
        }
        await (0, users_service_1.setUserStatus)({
            userId: targetId,
            active: true,
            actorId,
            ...buildRequestMetadata(req),
        });
        res["json"]({ ok: true });
    }
    catch (err) {
        next(err);
    }
});
exports.default = router;
