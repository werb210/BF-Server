"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const db_1 = require("../../db");
const audit_service_1 = require("../audit/audit.service");
const chat_service_1 = require("./chat.service");
const config_1 = require("../../config");
const router = (0, express_1.Router)();
const readinessLimiter = (0, express_rate_limit_1.default)({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many readiness requests" },
    skip: () => config_1.config.env === "test",
});
function toAmount(raw) {
    const parsed = Number(String(raw).replace(/[^0-9.-]/g, ""));
    return Number.isFinite(parsed) ? parsed : 0;
}
function calculateScore(payload) {
    let score = 0;
    const years = Number(payload.yearsInBusiness);
    const annual = toAmount(payload.annualRevenue);
    const monthly = toAmount(payload.monthlyRevenue);
    const ar = toAmount(payload.arOutstanding);
    const debt = toAmount(payload.existingDebt);
    if (years >= 5)
        score += 25;
    else if (years >= 2)
        score += 15;
    else if (years >= 1)
        score += 8;
    if (annual >= 1000000)
        score += 20;
    else if (annual >= 500000)
        score += 14;
    else if (annual >= 250000)
        score += 8;
    if (monthly >= 100000)
        score += 20;
    else if (monthly >= 50000)
        score += 14;
    else if (monthly >= 20000)
        score += 8;
    if (ar >= 50000)
        score += 20;
    else if (ar >= 15000)
        score += 12;
    else if (ar > 0)
        score += 5;
    if (debt <= monthly * 3)
        score += 15;
    else if (debt <= monthly * 8)
        score += 8;
    return Math.max(0, Math.min(100, score));
}
function scoreToTier(score) {
    if (score >= 80)
        return "Strong";
    if (score >= 60)
        return "Moderate";
    return "Emerging";
}
function recommendations(score) {
    if (score >= 80)
        return ["line-of-credit", "term-loan", "asset-based-lending"];
    if (score >= 60)
        return ["line-of-credit", "term-loan"];
    return ["invoice-financing", "revenue-advance"];
}
router.post("/capital-readiness", readinessLimiter, async (req, res, next) => {
    const payload = req.body;
    const score = calculateScore(payload);
    const tier = scoreToTier(score);
    const leadId = await (0, chat_service_1.upsertLead)({
        fullName: payload.fullName,
        email: payload.email,
        phone: payload.phone,
        companyName: payload.companyName,
        tag: "capital_readiness",
    });
    await (0, db_1.runQuery)(`insert into capital_readiness (id, lead_id, score, tier, payload)
     values (gen_random_uuid(), $1, $2, $3, $4::jsonb)`, [leadId, score, tier, JSON.stringify(payload)]);
    if (leadId) {
        await (0, audit_service_1.recordAuditEvent)({
            actorUserId: null,
            targetUserId: null,
            targetType: "contact",
            targetId: leadId,
            action: "crm_timeline",
            eventType: "crm_timeline",
            eventAction: "capital_readiness_submitted",
            success: true,
            metadata: { score, tier, tag: "capital_readiness" },
        });
    }
    res["json"]({ score, tier, recommendedProducts: recommendations(score) });
});
exports.default = router;
