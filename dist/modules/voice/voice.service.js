import AccessToken from "twilio/lib/jwt/AccessToken";
import { AppError } from "../../middleware/errors.js";
import { logError, logInfo, logWarn } from "../../observability/logger.js";
import { normalizePhoneNumber } from "../auth/phone.js";
import { startCall, updateCallStatus, updateCallRecording } from "../calls/calls.service.js";
import { findCallLogByTwilioSid } from "../calls/calls.repo.js";
import { fetchTwilioClient } from "../../services/twilio.js";
import { config } from "../../config/index.js";
import { recordAuditEvent } from "../audit/audit.service.js";
const VOICE_TOKEN_TTL_SECONDS = 15 * 60;
const DEFAULT_HOLD_TWIML = "<Response><Say>One moment.</Say><Pause length=\"3600\"/></Response>";
const VOICE_ENV_KEYS = [
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_API_KEY_SID",
    "TWILIO_API_SECRET",
    "TWILIO_VOICE_APP_SID",
    "TWILIO_VOICE_CALLER_ID",
];
const VOICE_ENV_MAP = {
    TWILIO_ACCOUNT_SID: config.twilio.accountSid,
    TWILIO_AUTH_TOKEN: config.twilio.authToken,
    TWILIO_API_KEY_SID: config.twilio.apiKey,
    TWILIO_API_SECRET: config.twilio.apiSecret,
    TWILIO_VOICE_APP_SID: config.twilio.voiceAppSid,
    TWILIO_VOICE_CALLER_ID: config.twilio.from ??
        config.twilio.number ??
        config.twilio.phone ??
        config.twilio.phoneNumber,
};
const TERMINAL_STATUSES = [
    "completed",
    "failed",
    "canceled",
    "cancelled",
    "busy",
    "no_answer",
    "ended",
];
const NORMALIZED_LIFECYCLE_STATUSES = [
    "initiated",
    "ringing",
    "in_progress",
    "completed",
    "failed",
];
export function fetchVoiceAvailability() {
    const missing = VOICE_ENV_KEYS.filter((key) => {
        const value = VOICE_ENV_MAP[key];
        return !value || !value.trim();
    });
    return { enabled: missing.length === 0, missing };
}
function requireVoiceEnv(name) {
    const value = VOICE_ENV_MAP[name];
    if (!value || !value.trim()) {
        const error = new AppError("voice_disabled", "Voice service is not configured.", 503);
        error.details = { missing: [name] };
        throw error;
    }
    return value.trim();
}
function assertVoiceEnabled() {
    const availability = fetchVoiceAvailability();
    if (!availability.enabled) {
        const error = new AppError("voice_disabled", "Voice service is not configured.", 503);
        error.details = { missing: availability.missing };
        throw error;
    }
}
function fetchVoiceConfig() {
    return {
        accountSid: requireVoiceEnv("TWILIO_ACCOUNT_SID"),
        authToken: requireVoiceEnv("TWILIO_AUTH_TOKEN"),
        apiKey: requireVoiceEnv("TWILIO_API_KEY_SID"),
        apiSecret: requireVoiceEnv("TWILIO_API_SECRET"),
        applicationSid: requireVoiceEnv("TWILIO_VOICE_APP_SID"),
        callerId: requireVoiceEnv("TWILIO_VOICE_CALLER_ID"),
    };
}
function normalizeTwilioError(error) {
    if (error && typeof error === "object") {
        const err = error;
        const details = {
            message: typeof err.message === "string" ? err.message : "Twilio error",
        };
        if (typeof err.code === "string" || typeof err.code === "number") {
            details.code = err.code;
        }
        return details;
    }
    if (error instanceof Error) {
        return { message: error.message };
    }
    return { message: "Twilio error" };
}
function buildRequestMetadata(params) {
    const metadata = {};
    if (params.ip) {
        metadata.ip = params.ip;
    }
    if (params.userAgent) {
        metadata.userAgent = params.userAgent;
    }
    return metadata;
}
function fetchVoiceStatusCallbackUrl() {
    const baseUrl = config.app.baseUrl?.trim();
    if (!baseUrl)
        return null;
    return `${baseUrl.replace(/\/$/, "")}/api/webhooks/twilio/voice`;
}
function normalizeRestrictedNumbers() {
    const restricted = config.security.voiceRestrictedNumbers;
    const normalized = restricted
        .map((entry) => normalizePhoneNumber(entry))
        .filter((entry) => Boolean(entry));
    return new Set(normalized);
}
function assertAllowedDestination(phoneNumber) {
    const digits = phoneNumber.replace(/\D/g, "");
    if (digits.length > 0 && digits.length <= 4) {
        throw new AppError("restricted_number", "Dialing restricted numbers is not allowed.", 400);
    }
    const normalized = normalizePhoneNumber(phoneNumber);
    if (!normalized) {
        throw new AppError("invalid_phone", "Phone number must be in E.164 format.", 400);
    }
    const restricted = normalizeRestrictedNumbers();
    if (restricted.has(normalized)) {
        throw new AppError("restricted_number", "Dialing restricted numbers is not allowed.", 400);
    }
}
function assertCallOwnership(call, staffUserId) {
    if (!staffUserId || call.staff_user_id !== staffUserId) {
        throw new AppError("forbidden", "You do not have access to this call.", 403);
    }
}
function normalizeLifecycleStatus(status) {
    switch (status) {
        case "connected":
            return "in_progress";
        case "ended":
            return "completed";
        case "busy":
        case "no_answer":
        case "canceled":
        case "cancelled":
            return "failed";
        default:
            return status;
    }
}
function mapTwilioStatus(status) {
    if (!status)
        return null;
    switch (status) {
        case "queued":
        case "initiated":
            return "initiated";
        case "ringing":
            return "ringing";
        case "answered":
        case "in-progress":
            return "in_progress";
        case "completed":
            return "completed";
        case "failed":
        case "busy":
        case "no-answer":
        case "canceled":
            return "failed";
        default:
            return null;
    }
}
export function issueVoiceToken(params) {
    assertVoiceEnabled();
    const { accountSid, apiKey, apiSecret, applicationSid } = fetchVoiceConfig();
    const token = new AccessToken(accountSid, apiKey, apiSecret, {
        identity: params.userId,
        ttl: VOICE_TOKEN_TTL_SECONDS,
    });
    const voiceGrant = new AccessToken.VoiceGrant({
        outgoingApplicationSid: applicationSid,
    });
    token.addGrant(voiceGrant);
    return token.toJwt();
}
export async function startVoiceCall(params) {
    assertVoiceEnabled();
    assertAllowedDestination(params.phoneNumber);
    const normalizedPhone = normalizePhoneNumber(params.phoneNumber);
    if (!normalizedPhone) {
        throw new AppError("invalid_phone", "Phone number must be in E.164 format.", 400);
    }
    const { callerId, applicationSid } = fetchVoiceConfig();
    const statusCallbackUrl = fetchVoiceStatusCallbackUrl();
    const shouldCreateTwilioCall = params.createTwilioCall ?? !params.callSid;
    let callSid = params.callSid ?? "";
    if (shouldCreateTwilioCall) {
        try {
            const client = fetchTwilioClient();
            const callOptions = {
                to: normalizedPhone,
                from: callerId,
                applicationSid,
            };
            if (statusCallbackUrl) {
                callOptions.statusCallback = statusCallbackUrl;
                callOptions.statusCallbackEvent = [
                    "initiated",
                    "ringing",
                    "answered",
                    "completed",
                    "busy",
                    "failed",
                    "no-answer",
                    "canceled",
                ];
                callOptions.statusCallbackMethod = "POST";
            }
            const call = await client.calls.create(callOptions);
            callSid = call.sid;
        }
        catch (error) {
            const details = normalizeTwilioError(error);
            logError("voice_call_start_failed", {
                error: details.message,
                code: details.code,
                phoneNumber: normalizedPhone,
                staffUserId: params.staffUserId,
            });
            throw new AppError("twilio_error", "Unable to start call.", 502);
        }
    }
    if (!callSid) {
        throw new AppError("validation_error", "Call SID is required.", 400);
    }
    const call = await startCall({
        phoneNumber: normalizedPhone,
        fromNumber: callerId,
        toNumber: normalizedPhone,
        direction: "outbound",
        status: "initiated",
        staffUserId: params.staffUserId,
        twilioCallSid: callSid,
        crmContactId: params.crmContactId ?? null,
        applicationId: params.applicationId ?? null,
        ...buildRequestMetadata(params),
    });
    return { callSid, call };
}
export async function endVoiceCall(params) {
    assertVoiceEnabled();
    const finalStatus = params.status ?? "completed";
    const callLog = await findCallLogByTwilioSid(params.callSid);
    if (!callLog) {
        throw new AppError("not_found", "Call not found.", 404);
    }
    assertCallOwnership(callLog, params.staffUserId);
    const isTerminal = TERMINAL_STATUSES.includes(callLog.status);
    let twilioError = null;
    if (!isTerminal) {
        try {
            const client = fetchTwilioClient();
            await client.calls(params.callSid).update({ status: "completed" });
        }
        catch (error) {
            const details = normalizeTwilioError(error);
            logError("voice_call_end_failed", {
                error: details.message,
                code: details.code,
                callSid: params.callSid,
                staffUserId: params.staffUserId,
            });
            twilioError = new AppError("twilio_error", "Unable to end call.", 502);
        }
    }
    const endedAt = new Date();
    const durationSeconds = params.durationSeconds ??
        (callLog.created_at
            ? Math.max(0, Math.round((endedAt.getTime() - callLog.created_at.getTime()) / 1000))
            : undefined);
    const endPayload = {
        id: callLog.id,
        status: normalizeLifecycleStatus(twilioError ? "failed" : finalStatus),
        actorUserId: params.staffUserId,
        ...(durationSeconds !== undefined ? { durationSeconds } : {}),
        ...buildRequestMetadata(params),
    };
    const updated = await updateCallStatus(endPayload);
    if (twilioError) {
        throw twilioError;
    }
    return updated;
}
export async function updateVoiceCallStatus(params) {
    assertVoiceEnabled();
    const callLog = await findCallLogByTwilioSid(params.callSid);
    if (!callLog) {
        throw new AppError("not_found", "Call not found.", 404);
    }
    assertCallOwnership(callLog, params.staffUserId);
    const statusFromInput = params.status ?? mapTwilioStatus(params.callStatus);
    if (!statusFromInput) {
        throw new AppError("validation_error", "Unsupported call status.", 400);
    }
    const normalizedStatus = normalizeLifecycleStatus(statusFromInput);
    if (!NORMALIZED_LIFECYCLE_STATUSES.includes(normalizedStatus)) {
        throw new AppError("validation_error", "Unsupported call status.", 400);
    }
    const updatePayload = {
        id: callLog.id,
        status: normalizedStatus,
        actorUserId: params.staffUserId,
        ...(params.durationSeconds !== undefined
            ? { durationSeconds: params.durationSeconds }
            : {}),
        ...buildRequestMetadata(params),
    };
    const updated = await updateCallStatus(updatePayload);
    return updated;
}
export async function fetchVoiceCallStatus(params) {
    assertVoiceEnabled();
    const callLog = await findCallLogByTwilioSid(params.callSid);
    if (!callLog) {
        throw new AppError("not_found", "Call not found.", 404);
    }
    assertCallOwnership(callLog, params.staffUserId);
    return callLog;
}
export async function controlVoiceCall(params) {
    assertVoiceEnabled();
    const callLog = await findCallLogByTwilioSid(params.callSid);
    if (!callLog) {
        throw new AppError("not_found", "Call not found.", 404);
    }
    assertCallOwnership(callLog, params.staffUserId);
    if (TERMINAL_STATUSES.includes(callLog.status) && params.action !== "hangup") {
        throw new AppError("call_inactive", "Call is no longer active.", 409);
    }
    const toNumber = callLog.to_number ?? callLog.phone_number;
    const twiml = params.action === "hold"
        ? DEFAULT_HOLD_TWIML
        : params.action === "mute"
            ? `<Response><Dial><Number muted="true">${toNumber}</Number></Dial></Response>`
            : params.action === "resume"
                ? `<Response><Dial><Number>${toNumber}</Number></Dial></Response>`
                : null;
    let twilioError = null;
    try {
        const client = fetchTwilioClient();
        if (params.action === "hangup") {
            await client.calls(params.callSid).update({ status: "completed" });
        }
        else if (twiml) {
            await client.calls(params.callSid).update({ twiml });
        }
    }
    catch (error) {
        const details = normalizeTwilioError(error);
        logError("voice_call_control_failed", {
            error: details.message,
            code: details.code,
            callSid: params.callSid,
            staffUserId: params.staffUserId,
            action: params.action,
        });
        twilioError = new AppError("twilio_error", "Unable to update call.", 502);
    }
    const nextStatus = params.action === "hangup" ? "completed" : "in_progress";
    const updated = await updateCallStatus({
        id: callLog.id,
        status: normalizeLifecycleStatus(nextStatus),
        actorUserId: params.staffUserId,
        ...buildRequestMetadata(params),
    });
    await recordAuditEvent({
        action: `call_${params.action}`,
        actorUserId: params.staffUserId,
        targetUserId: null,
        targetType: "call_log",
        targetId: updated.id,
        ip: params.ip ?? null,
        userAgent: params.userAgent ?? null,
        success: true,
        metadata: {
            twilio_call_sid: updated.twilio_call_sid,
            status: updated.status,
            to_number: updated.to_number ?? updated.phone_number,
            from_number: updated.from_number,
        },
    });
    if (twilioError) {
        throw twilioError;
    }
    return updated;
}
export async function recordVoiceCallRecording(params) {
    assertVoiceEnabled();
    const callLog = await findCallLogByTwilioSid(params.callSid);
    if (!callLog) {
        throw new AppError("not_found", "Call not found.", 404);
    }
    assertCallOwnership(callLog, params.staffUserId);
    const updated = await updateCallRecording({
        id: callLog.id,
        recordingSid: params.recordingSid,
        ...(params.durationSeconds !== undefined
            ? { recordingDurationSeconds: params.durationSeconds }
            : {}),
        actorUserId: params.staffUserId,
        ...buildRequestMetadata(params),
    });
    return updated;
}
export async function handleVoiceStatusWebhook(params) {
    const callLog = await findCallLogByTwilioSid(params.callSid);
    if (!callLog) {
        logWarn("voice_webhook_call_not_found", { callSid: params.callSid });
        return null;
    }
    const mappedStatus = mapTwilioStatus(params.callStatus);
    if (!mappedStatus) {
        logWarn("voice_webhook_unknown_status", {
            callSid: params.callSid,
            status: params.callStatus ?? "unknown",
        });
        return callLog;
    }
    const durationSeconds = params.callDuration !== null && params.callDuration !== undefined
        ? Number(params.callDuration)
        : undefined;
    const sanitizedDuration = Number.isFinite(durationSeconds) && durationSeconds !== undefined
        ? Math.max(0, Math.round(durationSeconds))
        : undefined;
    const updatePayload = {
        id: callLog.id,
        status: normalizeLifecycleStatus(mappedStatus),
        ...(sanitizedDuration !== undefined ? { durationSeconds: sanitizedDuration } : {}),
        ...(params.from !== undefined ? { fromNumber: params.from } : {}),
        ...(params.to !== undefined ? { toNumber: params.to } : {}),
        ...(params.errorCode !== undefined ? { errorCode: params.errorCode } : {}),
        ...(params.errorMessage !== undefined ? { errorMessage: params.errorMessage } : {}),
    };
    const updated = await updateCallStatus(updatePayload);
    logInfo("voice_webhook_status_updated", {
        callSid: params.callSid,
        status: mappedStatus,
    });
    return updated;
}
