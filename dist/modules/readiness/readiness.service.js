"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createReadinessLeadSchema = void 0;
exports.linkCrmContact = linkCrmContact;
exports.createReadinessLead = createReadinessLead;
exports.listReadinessLeads = listReadinessLeads;
exports.convertReadinessLeadToApplication = convertReadinessLeadToApplication;
exports.fetchReadinessLeadByApplicationId = fetchReadinessLeadByApplicationId;
const node_crypto_1 = require("node:crypto");
const zod_1 = require("zod");
const db_1 = require("../../db");
const phone_1 = require("../auth/phone");
const applications_repo_1 = require("../applications/applications.repo");
const leadUpsert_service_1 = require("../crm/leadUpsert.service");
const readinessSourceSchema = zod_1.z.enum(["website", "client"]);
const numericFromUnknown = zod_1.z.preprocess((value) => {
    if (value === null || value === undefined || value === "") {
        return undefined;
    }
    if (typeof value === "number") {
        return value;
    }
    if (typeof value === "string") {
        const parsed = Number(value.replace(/,/g, ""));
        return Number.isFinite(parsed) ? parsed : value;
    }
    return value;
}, zod_1.z.number().finite().nonnegative().optional());
const integerFromUnknown = zod_1.z.preprocess((value) => {
    if (value === null || value === undefined || value === "") {
        return undefined;
    }
    if (typeof value === "number") {
        return value;
    }
    if (typeof value === "string") {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : value;
    }
    return value;
}, zod_1.z.number().int().nonnegative().optional());
const booleanFromUnknown = zod_1.z.preprocess((value) => {
    if (value === null || value === undefined || value === "") {
        return undefined;
    }
    if (typeof value === "boolean") {
        return value;
    }
    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (["true", "yes", "1"].includes(normalized)) {
            return true;
        }
        if (["false", "no", "0"].includes(normalized)) {
            return false;
        }
    }
    return value;
}, zod_1.z.boolean().optional());
exports.createReadinessLeadSchema = zod_1.z.object({
    companyName: zod_1.z.string().trim().min(2),
    fullName: zod_1.z.string().trim().min(2),
    phone: zod_1.z.string().trim().min(7),
    email: zod_1.z.string().trim().email(),
    industry: zod_1.z.string().trim().min(2).optional(),
    yearsInBusiness: integerFromUnknown,
    monthlyRevenue: numericFromUnknown,
    annualRevenue: numericFromUnknown,
    arOutstanding: numericFromUnknown,
    existingDebt: booleanFromUnknown,
});
function normalizeEmail(email) {
    return email.trim().toLowerCase();
}
function normalizeRequiredPhone(phone) {
    const normalized = (0, phone_1.normalizePhoneNumber)(phone);
    if (!normalized) {
        throw new Error("invalid_phone");
    }
    return normalized;
}
async function findExistingContactId(params) {
    const result = await (0, db_1.dbQuery)(`select id
     from contacts
     where lower(email) = lower($1)
        or phone = $2
     order by created_at asc
     limit 1`, [params.email, params.phone]);
    return result.rows[0]?.id ?? null;
}
async function createContact(params) {
    const id = (0, node_crypto_1.randomUUID)();
    await (0, db_1.dbQuery)(`insert into contacts (id, name, email, phone, status, created_at, updated_at)
     values ($1, $2, $3, $4, $5, now(), now())`, [id, params.fullName, params.email, params.phone, params.sourceTag]);
    return id;
}
async function linkCrmContact(params) {
    const existingId = await findExistingContactId({
        email: params.email,
        phone: params.phone,
    });
    if (existingId) {
        await (0, db_1.dbQuery)(`update contacts
       set status = $2,
           updated_at = now()
       where id = $1`, [existingId, params.startupInterest ? "startup_interest" : "readiness_v1"]);
        return existingId;
    }
    return createContact({
        fullName: params.fullName,
        email: params.email,
        phone: params.phone,
        sourceTag: params.startupInterest ? "startup_interest" : "readiness_v1",
    });
}
async function createReadinessLead(input) {
    const parsed = exports.createReadinessLeadSchema.parse(input);
    const email = normalizeEmail(parsed.email);
    const phone = normalizeRequiredPhone(parsed.phone);
    const leadId = (0, node_crypto_1.randomUUID)();
    const source = readinessSourceSchema.parse(input.source ?? "website");
    const crmContactId = await linkCrmContact({
        fullName: parsed.fullName,
        email,
        phone,
    });
    await (0, leadUpsert_service_1.upsertCrmLead)({
        companyName: parsed.companyName,
        fullName: parsed.fullName,
        email,
        phone,
        industry: parsed.industry,
        yearsInBusiness: parsed.yearsInBusiness,
        monthlyRevenue: parsed.monthlyRevenue,
        annualRevenue: parsed.annualRevenue,
        arOutstanding: parsed.arOutstanding,
        existingDebt: parsed.existingDebt,
        source: `readiness_${source}`,
        tags: ["readiness"],
        activityType: "readiness_submission",
        activityPayload: { source },
    });
    await (0, db_1.dbQuery)(`insert into readiness_leads (
      id,
      company_name,
      full_name,
      phone,
      email,
      industry,
      years_in_business,
      monthly_revenue,
      annual_revenue,
      ar_outstanding,
      existing_debt,
      source,
      status,
      crm_contact_id,
      created_at,
      updated_at
    ) values (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'new', $13, now(), now()
    )`, [
        leadId,
        parsed.companyName,
        parsed.fullName,
        phone,
        email,
        parsed.industry ?? null,
        parsed.yearsInBusiness ?? null,
        parsed.monthlyRevenue ?? null,
        parsed.annualRevenue ?? null,
        parsed.arOutstanding ?? null,
        parsed.existingDebt ?? null,
        source,
        crmContactId,
    ]);
    return { leadId };
}
async function listReadinessLeads() {
    const result = await (0, db_1.dbQuery)(`select id, company_name, full_name, phone, email, industry, years_in_business,
            monthly_revenue, annual_revenue, ar_outstanding, existing_debt, source,
            status, crm_contact_id, application_id, created_at, updated_at
     from readiness_leads
     order by created_at desc`);
    return result.rows;
}
async function convertReadinessLeadToApplication(id, ownerUserId) {
    const leadResult = await (0, db_1.dbQuery)(`select id, company_name, full_name, phone, email, industry, years_in_business,
            monthly_revenue, annual_revenue, ar_outstanding, existing_debt, source,
            status, crm_contact_id, application_id, created_at, updated_at
     from readiness_leads
     where id = $1
     limit 1`, [id]);
    const lead = leadResult.rows[0];
    if (!lead) {
        throw new Error("not_found");
    }
    if (lead.application_id) {
        return { applicationId: lead.application_id };
    }
    const app = await (0, applications_repo_1.createApplication)({
        ownerUserId,
        name: lead.company_name,
        metadata: {
            readinessLeadId: lead.id,
            readiness: {
                fullName: lead.full_name,
                email: lead.email,
                phone: lead.phone,
                industry: lead.industry,
                yearsInBusiness: lead.years_in_business,
                monthlyRevenue: lead.monthly_revenue,
                annualRevenue: lead.annual_revenue,
                arOutstanding: lead.ar_outstanding,
                existingDebt: lead.existing_debt,
            },
        },
        productType: "readiness",
        productCategory: "standard",
        source: `readiness:${lead.source}`,
    });
    await (0, db_1.dbQuery)(`update readiness_leads
     set application_id = $2,
         status = 'converted',
         updated_at = now()
     where id = $1`, [lead.id, app.id]);
    try {
        await (0, db_1.dbQuery)(`with matched_session as (
         select id
         from readiness_sessions
         where lower(email) = lower($1)
           and is_active = true
         order by created_at desc
         limit 1
       )
       update readiness_sessions
       set converted_application_id = $2,
           is_active = false,
           updated_at = now()
       where id in (select id from matched_session)`, [lead.email, app.id]);
        await (0, db_1.dbQuery)(`insert into readiness_application_mappings (readiness_session_id, application_id)
       select id, $2
       from readiness_sessions
       where lower(email) = lower($1)
         and converted_application_id = $2
       on conflict (readiness_session_id) do nothing`, [lead.email, app.id]);
    }
    catch {
        // Backward-compatible in environments where readiness session mapping tables are not yet present.
    }
    return { applicationId: app.id };
}
async function fetchReadinessLeadByApplicationId(applicationId) {
    const result = await (0, db_1.dbQuery)(`select id, company_name, full_name, phone, email, industry, years_in_business,
            monthly_revenue, annual_revenue, ar_outstanding, existing_debt, source,
            status, crm_contact_id, application_id, created_at, updated_at
     from readiness_leads
     where application_id = $1
     limit 1`, [applicationId]);
    return result.rows[0] ?? null;
}
