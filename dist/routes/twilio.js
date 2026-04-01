"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.__resetTwilioRateLimitsForTest = __resetTwilioRateLimitsForTest;
const express_1 = require("express");
const crypto_1 = require("crypto");
const twilio_1 = __importDefault(require("twilio"));
const AccessToken_1 = __importDefault(require("twilio/lib/jwt/AccessToken"));
const AccessToken_2 = require("twilio/lib/jwt/AccessToken");
const auth_1 = require("../middleware/auth");
const capabilities_1 = require("../auth/capabilities");
const roles_1 = require("../auth/roles");
const errors_1 = require("../middleware/errors");
const apiResponse_1 = require("../lib/apiResponse");
const routeWrap_1 = require("../lib/routeWrap");
const db_1 = require("../db");
const calls_service_1 = require("../modules/calls/calls.service");
const calls_repo_1 = require("../modules/calls/calls.repo");
const voicemail_repo_1 = require("../modules/voice/voicemail.repo");
const logger_1 = require("../observability/logger");
const config_1 = require("../config");
const router = (0, express_1.Router)();
const oneMinuteMs = 60000;
const RATE_BUCKET_TTL_MS = 5 * oneMinuteMs;
const MAX_BUCKETS = 1000;
const ipBuckets = new Map();
const staffBuckets = new Map();
function consumeRateLimit(buckets, key, max) {
    const now = Date.now();
    const current = buckets.get(key);
    if (!current || current.resetAt <= now) {
        buckets.set(key, { count: 1, resetAt: now + oneMinuteMs });
        if (buckets.size > MAX_BUCKETS) {
            const firstKey = buckets.keys().next().value;
            if (firstKey) {
                buckets.delete(firstKey);
            }
        }
        return true;
    }
    if (current.count >= max) {
        return false;
    }
    current.count += 1;
    return true;
}
setInterval(() => {
    const cutoff = Date.now() - RATE_BUCKET_TTL_MS;
    for (const [key, value] of ipBuckets.entries()) {
        if (value.resetAt < cutoff) {
            ipBuckets.delete(key);
        }
    }
    for (const [key, value] of staffBuckets.entries()) {
        if (value.resetAt < cutoff) {
            staffBuckets.delete(key);
        }
    }
}, oneMinuteMs).unref();
function fetchIpKey(req) {
    const forwarded = typeof req.headers["x-forwarded-for"] === "string" ? req.headers["x-forwarded-for"].split(",")[0] : null;
    return (forwarded?.trim() || req.ip || "unknown").toLowerCase();
}
async function resolveStaffUserId(req) {
    const directStaffId = typeof req.body?.staffId === "string" ? req.body.staffId : typeof req.body?.StaffId === "string" ? req.body.StaffId : null;
    if (directStaffId) {
        return directStaffId;
    }
    const callSid = typeof req.body?.CallSid === "string"
        ? req.body.CallSid
        : typeof req.query?.callSid === "string"
            ? req.query.callSid
            : null;
    if (!callSid) {
        return null;
    }
    const callLog = await (0, calls_repo_1.findCallLogByTwilioSid)(callSid);
    return callLog?.staff_user_id ?? null;
}
const dialerRateLimit = async (req, res, next) => {
    const ipKey = fetchIpKey(req);
    if (!consumeRateLimit(ipBuckets, ipKey, 30)) {
        res.status(429).json({ code: "rate_limited", message: "Too many requests." });
        return;
    }
    const staffUserId = await resolveStaffUserId(req);
    if (staffUserId && !consumeRateLimit(staffBuckets, staffUserId, 10)) {
        res.status(429).json({ code: "rate_limited", message: "Too many requests." });
        return;
    }
    next();
};
function __resetTwilioRateLimitsForTest() {
    ipBuckets.clear();
    staffBuckets.clear();
}
const twilioRuntime = twilio_1.default;
function buildWebhookUrl(req) {
    const baseUrl = config_1.config.app.baseUrl?.trim();
    if (baseUrl) {
        return `${baseUrl.replace(/\/$/, "")}/api${req.originalUrl}`;
    }
    const proto = req.get("x-forwarded-proto") ?? req.protocol;
    const host = req.get("x-forwarded-host") ?? req.get("host");
    if (!host) {
        throw new errors_1.AppError("invalid_request", "Missing request host.", 400);
    }
    return `${proto}://${host}${req.originalUrl}`;
}
function assertValidTwilioSignature(req) {
    const authToken = config_1.config.twilio.authToken;
    if (!authToken || !authToken.trim()) {
        throw new errors_1.AppError("twilio_misconfigured", "Twilio auth token is missing.", 500);
    }
    const signature = req.get("x-twilio-signature");
    if (!signature) {
        throw new errors_1.AppError("invalid_signature", "Missing Twilio signature.", 403);
    }
    const fullUrl = buildWebhookUrl(req);
    const valid = twilioRuntime.validateRequest(authToken.trim(), signature, fullUrl, (req.body ?? {}));
    if (!valid) {
        throw new errors_1.AppError("invalid_signature", "Invalid Twilio signature.", 403);
    }
}
router.get("/dialer/token", auth_1.requireAuth, (0, auth_1.requireAuthorization)({
    roles: [roles_1.ROLES.ADMIN, roles_1.ROLES.STAFF],
    capabilities: [capabilities_1.CAPABILITIES.COMMUNICATIONS_CALL],
}), (0, routeWrap_1.wrap)(async (req) => {
    const identity = req.user?.userId;
    if (!identity) {
        throw new errors_1.AppError("invalid_token", "Invalid or expired token.", 401);
    }
    const activeCalls = await db_1.pool.runQuery(`select count(*)::text as count
       from call_logs
       where staff_user_id = $1
         and status in ('ringing', 'in_progress')`, [identity]);
    if (Number(activeCalls.rows[0]?.count ?? "0") > 0) {
        return (0, apiResponse_1.fail)(null, "active_call_in_progress");
    }
    const token = new AccessToken_1.default(config_1.config.twilio.accountSid ?? "", config_1.config.twilio.apiKey ?? "", config_1.config.twilio.apiSecret ?? "", { identity, ttl: 3600 });
    token.addGrant(new AccessToken_2.VoiceGrant({
        outgoingApplicationSid: config_1.config.twilio.voiceAppSid,
        incomingAllow: true,
    }));
    return (0, apiResponse_1.ok)({ token: token.toJwt() });
}));
router.post("/twilio/voice", dialerRateLimit, (0, routeWrap_1.wrap)(async (req, res) => {
    assertValidTwilioSignature(req);
    const from = typeof req.body?.From === "string" ? req.body.From : "";
    const callSid = typeof req.body?.CallSid === "string" ? req.body.CallSid : "";
    const dialAction = `${config_1.config.app.baseUrl?.replace(/\/$/, "") ?? ""}/api/twilio/voice/action`;
    const response = new twilioRuntime.twiml.VoiceResponse();
    const client = await db_1.pool.connect();
    try {
        const assignedRes = await client.runQuery(`select cl.staff_user_id, cl.crm_contact_id as client_id
         from call_logs cl
         where cl.phone_number = $1 and cl.staff_user_id is not null
         order by cl.created_at desc
         limit 1`, [from]);
        const assignedStaff = assignedRes.rows[0]?.staff_user_id ?? null;
        const clientId = assignedRes.rows[0]?.client_id ?? null;
        const dial = response.dial({ timeout: 20, answerOnBridge: true, action: `${dialAction}?clientId=${clientId ?? ""}&callSid=${callSid}` });
        if (assignedStaff) {
            dial.client(assignedStaff);
        }
        const fallbackStaff = await client.runQuery(`select id
         from users
         where role in ('admin','staff')
           and active = true
           and coalesce(disabled, false) = false
           and coalesce(is_active, true) = true`);
        for (const row of fallbackStaff.rows) {
            if (row.id !== assignedStaff) {
                dial.client(row.id);
            }
        }
        (0, logger_1.logInfo)("dialer.call_started", {
            staff_id: assignedStaff,
            application_id: null,
            silo: "twilio",
            duration: null,
            call_sid: callSid,
        });
    }
    finally {
        client.release();
    }
    res.type("text/xml").send(response.toString());
}));
router.post("/twilio/voice/action", dialerRateLimit, (0, routeWrap_1.wrap)(async (req, res) => {
    assertValidTwilioSignature(req);
    const dialStatus = typeof req.body?.DialCallStatus === "string" ? req.body.DialCallStatus : "";
    const response = new twilioRuntime.twiml.VoiceResponse();
    if (dialStatus !== "completed") {
        response.say("No one was available. Please leave a voicemail after the tone.");
        response.record({
            maxLength: 120,
            timeout: 5,
            playBeep: true,
            recordingStatusCallback: `${config_1.config.app.baseUrl?.replace(/\/$/, "") ?? ""}/api/twilio/recording?clientId=${typeof req.query.clientId === "string" ? req.query.clientId : ""}&callSid=${typeof req.query.callSid === "string" ? req.query.callSid : ""}`,
            recordingStatusCallbackMethod: "POST",
        });
    }
    res.type("text/xml").send(response.toString());
}));
router.post("/twilio/recording", dialerRateLimit, (0, routeWrap_1.wrap)(async (req) => {
    assertValidTwilioSignature(req);
    const recordingUrl = typeof req.body?.RecordingUrl === "string" ? req.body.RecordingUrl : "";
    const recordingSid = typeof req.body?.RecordingSid === "string" ? req.body.RecordingSid : "";
    const callSid = typeof req.body?.CallSid === "string" ? req.body.CallSid : (typeof req.query.callSid === "string" ? req.query.callSid : "");
    const clientId = typeof req.query.clientId === "string" ? req.query.clientId : null;
    if (!recordingUrl || !recordingSid || !callSid) {
        throw new errors_1.AppError("validation_error", "Missing recording payload.", 400);
    }
    await (0, voicemail_repo_1.createVoicemail)({
        clientId,
        callSid,
        recordingSid,
        recordingUrl,
    });
    const callLog = await (0, calls_repo_1.findCallLogByTwilioSid)(callSid);
    (0, logger_1.logInfo)("dialer.voicemail_recorded", {
        staff_id: callLog?.staff_user_id ?? null,
        application_id: callLog?.application_id ?? null,
        silo: "twilio",
        duration: null,
        call_sid: callSid,
    });
    return (0, apiResponse_1.ok)({ ok: true });
}));
router.post("/twilio/status", dialerRateLimit, (0, routeWrap_1.wrap)(async (req, res) => {
    assertValidTwilioSignature(req);
    const callSid = typeof req.body?.CallSid === "string" ? req.body.CallSid : "";
    const callStatus = typeof req.body?.CallStatus === "string" ? req.body.CallStatus : "";
    if (!callSid) {
        throw new errors_1.AppError("validation_error", "Missing CallSid.", 400);
    }
    const found = await (0, calls_repo_1.findCallLogByTwilioSid)(callSid);
    if (!found) {
        return (0, apiResponse_1.ok)({ ok: true });
    }
    let status = "failed";
    if (callStatus === "ringing")
        status = "ringing";
    else if (callStatus === "in-progress" || callStatus === "answered")
        status = "in_progress";
    else if (callStatus === "completed")
        status = "completed";
    const durationSeconds = typeof req.body?.CallDuration === "string" ? Number(req.body.CallDuration) : undefined;
    const isCompleted = callStatus === "completed";
    await (0, calls_service_1.updateCallStatus)({
        id: found.id,
        status,
        durationSeconds,
        errorCode: typeof req.body?.ErrorCode === "string" ? req.body.ErrorCode : undefined,
        errorMessage: typeof req.body?.ErrorMessage === "string" ? req.body.ErrorMessage : undefined,
        fromNumber: typeof req.body?.From === "string" ? req.body.From : undefined,
        toNumber: typeof req.body?.To === "string" ? req.body.To : undefined,
    });
    const priceEstimateCents = isCompleted && typeof durationSeconds === "number" ? durationSeconds * 3 : null;
    await db_1.pool.runQuery(`update call_logs
       set answered = $1,
           ended_reason = $2,
           price_estimate_cents = $3
       where id = $4`, [isCompleted, callStatus || null, priceEstimateCents, found.id]);
    if (callStatus === "no-answer") {
        const hasVoicemail = await db_1.pool.runQuery("select count(*)::text as count from voicemails where call_sid = $1", [callSid]);
        if (Number(hasVoicemail.rows[0]?.count ?? "0") === 0) {
            await db_1.pool.runQuery(`insert into crm_task (id, type, staff_id, phone_number, created_at)
           values ($1, 'missed_call', $2, $3, now())`, [(0, crypto_1.randomUUID)(), found.staff_user_id, found.phone_number]);
        }
    }
    if (callStatus === "completed") {
        (0, logger_1.logInfo)("dialer.call_completed", {
            staff_id: found.staff_user_id,
            application_id: found.application_id,
            silo: "twilio",
            duration: durationSeconds ?? null,
            call_sid: callSid,
        });
    }
    else if (callStatus === "failed" || callStatus === "busy" || callStatus === "no-answer") {
        (0, logger_1.logWarn)("dialer.call_failed", {
            staff_id: found.staff_user_id,
            application_id: found.application_id,
            silo: "twilio",
            duration: durationSeconds ?? null,
            call_sid: callSid,
            ended_reason: callStatus,
        });
    }
    return (0, apiResponse_1.ok)({ ok: true });
}));
exports.default = router;
