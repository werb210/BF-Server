import { ApplicationStage } from "../modules/applications/pipelineState.js";
export async function listApplicationStages(_req, res) {
    res.status(200).json([
        ApplicationStage.RECEIVED,
        ApplicationStage.IN_REVIEW,
        ApplicationStage.DOCUMENTS_REQUIRED,
        ApplicationStage.STARTUP,
        ApplicationStage.OFF_TO_LENDER,
        ApplicationStage.OFFER,
        ApplicationStage.ACCEPTED,
        ApplicationStage.REJECTED,
    ]);
}
