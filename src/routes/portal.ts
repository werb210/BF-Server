import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { fetchStatus as startupStatus, isReady } from "../startupState.js";
import { pool, runQuery } from "../db.js";
import {
  findActiveDocumentVersion,
  findApplicationById,
  listDocumentsByApplicationId,
} from "../modules/applications/applications.repo.js";
import { ApplicationStage } from "../modules/applications/pipelineState.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { listApplicationStages } from "../controllers/applications.controller.js";
import { portalRateLimit } from "../middleware/rateLimit.js";
import { requireAuth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { AppError } from "../middleware/errors.js";
import { isPipelineState } from "../modules/applications/pipelineState.js";
import { transitionPipelineState } from "../modules/applications/applications.service.js";
import { recordAuditEvent } from "../modules/audit/audit.service.js";
import { advanceProcessingStage } from "../modules/applications/processingStage.service.js";
import {
  retryProcessingJob,
  retryProcessingJobForApplication,
} from "../modules/processing/retry.service.js";
import {
  assertPipelineState,
  assertPipelineTransition,
  resolveNextPipelineStage,
} from "../modules/applications/applicationLifecycle.service.js";
import { config } from "../config/index.js";
import { listLenders } from "../repositories/lenders.repo.js";
import { eventBus } from "../events/eventBus.js";
import { toStringSafe } from "../utils/toStringSafe.js";
import twilio from "twilio";

const router = Router();
const portalLimiter = portalRateLimit();

function ensureReady(res: Response): boolean {
  if (!isReady()) {
    const status = startupStatus();
    res.status(503).json({
      ok: false,
      code: "service_not_ready",
      reason: status.reason,
    });
    return false;
  }
  return true;
}

function ensureAuditHistoryEnabled(): void {
  if (!config.flags.auditHistoryEnabled) {
    throw new AppError("not_found", "Audit history is disabled.", 404);
  }
}

function parsePagination(query: Request["query"]): { limit: number; offset: number } {
  const limitRaw = typeof query.limit === "string" ? Number(query.limit) : NaN;
  const offsetRaw = typeof query.offset === "string" ? Number(query.offset) : NaN;
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
  return { limit, offset };
}

// ── Pipeline helpers ──────────────────────────────────────────────────────────
async function recordTransition(
  appId: string,
  fromStage: string,
  toStage: string,
  actorId: string | null,
  reason: string
): Promise<void> {
  await runQuery(
    `INSERT INTO application_stage_events
       (application_id, from_stage, to_stage, trigger, triggered_by, reason, created_at)
     VALUES ($1, $2, $3, 'auto', $4, $5, now())`,
    [appId, fromStage, toStage, actorId ?? "system", reason]
  ).catch(() => {});
}

async function allDocumentsAccepted(appId: string): Promise<boolean> {
  const result = await runQuery<{ total: string; accepted: string }>(
    `SELECT
       count(*) AS total,
       count(*) FILTER (WHERE status = 'accepted') AS accepted
     FROM documents
     WHERE application_id = $1 AND status != 'rejected'`,
    [appId]
  ).catch(() => null);
  if (!result?.rows[0]) return false;
  const { total, accepted } = result.rows[0];
  return parseInt(total) > 0 && total === accepted;
}

// ── Document reject — auto-SMS ────────────────────────────────────────────
async function sendDocumentRejectionSms(params: {
  documentId: string;
  documentType: string;
  applicationId: string;
  rejectionReason: string | null;
}): Promise<void> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER ?? process.env.TWILIO_PHONE_NUMBER;
  if (!accountSid || !authToken || !from) return;

  // Find the contact phone via application → owner
  const result = await pool.query<{ phone: string | null; phone_number: string | null }>(
    `SELECT u.phone_number AS phone_number, c.phone AS phone
     FROM applications a
     LEFT JOIN users u ON u.id = a.owner_user_id
     LEFT JOIN contacts c ON c.id = a.contact_id
     WHERE a.id = $1 LIMIT 1`,
    [params.applicationId]
  ).catch(() => ({ rows: [] }));

  const row = result.rows[0];
  const to = row?.phone ?? row?.phone_number;
  if (!to) return;

  const reason = params.rejectionReason ? ` Reason: ${params.rejectionReason}.` : "";
  const body =
    `Your document "${params.documentType}" has been rejected.${reason} ` +
    "Please log in to re-upload: https://client.boreal.financial";

  const client: any = twilio(accountSid, authToken);
  const msg = await client.messages.create({ body, from, to }).catch(() => null);
  if (msg) {
    await pool.query(
      `INSERT INTO communications_messages
         (id, type, direction, status, body, phone_number, from_number, to_number, twilio_sid, application_id, created_at)
       VALUES (gen_random_uuid(), 'sms', 'outbound', $1, $2, $3, $4, $3, $5, $6, now())`,
      [msg.status, body, to, from, msg.sid, params.applicationId]
    ).catch(() => {});
  }
}

