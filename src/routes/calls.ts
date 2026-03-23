import { Router, type Request } from "express";
import { z } from "zod";
import { requireAuth, requireAuthorization } from "../middleware/auth";
import { safeHandler } from "../middleware/safeHandler";
import { ROLES } from "../auth/roles";
import { AppError } from "../middleware/errors";
import { endCall, listCalls, startCall, updateCallStatus } from "../modules/calls/calls.service";
import { type CallStatus } from "../modules/calls/calls.repo";
import { toStringSafe } from "../utils/toStringSafe";

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
  safeHandler(async (req: any, res: any, next: any) => {
    const parsed = z
      .object({
        staff_id: z.string().uuid(),
        client_id: z.string().uuid(),
        phone_number: z.string().min(1),
        call_duration: z.number().int().nonnegative().default(0),
        direction: z.enum(["outbound", "inbound"]),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError("validation_error", "Invalid call log payload.", 400);
    }

    const record = await startCall({
      phoneNumber: parsed.data.phone_number.trim(),
      direction: parsed.data.direction,
      staffUserId: parsed.data.staff_id,
      status: "completed",
      crmContactId: parsed.data.client_id,
      ...buildRequestMetadata(req),
    });

    const updated = await updateCallStatus({
      id: record.id,
      status: "completed",
      durationSeconds: parsed.data.call_duration,
      actorUserId: parsed.data.staff_id,
      ...buildRequestMetadata(req),
    });

    res.status(201).json({ ok: true, call: updated ?? record });
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
      ...buildRequestMetadata(req),
    };
    const record = await startCall(startPayload);

    res.status(201).json({ ok: true, call: record });
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

    res.status(200).json({ ok: true, call: updated });
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

    res.status(200).json({ ok: true, call: updated });
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

    const calls = await listCalls({ contactId, applicationId });
    res.status(200).json({ ok: true, calls });
  })
);

export default router;
