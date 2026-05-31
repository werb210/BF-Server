import { Router, type Request } from "express";
import { AppError } from "../../middleware/errors.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import {
  enqueueOcrForApplication,
  enqueueOcrForDocument,
  fetchOcrJobStatus,
  fetchOcrResult,
  retryOcrJob,
} from "./ocr.service.js";
// BF_SERVER_BLOCK_v686_BANKING_DIAGNOSTIC_v1
import { pool } from "../../db.js";
import { requireAdmin } from "../../middleware/requireAdmin.js";

const router = Router();

function fetchAuditContext(req: Request): { ip: string | null; userAgent: string | null } {
  return {
    ip: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
  };
}

router.post("/documents/:documentId/enqueue", async (req: any, res: any, next: any) => {
  try {
    const job = await enqueueOcrForDocument(req.params.documentId);
    await recordAuditEvent({
      action: "ocr_job_enqueued",
      actorUserId: req.user?.userId ?? null,
      targetUserId: null,
      targetType: "ocr_job",
      targetId: job.id,
      ...fetchAuditContext(req),
      success: true,
    });
    res.status(202).json({ job });
  } catch (err) {
    await recordAuditEvent({
      action: "ocr_job_enqueued",
      actorUserId: req.user?.userId ?? null,
      targetUserId: null,
      targetType: "ocr_job",
      targetId: req.params.documentId,
      ...fetchAuditContext(req),
      success: false,
    });
    next(err);
  }
});

router.post("/applications/:applicationId/enqueue", async (req: any, res: any, next: any) => {
  try {
    const jobs = await enqueueOcrForApplication(req.params.applicationId);
    await recordAuditEvent({
      action: "ocr_application_enqueued",
      actorUserId: req.user?.userId ?? null,
      targetUserId: null,
      targetType: "application",
      targetId: req.params.applicationId,
      ...fetchAuditContext(req),
      success: true,
    });
    res.status(202).json({ jobs });
  } catch (err) {
    await recordAuditEvent({
      action: "ocr_application_enqueued",
      actorUserId: req.user?.userId ?? null,
      targetUserId: null,
      targetType: "application",
      targetId: req.params.applicationId,
      ...fetchAuditContext(req),
      success: false,
    });
    next(err);
  }
});

router.get("/documents/:documentId/status", async (req: any, res: any, next: any) => {
  try {
    const job = await fetchOcrJobStatus(req.params.documentId);
    if (!job) {
      throw new AppError("not_found", "OCR job not found.", 404);
    }
    await recordAuditEvent({
      action: "ocr_job_status_viewed",
      actorUserId: req.user?.userId ?? null,
      targetUserId: null,
      targetType: "ocr_job",
      targetId: job.id,
      ...fetchAuditContext(req),
      success: true,
    });
    res["json"]({ job });
  } catch (err) {
    await recordAuditEvent({
      action: "ocr_job_status_viewed",
      actorUserId: req.user?.userId ?? null,
      targetUserId: null,
      targetType: "ocr_job",
      targetId: req.params.documentId,
      ...fetchAuditContext(req),
      success: false,
    });
    next(err);
  }
});

router.get("/documents/:documentId/result", async (req: any, res: any, next: any) => {
  try {
    const result = await fetchOcrResult(req.params.documentId);
    if (!result) {
      throw new AppError("not_found", "OCR result not found.", 404);
    }
    await recordAuditEvent({
      action: "ocr_result_viewed",
      actorUserId: req.user?.userId ?? null,
      targetUserId: null,
      targetType: "ocr_result",
      targetId: result.id,
      ...fetchAuditContext(req),
      success: true,
    });
    res["json"]({ result });
  } catch (err) {
    await recordAuditEvent({
      action: "ocr_result_viewed",
      actorUserId: req.user?.userId ?? null,
      targetUserId: null,
      targetType: "ocr_result",
      targetId: req.params.documentId,
      ...fetchAuditContext(req),
      success: false,
    });
    next(err);
  }
});

