import { Router, type Request } from "express";
import { requireAuth, requireCapability } from "../../middleware/auth";
import { CAPABILITIES } from "../../auth/capabilities";
import { AppError } from "../../middleware/errors";
import { safeHandler } from "../../middleware/safeHandler";
import { lenderSubmissionRateLimit } from "../../middleware/rateLimit";
import { submitLenderSubmission } from "./lenderSubmissions.service";
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
  "/:applicationId/submit",
  requireAuth,
  requireCapability([CAPABILITIES.LENDER_SUBMIT]),
  lenderSubmissionRateLimit(),
  safeHandler(async (req, res, next) => {
    if (!req.user) {
      throw new AppError("missing_token", "Authorization token is required.", 401);
    }
    const applicationId = toStringSafe(req.params.applicationId);
    if (!applicationId) {
      throw new AppError("missing_fields", "applicationId is required.", 400);
    }
    const { skipRequiredDocuments } = req.body ?? {};
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
    const submission = await submitLenderSubmission({
      applicationId,
      idempotencyKey: req.get("idempotency-key") ?? null,
      actorUserId: req.user.userId,
      skipRequiredDocuments: Boolean(skipRequiredDocuments),
      ...buildRequestMetadata(req),
    });
    res.status(submission.statusCode).json({ submission: submission.value });
  })
);

export default router;
