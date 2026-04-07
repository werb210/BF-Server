"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateBody = exports.validationErrorHandler = void 0;
exports.validate = validate;
exports.requireFields = requireFields;
const response_1 = require("../lib/response");
function validate(schema, target = "body") {
    return (req, res, next) => {
        if (target === "body") {
            const isUploadRoute = req.originalUrl.split("?")[0] === "/api/documents/upload";
            if (req.method === "POST" && !req.is("application/json") && !isUploadRoute) {
                return res.status(415).json((0, response_1.fail)("JSON_REQUIRED", req.rid));
            }
        }
        const result = schema.safeParse(req[target]);
        if (!result.success) {
            return res.status(400).json((0, response_1.fail)("INVALID_INPUT", req.rid));
        }
        Object.assign(req, { [target]: result.data });
        if (target === "body") {
            req.validated = result.data;
        }
        return next();
    };
}
function requireFields(fields) {
    return (req, res, next) => {
        for (const field of fields) {
            const value = req.body ? req.body[field] : undefined;
            if (!value || String(value).trim() === "") {
                return res.status(400).json((0, response_1.fail)("INVALID_INPUT", req.rid));
            }
        }
        return next();
    };
}
const validationErrorHandler = (err, req, res, next) => {
    if (err?.type === "validation") {
        return res.status(400).json((0, response_1.fail)("INVALID_INPUT", req.rid));
    }
    return next(err);
};
exports.validationErrorHandler = validationErrorHandler;
exports.validateBody = requireFields;
