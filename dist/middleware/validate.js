"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateBody = exports.validationErrorHandler = void 0;
exports.requireFields = requireFields;
function requireFields(fields) {
    return (req, res, next) => {
        for (const field of fields) {
            if (!req.body[field]) {
                return res.status(400).json({ error: "invalid_payload" });
            }
        }
        next();
    };
}
const validationErrorHandler = (err, _req, res, next) => {
    if (err?.type === "validation") {
        return res.status(400).json({ error: "invalid_payload" });
    }
    return next(err);
};
exports.validationErrorHandler = validationErrorHandler;
// backward compatibility
exports.validateBody = requireFields;
