"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requestTimeout = requestTimeout;
const REQUEST_TIMEOUT_MS = 5_000;
function requestTimeout(req, res, next) {
    res.setTimeout(REQUEST_TIMEOUT_MS, () => {
        if (!res.headersSent) {
            res.status(503).json({ error: "timeout" });
        }
    });
    next();
}
