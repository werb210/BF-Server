import { Router, type Request } from "express";
import { z } from "zod";
import { requireAuth, requireAuthorization } from "../middleware/auth";
import { safeHandler } from "../middleware/safeHandler";
import { ROLES } from "../auth/roles";
import { AppError } from "../middleware/errors";
import { voiceRateLimit } from "../middleware/rateLimit";
import { CAPABILITIES } from "../auth/capabilities";
import {
  issueVoiceToken,
  startVoiceCall,
  endVoiceCall,
  updateVoiceCallStatus,
  recordVoiceCallRecording,
  controlVoiceCall,
  fetchVoiceAvailability,
  fetchVoiceCallStatus,
} from "../modules/voice/voice.service";
import { listCalls } from "../modules/calls/calls.service";

const router = Router();

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

const voiceTokenSchema = z.object({});

const callStartSchema = z
  .object({
    fromStaffUserId: z.string().uuid().optional(),
    toPhone: z.string().min(1).optional(),
    phoneNumber: z.string().min(1).optional(),
    contactId: z.string().uuid().optional(),
    applicationId: z.string().uuid().optional(),
    callSid: z.string().min(1).optional(),
  })
  .refine((data) => Boolean(data.toPhone ?? data.phoneNumber), {
    message: "toPhone is required.",
  });

const callCreateSchema = z
  .object({
    to: z.string().min(1).optional(),
    toPhone: z.string().min(1).optional(),
    contactId: z.string().uuid().optional(),
    applicationId: z.string().uuid().optional(),
  })
  .refine((data) => Boolean(data.to ?? data.toPhone), {
    message: "to is required.",
  });

const callEndSchema = z.object({
  callSid: z.string().min(1),
  status: z.enum(["completed", "failed", "cancelled", "canceled"]).optional(),
  durationSeconds: z.number().int().nonnegative().optional().nullable(),
});

const callControlSchema = z.object({
  callSid: z.string().min(1),
});

const callStatusSchema = z
  .object({
    callSid: z.string().min(1),
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
    callStatus: z.string().min(1).optional(),
    durationSeconds: z.number().int().nonnegative().optional().nullable(),
    callDuration: z.string().min(1).optional(),
  })
  .strict();

const callRecordingSchema = z.object({
  callSid: z.string().min(1),
  recordingSid: z.string().min(1),
  recordingDurationSeconds: z.number().int().nonnegative().optional().nullable(),
  recordingDuration: z.string().min(1).optional(),
});

const uuidSchema = z.string().uuid();

const contextSchema = z
  .string()
  .min(1)
  .transform((value) => value.trim())
  .refine((value) => value.length > 0, "Invalid context")
  .optional();

function parseContext(context?: string): { contactId?: string; applicationId?: string } {
  if (!context) return {};
  const trimmed = context.trim();
  const parts = trimmed.split(":");
  if (parts.length === 2) {
    const [kind, id] = parts;
    if (!id) {
      return {};
    }
    if (kind === "contact") return { contactId: id };
    if (kind === "application") return { applicationId: id };
  }
  return { contactId: trimmed };
}

function resolveStaffUserId(params: {
  requesterId: string | null;
  requesterRole: string | null;
  fromStaffUserId?: string | null;
}): string | null {
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
  if (params.requesterRole === ROLES.ADMIN) {
    return requested;
  }
  throw new AppError("forbidden", "You do not have access to this staff user.", 403);
}

function assertVoiceEnabled(): void {
  const availability = fetchVoiceAvailability();
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

router.post(
  "/token",
  requireAuth,
  requireAuthorization({
    roles: [ROLES.ADMIN, ROLES.STAFF],
    capabilities: [CAPABILITIES.COMMUNICATIONS_CALL],
  }),
  voiceRateLimit(),
  safeHandler(async (req: any, res: any, next: any) => {
    assertVoiceEnabled();
    const parsed = voiceTokenSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError("validation_error", "Invalid token request.", 400);
    }

    const userId = req.user?.userId;
    if (!userId) {
      throw new AppError("invalid_token", "Invalid or expired token.", 401);
    }

    const token = issueVoiceToken({ userId });
    res.status(200).json({ ok: true, token });
  })
);

