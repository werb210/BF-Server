"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const leadUpsert_service_1 = require("../crm/leadUpsert.service");
const smsService_1 = require("../../services/smsService");
const logger_1 = require("../../observability/logger");
const router = (0, express_1.Router)();
router.post("/ai/confidence", async (req, res, next) => {
    const { companyName, fullName, email, phone, industry, yearsInBusiness, monthlyRevenue, annualRevenue, arOutstanding, existingDebt, } = req.body ?? {};
    const years = Number(yearsInBusiness ?? 0);
    const monthly = Number(monthlyRevenue ?? 0);
    const score = years > 2 && monthly > 20000 ? "Strong" : "Needs Review";
    await (0, leadUpsert_service_1.upsertCrmLead)({
        companyName,
        fullName,
        email,
        phone,
        industry,
        yearsInBusiness,
        monthlyRevenue,
        annualRevenue,
        arOutstanding,
        existingDebt,
        source: "confidence_check",
        tags: ["startup_interest"],
        activityType: "confidence_check",
        activityPayload: { score },
    });
    await (0, smsService_1.sendSMS)("+15878881837", `Lead type: confidence_check | Name: ${fullName ?? "unknown"} | Phone: ${phone ?? "unknown"}`).catch((error) => {
        (0, logger_1.logWarn)("confidence_sms_failed", {
            message: error instanceof Error ? error.message : String(error),
            email,
            phone,
        });
    });
    res["json"]({
        score,
        message: score === "Strong"
            ? "Based on the information provided, your business appears aligned with common underwriting parameters."
            : "We recommend speaking with an advisor to explore structuring options.",
    });
});
router.post("/ai/voice/token", async (_req, res) => {
    res["json"]({ token: "voice-ready-placeholder" });
});
exports.default = router;
