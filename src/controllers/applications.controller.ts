import { type Request, type Response } from "express";
import { ApplicationStage } from "../modules/applications/pipelineState.js";

export async function listApplicationStages(
  _req: Request,
  res: Response
): Promise<void> {
  res.status(200).json([
    ApplicationStage.RECEIVED,
    ApplicationStage.IN_REVIEW,
    ApplicationStage.DOCUMENTS_REQUIRED,
    ApplicationStage.ADDITIONAL_STEPS_REQUIRED,
    ApplicationStage.OFF_TO_LENDER,
    ApplicationStage.OFFER,
    ApplicationStage.ACCEPTED,
    ApplicationStage.REJECTED,
  ]);
}
