"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.submitLenderSubmission = submitLenderSubmission;
const errors_1 = require("../../middleware/errors");
const applications_repo_1 = require("../applications/applications.repo");
const lender_service_1 = require("../lender/lender.service");
async function submitLenderSubmission(params) {
    const application = await (0, applications_repo_1.findApplicationById)(params.applicationId);
    if (!application) {
        throw new errors_1.AppError("not_found", "Application not found.", 404);
    }
    if (!application.lender_id) {
        throw new errors_1.AppError("missing_lender", "Application lender is not set.", 400);
    }
    if (!application.lender_product_id) {
        throw new errors_1.AppError("missing_product", "Application lender product is not set.", 400);
    }
    const submitPayload = {
        applicationId: params.applicationId,
        idempotencyKey: params.idempotencyKey,
        lenderId: application.lender_id,
        lenderProductId: application.lender_product_id,
        actorUserId: params.actorUserId,
        ...(params.skipRequiredDocuments !== undefined
            ? { skipRequiredDocuments: params.skipRequiredDocuments }
            : {}),
        ...(params.ip ? { ip: params.ip } : {}),
        ...(params.userAgent ? { userAgent: params.userAgent } : {}),
    };
    const result = await (0, lender_service_1.submitApplication)(submitPayload);
    return { statusCode: result.statusCode, value: result.value };
}
