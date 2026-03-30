"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireFields = requireFields;
function requireFields(fields) {
    return (req, res, next) => {
        const missing = fields.filter((f) => {
            const v = (req.body ?? {})[f];
            return v === undefined || v === null || v === "";
        });
        if (missing.length > 0) {
            return res.status(400).json({
                error: "Contract violation",
                missing,
                message: "Request does not match API contract"
            });
        }
        next();
    };
}
