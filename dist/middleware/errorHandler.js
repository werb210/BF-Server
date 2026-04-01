"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.errorHandler = errorHandler;
function errorHandler(err, _req, res, _next) {
    console.error("SERVER ERROR:", err);
    if (err?.name === "UnauthorizedError") {
        return res.status(401).json({ success: false, error: "Unauthorized" });
    }
    return res.status(500).json({
        success: false,
        error: "Internal server error",
    });
}
