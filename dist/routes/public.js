"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = require("../db");
const validate_1 = require("../middleware/validate");
const validation_1 = require("../validation");
const response_1 = require("../lib/response");
const routeWrap_1 = require("../lib/routeWrap");
const clean_1 = require("../utils/clean");
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
    return (0, clean_1.stripUndefined)({ leadId: result.rows[0]?.id });
}
router.get("/test", (0, routeWrap_1.wrap)(async (req, res) => res.status(200).json((0, response_1.ok)({ ok: true }, req.rid))));
router.post("/lead", (0, validate_1.requireFields)(["companyName", "email"]), (0, routeWrap_1.wrap)(async (req, res) => {
    const result = await createLead(req.body);
    if (!result?.leadId) {
        return res.status(400).json((0, response_1.fail)("INVALID_INPUT", req.rid));
    }
    return res.status(200).json((0, response_1.ok)({ leadId: result.leadId }, req.rid));
}));
router.all("/lead", (0, routeWrap_1.wrap)(async (req, res) => res.status(405).json((0, response_1.fail)("METHOD_NOT_ALLOWED", req.rid))));
exports.default = router;
