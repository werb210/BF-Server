"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const crmService_1 = require("../services/crmService");
const smsService_1 = require("../services/smsService");
const config_1 = require("../config");
const router = (0, express_1.Router)();
const creditSchema = zod_1.z.object({
    companyName: zod_1.z.string().min(1),
    fullName: zod_1.z.string().min(1),
    email: zod_1.z.string().email(),
    phone: zod_1.z.string().min(1),
    industry: zod_1.z.string().optional(),
    yearsInBusiness: zod_1.z.number().nonnegative().default(0),
    monthlyRevenue: zod_1.z.number().nonnegative().optional(),
    annualRevenue: zod_1.z.number().nonnegative().default(0),
    arOutstanding: zod_1.z.number().nonnegative().optional(),
    existingDebt: zod_1.z.boolean().default(false),
});
router.post("/score", async (req, res, next) => {
    const parsed = creditSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: "Invalid payload" });
        return;
    }
    const { companyName, fullName, email, phone, industry, yearsInBusiness, monthlyRevenue, annualRevenue, arOutstanding, existingDebt, } = parsed.data;
    let score = 50;
    if (yearsInBusiness > 2)
        score += 10;
    if (annualRevenue > 500000)
        score += 15;
    if (!existingDebt)
        score += 10;
    score = Math.min(score, 85);
    await (0, crmService_1.createCRMLead)({
        companyName,
        fullName,
        email,
        phone,
        industry,
        source: "website_credit_check",
        metadata: {
            yearsInBusiness,
            monthlyRevenue,
            annualRevenue,
            arOutstanding,
            existingDebt,
            score,
        },
    });
    if (config_1.config.intake.smsNumber) {
        await (0, smsService_1.sendSMS)(config_1.config.intake.smsNumber, `New Credit Check Lead: ${companyName} (${score})`);
    }
    res["json"]({
        score,
        message: "Preliminary assessment complete.",
    });
});
exports.default = router;
