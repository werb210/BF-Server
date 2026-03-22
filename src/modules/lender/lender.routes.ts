import { Router, type Request } from "express";
import { requireAuth, requireCapability } from "../../middleware/auth";
import { CAPABILITIES } from "../../auth/capabilities";
import { AppError } from "../../middleware/errors";
import { getSubmissionStatus, submitApplication } from "./lender.service";
import { lenderSubmissionRateLimit } from "../../middleware/rateLimit";
import { safeHandler } from "../../middleware/safeHandler";
import { toStringSafe } from "../../utils/toStringSafe";

const router = Router();

function buildRequestMetadata(req: Request): { ip?: string; userAgent?: string } {
  const metadata: { ip?: string; userAgent?: string } = {};
  if (req.ip) {
    metadata.ip = req.ip;
  }
  const userAgent = req.get("user-agent");
  if (userAgent) {
    metadata.userAgent = userAgent;
  }
  return metadata;
}

router.post(
  "/submissions",
  requireAuth,
  requireCapability([CAPABILITIES.LENDER_SUBMIT]),
  lenderSubmissionRateLimit(),
  safeHandler(async (req, res, next) => {
    if (!req.user) {
      throw new AppError("missing_token", "Authorization token is required.", 401);
    }
    const {
      applicationId,
      lenderId,
      lenderProductId,
      lender_product_id,
      skipRequiredDocuments,
    } = req.body ?? {};
    const resolvedLenderProductId =
      typeof lenderProductId === "string" ? lenderProductId : lender_product_id;
    if (typeof applicationId !== "string" || applicationId.trim().length === 0) {
      throw new AppError(
        "missing_fields",
        "applicationId is required.",
        400
      );
    }
    if (typeof lenderId !== "string" || lenderId.trim().length === 0) {
      throw new AppError("missing_fields", "lenderId is required.", 400);
    }
    if (
      typeof resolvedLenderProductId !== "string" ||
      resolvedLenderProductId.trim().length === 0
    ) {
      throw new AppError("missing_fields", "lenderProductId is required.", 400);
    }
    if (
      skipRequiredDocuments !== undefined &&
      skipRequiredDocuments !== null &&
      typeof skipRequiredDocuments !== "boolean"
    ) {
      throw new AppError(
        "validation_error",
        "skipRequiredDocuments must be a boolean.",
        400
      );
    }
    const submission = await submitApplication({
      applicationId,
      idempotencyKey: req.get("idempotency-key") ?? null,
      lenderId,
      lenderProductId: resolvedLenderProductId,
      actorUserId: req.user.userId,
      skipRequiredDocuments: Boolean(skipRequiredDocuments),
      ...buildRequestMetadata(req),
    });
    res.status(submission.statusCode).json({ submission: submission.value });
  })
);

router.get(
  "/submissions/:id",
  requireAuth,
  requireCapability([CAPABILITIES.LENDER_SUBMIT]),
  safeHandler(async (req, res, next) => {
    const submissionId = toStringSafe(req.params.id);
    if (!submissionId) {
      throw new AppError("validation_error", "submission id is required.", 400);
    }
    const submission = await getSubmissionStatus(submissionId);
    res.json({ submission });
  })
);

export default router;
