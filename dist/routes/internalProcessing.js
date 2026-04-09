import { Router } from "express";
import { AppError } from "../middleware/errors.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { requireAuth, requireCapability } from "../middleware/auth.js";
import { CAPABILITIES } from "../auth/capabilities.js";
import { markBankingCompleted, markOcrCompleted, } from "../modules/documentProcessing/documentProcessing.service.js";
const router = Router();
router.use(requireAuth);
router.use(requireCapability([CAPABILITIES.OPS_MANAGE]));
router.post("/ocr/:documentId/complete", safeHandler(async (req, res, next) => {
    const documentId = typeof req.params.documentId === "string" ? req.params.documentId.trim() : "";
    if (!documentId) {
        throw new AppError("validation_error", "documentId is required.", 400);
    }
    const job = await markOcrCompleted(documentId);
    res.status(200).json({ job });
}));
router.post("/banking/:applicationId/complete", safeHandler(async (req, res, next) => {
    const applicationId = typeof req.params.applicationId === "string"
        ? req.params.applicationId.trim()
        : "";
    if (!applicationId) {
        throw new AppError("validation_error", "applicationId is required.", 400);
    }
    const monthsDetected = req.body?.monthsDetected;
    if (typeof monthsDetected !== "number" || Number.isNaN(monthsDetected)) {
        throw new AppError("validation_error", "monthsDetected must be a number.", 400);
    }
    const job = await markBankingCompleted({
        applicationId,
        monthsDetected,
    });
    res.status(200).json({ job });
}));
export default router;
