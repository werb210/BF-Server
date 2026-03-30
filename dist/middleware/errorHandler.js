"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.errorHandler = errorHandler;
const response_1 = require("../lib/response");
function errorHandler(err, _req, res, _next) {
    return (0, response_1.fail)(res, err.message || "Internal Server Error", 500);
}
