"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.wrap = wrap;
const response_1 = require("./response");
const respond_1 = require("../lib/respond");
function wrap(handler) {
    return async (req, res) => {
        try {
            const result = await handler(req, res);
            if (!res.headersSent) {
                (0, respond_1.ok)(res, (0, response_1.ok)(result, req.rid));
            }
        }
        catch (err) {
            if (!res.headersSent) {
                const status = err.status || 500;
                if (status === 429) {
                    res.setHeader("Retry-After", "1");
                }
                (0, respond_1.error)(res, (0, response_1.fail)(err, req.rid).error, status);
            }
        }
    };
}
