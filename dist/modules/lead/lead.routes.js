"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const auth_1 = require("../../middleware/auth");
const idempotency_1 = require("../../middleware/idempotency");
const lead_service_1 = require("./lead.service");
const createLeadSchema = zod_1.z.object({
    source: zod_1.z.string().trim().min(1),
    companyName: zod_1.z.string().trim().optional(),
    fullName: zod_1.z.string().trim().optional(),
    email: zod_1.z.string().trim().optional(),
    phone: zod_1.z.string().trim().optional(),
    yearsInBusiness: zod_1.z.string().trim().optional(),
    annualRevenue: zod_1.z.string().trim().optional(),
    monthlyRevenue: zod_1.z.string().trim().optional(),
    requestedAmount: zod_1.z.string().trim().optional(),
    creditScoreRange: zod_1.z.string().trim().optional(),
    productInterest: zod_1.z.string().trim().optional(),
    industryInterest: zod_1.z.string().trim().optional(),
    notes: zod_1.z.string().trim().optional(),
    tags: zod_1.z.unknown().optional(),
});
const router = (0, express_1.Router)();
router.post("/", auth_1.requireAuth, idempotency_1.idempotencyMiddleware, async (req, res, next) => {
    if (!req.body ||
        typeof req.body !== "object" ||
        !("source" in req.body) ||
        typeof req.body.source !== "string" ||
        !req.body.source.trim()) {
        return res.status(400).json({
            error: {
                message: "invalid_lead_body",
                code: "invalid_input",
            },
        });
    }
    const parseResult = createLeadSchema.safeParse(req.body);
    if (!parseResult.success) {
        return res.status(400).json({
            error: {
                message: "invalid_lead_body",
                code: "invalid_input",
            },
        });
    }
    const body = parseResult.data;
    try {
        const lead = await (0, lead_service_1.createLead)({
            source: body.source,
            companyName: body.companyName,
            fullName: body.fullName,
            email: body.email,
            phone: body.phone,
            yearsInBusiness: body.yearsInBusiness,
            annualRevenue: body.annualRevenue,
            monthlyRevenue: body.monthlyRevenue,
            requestedAmount: body.requestedAmount,
            creditScoreRange: body.creditScoreRange,
            productInterest: body.productInterest,
            industryInterest: body.industryInterest,
            notes: body.notes,
            tags: body.tags,
        });
        res.status(201).json(lead);
    }
    catch (err) {
        next(err);
    }
});
router.get("/", auth_1.requireAuth, async (_req, res, next) => {
    try {
        const leads = await (0, lead_service_1.getLeads)();
        res["json"](leads);
    }
    catch (err) {
        next(err);
    }
});
exports.default = router;
