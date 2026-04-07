"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.routeWrap = void 0;
exports.wrap = wrap;
function wrap(fn) {
    return async (req, res, next) => {
        try {
            const result = await fn(req, res, next);
            if (!res.headersSent && result) {
                res.json(result);
            }
        }
        catch (err) {
            next(err);
        }
    };
}
exports.routeWrap = wrap;
