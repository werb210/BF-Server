"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const errors_1 = require("../../middleware/errors");
const audit_service_1 = require("../audit/audit.service");
const ocr_service_1 = require("./ocr.service");
const router = (0, express_1.Router)();
function fetchAuditContext(req) {
    return {
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
    };
}
router.post("/documents/:documentId/enqueue", async (req, res, next) => {
    try {
        const job = await (0, ocr_service_1.enqueueOcrForDocument)(req.params.documentId);
        await (0, audit_service_1.recordAuditEvent)({
            action: "ocr_job_enqueued",
            actorUserId: req.user?.userId ?? null,
            targetUserId: null,
            targetType: "ocr_job",
            targetId: job.id,
            ...fetchAuditContext(req),
            success: true,
        });
        res.status(202).json({ job });
    }
    catch (err) {
        await (0, audit_service_1.recordAuditEvent)({
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
router.post("/applications/:applicationId/enqueue", async (req, res, next) => {
    try {
        const jobs = await (0, ocr_service_1.enqueueOcrForApplication)(req.params.applicationId);
        await (0, audit_service_1.recordAuditEvent)({
            action: "ocr_application_enqueued",
            actorUserId: req.user?.userId ?? null,
            targetUserId: null,
            targetType: "application",
            targetId: req.params.applicationId,
            ...fetchAuditContext(req),
            success: true,
        });
        res.status(202).json({ jobs });
    }
    catch (err) {
        await (0, audit_service_1.recordAuditEvent)({
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
router.get("/documents/:documentId/status", async (req, res, next) => {
    try {
        const job = await (0, ocr_service_1.fetchOcrJobStatus)(req.params.documentId);
        if (!job) {
            throw new errors_1.AppError("not_found", "OCR job not found.", 404);
        }
        await (0, audit_service_1.recordAuditEvent)({
            action: "ocr_job_status_viewed",
            actorUserId: req.user?.userId ?? null,
            targetUserId: null,
            targetType: "ocr_job",
            targetId: job.id,
            ...fetchAuditContext(req),
            success: true,
        });
        res["json"]({ job });
    }
    catch (err) {
        await (0, audit_service_1.recordAuditEvent)({
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
router.get("/documents/:documentId/result", async (req, res, next) => {
    try {
        const result = await (0, ocr_service_1.fetchOcrResult)(req.params.documentId);
        if (!result) {
            throw new errors_1.AppError("not_found", "OCR result not found.", 404);
        }
        await (0, audit_service_1.recordAuditEvent)({
            action: "ocr_result_viewed",
            actorUserId: req.user?.userId ?? null,
            targetUserId: null,
            targetType: "ocr_result",
            targetId: result.id,
            ...fetchAuditContext(req),
            success: true,
        });
        res["json"]({ result });
    }
    catch (err) {
        await (0, audit_service_1.recordAuditEvent)({
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
router.post("/documents/:documentId/retry", async (req, res, next) => {
    try {
        const job = await (0, ocr_service_1.retryOcrJob)(req.params.documentId);
        await (0, audit_service_1.recordAuditEvent)({
            action: "ocr_job_retried",
            actorUserId: req.user?.userId ?? null,
            targetUserId: null,
            targetType: "ocr_job",
            targetId: job.id,
            ...fetchAuditContext(req),
            success: true,
        });
        res.status(202).json({ job });
    }
    catch (err) {
        await (0, audit_service_1.recordAuditEvent)({
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
exports.default = router;
