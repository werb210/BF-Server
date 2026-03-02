import { Router } from "express";
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

const router = Router();

const twilioRuntime = twilio as unknown as {
  validateRequest: (authToken: string, signature: string, url: string, params: Record<string, unknown>) => boolean;
  twiml: { VoiceResponse: new () => { dial: (attrs: Record<string, unknown>) => { client: (identity: string) => void }; say: (text: string) => void; record: (attrs: Record<string, unknown>) => void; toString: () => string } };
};

function buildWebhookUrl(req: { protocol: string; get: (name: string) => string | undefined; originalUrl: string }): string {
  const baseUrl = process.env.BASE_URL?.trim();
  if (baseUrl) {
    return `${baseUrl.replace(/\/$/, "")}/api${req.originalUrl}`;
  }
  const proto = req.get("x-forwarded-proto") ?? req.protocol;
  const host = req.get("x-forwarded-host") ?? req.get("host");
  return `${proto}://${host ?? "localhost"}${req.originalUrl}`;
}

function assertValidTwilioSignature(req: { headers: Record<string, unknown>; get: (name: string) => string | undefined; body: unknown; protocol: string; originalUrl: string }): void {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
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
  safeHandler(async (req, res) => {
    const identity = req.user?.userId;
    if (!identity) {
      throw new AppError("invalid_token", "Invalid or expired token.", 401);
    }

    const token = new AccessToken(
      process.env.TWILIO_ACCOUNT_SID ?? "",
      process.env.TWILIO_API_KEY ?? "",
      process.env.TWILIO_API_SECRET ?? "",
      { identity, ttl: 3600 }
    );

    token.addGrant(
      new VoiceGrant({
        outgoingApplicationSid: process.env.TWILIO_VOICE_APP_SID ?? process.env.TWILIO_TWIML_APP_SID,
        incomingAllow: true,
      })
    );

    res.json({ token: token.toJwt() });
  })
);

router.post(
  "/twilio/voice",
  safeHandler(async (req, res) => {
    assertValidTwilioSignature(req);

    const from = typeof req.body?.From === "string" ? req.body.From : "";
    const callSid = typeof req.body?.CallSid === "string" ? req.body.CallSid : "";
    const dialAction = `${process.env.BASE_URL?.replace(/\/$/, "") ?? ""}/api/twilio/voice/action`;

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
    } finally {
      client.release();
    }

    res.type("text/xml").send(response.toString());
  })
);

router.post(
  "/twilio/voice/action",
  safeHandler(async (req, res) => {
    assertValidTwilioSignature(req);
    const dialStatus = typeof req.body?.DialCallStatus === "string" ? req.body.DialCallStatus : "";

    const response = new twilioRuntime.twiml.VoiceResponse();
    if (dialStatus !== "completed") {
      response.say("No one was available. Please leave a voicemail after the tone.");
      response.record({
        maxLength: 120,
        timeout: 5,
        playBeep: true,
        recordingStatusCallback: `${process.env.BASE_URL?.replace(/\/$/, "") ?? ""}/api/twilio/recording?clientId=${typeof req.query.clientId === "string" ? req.query.clientId : ""}&callSid=${typeof req.query.callSid === "string" ? req.query.callSid : ""}`,
        recordingStatusCallbackMethod: "POST",
      });
    }

    res.type("text/xml").send(response.toString());
  })
);

router.post(
  "/twilio/recording",
  safeHandler(async (req, res) => {
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

    res.status(200).json({ ok: true });
  })
);

router.post(
  "/twilio/status",
  safeHandler(async (req, res) => {
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

    await updateCallStatus({
      id: found.id,
      status,
      durationSeconds: typeof req.body?.CallDuration === "string" ? Number(req.body.CallDuration) : undefined,
      errorCode: typeof req.body?.ErrorCode === "string" ? req.body.ErrorCode : undefined,
      errorMessage: typeof req.body?.ErrorMessage === "string" ? req.body.ErrorMessage : undefined,
      fromNumber: typeof req.body?.From === "string" ? req.body.From : undefined,
      toNumber: typeof req.body?.To === "string" ? req.body.To : undefined,
    });

    res.status(200).json({ ok: true });
  })
);

export default router;
