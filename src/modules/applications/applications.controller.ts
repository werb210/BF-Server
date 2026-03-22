import { type Request, type Response } from "express";
import { AppError, forbiddenError } from "../../middleware/errors";
import { type Role, isRole, ROLES } from "../../auth/roles";
import { getProcessingStatus } from "./applications.service";
import { toStringSafe } from "../../utils/toStringSafe";

const STAFF_ROLES = new Set<Role>([ROLES.ADMIN, ROLES.STAFF, ROLES.OPS]);

export async function getApplicationProcessingStatus(
  req: Request,
  res: Response
): Promise<void> {
  if (!req.user) {
    throw new AppError("missing_token", "Authorization token is required.", 401);
  }
  const role = req.user.role;
  if (!role || !isRole(role)) {
    throw forbiddenError();
  }
  if (!STAFF_ROLES.has(role)) {
    throw new AppError("forbidden", "Not authorized.", 403);
  }
  const applicationId = toStringSafe(req.params.id);
  if (!applicationId) {
    throw new AppError("validation_error", "application id is required.", 400);
  }
  const status = await getProcessingStatus(applicationId);
  res.status(200).json(status);
}
