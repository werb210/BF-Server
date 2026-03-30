"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const errors_1 = require("../middleware/errors");
const safeHandler_1 = require("../middleware/safeHandler");
const auth_1 = require("../middleware/auth");
const capabilities_1 = require("../auth/capabilities");
const documentProcessing_service_1 = require("../modules/documentProcessing/documentProcessing.service");
const router = (0, express_1.Router)();
router.use(auth_1.requireAuth);
router.use((0, auth_1.requireCapability)([capabilities_1.CAPABILITIES.OPS_MANAGE]));
router.post("/ocr/:documentId/complete", (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    const documentId = typeof req.params.documentId === "string" ? req.params.documentId.trim() : "";
    if (!documentId) {
        throw new errors_1.AppError("validation_error", "documentId is required.", 400);
    }
    const job = await (0, documentProcessing_service_1.markOcrCompleted)(documentId);
    res.status(200).json({ job });
}));
router.post("/banking/:applicationId/complete", (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    const applicationId = typeof req.params.applicationId === "string"
        ? req.params.applicationId.trim()
        : "";
    if (!applicationId) {
        throw new errors_1.AppError("validation_error", "applicationId is required.", 400);
    }
    const monthsDetected = req.body?.monthsDetected;
    if (typeof monthsDetected !== "number" || Number.isNaN(monthsDetected)) {
        throw new errors_1.AppError("validation_error", "monthsDetected must be a number.", 400);
    }
    const job = await (0, documentProcessing_service_1.markBankingCompleted)({
        applicationId,
        monthsDetected,
    });
    res.status(200).json({ job });
}));
exports.default = router;
