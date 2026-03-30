"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureApplicationSubmissionState = ensureApplicationSubmissionState;
const errors_1 = require("../../middleware/errors");
const applications_repo_1 = require("../applications/applications.repo");
const pipelineState_1 = require("../applications/pipelineState");
const applications_service_1 = require("../applications/applications.service");
async function ensureApplicationSubmissionState(params) {
    const requestMetadata = {
        ...(params.ip ? { ip: params.ip } : {}),
        ...(params.userAgent ? { userAgent: params.userAgent } : {}),
    };
    const application = await (0, applications_repo_1.findApplicationById)(params.applicationId, params.client);
    if (!application) {
        throw new errors_1.AppError("not_found", "Application not found.", 404);
    }
    if (!(0, pipelineState_1.isPipelineState)(application.pipeline_state)) {
        throw new errors_1.AppError("invalid_state", "Pipeline state is invalid.", 400);
    }
    if (application.pipeline_state !== pipelineState_1.ApplicationStage.IN_REVIEW) {
        throw new errors_1.AppError("invalid_state", "Application must be in IN_REVIEW to submit to lenders.", 400);
    }
    await (0, applications_service_1.transitionPipelineState)({
        applicationId: params.applicationId,
        nextState: pipelineState_1.ApplicationStage.STARTUP,
        actorUserId: params.actorUserId,
        actorRole: null,
        trigger: "submission_started",
        ...requestMetadata,
        client: params.client,
    });
    await (0, applications_service_1.transitionPipelineState)({
        applicationId: params.applicationId,
        nextState: pipelineState_1.ApplicationStage.OFF_TO_LENDER,
        actorUserId: params.actorUserId,
        actorRole: null,
        trigger: "submission_sent",
        ...requestMetadata,
        client: params.client,
    });
}
