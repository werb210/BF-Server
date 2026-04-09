import { createCrmLead } from "../crm/crm.service.js";
import { sendSms } from "../notifications/sms.service.js";
import { createContinuation } from "../continuation/continuation.service.js";
import { stripUndefined } from "../../utils/clean.js";
export async function submitCreditReadiness(req, res) {
    try {
        const { companyName, fullName, phone, email, industry, yearsInBusiness, monthlyRevenue, annualRevenue, requestedAmount, creditScoreRange, productInterest, industryInterest, arOutstanding, existingDebt, } = req.body;
        if (!companyName || !fullName || !phone || !email) {
            return res.status(400).json({ error: "Missing required fields" });
        }
        const lead = await createCrmLead(stripUndefined({
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
        }));
        const token = await createContinuation(req.body, lead.id);
        await sendSms({
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
