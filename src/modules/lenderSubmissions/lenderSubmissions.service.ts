import { AppError } from "../../middleware/errors.js";
import { findApplicationById } from "../applications/applications.repo.js";
import { submitApplication } from "../lender/lender.service.js";

export async function submitLenderSubmission(params: {
  applicationId: string;
  idempotencyKey: string | null;
  actorUserId: string;
  skipRequiredDocuments?: boolean;
  ip?: string;
  userAgent?: string;
}): Promise<{ statusCode: number; value: { id: string; status: string; failureReason?: string | null } }> {
  const application = await findApplicationById(params.applicationId);
  if (!application) {
    throw new AppError("not_found", "Application not found.", 404);
  }
  if (!application.lender_id) {
    throw new AppError("missing_lender", "Application lender is not set.", 400);
  }
  if (!application.lender_product_id) {
    throw new AppError("missing_product", "Application lender product is not set.", 400);
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
  const result = await submitApplication(submitPayload);

  return { statusCode: result.statusCode, value: result.value };
}
