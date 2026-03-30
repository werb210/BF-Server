"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const publicService_1 = require("../services/publicService");
const readiness_service_1 = require("../modules/readiness/readiness.service");
const config_1 = require("../config");
const router = (0, express_1.Router)();
router.get("/lender-count", async (_req, res) => {
    const count = await (0, publicService_1.fetchActiveLenderCount)();
    res["json"]({ count });
});
const readinessLimiter = (0, express_rate_limit_1.default)({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => config_1.config.env === "test",
});
router.post("/readiness", readinessLimiter, async (req, res) => {
    try {
        const { leadId } = await (0, readiness_service_1.createReadinessLead)(req.body ?? {});
        res.status(201).json({ leadId, status: "created" });
    }
    catch (error) {
        if (error instanceof Error && error.message === "invalid_phone") {
            res.status(400).json({ error: "Invalid payload" });
            return;
        }
        if (error && typeof error === "object" && "name" in error && error.name === "ZodError") {
            res.status(400).json({ error: "Invalid payload" });
            return;
        }
        res.status(500).json({ error: "Server error" });
    }
});
exports.default = router;
