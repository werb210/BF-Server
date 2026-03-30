"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createContinuation = createContinuation;
exports.fetchContinuation = fetchContinuation;
exports.convertContinuation = convertContinuation;
const node_crypto_1 = require("node:crypto");
const db_1 = require("../../db");
function toNullableNumber(value) {
    if (value === undefined || value === null || value === "") {
        return null;
    }
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}
function toNullableInteger(value) {
    const parsed = toNullableNumber(value);
    if (parsed === null) {
        return null;
    }
    return Math.trunc(parsed);
}
function toNullableBoolean(value) {
    if (value === undefined || value === null || value === "") {
        return null;
    }
    if (typeof value === "boolean") {
        return value;
    }
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "y"].includes(normalized)) {
        return true;
    }
    if (["false", "0", "no", "n"].includes(normalized)) {
        return false;
    }
    return null;
}
async function createContinuation(payload, crmLeadId) {
    const token = (0, node_crypto_1.randomBytes)(24).toString("hex");
    await db_1.pool.query(`
    INSERT INTO application_continuations (
      token,
      company_name,
      full_name,
      email,
      phone,
      industry,
      years_in_business,
      monthly_revenue,
      annual_revenue,
      ar_outstanding,
      existing_debt,
      crm_lead_id
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    `, [
        token,
        payload.companyName ?? null,
        payload.fullName ?? null,
        payload.email ?? null,
        payload.phone ?? null,
        payload.industry ?? null,
        toNullableInteger(payload.yearsInBusiness),
        toNullableNumber(payload.monthlyRevenue),
        toNullableNumber(payload.annualRevenue),
        toNullableNumber(payload.arOutstanding),
        toNullableBoolean(payload.existingDebt),
        crmLeadId,
    ]);
    return token;
}
async function fetchContinuation(token) {
    const { rows } = await db_1.pool.query("SELECT * FROM application_continuations WHERE token = $1", [token]);
    return rows[0] ?? null;
}
async function convertContinuation(token, applicationId) {
    await db_1.pool.query(`
    UPDATE application_continuations
    SET converted_application_id = $1,
        converted_at = NOW()
    WHERE token = $2
    `, [applicationId, token]);
}
