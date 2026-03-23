import { Router, type Request } from "express";
import { AppError } from "../../middleware/errors";
import { recordAuditEvent } from "../audit/audit.service";
import {
  enqueueOcrForApplication,
  enqueueOcrForDocument,
  fetchOcrJobStatus,
  fetchOcrResult,
  retryOcrJob,
} from "./ocr.service";

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
    res.json({ job });
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
    res.json({ result });
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

export default router;
