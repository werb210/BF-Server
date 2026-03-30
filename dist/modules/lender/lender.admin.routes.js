"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const lender_service_1 = require("./lender.service");
const errors_1 = require("../../middleware/errors");
const auth_1 = require("../../middleware/auth");
const capabilities_1 = require("../../auth/capabilities");
const router = (0, express_1.Router)();
router.use(auth_1.requireAuth);
router.use((0, auth_1.requireCapability)([capabilities_1.CAPABILITIES.OPS_MANAGE]));
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
            throw new errors_1.AppError("validation_error", "application id is required.", 400);
        }
        const status = await (0, lender_service_1.fetchTransmissionStatus)(applicationId);
        res["json"]({ transmission: status });
    }
    catch (err) {
        next(err);
    }
});
router.post("/transmissions/:id/retry", async (req, res, next) => {
    try {
        if (!req.user) {
            throw new errors_1.AppError("missing_token", "Authorization token is required.", 401);
        }
        const submissionId = req.params.id;
        if (!submissionId) {
            throw new errors_1.AppError("validation_error", "submission id is required.", 400);
        }
        const result = await (0, lender_service_1.retrySubmission)({
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
            throw new errors_1.AppError("missing_token", "Authorization token is required.", 401);
        }
        const submissionId = req.params.id;
        if (!submissionId) {
            throw new errors_1.AppError("validation_error", "submission id is required.", 400);
        }
        const result = await (0, lender_service_1.cancelSubmissionRetry)({
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
exports.default = router;
