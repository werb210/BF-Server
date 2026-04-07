"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.errorHandler = errorHandler;
const response_1 = require("../lib/response");
function errorHandler(err, req, res, next) {
    const headerRid = req.headers["x-request-id"];
    const rid = req.id ?? req.rid ?? (typeof headerRid === "string" ? headerRid : undefined);
    console.error("SERVER ERROR:", {
        rid,
        path: req.path,
        error: err,
    });
    if (res.headersSent) {
        return next(err);
    }
    return res.status(500).json((0, response_1.fail)("Internal server error", rid));
}
