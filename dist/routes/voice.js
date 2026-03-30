"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const auth_1 = require("../middleware/auth");
const safeHandler_1 = require("../middleware/safeHandler");
const roles_1 = require("../auth/roles");
const errors_1 = require("../middleware/errors");
const rateLimit_1 = require("../middleware/rateLimit");
const capabilities_1 = require("../auth/capabilities");
const voice_service_1 = require("../modules/voice/voice.service");
const calls_service_1 = require("../modules/calls/calls.service");
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
const voiceTokenSchema = zod_1.z.object({});
const callStartSchema = zod_1.z
    .object({
    fromStaffUserId: zod_1.z.string().uuid().optional(),
    toPhone: zod_1.z.string().min(1).optional(),
    phoneNumber: zod_1.z.string().min(1).optional(),
    contactId: zod_1.z.string().uuid().optional(),
    applicationId: zod_1.z.string().uuid().optional(),
    callSid: zod_1.z.string().min(1).optional(),
})
    .refine((data) => Boolean(data.toPhone ?? data.phoneNumber), {
    message: "toPhone is required.",
});
const callCreateSchema = zod_1.z
    .object({
    to: zod_1.z.string().min(1).optional(),
    toPhone: zod_1.z.string().min(1).optional(),
    contactId: zod_1.z.string().uuid().optional(),
    applicationId: zod_1.z.string().uuid().optional(),
})
    .refine((data) => Boolean(data.to ?? data.toPhone), {
    message: "to is required.",
});
const callEndSchema = zod_1.z.object({
    callSid: zod_1.z.string().min(1),
    status: zod_1.z.enum(["completed", "failed", "cancelled", "canceled"]).optional(),
    durationSeconds: zod_1.z.number().int().nonnegative().optional().nullable(),
});
const callControlSchema = zod_1.z.object({
    callSid: zod_1.z.string().min(1),
});
const callStatusSchema = zod_1.z
    .object({
    callSid: zod_1.z.string().min(1),
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
    callStatus: zod_1.z.string().min(1).optional(),
    durationSeconds: zod_1.z.number().int().nonnegative().optional().nullable(),
    callDuration: zod_1.z.string().min(1).optional(),
})
    .strict();
const callRecordingSchema = zod_1.z.object({
    callSid: zod_1.z.string().min(1),
    recordingSid: zod_1.z.string().min(1),
    recordingDurationSeconds: zod_1.z.number().int().nonnegative().optional().nullable(),
    recordingDuration: zod_1.z.string().min(1).optional(),
});
const uuidSchema = zod_1.z.string().uuid();
const contextSchema = zod_1.z
    .string()
    .min(1)
    .transform((value) => value.trim())
    .refine((value) => value.length > 0, "Invalid context")
    .optional();