router.get(
  "/applications",
  portalLimiter,
  safeHandler(async (_req: any, res: any) => {
    if (!ensureReady(res)) {
      return;
    }
    try {
      const result = await runQuery<{
        id: string;
        name: string;
        pipeline_state: string | null;
        created_at: Date;
      }>(
        `select id,
          coalesce(name, business_legal_name) as name,
          pipeline_state,
          created_at
         from applications
         order by created_at desc`
      );
      const rows = Array.isArray(result?.rows) ? result.rows : [];
      res.status(200).json({
        items: rows.map((row) => ({
          id: row.id,
          name: row.name,
          pipelineState: row.pipeline_state ?? ApplicationStage.RECEIVED,
          createdAt: row.created_at,
        })),
      });
    } catch (err) {
      res.status(200).json({ items: [] });
    }
  })
);

router.get(
  "/applications/stages",
  portalLimiter,
  safeHandler(async (req: any, res: any, next: any) => {
    if (!ensureReady(res)) {
      return;
    }
    await listApplicationStages(req, res);
  })
);

router.get(
  "/applications/:id",
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  portalLimiter,
  safeHandler(async (req: any, res: Response) => {
    if (!ensureReady(res)) {
      return;
    }
    const applicationId = toStringSafe(req.params.id);
    if (!applicationId) throw new AppError("validation_error", "Application id required.", 400);

    const stageResult = await runQuery<{ pipeline_state: string }>(
      `SELECT pipeline_state FROM applications WHERE id = $1 LIMIT 1`,
      [applicationId]
    );
    if (stageResult.rows[0]?.pipeline_state === "Received") {
      await runQuery(
        `UPDATE applications SET pipeline_state = 'In Review', updated_at = now() WHERE id = $1`,
        [applicationId]
      ).catch(() => {});
      await recordTransition(
        applicationId,
        "Received",
        "In Review",
        req.user?.userId ?? null,
        "Staff opened application"
      );
    }

    const record = await findApplicationById(applicationId);
    if (!record) {
      res.status(404).json({
        code: "not_found",
        message: "Application not found.",
        requestId: res.locals.requestId ?? "unknown",
      });
      return;
    }
    const documents = await listDocumentsByApplicationId(record.id);
    const documentsWithVersions = await Promise.all(
      documents.map(async (doc) => {
        const version = await findActiveDocumentVersion({ documentId: doc.id });
        const metadata =
          version && version.metadata && typeof version.metadata === "object"
            ? (version.metadata as {
                fileName?: string;
                mimeType?: string;
                size?: number;
                storageKey?: string;
              })
            : {};
        return {
          documentId: doc.id,
          applicationId: doc.application_id,
          category: doc.document_type,
          title: doc.title,
          filename: metadata.fileName ?? doc.title,
          mimeType: metadata.mimeType ?? null,
          size: metadata.size ?? null,
          storageKey: metadata.storageKey ?? null,
          version: version?.version ?? null,
          createdAt: doc.created_at,
        };
      })
    );
    res.status(200).json({
      application: {
        id: record.id,
        name: record.name,
        productType: record.product_type,
        pipelineState: record.pipeline_state,
        createdAt: record.created_at,
        updatedAt: record.updated_at,
        metadata: record.metadata ?? null,
      },
      pipeline: {
        state: record.pipeline_state,
      },
      documents: documentsWithVersions,
    });
  })
);


