import { Router } from "express";
import { z } from "zod";
import { createCRMLead } from "../services/crmService.js";
import { sendSMS } from "../services/smsService.js";
import { config } from "../config/index.js";
import { stripUndefined } from "../utils/clean.js";
const router = Router();
const creditSchema = z.object({
    companyName: z.string().min(1),
    fullName: z.string().min(1),
    email: z.string().email(),
    phone: z.string().min(1),
    industry: z.string().optional(),
    yearsInBusiness: z.number().nonnegative().default(0),
    monthlyRevenue: z.number().nonnegative().optional(),
    annualRevenue: z.number().nonnegative().default(0),
    arOutstanding: z.number().nonnegative().optional(),
    existingDebt: z.boolean().default(false),
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
    await createCRMLead(stripUndefined({
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
    }));
    if (config.intake.smsNumber) {
        await sendSMS(config.intake.smsNumber, `New Credit Check Lead: ${companyName} (${score})`);
    }
    res["json"]({
        score,
        message: "Preliminary assessment complete.",
    });
});
export default router;
