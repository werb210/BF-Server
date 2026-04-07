"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.wrap = wrap;
exports.ok = ok;
exports.error = error;
const crypto_1 = __importDefault(require("crypto"));
function wrap(fn) {
    return async (req, res, next) => {
        try {
            const result = await fn(req, res, next);
            if (!res.headersSent && result !== undefined) {
                res.json(result);
            }
        }
        catch (err) {
            next(err);
        }
    };
}
function ok(res, data) {
    return res.json({
        status: "ok",
        data,
    });
}
function error(res, message, status = 400) {
    return res.status(status).json({
        status: "error",
        error: message,
        rid: crypto_1.default.randomUUID(),
    });
}
