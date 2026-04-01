"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = require("../db");
const validate_1 = require("../middleware/validate");
const validation_1 = require("../validation");
const apiResponse_1 = require("../lib/apiResponse");
const routeWrap_1 = require("../lib/routeWrap");
const router = (0, express_1.Router)();
async function createLead(payload) {
    const normalizedPayload = {
        ...payload,
        businessName: payload.businessName ?? payload.companyName,
    };
    const parsed = validation_1.LeadSchema.safeParse(normalizedPayload ?? {});
    if (!parsed.success) {
        return {};
    }
    const data = parsed.data;
    const result = await (0, db_1.dbQuery)(`insert into crm_leads (email, phone, company_name, product_interest, requested_amount, source)
       values ($1, $2, $3, $4, $5, 'public_api')
       returning id`, [data.email, data.phone, data.businessName, data.productType, data.requestedAmount ?? null]);
    return { leadId: result.rows[0]?.id };
}
router.get("/test", (0, routeWrap_1.wrap)(async () => (0, apiResponse_1.ok)({ ok: true })));
router.post("/lead", (0, validate_1.requireFields)(["companyName", "email"]), (0, routeWrap_1.wrap)(async (req, res) => {
    const result = await createLead(req.body);
    if (!result?.leadId) {
        return (0, apiResponse_1.fail)(res, "INVALID_INPUT");
    }
    return (0, apiResponse_1.ok)({ leadId: result.leadId });
}));
router.all("/lead", (0, routeWrap_1.wrap)(async (_req, res) => (0, apiResponse_1.fail)(res, "METHOD_NOT_ALLOWED")));
exports.default = router;
