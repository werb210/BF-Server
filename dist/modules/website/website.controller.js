"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.submitCreditReadiness = submitCreditReadiness;
const crm_service_1 = require("../crm/crm.service");
const sms_service_1 = require("../notifications/sms.service");
const continuation_service_1 = require("../continuation/continuation.service");
async function submitCreditReadiness(req, res) {
    try {
        const { companyName, fullName, phone, email, industry, yearsInBusiness, monthlyRevenue, annualRevenue, requestedAmount, creditScoreRange, productInterest, industryInterest, arOutstanding, existingDebt, } = req.body;
        if (!companyName || !fullName || !phone || !email) {
            return res.status(400).json({ error: "Missing required fields" });
        }
        const lead = await (0, crm_service_1.createCrmLead)({
            companyName,
            fullName,
            phone,
            email,
            industry,
            yearsInBusiness,
            monthlyRevenue,
            annualRevenue,
            requestedAmount,
            creditScoreRange,
            productInterest,
            industryInterest,
            arOutstanding,
            existingDebt,
            source: "website_credit_readiness",
            tags: ["credit_readiness"],
        });
        const token = await (0, continuation_service_1.createContinuation)(req.body, lead.id);
        await (0, sms_service_1.sendSms)({
            to: "+15878881837",
            message: `New continuation lead: ${companyName}`,
        });
        return res["json"]({
            success: true,
            leadId: lead.id,
            redirect: `https://client.boreal.financial/apply?continue=${token}`,
        });
    }
    catch (err) {
        console.error("Credit readiness error:", err);
        return res.status(500).json({ error: "Server error" });
    }
}
