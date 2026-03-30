"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.successResponse = successResponse;
exports.errorResponse = errorResponse;
function successResponse(res, data = {}, message = "ok") {
    return res.status(200).json({ success: true, message, data });
}
function errorResponse(res, status = 500, error = "server_error") {
    return res.status(status).json({ success: false, error });
}
