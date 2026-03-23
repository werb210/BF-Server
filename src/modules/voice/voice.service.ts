import AccessToken from "twilio/lib/jwt/AccessToken";
import { AppError } from "../../middleware/errors";
import { logError, logInfo, logWarn } from "../../observability/logger";
import { normalizePhoneNumber } from "../auth/phone";
import { startCall, updateCallStatus, updateCallRecording } from "../calls/calls.service";
import { findCallLogByTwilioSid } from "../calls/calls.repo";
import { getTwilioClient } from "../../services/twilio";
import { type CallStatus, type CallLogRecord } from "../calls/calls.repo";
import { getVoiceRestrictedNumbers, runtimeEnv } from "../../server/config/config";
import { recordAuditEvent } from "../audit/audit.service";

const VOICE_TOKEN_TTL_SECONDS = 15 * 60;
const DEFAULT_HOLD_TWIML =
  "<Response><Say>One moment.</Say><Pause length=\"3600\"/></Response>";

const VOICE_ENV_KEYS = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_API_KEY_SID",
  "TWILIO_API_SECRET",
  "TWILIO_VOICE_APP_SID",
  "TWILIO_VOICE_CALLER_ID",
] as const;

const TERMINAL_STATUSES: CallStatus[] = [
  "completed",
  "failed",
  "canceled",
  "cancelled",
  "busy",
  "no_answer",
  "ended",
];

const NORMALIZED_LIFECYCLE_STATUSES: CallStatus[] = [
  "initiated",
  "ringing",
  "in_progress",
  "completed",
  "failed",
];

export function getVoiceAvailability(): { enabled: boolean; missing: string[] } {
  const missing = VOICE_ENV_KEYS.filter((key) => {
    const value = process.env[key];
    return !value || !value.trim();
  });
  return { enabled: missing.length === 0, missing };
}

function requireVoiceEnv(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    const error = new AppError(
      "voice_disabled",
      "Voice service is not configured.",
      503
    );
    (error as { details?: unknown }).details = { missing: [name] };
    throw error;
  }
  return value.trim();
}

function assertVoiceEnabled(): void {
  const availability = getVoiceAvailability();
  if (!availability.enabled) {
    const error = new AppError(
      "voice_disabled",
      "Voice service is not configured.",
      503
    );
    (error as { details?: unknown }).details = { missing: availability.missing };
    throw error;
  }
}

function getVoiceConfig(): {
  accountSid: string;
  authToken: string;
  apiKey: string;
  apiSecret: string;
  applicationSid: string;
  callerId: string;
} {
  return {
    accountSid: requireVoiceEnv("TWILIO_ACCOUNT_SID"),
    authToken: requireVoiceEnv("TWILIO_AUTH_TOKEN"),
    apiKey: requireVoiceEnv("TWILIO_API_KEY_SID"),
    apiSecret: requireVoiceEnv("TWILIO_API_SECRET"),
    applicationSid: requireVoiceEnv("TWILIO_VOICE_APP_SID"),
    callerId: requireVoiceEnv("TWILIO_VOICE_CALLER_ID"),
  };
}