function parseContext(context) {
    if (!context)
        return {};
    const trimmed = context.trim();
    const parts = trimmed.split(":");
    if (parts.length === 2) {
        const [kind, id] = parts;
        if (!id) {
            return {};
        }
        if (kind === "contact")
            return { contactId: id };
        if (kind === "application")
            return { applicationId: id };
    }
    return { contactId: trimmed };
}
function resolveStaffUserId(params) {
    const requested = params.fromStaffUserId ?? null;
    if (!requested) {
        return params.requesterId;
    }
    if (!params.requesterId) {
        return requested;
    }
    if (requested === params.requesterId) {
        return requested;
    }
    if (params.requesterRole === roles_1.ROLES.ADMIN) {
        return requested;
    }
    throw new errors_1.AppError("forbidden", "You do not have access to this staff user.", 403);
}
function assertVoiceEnabled() {
    const availability = (0, voice_service_1.fetchVoiceAvailability)();
    if (!availability.enabled) {
        const error = new errors_1.AppError("voice_disabled", "Voice service is not configured.", 503);
        error.details = { missing: availability.missing };
        throw error;
    }
}
router.post("/token", auth_1.requireAuth, (0, auth_1.requireAuthorization)({
    roles: [roles_1.ROLES.ADMIN, roles_1.ROLES.STAFF],
    capabilities: [capabilities_1.CAPABILITIES.COMMUNICATIONS_CALL],
}), (0, rateLimit_1.voiceRateLimit)(), (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    assertVoiceEnabled();
    const parsed = voiceTokenSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
        throw new errors_1.AppError("validation_error", "Invalid token request.", 400);
    }
    const userId = req.user?.userId;
    if (!userId) {
        throw new errors_1.AppError("invalid_token", "Invalid or expired token.", 401);
    }
    const token = (0, voice_service_1.issueVoiceToken)({ userId });
    res.status(200).json({ ok: true, token });
}));
router.post("/call", auth_1.requireAuth, (0, auth_1.requireAuthorization)({
    roles: [roles_1.ROLES.ADMIN, roles_1.ROLES.STAFF],
    capabilities: [capabilities_1.CAPABILITIES.COMMUNICATIONS_CALL],
}), (0, rateLimit_1.voiceRateLimit)(), (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    assertVoiceEnabled();
    const parsed = callCreateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
        throw new errors_1.AppError("validation_error", "Invalid call payload.", 400);
    }
    const staffUserId = resolveStaffUserId({
        requesterId: req.user?.userId ?? null,
        requesterRole: req.user?.role ?? null,
        fromStaffUserId: null,
    });
    const startPayload = {
        phoneNumber: parsed.data.toPhone ?? parsed.data.to ?? "",
        staffUserId,
        crmContactId: parsed.data.contactId ?? null,
        applicationId: parsed.data.applicationId ?? null,
        ...buildRequestMetadata(req),
    };
    const result = await (0, voice_service_1.startVoiceCall)(startPayload);
    res.status(201).json({
        ok: true,
        callSid: result.callSid,
        call: result.call,
    });
}));
router.post("/call/start", auth_1.requireAuth, (0, auth_1.requireAuthorization)({
    roles: [roles_1.ROLES.ADMIN, roles_1.ROLES.STAFF],
    capabilities: [capabilities_1.CAPABILITIES.COMMUNICATIONS_CALL],
}), (0, rateLimit_1.voiceRateLimit)(), (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    assertVoiceEnabled();
    const parsed = callStartSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
        throw new errors_1.AppError("validation_error", "Invalid call payload.", 400);
    }
    const staffUserId = resolveStaffUserId({
        requesterId: req.user?.userId ?? null,
        requesterRole: req.user?.role ?? null,
        fromStaffUserId: parsed.data.fromStaffUserId ?? null,
    });
    const startPayload = {
        phoneNumber: parsed.data.toPhone ?? parsed.data.phoneNumber ?? "",
        staffUserId,
        crmContactId: parsed.data.contactId ?? null,
        applicationId: parsed.data.applicationId ?? null,
        callSid: parsed.data.callSid ?? null,
        createTwilioCall: !parsed.data.callSid,
        ...buildRequestMetadata(req),
    };
    const result = await (0, voice_service_1.startVoiceCall)(startPayload);
    res.status(201).json({
        ok: true,
        callSid: result.callSid,
        call: result.call,
    });
}));
router.post("/call/mute", auth_1.requireAuth, (0, auth_1.requireAuthorization)({
    roles: [roles_1.ROLES.ADMIN, roles_1.ROLES.STAFF],
    capabilities: [capabilities_1.CAPABILITIES.COMMUNICATIONS_CALL],
}), (0, rateLimit_1.voiceRateLimit)(), (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    assertVoiceEnabled();
    const parsed = callControlSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
        throw new errors_1.AppError("validation_error", "Invalid call control payload.", 400);
    }
    const controlPayload = {
        callSid: parsed.data.callSid,
        action: "mute",
        staffUserId: req.user?.userId ?? null,
        ...buildRequestMetadata(req),
    };
    const updated = await (0, voice_service_1.controlVoiceCall)(controlPayload);
    res.status(200).json({ ok: true, call: updated });
}));
router.post("/call/hold", auth_1.requireAuth, (0, auth_1.requireAuthorization)({
    roles: [roles_1.ROLES.ADMIN, roles_1.ROLES.STAFF],
    capabilities: [capabilities_1.CAPABILITIES.COMMUNICATIONS_CALL],
}), (0, rateLimit_1.voiceRateLimit)(), (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    assertVoiceEnabled();
    const parsed = callControlSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
        throw new errors_1.AppError("validation_error", "Invalid call control payload.", 400);
    }
    const controlPayload = {
        callSid: parsed.data.callSid,
        action: "hold",
        staffUserId: req.user?.userId ?? null,
        ...buildRequestMetadata(req),
    };
    const updated = await (0, voice_service_1.controlVoiceCall)(controlPayload);
    res.status(200).json({ ok: true, call: updated });
}));
router.post("/call/resume", auth_1.requireAuth, (0, auth_1.requireAuthorization)({
    roles: [roles_1.ROLES.ADMIN, roles_1.ROLES.STAFF],
    capabilities: [capabilities_1.CAPABILITIES.COMMUNICATIONS_CALL],
}), (0, rateLimit_1.voiceRateLimit)(), (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    assertVoiceEnabled();
    const parsed = callControlSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
        throw new errors_1.AppError("validation_error", "Invalid call control payload.", 400);
    }
    const controlPayload = {
        callSid: parsed.data.callSid,
        action: "resume",
        staffUserId: req.user?.userId ?? null,
        ...buildRequestMetadata(req),
    };
    const updated = await (0, voice_service_1.controlVoiceCall)(controlPayload);
    res.status(200).json({ ok: true, call: updated });
}));
router.post("/call/hangup", auth_1.requireAuth, (0, auth_1.requireAuthorization)({
    roles: [roles_1.ROLES.ADMIN, roles_1.ROLES.STAFF],
    capabilities: [capabilities_1.CAPABILITIES.COMMUNICATIONS_CALL],
}), (0, rateLimit_1.voiceRateLimit)(), (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    assertVoiceEnabled();
    const parsed = callControlSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
        throw new errors_1.AppError("validation_error", "Invalid call control payload.", 400);
    }
    const controlPayload = {
        callSid: parsed.data.callSid,
        action: "hangup",
        staffUserId: req.user?.userId ?? null,
        ...buildRequestMetadata(req),
    };
    const updated = await (0, voice_service_1.controlVoiceCall)(controlPayload);
    res.status(200).json({ ok: true, call: updated });
}));
router.post("/call/end", auth_1.requireAuth, (0, auth_1.requireAuthorization)({
    roles: [roles_1.ROLES.ADMIN, roles_1.ROLES.STAFF],
    capabilities: [capabilities_1.CAPABILITIES.COMMUNICATIONS_CALL],
}), (0, rateLimit_1.voiceRateLimit)(), (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    assertVoiceEnabled();
    const parsed = callEndSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
        throw new errors_1.AppError("validation_error", "Invalid call end payload.", 400);
    }
    const endPayload = {
        callSid: parsed.data.callSid,
        staffUserId: req.user?.userId ?? null,
        ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
        ...(parsed.data.durationSeconds !== undefined
            ? { durationSeconds: parsed.data.durationSeconds }
            : {}),
        ...buildRequestMetadata(req),
    };
    const updated = await (0, voice_service_1.endVoiceCall)(endPayload);
    res.status(200).json({ ok: true, call: updated });
}));
router.post("/call/status", auth_1.requireAuth, (0, auth_1.requireAuthorization)({
    roles: [roles_1.ROLES.ADMIN, roles_1.ROLES.STAFF],
    capabilities: [capabilities_1.CAPABILITIES.COMMUNICATIONS_CALL],
}), (0, rateLimit_1.voiceRateLimit)(), (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    assertVoiceEnabled();
    const parsed = callStatusSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
        throw new errors_1.AppError("validation_error", "Invalid call status payload.", 400);
    }
    if (!parsed.data.status && !parsed.data.callStatus) {
        const current = await (0, voice_service_1.fetchVoiceCallStatus)({
            callSid: parsed.data.callSid,
            staffUserId: req.user?.userId ?? null,
        });
        res.status(200).json({ ok: true, call: current });
        return;
    }
    const durationSeconds = parsed.data.durationSeconds ??
        (parsed.data.callDuration ? Number(parsed.data.callDuration) : undefined);
    const normalizedDuration = durationSeconds !== undefined && Number.isFinite(durationSeconds)
        ? Math.max(0, Math.round(durationSeconds))
        : undefined;
    const updatePayload = {
        callSid: parsed.data.callSid,
        staffUserId: req.user?.userId ?? null,
        ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
        ...(parsed.data.callStatus !== undefined
            ? { callStatus: parsed.data.callStatus }
            : {}),
        ...(normalizedDuration !== undefined
            ? { durationSeconds: normalizedDuration }
            : {}),
        ...buildRequestMetadata(req),
    };
    const updated = await (0, voice_service_1.updateVoiceCallStatus)(updatePayload);
    res.status(200).json({ ok: true, call: updated });
}));
router.post("/call/recording", auth_1.requireAuth, (0, auth_1.requireAuthorization)({
    roles: [roles_1.ROLES.ADMIN, roles_1.ROLES.STAFF],
    capabilities: [capabilities_1.CAPABILITIES.COMMUNICATIONS_CALL],
}), (0, rateLimit_1.voiceRateLimit)(), (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    assertVoiceEnabled();
    const parsed = callRecordingSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
        throw new errors_1.AppError("validation_error", "Invalid call recording payload.", 400);
    }
    const durationSeconds = parsed.data.recordingDurationSeconds ??
        (parsed.data.recordingDuration
            ? Number(parsed.data.recordingDuration)
            : undefined);
    const normalizedDuration = durationSeconds !== undefined && Number.isFinite(durationSeconds)
        ? Math.max(0, Math.round(durationSeconds))
        : undefined;
    const recordPayload = {
        callSid: parsed.data.callSid,
        recordingSid: parsed.data.recordingSid,
        staffUserId: req.user?.userId ?? null,
        ...(normalizedDuration !== undefined
            ? { durationSeconds: normalizedDuration }
            : {}),
        ...buildRequestMetadata(req),
    };
    const updated = await (0, voice_service_1.recordVoiceCallRecording)(recordPayload);
    res.status(200).json({ ok: true, call: updated });
}));
router.get("/calls", auth_1.requireAuth, (0, auth_1.requireAuthorization)({
    roles: [roles_1.ROLES.ADMIN, roles_1.ROLES.STAFF],
    capabilities: [capabilities_1.CAPABILITIES.COMMUNICATIONS_CALL],
}), (0, rateLimit_1.voiceRateLimit)(), (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    assertVoiceEnabled();
    const contextInput = typeof req.query.context === "string" ? req.query.context : undefined;
    const parsedContext = contextSchema.safeParse(contextInput);
    if (!parsedContext.success) {
        throw new errors_1.AppError("validation_error", "Invalid context.", 400);
    }
    const context = parseContext(parsedContext.data);
    if (context.contactId && !uuidSchema.safeParse(context.contactId).success) {
        throw new errors_1.AppError("validation_error", "Invalid contactId.", 400);
    }
    if (context.applicationId &&
        !uuidSchema.safeParse(context.applicationId).success) {
        throw new errors_1.AppError("validation_error", "Invalid applicationId.", 400);
    }
    const calls = await (0, calls_service_1.listCalls)({
        contactId: context.contactId ?? null,
        applicationId: context.applicationId ?? null,
    });
    res.status(200).json({ ok: true, calls });
}));
exports.default = router;
