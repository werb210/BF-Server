import { ROLES } from "./roles.js";
import { AppError } from "../middleware/errors.js";
export function assertLenderBinding(params) {
    const lenderId = typeof params.lenderId === "string" && params.lenderId.trim().length > 0
        ? params.lenderId.trim()
        : null;
    if (params.role === ROLES.LENDER) {
        if (!lenderId) {
            throw new AppError("invalid_lender_binding", "lender_id is required for Lender users.", 400);
        }
        return lenderId;
    }
    if (lenderId) {
        throw new AppError("invalid_lender_binding", "lender_id must be null for non-Lender users.", 400);
    }
    return null;
}
