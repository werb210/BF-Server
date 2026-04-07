"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireFields = requireFields;
const response_1 = require("../lib/response");
function requireFields(fields) {
    return (req, res, next) => {
        const missing = fields.filter((f) => {
            const value = (req.body ?? {})[f];
            return !value || String(value).trim() === "";
        });
        if (missing.length > 0) {
            return res.status(400).json((0, response_1.fail)("INVALID_INPUT", req.rid));
        }
        next();
    };
}
