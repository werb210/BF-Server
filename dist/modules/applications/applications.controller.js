"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchApplicationProcessingStatus = fetchApplicationProcessingStatus;
const errors_1 = require("../../middleware/errors");
const roles_1 = require("../../auth/roles");
const applications_service_1 = require("./applications.service");
const toStringSafe_1 = require("../../utils/toStringSafe");
const STAFF_ROLES = new Set([roles_1.ROLES.ADMIN, roles_1.ROLES.STAFF, roles_1.ROLES.OPS]);
async function fetchApplicationProcessingStatus(req, res) {
    if (!req.user) {
        throw new errors_1.AppError("missing_token", "Authorization token is required.", 401);
    }
    const role = req.user.role;
    if (!role || !(0, roles_1.isRole)(role)) {
        throw (0, errors_1.forbiddenError)();
    }
    if (!STAFF_ROLES.has(role)) {
        throw new errors_1.AppError("forbidden", "Not authorized.", 403);
    }
    const applicationId = (0, toStringSafe_1.toStringSafe)(req.params.id);
    if (!applicationId) {
        throw new errors_1.AppError("validation_error", "application id is required.", 400);
    }
    const status = await (0, applications_service_1.fetchProcessingStatus)(applicationId);
    res.status(200).json(status);
}