router.post(
  "/call",
  requireAuth,
  requireAuthorization({
    roles: [ROLES.ADMIN, ROLES.STAFF],
    capabilities: [CAPABILITIES.COMMUNICATIONS_CALL],
  }),
  voiceRateLimit(),
  safeHandler(async (req: any, res: any, next: any) => {
    assertVoiceEnabled();
    const parsed = callCreateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError("validation_error", "Invalid call payload.", 400);
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
    const result = await startVoiceCall(startPayload);

    res.status(201).json({
      ok: true,
      callSid: result.callSid,
      call: result.call,
    });
  })
);

router.post(
  "/call/start",
  requireAuth,
  requireAuthorization({
    roles: [ROLES.ADMIN, ROLES.STAFF],
    capabilities: [CAPABILITIES.COMMUNICATIONS_CALL],
  }),
  voiceRateLimit(),
  safeHandler(async (req: any, res: any, next: any) => {
    assertVoiceEnabled();
    const parsed = callStartSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError("validation_error", "Invalid call payload.", 400);
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
    const result = await startVoiceCall(startPayload);

    res.status(201).json({
      ok: true,
      callSid: result.callSid,
      call: result.call,
    });
  })
);

router.post(
  "/call/mute",
  requireAuth,
  requireAuthorization({
    roles: [ROLES.ADMIN, ROLES.STAFF],
    capabilities: [CAPABILITIES.COMMUNICATIONS_CALL],
  }),
  voiceRateLimit(),
  safeHandler(async (req: any, res: any, next: any) => {
    assertVoiceEnabled();
    const parsed = callControlSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError("validation_error", "Invalid call control payload.", 400);
    }

    const controlPayload = {
      callSid: parsed.data.callSid,
      action: "mute" as const,
      staffUserId: req.user?.userId ?? null,
      ...buildRequestMetadata(req),
    };
    const updated = await controlVoiceCall(controlPayload);

    res.status(200).json({ ok: true, call: updated });
  })
);

router.post(
  "/call/hold",
  requireAuth,
  requireAuthorization({
    roles: [ROLES.ADMIN, ROLES.STAFF],
    capabilities: [CAPABILITIES.COMMUNICATIONS_CALL],
  }),
  voiceRateLimit(),
  safeHandler(async (req: any, res: any, next: any) => {
    assertVoiceEnabled();
    const parsed = callControlSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError("validation_error", "Invalid call control payload.", 400);
    }

    const controlPayload = {
      callSid: parsed.data.callSid,
      action: "hold" as const,
      staffUserId: req.user?.userId ?? null,
      ...buildRequestMetadata(req),
    };
    const updated = await controlVoiceCall(controlPayload);

    res.status(200).json({ ok: true, call: updated });
  })
);

router.post(
  "/call/resume",
  requireAuth,
  requireAuthorization({
    roles: [ROLES.ADMIN, ROLES.STAFF],
    capabilities: [CAPABILITIES.COMMUNICATIONS_CALL],
  }),
  voiceRateLimit(),
  safeHandler(async (req: any, res: any, next: any) => {
    assertVoiceEnabled();
    const parsed = callControlSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError("validation_error", "Invalid call control payload.", 400);
    }

    const controlPayload = {
      callSid: parsed.data.callSid,
      action: "resume" as const,
      staffUserId: req.user?.userId ?? null,
      ...buildRequestMetadata(req),
    };
    const updated = await controlVoiceCall(controlPayload);

    res.status(200).json({ ok: true, call: updated });
  })
);

router.post(
  "/call/hangup",
  requireAuth,
  requireAuthorization({
    roles: [ROLES.ADMIN, ROLES.STAFF],
    capabilities: [CAPABILITIES.COMMUNICATIONS_CALL],
  }),
  voiceRateLimit(),
  safeHandler(async (req: any, res: any, next: any) => {
    assertVoiceEnabled();
    const parsed = callControlSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError("validation_error", "Invalid call control payload.", 400);
    }

    const controlPayload = {
      callSid: parsed.data.callSid,
      action: "hangup" as const,
      staffUserId: req.user?.userId ?? null,
      ...buildRequestMetadata(req),
    };
    const updated = await controlVoiceCall(controlPayload);

    res.status(200).json({ ok: true, call: updated });
  })
);

