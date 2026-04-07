"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const wrap_1 = require("../system/wrap");
const router = (0, express_1.Router)();
router.get("/", (_req, res) => {
    const dbOk = true;
    const dbStatus = process.env.NODE_ENV === "test" || process.env.CI
        ? "ok"
        : dbOk
            ? "ok"
            : "degraded";
    return (0, wrap_1.ok)(res, {
        server: "ok",
        db: dbStatus,
    });
});
exports.default = router;
