import { Router, type Request } from "express";
import { z } from "zod";
import { ok } from "../lib/response.js";
import { requireAuth, requireAuthorization } from "../middleware/auth.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { getSilo } from "../middleware/silo.js";
import { ROLES } from "../auth/roles.js";
import { AppError } from "../middleware/errors.js";
import { dbQuery } from "../db.js";
import { logCrmEvent } from "../modules/crm/crmTimeline.service.js";
import { endCall, listCalls, startCall, updateCallStatus } from "../modules/calls/calls.service.js";
import { type CallStatus } from "../modules/calls/calls.repo.js";
import { toStringSafe } from "../utils/toStringSafe.js";

const router = Router();

const callStartSchema = z.object({
  phoneNumber: z.string().min(1),
  direction: z.enum(["outbound", "inbound"]),
  status: z
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
  crmContactId: z.string().uuid().optional(),
  applicationId: z.string().uuid().optional(),
});

const callStatusSchema = z.object({
  status: z.enum([
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
  durationSeconds: z.number().int().nonnegative().optional().nullable(),
});

const callEndSchema = z.object({
  durationSeconds: z.number().int().nonnegative().optional().nullable(),
});

const uuidSchema = z.string().uuid();

const transcriptSchema = z.object({
  callSid: z.string(),
  transcript: z.string(),
  summary: z.string().optional(),
  score: z.number().optional(),
  crmContactId: z.string().uuid().optional(),
  applicationId: z.string().uuid().optional(),
});

function buildRequestMetadata(req: Request): { ip?: string; userAgent?: string } {
  const metadata: { ip?: string; userAgent?: string } = {};
  if (req.ip) {
    metadata.ip = req.ip;
  }
  const userAgent = req.get("user-agent");
  if (userAgent) {
    metadata.userAgent = userAgent;
  }
  return metadata;
}

router.post(
  "/log",
  // BF_SERVER_BLOCK_v143_CALLS_LOG_AUTH_v1 — every other /api/calls/*
  // route gates on requireAuth + ADMIN/STAFF. /log was missing both,
  // letting anyone POST fake completed call records.
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  safeHandler(async (req: any, res: any, next: any) => {
    // BF_SERVER_BLOCK_v332_SETTINGS_AND_AUDIT_HARDENING_v1 -- Edit 7
    // Pre-fix staff_id was a body-supplied UUID. Any authenticated
    // ADMIN/STAFF user could log a call against any other staff member's
    // identity by passing their UUID, poisoning call attribution and the
    // CRM timeline. Source staff_id from the verified JWT (req.user.userId)
    // instead. The body field stays in the schema for backward compat
    // (iOS dialer still sends it) but we ignore its value.
    const parsed = z
      .object({
        staff_id: z.string().uuid().optional(),
        client_id: z.string().uuid(),
        phone_number: z.string().min(1),
        call_duration: z.number().int().nonnegative().default(0),
        direction: z.enum(["outbound", "inbound"]),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError("validation_error", "Invalid call log payload.", 400);
    }
    const callerStaffId = typeof req.user?.userId === "string" ? req.user.userId : null;
    if (!callerStaffId) {
      throw new AppError("missing_token", "Authorization token is required.", 401);
    }

    const record = await startCall({
      phoneNumber: parsed.data.phone_number.trim(),
      direction: parsed.data.direction,
      staffUserId: callerStaffId,
      status: "completed",
      crmContactId: parsed.data.client_id,
      ...buildRequestMetadata(req),
    });

    const updated = await updateCallStatus({
      id: record.id,
      status: "completed",
      durationSeconds: parsed.data.call_duration,
      actorUserId: callerStaffId,
      ...buildRequestMetadata(req),
    });

    res.status(201).json(ok({ call: updated ?? record }, req.rid));
  })
);

router.post(
  "/start",
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  safeHandler(async (req: any, res: any, next: any) => {
    const parsed = callStartSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError("validation_error", "Invalid call payload.", 400);
    }

    const startPayload = {
      phoneNumber: parsed.data.phoneNumber.trim(),
      direction: parsed.data.direction,
      staffUserId: req.user?.userId ?? null,
      ...(parsed.data.status ? { status: parsed.data.status as CallStatus } : {}),
      ...(parsed.data.crmContactId ? { crmContactId: parsed.data.crmContactId } : {}),
      ...(parsed.data.applicationId ? { applicationId: parsed.data.applicationId } : {}),
      silo: getSilo(res),
      ...buildRequestMetadata(req),
    };
    const record = await startCall(startPayload);

    res.status(201).json(ok({ call: record }, req.rid));
  })
);

router.post(
  "/:id/status",
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  safeHandler(async (req: any, res: any, next: any) => {
    const id = toStringSafe(req.params.id);
    if (!id || !uuidSchema.safeParse(id).success) {
      throw new AppError("validation_error", "Invalid call id.", 400);
    }
    const parsed = callStatusSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError("validation_error", "Invalid call status payload.", 400);
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
    const updated = await updateCallStatus(updatePayload);

    res.status(200).json(ok({ call: updated }, req.rid));
  })
);

router.post(
  "/:id/end",
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  safeHandler(async (req: any, res: any, next: any) => {
    const id = toStringSafe(req.params.id);
    if (!id || !uuidSchema.safeParse(id).success) {
      throw new AppError("validation_error", "Invalid call id.", 400);
    }
    const parsed = callEndSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError("validation_error", "Invalid call end payload.", 400);
    }

    const endPayload = {
      id,
      staffUserId: req.user?.userId ?? null,
      ...(parsed.data.durationSeconds !== undefined
        ? { durationSeconds: parsed.data.durationSeconds }
        : {}),
      ...buildRequestMetadata(req),
    };
    const updated = await endCall(endPayload);

    res.status(200).json(ok({ call: updated }, req.rid));
  })
);


router.post(
  "/transcript",
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  safeHandler(async (req: any, res: any) => {
    const parsed = transcriptSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError("validation_error", "Invalid transcript payload.", 400);
    }

    const { callSid, transcript, summary, score, crmContactId, applicationId } = parsed.data;

    await dbQuery(
      `update call_logs set transcript = $1, summary = $2, score = $3, updated_at = now()
       where twilio_call_sid = $4`,
      [transcript, summary ?? null, score ?? null, callSid]
    );

    if (crmContactId) {
      await logCrmEvent({
        contactId: crmContactId,
        applicationId: applicationId ?? null,
        eventType: "call_made",
        payload: { callSid, transcriptPreview: transcript.slice(0, 200), score },
        actorUserId: req.user?.userId,
      });
    }

    res.status(200).json({ ok: true });
  })
);