router.get(
  "/applications/:id/history",
  requireAuth,
  portalLimiter,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  safeHandler(async (req: any, res: any, next: any) => {
    ensureAuditHistoryEnabled();
    const applicationId = typeof toStringSafe(req.params.id) === "string" ? toStringSafe(req.params.id).trim() : "";
    if (!applicationId) {
      throw new AppError("validation_error", "Application id is required.", 400);
    }
    const actorType =
      typeof toStringSafe(req.query.actorType) === "string" ? toStringSafe(req.query.actorType).trim() : "";
    const fromStage =
      typeof toStringSafe(req.query.fromStage) === "string" ? toStringSafe(req.query.fromStage).trim() : "";
    const toStage =
      typeof toStringSafe(req.query.toStage) === "string" ? toStringSafe(req.query.toStage).trim() : "";
    const trigger =
      typeof toStringSafe(req.query.trigger) === "string" ? toStringSafe(req.query.trigger).trim() : "";
    const { limit, offset } = parsePagination(req.query);
    const values: Array<string | number> = [applicationId];
    const filters: string[] = [];
    if (actorType) {
      values.push(actorType);
      filters.push(`actor_type = $${values.length}`);
    }
    if (fromStage) {
      values.push(fromStage);
      filters.push(`from_stage = $${values.length}`);
    }
    if (toStage) {
      values.push(toStage);
      filters.push(`to_stage = $${values.length}`);
    }
    if (trigger) {
      values.push(trigger);
      filters.push(`trigger = $${values.length}`);
    }
    values.push(limit, offset);
    const filterClause = filters.length > 0 ? `and ${filters.join(" and ")}` : "";
    const result = await runQuery<{
      application_id: string;
      from_stage: string | null;
      to_stage: string;
      trigger: string;
      actor_id: string | null;
      actor_role: string | null;
      actor_type: string;
      occurred_at: Date;
      reason: string | null;
    }>(
      `select application_id, from_stage, to_stage, trigger, actor_id, actor_role,
              actor_type, occurred_at, reason
       from application_pipeline_history
       where application_id = $1
       ${filterClause}
       order by occurred_at asc
       limit $${values.length - 1} offset $${values.length}`,
      values
    );
    res.status(200).json({ items: result.rows ?? [] });
  })
);

router.get(
  "/jobs/:id/history",
  requireAuth,
  portalLimiter,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  safeHandler(async (req: any, res: any, next: any) => {
    ensureAuditHistoryEnabled();
    const jobId = typeof toStringSafe(req.params.id) === "string" ? toStringSafe(req.params.id).trim() : "";
    if (!jobId) {
      throw new AppError("validation_error", "Job id is required.", 400);
    }
    const jobType =
      typeof toStringSafe(req.query.jobType) === "string" ? toStringSafe(req.query.jobType).trim() : "";
    const nextStatus =
      typeof toStringSafe(req.query.nextStatus) === "string" ? toStringSafe(req.query.nextStatus).trim() : "";
    const actorType =
      typeof toStringSafe(req.query.actorType) === "string" ? toStringSafe(req.query.actorType).trim() : "";
    const { limit, offset } = parsePagination(req.query);
    const values: Array<string | number> = [jobId];
    const filters: string[] = [];
    if (jobType) {
      values.push(jobType);
      filters.push(`job_type = $${values.length}`);
    }
    if (nextStatus) {
      values.push(nextStatus);
      filters.push(`next_status = $${values.length}`);
    }
    if (actorType) {
      values.push(actorType);
      filters.push(`actor_type = $${values.length}`);
    }
    values.push(limit, offset);
    const filterClause = filters.length > 0 ? `and ${filters.join(" and ")}` : "";
    const result = await runQuery<{
      job_id: string;
      job_type: string;
      application_id: string | null;
      document_id: string | null;
      previous_status: string | null;
      next_status: string;
      reason: string | null;
      retry_count: number;
      last_retry_at: Date | null;
      occurred_at: Date;
      actor_type: string;
      actor_id: string | null;
    }>(
      `select job_id, job_type, application_id, document_id, previous_status, next_status,
              reason, retry_count, last_retry_at, occurred_at, actor_type, actor_id
       from processing_job_history
       where job_id = $1
       ${filterClause}
       order by occurred_at asc
       limit $${values.length - 1} offset $${values.length}`,
      values
    );
    res.status(200).json({ items: result.rows ?? [] });
  })
);

