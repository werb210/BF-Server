"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getLeads = void 0;
exports.createLead = createLead;
const db_1 = require("../../db");
const crm_service_1 = require("../crm/crm.service");
async function createLead(payload) {
    if (payload.source === "exit_intent") {
        const email = typeof payload.email === "string" ? payload.email.trim() : "";
        if (!email) {
            throw new Error("Email required for exit_intent lead");
        }
        await (0, db_1.dbQuery)(`insert into crm_leads (email, source) values ($1, 'exit_intent')`, [email]);
        return { success: true };
    }
    return (0, crm_service_1.createCrmLead)({
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
    });
}
exports.getLeads = crm_service_1.listCrmLeads;
