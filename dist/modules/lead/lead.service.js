import { dbQuery } from "../../db.js";
import { createCrmLead, listCrmLeads } from "../crm/crm.service.js";
import { stripUndefined } from "../../utils/clean.js";
export async function createLead(payload) {
    if (payload.source === "exit_intent") {
        const email = typeof payload.email === "string" ? payload.email.trim() : "";
        if (!email) {
            throw new Error("Email required for exit_intent lead");
        }
        await dbQuery(`insert into crm_leads (email, source) values ($1, 'exit_intent')`, [email]);
        return { success: true };
    }
    return createCrmLead(stripUndefined({
        companyName: payload.companyName ?? "",
        fullName: payload.fullName ?? "",
        email: payload.email ?? "",
        phone: payload.phone ?? "",
        yearsInBusiness: payload.yearsInBusiness,
        annualRevenue: payload.annualRevenue,
        monthlyRevenue: payload.monthlyRevenue,
        requestedAmount: payload.requestedAmount,
        creditScoreRange: payload.creditScoreRange,
        productInterest: payload.productInterest,
        industryInterest: payload.industryInterest,
        source: payload.source,
        notes: payload.notes,
        tags: Array.isArray(payload.tags) ? payload.tags : [],
    }));
}
export const getLeads = listCrmLeads;