router.post("/documents/:documentId/retry", async (req: any, res: any, next: any) => {
  try {
    const job = await retryOcrJob(req.params.documentId);
    await recordAuditEvent({
      action: "ocr_job_retried",
      actorUserId: req.user?.userId ?? null,
      targetUserId: null,
      targetType: "ocr_job",
      targetId: job.id,
      ...fetchAuditContext(req),
      success: true,
    });
    res.status(202).json({ job });
  } catch (err) {
    await recordAuditEvent({
      action: "ocr_job_retried",
      actorUserId: req.user?.userId ?? null,
      targetUserId: null,
      targetType: "ocr_job",
      targetId: req.params.documentId,
      ...fetchAuditContext(req),
      success: false,
    });
    next(err);
  }
});

// BF_SERVER_BLOCK_v686_BANKING_DIAGNOSTIC_v1 — read-only aggregate answering
// "why is Banking analysis empty?" Admin-only. Runs inside the App Service, so
// azureDocIntel reflects the REAL runtime config (unlike a Codex/Cloud-Shell
// script, which can't see App Service settings). No writes.
router.get("/banking-diagnostic", requireAdmin, async (_req: any, res: any, next: any) => {
  try {
    const azureDocIntel = {
      endpointSet: Boolean(process.env.AZURE_DOC_INTEL_ENDPOINT),
      keySet: Boolean(process.env.AZURE_DOC_INTEL_KEY),
    };
    const bankDocsByOcrStatus = (await pool.query(
      `SELECT COALESCE(ocr_status,'(null)') AS ocr_status, COUNT(*)::int AS bank_docs
         FROM documents
        WHERE LOWER(COALESCE(signed_category, document_type, '')) LIKE '%bank%'
        GROUP BY 1 ORDER BY 2 DESC`)).rows;
    const analysisStatusSpread = (await pool.query(
      `SELECT status, COUNT(*)::int AS apps, ROUND(AVG(attempt_count),1)::float AS avg_attempts
         FROM banking_analyses GROUP BY 1 ORDER BY 2 DESC`)).rows;
    const topLastErrors = (await pool.query(
      `SELECT LEFT(last_error,200) AS last_error, COUNT(*)::int AS apps
         FROM banking_analyses
        WHERE last_error IS NOT NULL AND last_error <> ''
        GROUP BY 1 ORDER BY 2 DESC LIMIT 8`)).rows;
    const autoSkippedApps = Number((await pool.query(
      `SELECT COUNT(*)::int AS n FROM applications
        WHERE COALESCE((metadata->>'banking_auto_skip')::boolean,false) IS TRUE`)).rows[0]?.n ?? 0);
    const recentBankApps = (await pool.query(
      `WITH bankapps AS (
         SELECT d.application_id AS app_id, COUNT(*)::int AS bank_docs,
                COUNT(*) FILTER (WHERE d.ocr_status='completed')::int AS ocr_done,
                MAX(d.created_at) AS last_doc_at
           FROM documents d
          WHERE LOWER(COALESCE(d.signed_category, d.document_type, '')) LIKE '%bank%'
          GROUP BY d.application_id)
       SELECT ba.app_id::text AS application_id, ba.bank_docs, ba.ocr_done,
              COALESCE(an.status,'(no row)') AS analysis_status,
              COALESCE((SELECT COUNT(*) FROM banking_transactions t WHERE t.application_id=ba.app_id),0)::int AS txns,
              COALESCE((SELECT COUNT(*) FROM banking_monthly_summaries m WHERE m.application_id=ba.app_id),0)::int AS months,
              LEFT(an.last_error,160) AS last_error
         FROM bankapps ba
         LEFT JOIN banking_analyses an ON an.application_id = ba.app_id
        ORDER BY ba.last_doc_at DESC NULLS LAST LIMIT 15`)).rows;
    res.status(200).json({
      ok: true,
      azureDocIntel,
      bankDocsByOcrStatus,
      analysisStatusSpread,
      topLastErrors,
      autoSkippedApps,
      recentBankApps,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
