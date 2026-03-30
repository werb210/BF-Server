"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const bullmq_1 = require("bullmq");
const redis_1 = require("../queue/redis");
const ocr_service_1 = require("../modules/ocr/ocr.service");
const ocr_repo_1 = require("../modules/ocr/ocr.repo");
const logger_1 = require("../observability/logger");
const worker = new bullmq_1.Worker("ocr-processing", async (job) => {
    (0, logger_1.logInfo)("ocr_queue_job_started", { jobId: job.id });
    const documentId = String(job.data?.documentId ?? "");
    if (!documentId) {
        throw new Error("missing_document_id");
    }
    const ocrJob = await (0, ocr_repo_1.findOcrJobByDocumentId)(documentId);
    if (!ocrJob) {
        throw new Error(`ocr_job_not_found:${documentId}`);
    }
    await (0, ocr_service_1.processOcrJob)(ocrJob);
    (0, logger_1.logInfo)("ocr_queue_job_completed", { jobId: job.id });
}, { connection: redis_1.redisConnection });
worker.on("failed", (job, err) => {
    (0, logger_1.logError)("ocr_queue_job_failed", {
        jobId: job?.id,
        error: err instanceof Error ? err.message : String(err),
    });
});
