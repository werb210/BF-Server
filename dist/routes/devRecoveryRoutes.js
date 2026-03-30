"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const router = (0, express_1.Router)();
router.get("/api/dev/ready", async (_req, res) => {
    res["json"]({
        ok: true,
        service: "bf-server",
        mode: "development",
    });
});
router.get("/telephony/token", async (_req, res) => {
    res["json"]({
        ok: true,
        token: "dev-token",
        identity: "dev-user",
    });
});
router.get("/api/application/continuation", async (_req, res) => {
    res["json"]({
        status: "ok",
        data: {},
    });
});
router.post("/api/application/update", async (_req, res) => {
    res["json"]({
        status: "ok",
        saved: true,
    });
});
exports.default = router;
