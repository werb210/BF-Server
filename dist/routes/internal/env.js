"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const config_1 = require("../../config");
const api_1 = require("../../config/api");
const router = (0, express_1.Router)();
router.get("/api/_int/env", (_req, res) => {
    res["json"]({
        apiBaseUrl: config_1.config.api.baseUrl ?? config_1.config.client.url ?? api_1.API_BASE_URL,
        allowedOrigins: (config_1.config.allowedOrigins ?? "").split(",").map((v) => v.trim()).filter(Boolean),
    });
});
exports.default = router;
