"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createOrReuseReadinessSession = createOrReuseReadinessSession;
exports.fetchActiveReadinessSessionByToken = fetchActiveReadinessSessionByToken;
const node_crypto_1 = require("node:crypto");
const db_1 = require("../../db");
const leadUpsert_service_1 = require("../crm/leadUpsert.service");
function normalizeEmail(email) {
    return email.trim().toLowerCase();
}
function toInteger(value) {
    if (value === undefined || value === null || value === "")
        return null;
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : null;
}
function toNumeric(value) {
    if (value === undefined || value === null || value === "")
        return null;
    const n = Number(typeof value === "string" ? value.replace(/,/g, "") : value);
    return Number.isFinite(n) ? n : null;
}
function toBoolean(value) {
    if (value === undefined || value === null || value === "")
        return null;
    if (typeof value === "boolean")
        return value;
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes"].includes(normalized))
        return true;
    if (["false", "0", "no"].includes(normalized))
        return false;
    return null;
}
async function createOrReuseReadinessSession(payload) {
    const email = normalizeEmail(payload.email);
    const normalizedPhone = payload.phone.trim();
    await (0, db_1.dbQuery)(`update readiness_sessions
     set is_active = false, updated_at = now()
     where is_active = true and expires_at <= now()`);
    const existing = await (0, db_1.dbQuery)(`select id, token, crm_lead_id
     from readiness_sessions
     where (
        lower(email) = $1
        or ($2::text is not null and phone = $2)
     )
     and is_active = true and expires_at > now()
     order by created_at desc
     limit 1`, [email, normalizedPhone]);
    const startupInterest = String(payload.industry ?? "").toLowerCase().includes("startup");
    const crmLead = await (0, leadUpsert_service_1.upsertCrmLead)({
        companyName: payload.companyName,
        fullName: payload.fullName,
        email,
        phone: payload.phone,
        industry: payload.industry,
        yearsInBusiness: payload.yearsInBusiness,
        monthlyRevenue: payload.monthlyRevenue,
        annualRevenue: payload.annualRevenue,
        arOutstanding: payload.arOutstanding,
        existingDebt: payload.existingDebt,
        source: "credit_readiness",
        tags: startupInterest ? ["readiness", "startup_interest"] : ["readiness"],
        activityType: "readiness_submission",
        activityPayload: { email },
    });
    if (existing.rows[0]) {
        await (0, db_1.dbQuery)(`update readiness_sessions
       set crm_lead_id = $2,
           updated_at = now()
       where id = $1`, [existing.rows[0].id, crmLead.id]);
        return {
            sessionId: existing.rows[0].id,
            token: existing.rows[0].token,
            reused: true,
            crmLeadId: crmLead.id,
        };
    }
    const id = (0, node_crypto_1.randomUUID)();
    const token = (0, node_crypto_1.randomUUID)();
    const expiresAt = new Date(Date.now() + 1000 * 60 * 30);
    await (0, db_1.dbQuery)(`insert into readiness_sessions (
      id, token, email, phone, company_name, full_name, industry,
      years_in_business, monthly_revenue, annual_revenue, ar_outstanding, existing_debt,
      crm_lead_id, expires_at
    ) values (
      $1, $2, $3, $4, $5, $6, $7,
      $8, $9, $10, $11, $12,
      $13, $14
    )`, [
        id,
        token,
        email,
        payload.phone,
        payload.companyName,
        payload.fullName,
        payload.industry ?? null,
        toInteger(payload.yearsInBusiness),
        toNumeric(payload.monthlyRevenue),
        toNumeric(payload.annualRevenue),
        toNumeric(payload.arOutstanding),
        toBoolean(payload.existingDebt),
        crmLead.id,
        expiresAt,
    ]);
    return { sessionId: id, token, reused: false, crmLeadId: crmLead.id };
}
async function fetchActiveReadinessSessionByToken(sessionId) {
    const result = await (0, db_1.dbQuery)(`select id, token, crm_lead_id, email, phone, company_name, full_name, industry,
            years_in_business, monthly_revenue, annual_revenue, ar_outstanding, existing_debt,
            expires_at
     from readiness_sessions
     where id = $1 and is_active = true and expires_at > now()
     limit 1`, [sessionId]);
    const row = result.rows[0];
    if (!row) {
        return null;
    }
    return {
        sessionId: row.id,
        readinessToken: row.token,
        leadId: row.crm_lead_id,
        email: row.email,
        phone: row.phone,
        companyName: row.company_name,
        fullName: row.full_name,
        industry: row.industry,
        yearsInBusiness: row.years_in_business,
        monthlyRevenue: row.monthly_revenue,
        annualRevenue: row.annual_revenue,
        arOutstanding: row.ar_outstanding,
        existingDebt: row.existing_debt,
        expiresAt: row.expires_at,
    };
}
