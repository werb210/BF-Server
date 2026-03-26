import { Router, type RequestHandler } from "express";
import { randomUUID } from "crypto";
import twilio from "twilio";
import AccessToken from "twilio/lib/jwt/AccessToken";
import { VoiceGrant } from "twilio/lib/jwt/AccessToken";
import { requireAuth, requireAuthorization } from "../middleware/auth";
import { CAPABILITIES } from "../auth/capabilities";
import { ROLES } from "../auth/roles";
import { AppError } from "../middleware/errors";
import { safeHandler } from "../middleware/safeHandler";
import { pool } from "../db";
import { updateCallStatus } from "../modules/calls/calls.service";
import { findCallLogByTwilioSid } from "../modules/calls/calls.repo";
import { createVoicemail } from "../modules/voice/voicemail.repo";
import { logInfo, logWarn } from "../observability/logger";
import { config } from "../config";

const router = Router();
const oneMinuteMs = 60_000;
const RATE_BUCKET_TTL_MS = 5 * oneMinuteMs;
const MAX_BUCKETS = 1_000;

type Bucket = { count: number; resetAt: number };
const ipBuckets = new Map<string, Bucket>();
const staffBuckets = new Map<string, Bucket>();

function consumeRateLimit(buckets: Map<string, Bucket>, key: string, max: number): boolean {
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

function fetchIpKey(req: { ip?: string; headers: Record<string, unknown> }): string {
  const forwarded = typeof req.headers["x-forwarded-for"] === "string" ? req.headers["x-forwarded-for"].split(",")[0] : null;
  return (forwarded?.trim() || req.ip || "unknown").toLowerCase();
}

async function resolveStaffUserId(req: { body?: Record<string, unknown>; query?: Record<string, unknown> }): Promise<string | null> {
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

  const callLog = await findCallLogByTwilioSid(callSid);
  return callLog?.staff_user_id ?? null;
}

const dialerRateLimit: RequestHandler = async (req: any, res: any, next: any) => {
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

export function __resetTwilioRateLimitsForTest(): void {
  ipBuckets.clear();
  staffBuckets.clear();
}

const twilioRuntime = twilio as unknown as {
  validateRequest: (authToken: string, signature: string, url: string, params: Record<string, unknown>) => boolean;
  twiml: { VoiceResponse: new () => { dial: (attrs: Record<string, unknown>) => { client: (identity: string) => void }; say: (text: string) => void; record: (attrs: Record<string, unknown>) => void; toString: () => string } };
};

function buildWebhookUrl(req: { protocol: string; get: (name: string) => string | undefined; originalUrl: string }): string {
  const baseUrl = config.app.baseUrl?.trim();
  if (baseUrl) {
    return `${baseUrl.replace(/\/$/, "")}/api${req.originalUrl}`;
  }
  const proto = req.get("x-forwarded-proto") ?? req.protocol;
  const host = req.get("x-forwarded-host") ?? req.get("host");
  return `${proto}://${host ?? "localhost"}${req.originalUrl}`;
}

function assertValidTwilioSignature(req: { headers: Record<string, unknown>; get: (name: string) => string | undefined; body: unknown; protocol: string; originalUrl: string }): void {
  const authToken = config.twilio.authToken;
  if (!authToken || !authToken.trim()) {
    throw new AppError("twilio_misconfigured", "Twilio auth token is missing.", 500);
  }
  const signature = req.get("x-twilio-signature");
  if (!signature) {
    throw new AppError("invalid_signature", "Missing Twilio signature.", 403);
  }
  const fullUrl = buildWebhookUrl(req);
  const valid = twilioRuntime.validateRequest(authToken.trim(), signature, fullUrl, (req.body ?? {}) as Record<string, unknown>);
  if (!valid) {
    throw new AppError("invalid_signature", "Invalid Twilio signature.", 403);
  }
}

router.get(
  "/dialer/token",
  requireAuth,
  requireAuthorization({
    roles: [ROLES.ADMIN, ROLES.STAFF],
    capabilities: [CAPABILITIES.COMMUNICATIONS_CALL],
  }),
  safeHandler(async (req: any, res: any, next: any) => {
    const identity = req.user?.userId;
    if (!identity) {
      throw new AppError("invalid_token", "Invalid or expired token.", 401);
    }

    const activeCalls = await pool.query<{ count: string }>(
      `select count(*)::text as count
       from call_logs
       where staff_user_id = $1
         and status in ('ringing', 'in_progress')`,
      [identity]
    );

    if (Number(activeCalls.rows[0]?.count ?? "0") > 0) {
      res.status(409).json({ code: "active_call_in_progress" });
      return;
    }

    const token = new AccessToken(
      config.twilio.accountSid ?? "",
      config.twilio.apiKey ?? "",
      config.twilio.apiSecret ?? "",
      { identity, ttl: 3600 }
    );

    token.addGrant(
      new VoiceGrant({
        outgoingApplicationSid: config.twilio.voiceAppSid,
        incomingAllow: true,
      })
    );

    res.json({ token: token.toJwt() });
  })
);

router.post(
  "/twilio/voice",
  dialerRateLimit,
  safeHandler(async (req: any, res: any, next: any) => {
    assertValidTwilioSignature(req);

    const from = typeof req.body?.From === "string" ? req.body.From : "";
    const callSid = typeof req.body?.CallSid === "string" ? req.body.CallSid : "";
    const dialAction = `${config.app.baseUrl?.replace(/\/$/, "") ?? ""}/api/twilio/voice/action`;

    const response = new twilioRuntime.twiml.VoiceResponse();
    const client = await pool.connect();
    try {
      const assignedRes = await client.query<{ staff_user_id: string | null; client_id: string | null }>(
        `select cl.staff_user_id, cl.crm_contact_id as client_id
         from call_logs cl
         where cl.phone_number = $1 and cl.staff_user_id is not null
         order by cl.created_at desc
         limit 1`,
        [from]
      );
      const assignedStaff = assignedRes.rows[0]?.staff_user_id ?? null;
      const clientId = assignedRes.rows[0]?.client_id ?? null;

      const dial = response.dial({ timeout: 20, answerOnBridge: true, action: `${dialAction}?clientId=${clientId ?? ""}&callSid=${callSid}` });
      if (assignedStaff) {
        dial.client(assignedStaff);
      }

      const fallbackStaff = await client.query<{ id: string }>(
        `select id
         from users
         where role in ('admin','staff')
           and active = true
           and coalesce(disabled, false) = false
           and coalesce(is_active, true) = true`
      );

      for (const row of fallbackStaff.rows) {
        if (row.id !== assignedStaff) {
          dial.client(row.id);
        }
      }

      logInfo("dialer.call_started", {
        staff_id: assignedStaff,
        application_id: null,
        silo: "twilio",
        duration: null,
        call_sid: callSid,
      });
    } finally {
      client.release();
    }

    res.type("text/xml").send(response.toString());
  })
);

router.post(
  "/twilio/voice/action",
  dialerRateLimit,
  safeHandler(async (req: any, res: any, next: any) => {
    assertValidTwilioSignature(req);
    const dialStatus = typeof req.body?.DialCallStatus === "string" ? req.body.DialCallStatus : "";

    const response = new twilioRuntime.twiml.VoiceResponse();
    if (dialStatus !== "completed") {
      response.say("No one was available. Please leave a voicemail after the tone.");
      response.record({
        maxLength: 120,
        timeout: 5,
        playBeep: true,
        recordingStatusCallback: `${config.app.baseUrl?.replace(/\/$/, "") ?? ""}/api/twilio/recording?clientId=${typeof req.query.clientId === "string" ? req.query.clientId : ""}&callSid=${typeof req.query.callSid === "string" ? req.query.callSid : ""}`,
        recordingStatusCallbackMethod: "POST",
      });
    }

    res.type("text/xml").send(response.toString());
  })
);

router.post(
  "/twilio/recording",
  dialerRateLimit,
  safeHandler(async (req: any, res: any, next: any) => {
    assertValidTwilioSignature(req);

    const recordingUrl = typeof req.body?.RecordingUrl === "string" ? req.body.RecordingUrl : "";
    const recordingSid = typeof req.body?.RecordingSid === "string" ? req.body.RecordingSid : "";
    const callSid = typeof req.body?.CallSid === "string" ? req.body.CallSid : (typeof req.query.callSid === "string" ? req.query.callSid : "");
    const clientId = typeof req.query.clientId === "string" ? req.query.clientId : null;

    if (!recordingUrl || !recordingSid || !callSid) {
      throw new AppError("validation_error", "Missing recording payload.", 400);
    }

    await createVoicemail({
      clientId,
      callSid,
      recordingSid,
      recordingUrl,
    });

    const callLog = await findCallLogByTwilioSid(callSid);
    logInfo("dialer.voicemail_recorded", {
      staff_id: callLog?.staff_user_id ?? null,
      application_id: callLog?.application_id ?? null,
      silo: "twilio",
      duration: null,
      call_sid: callSid,
    });

    res.status(200).json({ ok: true });
  })
);

router.post(
  "/twilio/status",
  dialerRateLimit,
  safeHandler(async (req: any, res: any, next: any) => {
    assertValidTwilioSignature(req);
    const callSid = typeof req.body?.CallSid === "string" ? req.body.CallSid : "";
    const callStatus = typeof req.body?.CallStatus === "string" ? req.body.CallStatus : "";
    if (!callSid) {
      throw new AppError("validation_error", "Missing CallSid.", 400);
    }

    const found = await findCallLogByTwilioSid(callSid);
    if (!found) {
      res.status(200).json({ ok: true });
      return;
    }

    let status: "ringing" | "in_progress" | "completed" | "failed" = "failed";
    if (callStatus === "ringing") status = "ringing";
    else if (callStatus === "in-progress" || callStatus === "answered") status = "in_progress";
    else if (callStatus === "completed") status = "completed";

    const durationSeconds = typeof req.body?.CallDuration === "string" ? Number(req.body.CallDuration) : undefined;
    const isCompleted = callStatus === "completed";

    await updateCallStatus({
      id: found.id,
      status,
      durationSeconds,
      errorCode: typeof req.body?.ErrorCode === "string" ? req.body.ErrorCode : undefined,
      errorMessage: typeof req.body?.ErrorMessage === "string" ? req.body.ErrorMessage : undefined,
      fromNumber: typeof req.body?.From === "string" ? req.body.From : undefined,
      toNumber: typeof req.body?.To === "string" ? req.body.To : undefined,
    });

    const priceEstimateCents = isCompleted && typeof durationSeconds === "number" ? durationSeconds * 3 : null;
    await pool.query(
      `update call_logs
       set answered = $1,
           ended_reason = $2,
           price_estimate_cents = $3
       where id = $4`,
      [isCompleted, callStatus || null, priceEstimateCents, found.id]
    );

    if (callStatus === "no-answer") {
      const hasVoicemail = await pool.query<{ count: string }>(
        "select count(*)::text as count from voicemails where call_sid = $1",
        [callSid]
      );
      if (Number(hasVoicemail.rows[0]?.count ?? "0") === 0) {
        await pool.query(
          `insert into crm_task (id, type, staff_id, phone_number, created_at)
           values ($1, 'missed_call', $2, $3, now())`,
          [randomUUID(), found.staff_user_id, found.phone_number]
        );
      }
    }

    if (callStatus === "completed") {
      logInfo("dialer.call_completed", {
        staff_id: found.staff_user_id,
        application_id: found.application_id,
        silo: "twilio",
        duration: durationSeconds ?? null,
        call_sid: callSid,
      });
    } else if (callStatus === "failed" || callStatus === "busy" || callStatus === "no-answer") {
      logWarn("dialer.call_failed", {
        staff_id: found.staff_user_id,
        application_id: found.application_id,
        silo: "twilio",
        duration: durationSeconds ?? null,
        call_sid: callSid,
        ended_reason: callStatus,
      });
    }

    res.status(200).json({ ok: true });
  })
);

export default router;
