import { type Request, type Response } from "express";
import { AppError, forbiddenError } from "../../middleware/errors.js";
import { type Role, isRole, ROLES } from "../../auth/roles.js";
import { fetchProcessingStatus } from "./applications.service.js";
import { toStringSafe } from "../../utils/toStringSafe.js";

const STAFF_ROLES = new Set<Role>([ROLES.ADMIN, ROLES.STAFF, ROLES.OPS]);

export async function fetchApplicationProcessingStatus(
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
  const status = await fetchProcessingStatus(applicationId);
  res.status(200).json(status);
}
