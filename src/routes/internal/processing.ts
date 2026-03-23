import { Router } from "express";
import { AppError } from "../../middleware/errors";
import { safeHandler } from "../../middleware/safeHandler";
import { requireAuth, requireCapability } from "../../middleware/auth";
import { CAPABILITIES } from "../../auth/capabilities";
import {
  markBankingAnalysisCompleted,
  markBankingAnalysisFailed,
  markDocumentProcessingCompleted,
  markDocumentProcessingFailed,
} from "../../modules/processing/processing.service";

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
