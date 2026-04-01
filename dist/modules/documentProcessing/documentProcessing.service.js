"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleDocumentUploadProcessing = handleDocumentUploadProcessing;
exports.markOcrCompleted = markOcrCompleted;
exports.markOcrFailed = markOcrFailed;
exports.markBankingCompleted = markBankingCompleted;
exports.markBankingFailed = markBankingFailed;
exports.shouldEnqueueOcrForCategory = shouldEnqueueOcrForCategory;
const db_1 = require("../../db");
const errors_1 = require("../../middleware/errors");
const requiredDocuments_1 = require("../../db/schema/requiredDocuments");
const documentProcessing_repo_1 = require("./documentProcessing.repo");
const processingStage_service_1 = require("../applications/processingStage.service");
const circuitBreaker_1 = require("../../utils/circuitBreaker");
const BANK_STATEMENT_CATEGORY = "bank_statements_6_months";
const OCR_BREAKER = (0, circuitBreaker_1.fetchCircuitBreaker)("ocr_job_creation", {
    failureThreshold: 3,
    cooldownMs: 60000,
});
const BANKING_BREAKER = (0, circuitBreaker_1.fetchCircuitBreaker)("banking_job_creation", {
    failureThreshold: 3,
    cooldownMs: 60000,
});
function isBankStatementCategory(category) {
    const normalized = (0, requiredDocuments_1.normalizeRequiredDocumentKey)(category) ?? category;
    return normalized === BANK_STATEMENT_CATEGORY;
}
async function handleDocumentUploadProcessing(params) {
    const normalizedCategory = (0, requiredDocuments_1.normalizeRequiredDocumentKey)(params.documentCategory) ?? params.documentCategory;
    if (!isBankStatementCategory(normalizedCategory)) {
        if (!OCR_BREAKER.canRequest()) {
            throw new errors_1.AppError("circuit_open", "OCR circuit breaker is open.", 503);
        }
        try {
            const ocrJob = await (0, documentProcessing_repo_1.createDocumentProcessingJob)({
                documentId: params.documentId,
                jobType: "ocr",
                status: "pending",
                ...(params.client ? { client: params.client } : {}),
            });
            OCR_BREAKER.recordSuccess();
            return { ocrJob, bankingJob: null };
        }
        catch (err) {
            OCR_BREAKER.recordFailure();
            throw err;
        }
    }
    const aliases = (0, requiredDocuments_1.fetchDocumentTypeAliases)(BANK_STATEMENT_CATEGORY);
    const bankDocs = await (0, documentProcessing_repo_1.listBankStatementDocuments)({
        applicationId: params.applicationId,
        documentTypes: aliases,
        ...(params.client ? { client: params.client } : {}),
    });
    if (bankDocs.length < 6) {
        BANKING_BREAKER.recordSuccess();
        return { ocrJob: null, bankingJob: null };
    }
    const allUploaded = bankDocs.every((doc) => doc.status === "uploaded");
    if (!allUploaded) {
        BANKING_BREAKER.recordSuccess();
        return { ocrJob: null, bankingJob: null };
    }
    if (!BANKING_BREAKER.canRequest()) {
        throw new errors_1.AppError("circuit_open", "Banking circuit breaker is open.", 503);
    }
    try {
        const bankingJob = await (0, documentProcessing_repo_1.createBankingAnalysisJob)({
            applicationId: params.applicationId,
            status: "pending",
            ...(params.client ? { client: params.client } : {}),
        });
        BANKING_BREAKER.recordSuccess();
        return { ocrJob: null, bankingJob };
    }
    catch (err) {
        BANKING_BREAKER.recordFailure();
        throw err;
    }
}
async function markOcrCompleted(documentId) {
    const client = await db_1.pool.connect();
    try {
        await client.runQuery("begin");
        const job = await (0, documentProcessing_repo_1.updateDocumentProcessingJob)({
            documentId,
            jobType: "ocr",
            status: "completed",
            completedAt: new Date(),
            errorMessage: null,
            client,
        });
        if (!job) {
            throw new errors_1.AppError("not_found", "OCR job not found.", 404);
        }
        const appRes = await client.runQuery(`update applications
       set ocr_completed_at = now(),
           updated_at = now()
       where id = (select application_id from documents where id = $1)
       returning id`, [documentId]);
        if (appRes.rows.length === 0) {
            throw new errors_1.AppError("not_found", "Application not found.", 404);
        }
        const applicationId = appRes.rows[0]?.id;
        if (!applicationId) {
            throw new errors_1.AppError("not_found", "Application not found.", 404);
        }
        await (0, processingStage_service_1.advanceProcessingStage)({ applicationId, client });
        await client.runQuery("commit");
        return job;
    }
    catch (err) {
        await client.runQuery("rollback");
        throw err;
    }
    finally {
        client.release();
    }
}
async function markOcrFailed(params) {
    const client = await db_1.pool.connect();
    try {
        await client.runQuery("begin");
        const job = await (0, documentProcessing_repo_1.updateDocumentProcessingJob)({
            documentId: params.documentId,
            jobType: "ocr",
            status: "failed",
            completedAt: new Date(),
            errorMessage: params.errorMessage,
            client,
        });
        if (!job) {
            throw new errors_1.AppError("not_found", "OCR job not found.", 404);
        }
        await client.runQuery("commit");
        return job;
    }
    catch (err) {
        await client.runQuery("rollback");
        throw err;
    }
    finally {
        client.release();
    }
}
async function markBankingCompleted(params) {
    const client = await db_1.pool.connect();
    try {
        await client.runQuery("begin");
        const job = await (0, documentProcessing_repo_1.updateBankingAnalysisJob)({
            applicationId: params.applicationId,
            status: "completed",
            monthsDetected: params.monthsDetected,
            completedAt: new Date(),
            errorMessage: null,
            client,
        });
        if (!job) {
            throw new errors_1.AppError("not_found", "Banking analysis job not found.", 404);
        }
        await client.runQuery(`update applications
       set banking_completed_at = now(),
           updated_at = now()
       where id = $1`, [params.applicationId]);
        await (0, processingStage_service_1.advanceProcessingStage)({ applicationId: params.applicationId, client });
        await client.runQuery("commit");
        return job;
    }
    catch (err) {
        await client.runQuery("rollback");
        throw err;
    }
    finally {
        client.release();
    }
}
async function markBankingFailed(params) {
    const client = await db_1.pool.connect();
    try {
        await client.runQuery("begin");
        const job = await (0, documentProcessing_repo_1.updateBankingAnalysisJob)({
            applicationId: params.applicationId,
            status: "failed",
            monthsDetected: null,
            completedAt: new Date(),
            errorMessage: params.errorMessage,
            client,
        });
        if (!job) {
            throw new errors_1.AppError("not_found", "Banking analysis job not found.", 404);
        }
        await client.runQuery("commit");
        return job;
    }
    catch (err) {
        await client.runQuery("rollback");
        throw err;
    }
    finally {
        client.release();
    }
}
function shouldEnqueueOcrForCategory(category) {
    const normalized = (0, requiredDocuments_1.normalizeRequiredDocumentKey)(category) ?? category;
    return !isBankStatementCategory(normalized);
}
