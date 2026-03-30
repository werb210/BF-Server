"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.dbGuard = void 0;
const startupState_1 = require("../startupState");
const dbGuard = (req, res, next) => {
    const bypassPrefixes = [
        "/health",
        "/_int",
        "/ready",
    ];
    if (bypassPrefixes.some((prefix) => req.path.startsWith(prefix))) {
        return next();
    }
    if (!(0, startupState_1.isReady)()) {
        return res.status(503).json({
            code: "DB_NOT_READY",
            message: "Database unavailable",
        });
    }
    next();
};
exports.dbGuard = dbGuard;
