import { dbQuery } from "../../db";
import { createCrmLead, listCrmLeads } from "../crm/crm.service";

type LeadPayload = {
  source: string;
  companyName?: string;
  fullName?: string;
  email?: string;
  phone?: string;
  yearsInBusiness?: string;
  annualRevenue?: string;
  monthlyRevenue?: string;
  requestedAmount?: string;
  creditScoreRange?: string;
  productInterest?: string;
  industryInterest?: string;
  notes?: string;
  tags?: unknown;
};

export async function createLead(payload: LeadPayload) {
  if (payload.source === "exit_intent") {
    const email = typeof payload.email === "string" ? payload.email.trim() : "";
    if (!email) {
      throw new Error("Email required for exit_intent lead");
    }

    await dbQuery(
      `insert into crm_leads (email, source) values ($1, 'exit_intent')`,
      [email],
    );

    return { success: true };
  }

  return createCrmLead({
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

export const getLeads = listCrmLeads;
