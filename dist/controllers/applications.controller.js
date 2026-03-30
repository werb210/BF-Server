"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listApplicationStages = listApplicationStages;
const pipelineState_1 = require("../modules/applications/pipelineState");
async function listApplicationStages(_req, res) {
    res.status(200).json([
        pipelineState_1.ApplicationStage.RECEIVED,
        pipelineState_1.ApplicationStage.IN_REVIEW,
        pipelineState_1.ApplicationStage.DOCUMENTS_REQUIRED,
        pipelineState_1.ApplicationStage.STARTUP,
        pipelineState_1.ApplicationStage.OFF_TO_LENDER,
        pipelineState_1.ApplicationStage.OFFER,
        pipelineState_1.ApplicationStage.ACCEPTED,
        pipelineState_1.ApplicationStage.REJECTED,
    ]);
}
