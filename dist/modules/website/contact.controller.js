"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.submitContactForm = submitContactForm;
const crm_service_1 = require("../crm/crm.service");
const sms_service_1 = require("../notifications/sms.service");
const continuation_service_1 = require("../continuation/continuation.service");
const logger_1 = require("../../observability/logger");
async function submitContactForm(req, res) {
    try {
        const { companyName, fullName, phone, email, message, productInterest, industryInterest } = req.body;
        if (!companyName || !fullName || !phone || !email) {
            return res.status(400).json({ error: "Missing required fields" });
        }
        const lead = await (0, crm_service_1.createCrmLead)({
            companyName,
            fullName,
            phone,
            email,
            notes: message,
            productInterest,
            industryInterest,
            source: "website_contact",
            tags: ["contact_form"],
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
        (0, logger_1.logError)("website_contact_form_failed", { message: err instanceof Error ? err.message : String(err) });
        return res.status(500).json({ error: "Server error" });
    }
}
