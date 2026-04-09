import { Router } from "express";
import { fetchTransmissionStatus, retrySubmission, cancelSubmissionRetry } from "./lender.service.js";
import { AppError } from "../../middleware/errors.js";
import { requireAuth, requireCapability } from "../../middleware/auth.js";
import { CAPABILITIES } from "../../auth/capabilities.js";
const router = Router();
router.use(requireAuth);
router.use(requireCapability([CAPABILITIES.OPS_MANAGE]));
function buildRequestMetadata(req) {
    const metadata = {};
    if (req.ip) {
        metadata.ip = req.ip;
    }
    const userAgent = req.get("user-agent");
    if (userAgent) {
        metadata.userAgent = userAgent;
    }
    return metadata;
}
router.get("/applications/:id/transmission-status", async (req, res, next) => {
    try {
        const applicationId = req.params.id;
        if (!applicationId) {
            throw new AppError("validation_error", "application id is required.", 400);
        }
        const status = await fetchTransmissionStatus(applicationId);
        res["json"]({ transmission: status });
    }
    catch (err) {
        next(err);
    }
});
router.post("/transmissions/:id/retry", async (req, res, next) => {
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
        res["json"]({ retry: result });
    }
    catch (err) {
        next(err);
    }
});
router.post("/transmissions/:id/cancel", async (req, res, next) => {
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
        res["json"]({ retry: result });
    }
    catch (err) {
        next(err);
    }
});
export default router;
