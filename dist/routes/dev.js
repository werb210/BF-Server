"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const router = (0, express_1.Router)();
router.get("/health", (_req, res) => {
    res["json"]({
        status: "ok",
        service: "bf-server",
        timestamp: new Date().toISOString(),
    });
});
router.get("/dev/ping", (_req, res) => {
    res["json"]({
        message: "pong",
    });
});
exports.default = router;
