"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createCrmLead = createCrmLead;
exports.listCrmLeads = listCrmLeads;
const node_crypto_1 = require("node:crypto");
const db_1 = require("../../db");
async function createCrmLead(input) {
    const id = (0, node_crypto_1.randomUUID)();
    await (0, db_1.dbQuery)(`insert into crm_leads (
      id,
      company_name,
      full_name,
      phone,
      email,
      industry,
      years_in_business,
      monthly_revenue,
      annual_revenue,
      requested_amount,
      credit_score_range,
      product_interest,
      industry_interest,
      ar_outstanding,
      existing_debt,
      notes,
      source,
      tags
    ) values (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb
    )`, [
        id,
        input.companyName,
        input.fullName,
        input.phone,
        input.email,
        input.industry ?? null,
        input.yearsInBusiness ?? null,
        input.monthlyRevenue ?? null,
        input.annualRevenue ?? null,
        input.requestedAmount ?? null,
        input.creditScoreRange ?? null,
        input.productInterest ?? null,
        input.industryInterest ?? null,
        input.arOutstanding ?? null,
        input.existingDebt ?? null,
        input.notes ?? null,
        input.source,
        JSON.stringify(input.tags ?? []),
    ]);
    return { id };
}
async function listCrmLeads() {
    const result = await (0, db_1.dbQuery)(`select
      id,
      company_name,
      full_name,
      phone,
      email,
      industry,
      years_in_business,
      monthly_revenue,
      annual_revenue,
      requested_amount,
      credit_score_range,
      product_interest,
      industry_interest,
      ar_outstanding,
      existing_debt,
      notes,
      source,
      tags,
      created_at
    from crm_leads
    order by created_at desc`);
    return result.rows.map((row) => ({
        id: row.id,
        companyName: row.company_name,
        fullName: row.full_name,
        phone: row.phone,
        email: row.email,
        industry: row.industry,
        yearsInBusiness: row.years_in_business,
        monthlyRevenue: row.monthly_revenue,
        annualRevenue: row.annual_revenue,
        requestedAmount: row.requested_amount,
        creditScoreRange: row.credit_score_range,
        productInterest: row.product_interest,
        industryInterest: row.industry_interest,
        arOutstanding: row.ar_outstanding,
        existingDebt: row.existing_debt,
        notes: row.notes,
        source: row.source,
        tags: Array.isArray(row.tags) ? row.tags : [],
        createdAt: row.created_at,
    }));
}
