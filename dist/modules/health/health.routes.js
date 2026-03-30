"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const config_1 = require("../../config");
const registry_1 = require("../../metrics/registry");
const router = (0, express_1.Router)();
router.get("/healthz", async (_req, res) => {
    res["json"]({ status: "ok" });
});
router.get("/readyz", async (_req, res) => {
    if (!config_1.config.db.skip) {
        // optional DB check
    }
    res["json"]({ status: "ready" });
});
router.get("/metrics", async (_req, res) => {
    res.set("Content-Type", registry_1.registry.contentType);
    res.send(await registry_1.registry.metrics());
});
exports.default = router;
