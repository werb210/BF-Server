"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.upsertCrmLead = upsertCrmLead;
const node_crypto_1 = require("node:crypto");
const db_1 = require("../../db");
function normalizeEmail(email) {
    if (!email)
        return null;
    const normalized = email.trim().toLowerCase();
    return normalized.length > 0 ? normalized : null;
}
function normalizePhone(phone) {
    if (!phone)
        return null;
    const normalized = phone.trim();
    return normalized.length > 0 ? normalized : null;
}
function dedupeTags(tags) {
    return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
}
async function upsertCrmLead(input) {
    const email = normalizeEmail(input.email);
    const phone = normalizePhone(input.phone);
    if (!email && !phone) {
        throw new Error("crm_dedupe_key_required");
    }
    const existing = await (0, db_1.dbQuery)(`select id, tags
     from crm_leads
     where ($1::text is not null and lower(email) = $1)
        or ($2::text is not null and regexp_replace(coalesce(phone, ''), '\\D', '', 'g') = regexp_replace($2, '\\D', '', 'g'))
     order by created_at asc
     limit 1`, [email, phone]);
    const normalizedTags = dedupeTags(input.tags ?? []);
    let leadId;
    let created = false;
    if (existing.rows[0]) {
        leadId = existing.rows[0].id;
        const existingTags = Array.isArray(existing.rows[0].tags) ? existing.rows[0].tags : [];
        const mergedTags = dedupeTags([...existingTags, ...normalizedTags]);
        await (0, db_1.dbQuery)(`update crm_leads
       set company_name = coalesce($2, company_name),
           full_name = coalesce($3, full_name),
           email = coalesce($4, email),
           phone = coalesce($5, phone),
           industry = coalesce($6, industry),
           years_in_business = coalesce($7, years_in_business),
           monthly_revenue = coalesce($8, monthly_revenue),
           annual_revenue = coalesce($9, annual_revenue),
           ar_outstanding = coalesce($10, ar_outstanding),
           existing_debt = coalesce($11, existing_debt),
           source = coalesce($12, source),
           tags = $13::jsonb
       where id = $1`, [
            leadId,
            input.companyName ?? null,
            input.fullName ?? null,
            email,
            phone,
            input.industry ?? null,
            input.yearsInBusiness != null ? String(input.yearsInBusiness) : null,
            input.monthlyRevenue != null ? String(input.monthlyRevenue) : null,
            input.annualRevenue != null ? String(input.annualRevenue) : null,
            input.arOutstanding != null ? String(input.arOutstanding) : null,
            input.existingDebt != null ? String(input.existingDebt) : null,
            input.source,
            JSON.stringify(mergedTags),
        ]);
    }
    else {
        leadId = (0, node_crypto_1.randomUUID)();
        created = true;
        await (0, db_1.dbQuery)(`insert into crm_leads (
        id, company_name, full_name, email, phone, industry,
        years_in_business, monthly_revenue, annual_revenue,
        ar_outstanding, existing_debt, source, tags
      ) values (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9,
        $10, $11, $12, $13::jsonb
      )`, [
            leadId,
            input.companyName ?? null,
            input.fullName ?? null,
            email,
            phone,
            input.industry ?? null,
            input.yearsInBusiness != null ? String(input.yearsInBusiness) : null,
            input.monthlyRevenue != null ? String(input.monthlyRevenue) : null,
            input.annualRevenue != null ? String(input.annualRevenue) : null,
            input.arOutstanding != null ? String(input.arOutstanding) : null,
            input.existingDebt != null ? String(input.existingDebt) : null,
            input.source,
            JSON.stringify(normalizedTags),
        ]);
    }
    await (0, db_1.dbQuery)(`insert into crm_lead_activities (id, lead_id, activity_type, payload)
     values ($1, $2, $3, $4::jsonb)`, [(0, node_crypto_1.randomUUID)(), leadId, input.activityType, JSON.stringify(input.activityPayload ?? {})]);
    return { id: leadId, created };
}