router.get(
  "/documents/:id/history",
  requireAuth,
  portalLimiter,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  safeHandler(async (req: any, res: any, next: any) => {
    ensureAuditHistoryEnabled();
    const documentId = typeof toStringSafe(req.params.id) === "string" ? toStringSafe(req.params.id).trim() : "";
    if (!documentId) {
      throw new AppError("validation_error", "Document id is required.", 400);
    }
    const nextStatus =
      typeof toStringSafe(req.query.nextStatus) === "string" ? toStringSafe(req.query.nextStatus).trim() : "";
    const actorType =
      typeof toStringSafe(req.query.actorType) === "string" ? toStringSafe(req.query.actorType).trim() : "";
    const { limit, offset } = parsePagination(req.query);
    const values: Array<string | number> = [documentId];
    const filters: string[] = [];
    if (nextStatus) {
      values.push(nextStatus);
      filters.push(`next_status = $${values.length}`);
    }
    if (actorType) {
      values.push(actorType);
      filters.push(`actor_type = $${values.length}`);
    }
    values.push(limit, offset);
    const filterClause = filters.length > 0 ? `and ${filters.join(" and ")}` : "";
    const result = await runQuery<{
      application_id: string;
      document_id: string;
      document_type: string;
      actor_id: string | null;
      actor_role: string | null;
      actor_type: string;
      previous_status: string | null;
      next_status: string;
      reason: string | null;
      occurred_at: Date;
    }>(
      `select application_id, document_id, document_type, actor_id, actor_role, actor_type,
              previous_status, next_status, reason, occurred_at
       from document_status_history
       where document_id = $1
       ${filterClause}
       order by occurred_at asc
       limit $${values.length - 1} offset $${values.length}`,
      values
    );
    res.status(200).json({ items: result.rows ?? [] });
  })
);

router.post(
  "/jobs/:id/retry",
  requireAuth,
  portalLimiter,
  requireAuthorization({ roles: [ROLES.ADMIN] }),
  safeHandler(async (req: any, res: any, next: any) => {
    if (!req.user) {
      throw new AppError("missing_token", "Authorization token is required.", 401);
    }
    const jobId = typeof toStringSafe(req.params.id) === "string" ? toStringSafe(req.params.id).trim() : "";
    if (!jobId) {
      throw new AppError("validation_error", "Job id is required.", 400);
    }
    const reason =
      typeof req.body?.reason === "string" ? req.body.reason.trim() : null;
    const job = await retryProcessingJob({
      jobId,
      actorUserId: req.user.userId,
      actorRole: req.user.role,
      reason,
      force: true,
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    });
    res.status(200).json({ job });
  })
);

router.post(
  "/applications/:id/retry-job",
  requireAuth,
  portalLimiter,
  requireAuthorization({ roles: [ROLES.ADMIN] }),
  safeHandler(async (req: any, res: any, next: any) => {
    if (!req.user) {
      throw new AppError("missing_token", "Authorization token is required.", 401);
    }
    const applicationId = typeof toStringSafe(req.params.id) === "string" ? toStringSafe(req.params.id).trim() : "";
    if (!applicationId) {
      throw new AppError("validation_error", "Application id is required.", 400);
    }
    const reason =
      typeof req.body?.reason === "string" ? req.body.reason.trim() : null;
    const job = await retryProcessingJobForApplication({
      applicationId,
      actorUserId: req.user.userId,
      actorRole: req.user.role,
      reason,
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    });
    res.status(200).json({ job });
  })
);

