"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assertLenderBinding = assertLenderBinding;
const roles_1 = require("./roles");
const errors_1 = require("../middleware/errors");
function assertLenderBinding(params) {
    const lenderId = typeof params.lenderId === "string" && params.lenderId.trim().length > 0
        ? params.lenderId.trim()
        : null;
    if (params.role === roles_1.ROLES.LENDER) {
        if (!lenderId) {
            throw new errors_1.AppError("invalid_lender_binding", "lender_id is required for Lender users.", 400);
        }
        return lenderId;
    }
    if (lenderId) {
        throw new errors_1.AppError("invalid_lender_binding", "lender_id must be null for non-Lender users.", 400);
    }
    return null;
}
