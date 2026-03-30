"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const errors_1 = require("../../middleware/errors");
const safeHandler_1 = require("../../middleware/safeHandler");
const auth_1 = require("../../middleware/auth");
const capabilities_1 = require("../../auth/capabilities");
const processing_service_1 = require("../../modules/processing/processing.service");
const router = (0, express_1.Router)();
router.use(auth_1.requireAuth);
router.use((0, auth_1.requireCapability)([capabilities_1.CAPABILITIES.OPS_MANAGE]));
router.post("/ocr/:applicationId/complete", (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    const applicationId = typeof req.params.applicationId === "string"
        ? req.params.applicationId.trim()
        : "";
    if (!applicationId) {
        throw new errors_1.AppError("validation_error", "applicationId is required.", 400);
    }
    const jobs = await (0, processing_service_1.markDocumentProcessingCompleted)(applicationId);
    res.status(200).json({ jobs });
}));
router.post("/banking/:applicationId/complete", (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    const applicationId = typeof req.params.applicationId === "string"
        ? req.params.applicationId.trim()
        : "";
    if (!applicationId) {
        throw new errors_1.AppError("validation_error", "applicationId is required.", 400);
    }
    const jobs = await (0, processing_service_1.markBankingAnalysisCompleted)(applicationId);
    res.status(200).json({ jobs });
}));
router.post("/ocr/:applicationId/fail", (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    const applicationId = typeof req.params.applicationId === "string"
        ? req.params.applicationId.trim()
        : "";
    if (!applicationId) {
        throw new errors_1.AppError("validation_error", "applicationId is required.", 400);
    }
    const jobs = await (0, processing_service_1.markDocumentProcessingFailed)(applicationId);
    res.status(200).json({ jobs });
}));
router.post("/banking/:applicationId/fail", (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    const applicationId = typeof req.params.applicationId === "string"
        ? req.params.applicationId.trim()
        : "";
    if (!applicationId) {
        throw new errors_1.AppError("validation_error", "applicationId is required.", 400);
    }
    const jobs = await (0, processing_service_1.markBankingAnalysisFailed)(applicationId);
    res.status(200).json({ jobs });
}));
exports.default = router;