router.post(
  "/applications/:id/promote",
  requireAuth,
  portalLimiter,
  requireAuthorization({ roles: [ROLES.ADMIN] }),
  safeHandler(async (req: any, res: any, next: any) => {
    if (!req.user) {
      throw new AppError("missing_token", "Authorization token is required.", 401);
    }
    const applicationId = typeof toStringSafe(req.params.id) === "string" ? toStringSafe(req.params.id).trim() : "";
    if (!applicationId) {
      throw new AppError("validation_error", "Application id is required.", 400);
    }
    const reason =
      typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (!reason) {
      throw new AppError("validation_error", "Reason is required.", 400);
    }
    const nextStageRaw =
      typeof req.body?.nextStage === "string" ? req.body.nextStage.trim() : "";
    if (nextStageRaw && !isPipelineState(nextStageRaw)) {
      throw new AppError("validation_error", "nextStage is invalid.", 400);
    }
    const record = await findApplicationById(applicationId);
    if (!record) {
      throw new AppError("not_found", "Application not found.", 404);
    }
    const currentStage = assertPipelineState(record.pipeline_state);
    const nextStage = nextStageRaw && isPipelineState(nextStageRaw)
      ? nextStageRaw
      : resolveNextPipelineStage(currentStage);
    if (!nextStage) {
      throw new AppError("invalid_transition", "No valid next stage.", 400);
    }
    const transition = assertPipelineTransition({
      currentStage,
      nextStage,
      status: null,
    });
    if (!transition.shouldTransition) {
      res.status(200).json({ ok: true, applicationId, nextStage });
      return;
    }
    const promoteMeta = {
      ...(req.ip ? { ip: req.ip } : {}),
      ...(req.get("user-agent") ? { userAgent: req.get("user-agent") as string } : {}),
    };
    await transitionPipelineState({
      applicationId,
      nextState: nextStage,
      actorUserId: req.user.userId,
      actorRole: req.user.role,
      trigger: "admin_promotion",
      reason,
      ...promoteMeta,
    });
    await recordAuditEvent({
      action: "application_promoted",
      actorUserId: req.user.userId,
      targetUserId: record.owner_user_id,
      targetType: "application",
      targetId: applicationId,
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
      success: true,
      metadata: {
        from: record.pipeline_state,
        to: nextStage,
        reason,
      },
    });
    await advanceProcessingStage({ applicationId });
    res.status(200).json({ ok: true, applicationId, nextStage });
  })
);


router.patch(
  "/applications/:id/status",
  requireAuth,
  portalLimiter,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  safeHandler(async (req: any, res: any, next: any) => {
    if (!req.user) {
      throw new AppError("missing_token", "Authorization token is required.", 401);
    }
    const applicationId = typeof toStringSafe(req.params.id) === "string" ? toStringSafe(req.params.id).trim() : "";
    if (!applicationId) {
      throw new AppError("validation_error", "Application id is required.", 400);
    }
    const status = typeof req.body?.status === "string" ? req.body.status.trim() : "";
    const allowedManualStatuses = new Set<string>([
      ApplicationStage.ADDITIONAL_STEPS_REQUIRED,
      ApplicationStage.ACCEPTED,
      ApplicationStage.REJECTED,
    ]);
    if (!status || !isPipelineState(status) || !allowedManualStatuses.has(status)) {
      throw new AppError("validation_error", "status is invalid.", 400);
    }
    const statusMeta = {
      ...(req.ip ? { ip: req.ip } : {}),
      ...(req.get("user-agent") ? { userAgent: req.get("user-agent") as string } : {}),
    };
    await transitionPipelineState({
      applicationId,
      nextState: status,
      actorUserId: req.user.userId,
      actorRole: req.user.role,
      trigger: "manual_status_update",
      reason: typeof req.body?.reason === "string" ? req.body.reason.trim() : null,
      ...statusMeta,
    });
    res.status(200).json({ ok: true, applicationId, status });
  })
);

