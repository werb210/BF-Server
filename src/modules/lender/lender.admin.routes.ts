import { Router, type Request } from "express";
import { fetchTransmissionStatus, retrySubmission, cancelSubmissionRetry } from "./lender.service";
import { AppError } from "../../middleware/errors";
import { requireAuth, requireCapability } from "../../middleware/auth";
import { CAPABILITIES } from "../../auth/capabilities";

const router = Router();

router.use(requireAuth);
router.use(requireCapability([CAPABILITIES.OPS_MANAGE]));

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

router.get("/applications/:id/transmission-status", async (req: any, res: any, next: any) => {
  try {
    const applicationId = req.params.id;
    if (!applicationId) {
      throw new AppError("validation_error", "application id is required.", 400);
    }
    const status = await fetchTransmissionStatus(applicationId);
    res.json({ transmission: status });
  } catch (err) {
    next(err);
  }
});

router.post("/transmissions/:id/retry", async (req: any, res: any, next: any) => {
  try {
    if (!req.user) {
      throw new AppError("missing_token", "Authorization token is required.", 401);
    }
    const submissionId = req.params.id;
    if (!submissionId) {
      throw new AppError("validation_error", "submission id is required.", 400);
    }
    const result = await retrySubmission({
      submissionId,
      actorUserId: req.user.userId,
      ...buildRequestMetadata(req),
    });
    res.json({ retry: result });
  } catch (err) {
    next(err);
  }
});

router.post("/transmissions/:id/cancel", async (req: any, res: any, next: any) => {
  try {
    if (!req.user) {
      throw new AppError("missing_token", "Authorization token is required.", 401);
    }
    const submissionId = req.params.id;
    if (!submissionId) {
      throw new AppError("validation_error", "submission id is required.", 400);
    }
    const result = await cancelSubmissionRetry({
      submissionId,
      actorUserId: req.user.userId,
      ...buildRequestMetadata(req),
    });
    res.json({ retry: result });
  } catch (err) {
    next(err);
  }
});

export default router;
