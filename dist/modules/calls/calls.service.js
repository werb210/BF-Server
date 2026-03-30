"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startCall = startCall;
exports.updateCallStatus = updateCallStatus;
exports.updateCallRecording = updateCallRecording;
exports.endCall = endCall;
exports.listCalls = listCalls;
const errors_1 = require("../../middleware/errors");
const audit_service_1 = require("../audit/audit.service");
const calls_repo_1 = require("./calls.repo");
async function startCall(params) {
    const status = params.status ?? "initiated";
    const record = await (0, calls_repo_1.createCallLog)({
        phoneNumber: params.phoneNumber,
        fromNumber: params.fromNumber ?? null,
        toNumber: params.toNumber ?? null,
        direction: params.direction,
        status,
        staffUserId: params.staffUserId,
        twilioCallSid: params.twilioCallSid ?? null,
        crmContactId: params.crmContactId ?? null,
        applicationId: params.applicationId ?? null,
    });
    await (0, audit_service_1.recordAuditEvent)({
        action: "call_started",
        actorUserId: params.staffUserId,
        targetUserId: null,
        targetType: "call_log",
        targetId: record.id,
        ip: params.ip ?? null,
        userAgent: params.userAgent ?? null,
        success: true,
        metadata: {
            phone_number: record.phone_number,
            from_number: record.from_number,
            to_number: record.to_number,
            twilio_call_sid: record.twilio_call_sid,
            direction: record.direction,
            status: record.status,
            crm_contact_id: record.crm_contact_id,
            application_id: record.application_id,
        },
    });
    return record;
}
async function updateCallStatus(params) {
    const existing = await (0, calls_repo_1.findCallLogById)(params.id);
    if (!existing) {
        throw new errors_1.AppError("not_found", "Call not found.", 404);
    }
    const shouldUpdateStatus = existing.status !== params.status;
    const shouldUpdateDuration = params.durationSeconds !== undefined &&
        params.durationSeconds !== existing.duration_seconds;
    const shouldUpdateFrom = params.fromNumber !== undefined && params.fromNumber !== existing.from_number;
    const shouldUpdateTo = params.toNumber !== undefined && params.toNumber !== existing.to_number;
    const shouldUpdateErrorCode = params.errorCode !== undefined && params.errorCode !== existing.error_code;
    const shouldUpdateErrorMessage = params.errorMessage !== undefined && params.errorMessage !== existing.error_message;
    const shouldUpdateRecordingSid = params.recordingSid !== undefined && params.recordingSid !== existing.recording_sid;
    const shouldUpdateRecordingDuration = params.recordingDurationSeconds !== undefined &&
        params.recordingDurationSeconds !== existing.recording_duration_seconds;
    const shouldEnd = (params.status === "ended" ||
        params.status === "failed" ||
        params.status === "completed" ||
        params.status === "cancelled" ||
        params.status === "canceled") &&
        existing.ended_at === null;
    if (!shouldUpdateStatus &&
        !shouldUpdateDuration &&
        !shouldUpdateFrom &&
        !shouldUpdateTo &&
        !shouldUpdateErrorCode &&
        !shouldUpdateErrorMessage &&
        !shouldUpdateRecordingSid &&
        !shouldUpdateRecordingDuration &&
        !shouldEnd) {
        return existing;
    }
    const updated = await (0, calls_repo_1.updateCallLogStatus)({
        id: params.id,
        status: params.status,
        durationSeconds: params.durationSeconds !== undefined
            ? params.durationSeconds
            : existing.duration_seconds,
        endedAt: shouldEnd ? new Date() : existing.ended_at,
        fromNumber: params.fromNumber !== undefined ? params.fromNumber : existing.from_number,
        toNumber: params.toNumber !== undefined ? params.toNumber : existing.to_number,
        errorCode: params.errorCode !== undefined ? params.errorCode : existing.error_code,
        errorMessage: params.errorMessage !== undefined ? params.errorMessage : existing.error_message,
        recordingSid: params.recordingSid !== undefined
            ? params.recordingSid
            : existing.recording_sid,
        recordingDurationSeconds: params.recordingDurationSeconds !== undefined
            ? params.recordingDurationSeconds
            : existing.recording_duration_seconds,
    });
    if (!updated) {
        throw new errors_1.AppError("not_found", "Call not found.", 404);
    }
    if (shouldUpdateStatus ||
        shouldUpdateDuration ||
        shouldUpdateFrom ||
        shouldUpdateTo ||
        shouldUpdateErrorCode ||
        shouldUpdateErrorMessage ||
        shouldUpdateRecordingSid ||
        shouldUpdateRecordingDuration) {
        await (0, audit_service_1.recordAuditEvent)({
            action: "call_status_updated",
            actorUserId: params.actorUserId ?? null,
            targetUserId: null,
            targetType: "call_log",
            targetId: updated.id,
            ip: params.ip ?? null,
            userAgent: params.userAgent ?? null,
            success: true,
            metadata: {
                phone_number: updated.phone_number,
                from_number: updated.from_number,
                to_number: updated.to_number,
                twilio_call_sid: updated.twilio_call_sid,
                direction: updated.direction,
                status: updated.status,
                duration_seconds: updated.duration_seconds,
                crm_contact_id: updated.crm_contact_id,
                application_id: updated.application_id,
                error_code: updated.error_code,
                error_message: updated.error_message,
                recording_sid: updated.recording_sid,
                recording_duration_seconds: updated.recording_duration_seconds,
            },
        });
    }
    return updated;
}
async function updateCallRecording(params) {
    const existing = await (0, calls_repo_1.findCallLogById)(params.id);
    if (!existing) {
        throw new errors_1.AppError("not_found", "Call not found.", 404);
    }
    const updatePayload = {
        id: params.id,
        status: existing.status,
        recordingSid: params.recordingSid,
        ...(params.recordingDurationSeconds !== undefined
            ? { recordingDurationSeconds: params.recordingDurationSeconds }
            : {}),
        ...(params.actorUserId !== undefined ? { actorUserId: params.actorUserId } : {}),
        ...(params.ip ? { ip: params.ip } : {}),
        ...(params.userAgent ? { userAgent: params.userAgent } : {}),
    };
    const updated = await updateCallStatus(updatePayload);
    await (0, audit_service_1.recordAuditEvent)({
        action: "call_recording_updated",
        actorUserId: params.actorUserId ?? null,
        targetUserId: null,
        targetType: "call_log",
        targetId: updated.id,
        ip: params.ip ?? null,
        userAgent: params.userAgent ?? null,
        success: true,
        metadata: {
            phone_number: updated.phone_number,
            twilio_call_sid: updated.twilio_call_sid,
            recording_sid: updated.recording_sid,
            recording_duration_seconds: updated.recording_duration_seconds,
        },
    });
    return updated;
}
async function endCall(params) {
    const existing = await (0, calls_repo_1.findCallLogById)(params.id);
    if (!existing) {
        throw new errors_1.AppError("not_found", "Call not found.", 404);
    }
    const shouldEnd = existing.status !== "ended";
    const endPayload = {
        id: params.id,
        status: "ended",
        durationSeconds: params.durationSeconds ?? existing.duration_seconds,
        actorUserId: params.staffUserId,
        ...(params.ip ? { ip: params.ip } : {}),
        ...(params.userAgent ? { userAgent: params.userAgent } : {}),
    };
    const updated = await updateCallStatus(endPayload);
    if (shouldEnd) {
        await (0, audit_service_1.recordAuditEvent)({
            action: "call_ended",
            actorUserId: params.staffUserId,
            targetUserId: null,
            targetType: "call_log",
            targetId: updated.id,
            ip: params.ip ?? null,
            userAgent: params.userAgent ?? null,
            success: true,
            metadata: {
                phone_number: updated.phone_number,
                from_number: updated.from_number,
                to_number: updated.to_number,
                direction: updated.direction,
                status: updated.status,
                duration_seconds: updated.duration_seconds,
                crm_contact_id: updated.crm_contact_id,
                application_id: updated.application_id,
            },
        });
    }
    return updated;
}
async function listCalls(params) {
    return (0, calls_repo_1.listCallLogs)({
        contactId: params.contactId ?? null,
        applicationId: params.applicationId ?? null,
    });
}
