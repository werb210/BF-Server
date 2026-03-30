"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const auth_1 = require("../middleware/auth");
const safeHandler_1 = require("../middleware/safeHandler");
const roles_1 = require("../auth/roles");
const errors_1 = require("../middleware/errors");
const calls_service_1 = require("../modules/calls/calls.service");
const toStringSafe_1 = require("../utils/toStringSafe");
const router = (0, express_1.Router)();
const callStartSchema = zod_1.z.object({
    phoneNumber: zod_1.z.string().min(1),
    direction: zod_1.z.enum(["outbound", "inbound"]),
    status: zod_1.z
        .enum([
        "initiated",
        "ringing",
        "in_progress",
        "connected",
        "ended",
        "failed",
        "no_answer",
        "busy",
        "completed",
        "canceled",
        "cancelled",
    ])
        .optional(),
    crmContactId: zod_1.z.string().uuid().optional(),
    applicationId: zod_1.z.string().uuid().optional(),
});
const callStatusSchema = zod_1.z.object({
    status: zod_1.z.enum([
        "initiated",
        "ringing",
        "in_progress",
        "connected",
        "ended",
        "failed",
        "no_answer",
        "busy",
        "completed",
        "canceled",
        "cancelled",
    ]),
    durationSeconds: zod_1.z.number().int().nonnegative().optional().nullable(),
});
const callEndSchema = zod_1.z.object({
    durationSeconds: zod_1.z.number().int().nonnegative().optional().nullable(),
});
const uuidSchema = zod_1.z.string().uuid();
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
router.post("/log", (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    const parsed = zod_1.z
        .object({
        staff_id: zod_1.z.string().uuid(),
        client_id: zod_1.z.string().uuid(),
        phone_number: zod_1.z.string().min(1),
        call_duration: zod_1.z.number().int().nonnegative().default(0),
        direction: zod_1.z.enum(["outbound", "inbound"]),
    })
        .safeParse(req.body ?? {});
    if (!parsed.success) {
        throw new errors_1.AppError("validation_error", "Invalid call log payload.", 400);
    }
    const record = await (0, calls_service_1.startCall)({
        phoneNumber: parsed.data.phone_number.trim(),
        direction: parsed.data.direction,
        staffUserId: parsed.data.staff_id,
        status: "completed",
        crmContactId: parsed.data.client_id,
        ...buildRequestMetadata(req),
    });
    const updated = await (0, calls_service_1.updateCallStatus)({
        id: record.id,
        status: "completed",
        durationSeconds: parsed.data.call_duration,
        actorUserId: parsed.data.staff_id,
        ...buildRequestMetadata(req),
    });
    res.status(201).json({ ok: true, call: updated ?? record });
}));
router.post("/start", auth_1.requireAuth, (0, auth_1.requireAuthorization)({ roles: [roles_1.ROLES.ADMIN, roles_1.ROLES.STAFF] }), (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    const parsed = callStartSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
        throw new errors_1.AppError("validation_error", "Invalid call payload.", 400);
    }
    const startPayload = {
        phoneNumber: parsed.data.phoneNumber.trim(),
        direction: parsed.data.direction,
        staffUserId: req.user?.userId ?? null,
        ...(parsed.data.status ? { status: parsed.data.status } : {}),
        ...(parsed.data.crmContactId ? { crmContactId: parsed.data.crmContactId } : {}),
        ...(parsed.data.applicationId ? { applicationId: parsed.data.applicationId } : {}),
        ...buildRequestMetadata(req),
    };
    const record = await (0, calls_service_1.startCall)(startPayload);
    res.status(201).json({ ok: true, call: record });
}));
router.post("/:id/status", auth_1.requireAuth, (0, auth_1.requireAuthorization)({ roles: [roles_1.ROLES.ADMIN, roles_1.ROLES.STAFF] }), (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    const id = (0, toStringSafe_1.toStringSafe)(req.params.id);
    if (!id || !uuidSchema.safeParse(id).success) {
        throw new errors_1.AppError("validation_error", "Invalid call id.", 400);
    }
    const parsed = callStatusSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
        throw new errors_1.AppError("validation_error", "Invalid call status payload.", 400);
    }
    const updatePayload = {
        id,
        status: parsed.data.status,
        actorUserId: req.user?.userId ?? null,
        ...(parsed.data.durationSeconds !== undefined
            ? { durationSeconds: parsed.data.durationSeconds }
            : {}),
        ...buildRequestMetadata(req),
    };
    const updated = await (0, calls_service_1.updateCallStatus)(updatePayload);
    res.status(200).json({ ok: true, call: updated });
}));
router.post("/:id/end", auth_1.requireAuth, (0, auth_1.requireAuthorization)({ roles: [roles_1.ROLES.ADMIN, roles_1.ROLES.STAFF] }), (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    const id = (0, toStringSafe_1.toStringSafe)(req.params.id);
    if (!id || !uuidSchema.safeParse(id).success) {
        throw new errors_1.AppError("validation_error", "Invalid call id.", 400);
    }
    const parsed = callEndSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
        throw new errors_1.AppError("validation_error", "Invalid call end payload.", 400);
    }
    const endPayload = {
        id,
        staffUserId: req.user?.userId ?? null,
        ...(parsed.data.durationSeconds !== undefined
            ? { durationSeconds: parsed.data.durationSeconds }
            : {}),
        ...buildRequestMetadata(req),
    };
    const updated = await (0, calls_service_1.endCall)(endPayload);
    res.status(200).json({ ok: true, call: updated });
}));
router.get("/", auth_1.requireAuth, (0, auth_1.requireAuthorization)({ roles: [roles_1.ROLES.ADMIN, roles_1.ROLES.STAFF] }), (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    const contactId = typeof (0, toStringSafe_1.toStringSafe)(req.query.contactId) === "string" ? (0, toStringSafe_1.toStringSafe)(req.query.contactId) : null;
    const applicationId = typeof (0, toStringSafe_1.toStringSafe)(req.query.applicationId) === "string" ? (0, toStringSafe_1.toStringSafe)(req.query.applicationId) : null;
    if (contactId && !uuidSchema.safeParse(contactId).success) {
        throw new errors_1.AppError("validation_error", "Invalid contactId.", 400);
    }
    if (applicationId && !uuidSchema.safeParse(applicationId).success) {
        throw new errors_1.AppError("validation_error", "Invalid applicationId.", 400);
    }
    const calls = await (0, calls_service_1.listCalls)({ contactId, applicationId });
    res.status(200).json({ ok: true, calls });
}));
exports.default = router;