router.get(
  "/",
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  safeHandler(async (req: any, res: any, next: any) => {
    const contactId = typeof toStringSafe(req.query.contactId) === "string" ? toStringSafe(req.query.contactId) : null;
    const applicationId =
      typeof toStringSafe(req.query.applicationId) === "string" ? toStringSafe(req.query.applicationId) : null;

    if (contactId && !uuidSchema.safeParse(contactId).success) {
      throw new AppError("validation_error", "Invalid contactId.", 400);
    }
    if (applicationId && !uuidSchema.safeParse(applicationId).success) {
      throw new AppError("validation_error", "Invalid applicationId.", 400);
    }

    const calls = await listCalls({ contactId, applicationId, silo: getSilo(res) });
    res.status(200).json(ok({ calls }, req.rid));
  })
);

// BF_SERVER_AUTO_CALL_SUMMARY_v245 - dialer polls this after a call ends.
router.get(
  "/summary",
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  safeHandler(async (req: any, res: any) => {
    const callSid = toStringSafe(req.query.callSid);
    if (typeof callSid !== "string" || !/^CA[0-9a-f]{32}$/i.test(callSid)) {
      throw new AppError("validation_error", "Invalid callSid.", 400);
    }
    // BF_SERVER_v831_DIALER_POLISH - anyone signed in could read any call's summary by its CallSid. Same rule as
    // /:callSid/summary now: Admin, the call's creator, or a staff member who was on the call.
    const { dialerCallSummary, summaryForCallSid } = await import("../services/calls/autoCallSummary.js");
    const userId = String(req.user?.userId ?? req.user?.id ?? req.user?.sub ?? "");
    const access = await dialerCallSummary(callSid, { userId, isAdmin: req.user?.role === ROLES.ADMIN });
    if (access.access === "forbidden") {
      return res.status(403).json({ ok: false, error: "forbidden", message: "You can only read summaries of calls you were on." });
    }
    res.status(200).json(ok(await summaryForCallSid(callSid), req.rid));
  })
);

// BF_SERVER_v821_DIALER - the iPhone dialler / Watch post-call card: AI summary + next steps for one call.
//   GET /api/calls/:callSid/summary -> { status: "pending"|"ready"|"none", summary?, nextSteps?, taskId?, contactId?, contactName? }
// :callSid is a Twilio CallSid (any leg the app holds) or a Watch bridge id. Staff read only calls they are on
// (creator or staff participant, as voiceMidCall.ts); Admin reads any. Unknown -> { status: "none" }.
router.get(
  "/:callSid/summary",
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  safeHandler(async (req: any, res: any) => {
    const callSid = String(req.params.callSid ?? "").trim();
    if (!/^CA[0-9a-f]{32}$/i.test(callSid) && !uuidSchema.safeParse(callSid).success) {
      throw new AppError("validation_error", "Invalid callSid.", 400);
    }
    const userId = String(req.user?.userId ?? req.user?.id ?? req.user?.sub ?? "");
    const { dialerCallSummary } = await import("../services/calls/autoCallSummary.js");
    const result = await dialerCallSummary(callSid, { userId, isAdmin: req.user?.role === ROLES.ADMIN });
    if (result.access === "forbidden") {
      return res.status(403).json({ ok: false, error: "forbidden", message: "You can only read summaries of calls you were on." });
    }
    return res.status(200).json(result.body);
  })
);

export default router;
