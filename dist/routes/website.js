"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const contact_controller_1 = require("../modules/website/contact.controller");
const website_controller_1 = require("../modules/website/website.controller");
const config_1 = require("../config");
const router = (0, express_1.Router)();
const websiteLimiter = (0, express_rate_limit_1.default)({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => config_1.config.env === "test",
});
const websiteBodyLimitBytes = 64 * 1024;
router.use(websiteLimiter);
router.use((req, res, next) => {
    const contentLength = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(contentLength) && contentLength > websiteBodyLimitBytes) {
        res.status(413).json({ error: "Payload too large" });
        return;
    }
    next();
});
router.post("/credit-readiness", website_controller_1.submitCreditReadiness);
router.post("/contact", contact_controller_1.submitContactForm);
exports.default = router;