router.post(
  "/call/end",
  requireAuth,
  requireAuthorization({
    roles: [ROLES.ADMIN, ROLES.STAFF],
    capabilities: [CAPABILITIES.COMMUNICATIONS_CALL],
  }),
  voiceRateLimit(),
  safeHandler(async (req: any, res: any, next: any) => {
    assertVoiceEnabled();
    const parsed = callEndSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError("validation_error", "Invalid call end payload.", 400);
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
    const updated = await endVoiceCall(endPayload);

    res.status(200).json({ ok: true, call: updated });
  })
);

router.post(
  "/call/status",
  requireAuth,
  requireAuthorization({
    roles: [ROLES.ADMIN, ROLES.STAFF],
    capabilities: [CAPABILITIES.COMMUNICATIONS_CALL],
  }),
  voiceRateLimit(),
  safeHandler(async (req: any, res: any, next: any) => {
    assertVoiceEnabled();
    const parsed = callStatusSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError("validation_error", "Invalid call status payload.", 400);
    }

    if (!parsed.data.status && !parsed.data.callStatus) {
      const current = await fetchVoiceCallStatus({
        callSid: parsed.data.callSid,
        staffUserId: req.user?.userId ?? null,
      });
      res.status(200).json({ ok: true, call: current });
      return;
    }

    const durationSeconds =
      parsed.data.durationSeconds ??
      (parsed.data.callDuration ? Number(parsed.data.callDuration) : undefined);

    const normalizedDuration =
      durationSeconds !== undefined && Number.isFinite(durationSeconds)
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
    const updated = await updateVoiceCallStatus(updatePayload);

    res.status(200).json({ ok: true, call: updated });
  })
);

router.post(
  "/call/recording",
  requireAuth,
  requireAuthorization({
    roles: [ROLES.ADMIN, ROLES.STAFF],
    capabilities: [CAPABILITIES.COMMUNICATIONS_CALL],
  }),
  voiceRateLimit(),
  safeHandler(async (req: any, res: any, next: any) => {
    assertVoiceEnabled();
    const parsed = callRecordingSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError("validation_error", "Invalid call recording payload.", 400);
    }

    const durationSeconds =
      parsed.data.recordingDurationSeconds ??
      (parsed.data.recordingDuration
        ? Number(parsed.data.recordingDuration)
        : undefined);

    const normalizedDuration =
      durationSeconds !== undefined && Number.isFinite(durationSeconds)
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
    const updated = await recordVoiceCallRecording(recordPayload);

    res.status(200).json({ ok: true, call: updated });
  })
);

router.get(
  "/calls",
  requireAuth,
  requireAuthorization({
    roles: [ROLES.ADMIN, ROLES.STAFF],
    capabilities: [CAPABILITIES.COMMUNICATIONS_CALL],
  }),
  voiceRateLimit(),
  safeHandler(async (req: any, res: any, next: any) => {
    assertVoiceEnabled();
    const contextInput =
      typeof req.query.context === "string" ? req.query.context : undefined;
    const parsedContext = contextSchema.safeParse(contextInput);
    if (!parsedContext.success) {
      throw new AppError("validation_error", "Invalid context.", 400);
    }

    const context = parseContext(parsedContext.data);
    if (context.contactId && !uuidSchema.safeParse(context.contactId).success) {
      throw new AppError("validation_error", "Invalid contactId.", 400);
    }
    if (
      context.applicationId &&
      !uuidSchema.safeParse(context.applicationId).success
    ) {
      throw new AppError("validation_error", "Invalid applicationId.", 400);
    }
    const calls = await listCalls({
      contactId: context.contactId ?? null,
      applicationId: context.applicationId ?? null,
    });
    res.status(200).json({ ok: true, calls });
  })
);

export default router;
