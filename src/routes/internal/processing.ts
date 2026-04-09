import { Router } from "express";
import { AppError } from "../../middleware/errors.js";
import { safeHandler } from "../../middleware/safeHandler.js";
import { requireAuth, requireCapability } from "../../middleware/auth.js";
import { CAPABILITIES } from "../../auth/capabilities.js";
import {
  markBankingAnalysisCompleted,
  markBankingAnalysisFailed,
  markDocumentProcessingCompleted,
  markDocumentProcessingFailed,
} from "../../modules/processing/processing.service.js";

const router = Router();

router.use(requireAuth);
router.use(requireCapability([CAPABILITIES.OPS_MANAGE]));

router.post(
  "/ocr/:applicationId/complete",
  safeHandler(async (req: any, res: any, next: any) => {
    const applicationId =
      typeof req.params.applicationId === "string"
        ? req.params.applicationId.trim()
        : "";
    if (!applicationId) {
      throw new AppError("validation_error", "applicationId is required.", 400);
    }
    const jobs = await markDocumentProcessingCompleted(applicationId);
    res.status(200).json({ jobs });
  })
);

router.post(
  "/banking/:applicationId/complete",
  safeHandler(async (req: any, res: any, next: any) => {
    const applicationId =
      typeof req.params.applicationId === "string"
        ? req.params.applicationId.trim()
        : "";
    if (!applicationId) {
      throw new AppError("validation_error", "applicationId is required.", 400);
    }
    const jobs = await markBankingAnalysisCompleted(applicationId);
    res.status(200).json({ jobs });
  })
);

router.post(
  "/ocr/:applicationId/fail",
  safeHandler(async (req: any, res: any, next: any) => {
    const applicationId =
      typeof req.params.applicationId === "string"
        ? req.params.applicationId.trim()
        : "";
    if (!applicationId) {
      throw new AppError("validation_error", "applicationId is required.", 400);
    }
    const jobs = await markDocumentProcessingFailed(applicationId);
    res.status(200).json({ jobs });
  })
);

router.post(
  "/banking/:applicationId/fail",
  safeHandler(async (req: any, res: any, next: any) => {
    const applicationId =
      typeof req.params.applicationId === "string"
        ? req.params.applicationId.trim()
        : "";
    if (!applicationId) {
      throw new AppError("validation_error", "applicationId is required.", 400);
    }
    const jobs = await markBankingAnalysisFailed(applicationId);
    res.status(200).json({ jobs });
  })
);

export default router;