router.post(
  "/applications/:id/retry",
  requireAuth,
  portalLimiter,
  requireAuthorization({ roles: [ROLES.ADMIN] }),
  safeHandler(async (req: any, res: any, next: any) => {
    if (!req.user) {
      throw new AppError("missing_token", "Authorization token is required.", 401);
    }
    const applicationId = typeof toStringSafe(req.params.id) === "string" ? toStringSafe(req.params.id).trim() : "";
    if (!applicationId) {
      throw new AppError("validation_error", "Application id is required.", 400);
    }
    const reason =
      typeof req.body?.reason === "string" ? req.body.reason.trim() : null;
    const job = await retryProcessingJobForApplication({
      applicationId,
      actorUserId: req.user.userId,
      actorRole: req.user.role,
      reason,
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    });
    res.status(200).json({ job });
  })
);

// ── Issues ───────────────────────────────────────────────────────────────────
router.get(
  "/issues",
  requireAuth,
  safeHandler(async (_req: any, res: any) => {
    const result = await runQuery(
      `SELECT i.id, i.title, i.description, i.screenshot_url, i.status,
              i.contact_id, i.application_id, i.submitted_by, i.created_at
       FROM issues i
       ORDER BY i.created_at DESC
       LIMIT 100`,
      []
    );
    res.json({ issues: result.rows ?? [] });
  })
);

