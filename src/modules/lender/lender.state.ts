import { AppError } from "../../middleware/errors";
import { findApplicationById } from "../applications/applications.repo";
import { ApplicationStage, isPipelineState } from "../applications/pipelineState";
import { transitionPipelineState } from "../applications/applications.service";
import { type PoolClient } from "pg";

export async function ensureApplicationSubmissionState(params: {
  applicationId: string;
  actorUserId: string;
  ip?: string;
  userAgent?: string;
  client: Pick<PoolClient, "query" | "runQuery">;
}): Promise<void> {
  const requestMetadata = {
    ...(params.ip ? { ip: params.ip } : {}),
    ...(params.userAgent ? { userAgent: params.userAgent } : {}),
  };
  const application = await findApplicationById(params.applicationId, params.client);
  if (!application) {
    throw new AppError("not_found", "Application not found.", 404);
  }
  if (!isPipelineState(application.pipeline_state)) {
    throw new AppError("invalid_state", "Pipeline state is invalid.", 400);
  }
  if (application.pipeline_state !== ApplicationStage.IN_REVIEW) {
    throw new AppError(
      "invalid_state",
      "Application must be in IN_REVIEW to submit to lenders.",
      400
    );
  }

  await transitionPipelineState({
    applicationId: params.applicationId,
    nextState: ApplicationStage.STARTUP,
    actorUserId: params.actorUserId,
    actorRole: null,
    trigger: "submission_started",
    ...requestMetadata,
    client: params.client,
  });

  await transitionPipelineState({
    applicationId: params.applicationId,
    nextState: ApplicationStage.OFF_TO_LENDER,
    actorUserId: params.actorUserId,
    actorRole: null,
    trigger: "submission_sent",
    ...requestMetadata,
    client: params.client,
  });
}