function normalizeTwilioError(error: unknown): { message: string; code?: string | number } {
  if (error && typeof error === "object") {
    const err = error as { message?: unknown; code?: unknown };
    const details: { message: string; code?: string | number } = {
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

function buildRequestMetadata(params: {
  ip?: string;
  userAgent?: string;
}): { ip?: string; userAgent?: string } {
  const metadata: { ip?: string; userAgent?: string } = {};
  if (params.ip) {
    metadata.ip = params.ip;
  }
  if (params.userAgent) {
    metadata.userAgent = params.userAgent;
  }
  return metadata;
}

function getVoiceStatusCallbackUrl(): string | null {
  const baseUrl = process.env.BASE_URL?.trim();
  if (!baseUrl) return null;
  return `${baseUrl.replace(/\/$/, "")}/api/webhooks/twilio/voice`;
}

function normalizeRestrictedNumbers(): Set<string> {
  const restricted = runtimeEnv.voiceRestrictedNumbers;
  const normalized = restricted
    .map((entry: any) => normalizePhoneNumber(entry))
    .filter((entry): entry is string => Boolean(entry));
  return new Set(normalized);
}

function assertAllowedDestination(phoneNumber: string): void {
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

function assertCallOwnership(call: CallLogRecord, staffUserId: string | null): void {
  if (!staffUserId || call.staff_user_id !== staffUserId) {
    throw new AppError("forbidden", "You do not have access to this call.", 403);
  }
}

function normalizeLifecycleStatus(status: CallStatus): CallStatus {
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

function mapTwilioStatus(status: string | null | undefined): CallStatus | null {
  if (!status) return null;
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

export function issueVoiceToken(params: { userId: string }): string {
  assertVoiceEnabled();
  const { accountSid, apiKey, apiSecret, applicationSid } = getVoiceConfig();

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

export async function startVoiceCall(params: {
  phoneNumber: string;
  staffUserId: string | null;
  crmContactId?: string | null;
  applicationId?: string | null;
  callSid?: string | null;
  createTwilioCall?: boolean;
  ip?: string;
  userAgent?: string;
}): Promise<{ callSid: string; call: CallLogRecord }> {
  assertVoiceEnabled();
  assertAllowedDestination(params.phoneNumber);
  const normalizedPhone = normalizePhoneNumber(params.phoneNumber);
  if (!normalizedPhone) {
    throw new AppError("invalid_phone", "Phone number must be in E.164 format.", 400);
  }

  const { callerId, applicationSid } = getVoiceConfig();
  const statusCallbackUrl = getVoiceStatusCallbackUrl();

  const shouldCreateTwilioCall = params.createTwilioCall ?? !params.callSid;
  let callSid = params.callSid ?? "";
  if (shouldCreateTwilioCall) {
    try {
      const client = getTwilioClient();
      const callOptions: {
        to: string;
        from: string;
        applicationSid: string;
        statusCallback?: string;
        statusCallbackEvent?: string[];
        statusCallbackMethod?: string;
      } = {
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
    } catch (error) {
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

export async function endVoiceCall(params: {
  callSid: string;
  status?: CallStatus;
  durationSeconds?: number | null;
  staffUserId: string | null;
  ip?: string;
  userAgent?: string;
}): Promise<CallLogRecord> {
  assertVoiceEnabled();
  const finalStatus: CallStatus = params.status ?? "completed";

  const callLog = await findCallLogByTwilioSid(params.callSid);
  if (!callLog) {
    throw new AppError("not_found", "Call not found.", 404);
  }
  assertCallOwnership(callLog, params.staffUserId);

  const isTerminal = TERMINAL_STATUSES.includes(callLog.status);
  let twilioError: AppError | null = null;
  if (!isTerminal) {
    try {
      const client = getTwilioClient();
      await client.calls(params.callSid).update({ status: "completed" });
    } catch (error) {
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
  const durationSeconds =
    params.durationSeconds ??
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

export async function updateVoiceCallStatus(params: {
  callSid: string;
  status?: CallStatus;
  callStatus?: string | null;
  durationSeconds?: number | null;
  staffUserId: string | null;
  ip?: string;
  userAgent?: string;
}): Promise<CallLogRecord> {
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

export async function getVoiceCallStatus(params: {
  callSid: string;
  staffUserId: string | null;
}): Promise<CallLogRecord> {
  assertVoiceEnabled();
  const callLog = await findCallLogByTwilioSid(params.callSid);
  if (!callLog) {
    throw new AppError("not_found", "Call not found.", 404);
  }
  assertCallOwnership(callLog, params.staffUserId);
  return callLog;
}

export async function controlVoiceCall(params: {
  callSid: string;
  action: "mute" | "hold" | "resume" | "hangup";
  staffUserId: string | null;
  ip?: string;
  userAgent?: string;
}): Promise<CallLogRecord> {
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
  const twiml =
    params.action === "hold"
      ? DEFAULT_HOLD_TWIML
      : params.action === "mute"
        ? `<Response><Dial><Number muted="true">${toNumber}</Number></Dial></Response>`
        : params.action === "resume"
          ? `<Response><Dial><Number>${toNumber}</Number></Dial></Response>`
          : null;

  let twilioError: AppError | null = null;
  try {
    const client = getTwilioClient();
    if (params.action === "hangup") {
      await client.calls(params.callSid).update({ status: "completed" });
    } else if (twiml) {
      await client.calls(params.callSid).update({ twiml });
    }
  } catch (error) {
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

  const nextStatus: CallStatus =
    params.action === "hangup" ? "completed" : "in_progress";

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

export async function recordVoiceCallRecording(params: {
  callSid: string;
  recordingSid: string;
  durationSeconds?: number | null;
  staffUserId: string | null;
  ip?: string;
  userAgent?: string;
}): Promise<CallLogRecord> {
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

export async function handleVoiceStatusWebhook(params: {
  callSid: string;
  callStatus?: string | null;
  callDuration?: string | number | null;
  from?: string | null;
  to?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}): Promise<CallLogRecord | null> {
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

  const durationSeconds =
    params.callDuration !== null && params.callDuration !== undefined
      ? Number(params.callDuration)
      : undefined;
  const sanitizedDuration =
    Number.isFinite(durationSeconds) && durationSeconds !== undefined
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