router.patch(
  "/issues/:id/status",
  requireAuth,
  safeHandler(async (req: any, res: any) => {
    const { id } = req.params;
    const { status } = req.body ?? {};
    if (!["open", "in_progress", "resolved"].includes(status)) {
      throw new AppError("validation_error", "Invalid status.", 400);
    }
    const result = await runQuery(
      `UPDATE issues SET status = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [status, id]
    );
    if (!result.rows[0]) throw new AppError("not_found", "Issue not found.", 404);
    res.json({ issue: result.rows[0] });
  })
);

router.get(
  "/lenders",
  portalLimiter,
  safeHandler(async (_req: any, res: any) => {
    const lenders = await listLenders(pool);
    res.status(200).json({ items: lenders ?? [] });
  })
);

// ── Portal document reject with auto-SMS ──────────────────────────────────────
router.post(
  "/documents/:id/accept",
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  portalLimiter,
  safeHandler(async (req: any, res: any) => {
    const docId = typeof req.params.id === "string" ? req.params.id.trim() : "";
    if (!docId) throw new AppError("validation_error", "Document id required.", 400);

    const updated = await runQuery<{ id: string; document_type: string; application_id: string; status: string }>(
      `UPDATE documents SET status = 'accepted', updated_at = now()
       WHERE id = $1 RETURNING id, document_type, application_id, status`,
      [docId]
    );
    const doc = updated.rows[0];
    if (!doc) throw new AppError("not_found", "Document not found.", 404);

    const appId = doc.application_id;
    if (appId && await allDocumentsAccepted(appId)) {
      const appRes = await runQuery<{ pipeline_state: string }>(
        `SELECT pipeline_state FROM applications WHERE id = $1`,
        [appId]
      );
      const cur = appRes.rows[0]?.pipeline_state;
      if (cur && ["In Review", "Documents Required", "Additional Steps Required"].includes(cur)) {
        await runQuery(
          `UPDATE applications SET pipeline_state = 'Off to Lender', updated_at = now() WHERE id = $1`,
          [appId]
        ).catch(() => {});
        await recordTransition(appId, cur, "Off to Lender", req.user?.userId ?? null, "All documents accepted");
      }
    }
    res.status(200).json({ ok: true, document: doc });
  })
);

// ── Portal document reject with auto-SMS ──────────────────────────────────────
router.post(
  "/documents/:id/reject",
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  portalLimiter,
  safeHandler(async (req: any, res: any) => {
    const docId = typeof req.params.id === "string" ? req.params.id.trim() : "";
    if (!docId) throw new AppError("validation_error", "Document id required.", 400);
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : null;

    const updated = await runQuery<{
      id: string; document_type: string; application_id: string; status: string;
    }>(
      `UPDATE documents SET status = 'rejected', rejection_reason = $2, updated_at = now()
       WHERE id = $1
       RETURNING id, document_type, application_id, status`,
      [docId, reason]
    );
    const doc = updated.rows[0];
    if (!doc) throw new AppError("not_found", "Document not found.", 404);

    // Fire auto-SMS asynchronously — non-blocking
    void sendDocumentRejectionSms({
      documentId: docId,
      documentType: doc.document_type ?? "document",
      applicationId: doc.application_id,
      rejectionReason: reason,
    });

    if (doc.application_id) {
      const appRes = await runQuery<{ pipeline_state: string }>(
        `SELECT pipeline_state FROM applications WHERE id = $1`,
        [doc.application_id]
      );
      const cur = appRes.rows[0]?.pipeline_state;
      if (cur && ["In Review", "Off to Lender", "Received"].includes(cur)) {
        await runQuery(
          `UPDATE applications SET pipeline_state = 'Documents Required', updated_at = now() WHERE id = $1`,
          [doc.application_id]
        ).catch(() => {});
        await recordTransition(
          doc.application_id,
          cur,
          "Documents Required",
          req.user?.userId ?? null,
          `Document rejected: ${doc.document_type}`
        );
      }
    }

    res.status(200).json({ ok: true, document: doc });
  })
);

router.post(
  "/applications/:id/term-sheet",
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  portalLimiter,
  safeHandler(async (req: any, res: any) => {
    const appId = typeof req.params.id === "string" ? req.params.id.trim() : "";
    if (!appId) throw new AppError("validation_error", "Application id required.", 400);

    const appRes = await runQuery<{ pipeline_state: string }>(
      `SELECT pipeline_state FROM applications WHERE id = $1`,
      [appId]
    );
    const cur = appRes.rows[0]?.pipeline_state;
    if (cur === "Off to Lender") {
      await runQuery(
        `UPDATE applications SET pipeline_state = 'Offer', updated_at = now() WHERE id = $1`,
        [appId]
      ).catch(() => {});
      await recordTransition(appId, "Off to Lender", "Offer", req.user?.userId ?? null, "Term sheet uploaded");
    }
    res.status(200).json({ ok: true, stage: "Offer" });
  })
);

router.post(
  "/lender-submissions",
  requireAuth,
  portalLimiter,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  safeHandler(async (req: any, res: any, next: any) => {
    const applicationId = typeof req.body?.application_id === "string" ? req.body.application_id.trim() : "";
    const selectedLenders = Array.isArray(req.body?.selected_lenders) ? req.body.selected_lenders : [];
    if (!applicationId || selectedLenders.length === 0) {
      throw new AppError("validation_error", "application_id and selected_lenders are required.", 400);
    }

    const submissions: any[] = [];
    for (const lenderId of selectedLenders) {
      const result = await runQuery(
        `insert into lender_submissions (id, application_id, lender_id, status, idempotency_key, payload, submitted_at, created_at, updated_at)
         values ($1, $2, $3, 'submitted', $4, $5, now(), now(), now())
         on conflict (application_id, lender_id) do update
         set status = excluded.status,
             payload = excluded.payload,
             submitted_at = now(),
             updated_at = now()
         returning id, application_id, lender_id, status, submitted_at, created_at`,
        [randomUUID(), applicationId, String(lenderId), randomUUID(), JSON.stringify({ package: 'generated', documents: 'attached', credit_summary: 'attached' })]
      );
      if (result.rows[0]) {
        submissions.push(result.rows[0]);
        eventBus.emit("lender_submission_created", {
          submissionId: result.rows[0].id,
          applicationId,
          lenderId: result.rows[0].lender_id,
        });
      }
    }

    res.status(201).json({ submissions });
  })
);

router.get(
  "/offers",
  portalLimiter,
  safeHandler(async (req: any, res: any, next: any) => {
    const applicationId = typeof toStringSafe(req.query.applicationId) === "string" ? toStringSafe(req.query.applicationId).trim() : "";
    const query = applicationId
      ? {
          text: `select id, application_id, lender_name, amount::text as amount, rate_factor, term, payment_frequency, expiry_date, document_url, recommended, status, created_at, updated_at
                 from offers
                 where application_id = $1
                 order by updated_at desc`,
          values: [applicationId],
        }
      : {
          text: `select id, application_id, lender_name, amount::text as amount, rate_factor, term, payment_frequency, expiry_date, document_url, recommended, status, created_at, updated_at
                 from offers
                 order by updated_at desc
                 limit 100`,
          values: [],
        };
    const rows = await runQuery(query.text, query.values);
    res.status(200).json({ items: rows.rows });
  })
);

router.post(
  "/offers",
  requireAuth,
  portalLimiter,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  safeHandler(async (req: any, res: any, next: any) => {
    const applicationId = typeof req.body?.applicationId === "string" ? req.body.applicationId.trim() : "";
    const lenderName = typeof req.body?.lenderName === "string" ? req.body.lenderName.trim() : "";
    if (!applicationId || !lenderName) {
      throw new AppError("validation_error", "applicationId and lenderName are required.", 400);
    }
    const result = await runQuery(
      `insert into offers (id, application_id, lender_name, amount, rate_factor, term, payment_frequency, expiry_date, document_url, recommended, status, notes, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, coalesce($11, 'created'), $12, now(), now())
       returning id, application_id, lender_name, amount::text as amount, rate_factor, term, payment_frequency, expiry_date, document_url, recommended, status, notes, created_at, updated_at`,
      [
        randomUUID(),
        applicationId,
        lenderName,
        req.body?.amount ?? null,
        req.body?.rateFactor ?? null,
        req.body?.term ?? null,
        req.body?.paymentFrequency ?? null,
        req.body?.expiry ?? null,
        req.body?.documentUrl ?? null,
        Boolean(req.body?.recommended),
        typeof req.body?.status === "string" ? req.body.status.trim() : "created",
        typeof req.body?.notes === "string" ? req.body.notes.trim() : null,
      ]
    );
    if (result.rows[0]) {
      eventBus.emit("offer_created", { offerId: result.rows[0].id, applicationId });
    }
    res.status(201).json({ offer: result.rows[0] });
  })
);

router.patch(
  "/offers/:id/status",
  requireAuth,
  portalLimiter,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  safeHandler(async (req: any, res: any, next: any) => {
    const id = typeof toStringSafe(req.params.id) === "string" ? toStringSafe(req.params.id).trim() : "";
    const status = typeof req.body?.status === "string" ? req.body.status.trim() : "";
    const allowed = new Set(["created", "sent", "accepted", "declined"]);
    if (!id || !allowed.has(status)) {
      throw new AppError("validation_error", "Valid status is required.", 400);
    }
    const updated = await runQuery(
      `update offers
       set status = $2, updated_at = now()
       where id = $1
       returning id, application_id, lender_name, amount::text as amount, rate_factor, term, payment_frequency, expiry_date, document_url, recommended, status, notes, created_at, updated_at`,
      [id, status]
    );
    if (!updated.rows[0]) {
      throw new AppError("not_found", "Offer not found.", 404);
    }
    if (updated.rows[0] && status === "accepted") {
      eventBus.emit("offer_accepted", { offerId: updated.rows[0].id, applicationId: updated.rows[0].application_id });
    }
    res.status(200).json({ offer: updated.rows[0] });
  })
);

export default router;
