"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const schemas_1 = require("../schemas");
const validate_1 = require("../middleware/validate");
const response_1 = require("../lib/response");
const db_1 = require("../db");
const router = (0, express_1.Router)();
router.post("/lead", (0, validate_1.validate)(schemas_1.LeadSchema), async (req, res, next) => {
    try {
        const lead = req.validated;
        const created = await (0, db_1.dbQuery)(`insert into crm_leads (email, phone, company_name, product_interest, source)
       values ($1, $2, $3, $4, $5)
       returning id, email, phone, company_name, product_interest, source`, [lead.email, lead.phone, lead.businessName ?? lead.name, lead.productType ?? null, "crm_api"]);
        return (0, response_1.ok)({
            id: created.rows[0]?.id,
            name: lead.name,
            email: created.rows[0]?.email ?? lead.email,
            phone: created.rows[0]?.phone ?? lead.phone,
            businessName: created.rows[0]?.company_name ?? lead.businessName ?? lead.name,
            productType: created.rows[0]?.product_interest ?? lead.productType ?? null,
            source: created.rows[0]?.source ?? "crm_api",
        }, req.rid);
    }
    catch (error) {
        return next(error);
    }
});
exports.default = router;
