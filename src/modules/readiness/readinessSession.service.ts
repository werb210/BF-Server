import { randomUUID } from "node:crypto";
import { dbQuery } from "../../db";
import { upsertCrmLead } from "../crm/leadUpsert.service";

type ReadinessSessionInput = {
  companyName: string;
  fullName: string;
  phone: string;
  email: string;
  industry?: string;
  yearsInBusiness?: number | string;
  monthlyRevenue?: number | string;
  annualRevenue?: number | string;
  arOutstanding?: number | string;
  existingDebt?: boolean | string;
};

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function toInteger(value: number | string | undefined): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function toNumeric(value: number | string | undefined): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(typeof value === "string" ? value.replace(/,/g, "") : value);
  return Number.isFinite(n) ? n : null;
}

function toBoolean(value: boolean | string | undefined): boolean | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "boolean") return value;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes"].includes(normalized)) return true;
  if (["false", "0", "no"].includes(normalized)) return false;
  return null;
}

export async function createOrReuseReadinessSession(payload: ReadinessSessionInput): Promise<{ sessionId: string; token: string; reused: boolean; crmLeadId: string }> {
  const email = normalizeEmail(payload.email);
  const normalizedPhone = payload.phone.trim();

  await dbQuery(
    `update readiness_sessions
     set is_active = false, updated_at = now()
     where is_active = true and expires_at <= now()`
  );

  const existing = await dbQuery<{ id: string; token: string; crm_lead_id: string | null }>(
    `select id, token, crm_lead_id
     from readiness_sessions
     where (
        lower(email) = $1
        or ($2::text is not null and phone = $2)
     )
     and is_active = true and expires_at > now()
     order by created_at desc
     limit 1`,
    [email, normalizedPhone]
  );

  const startupInterest = String(payload.industry ?? "").toLowerCase().includes("startup");

  const crmLead = await upsertCrmLead({
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
    await dbQuery(
      `update readiness_sessions
       set crm_lead_id = $2,
           updated_at = now()
       where id = $1`,
      [existing.rows[0].id, crmLead.id]
    );
    return {
      sessionId: existing.rows[0].id,
      token: existing.rows[0].token,
      reused: true,
      crmLeadId: crmLead.id,
    };
  }

  const id = randomUUID();
  const token = randomUUID();
  const expiresAt = new Date(Date.now() + 1000 * 60 * 30);

  await dbQuery(
    `insert into readiness_sessions (
      id, token, email, phone, company_name, full_name, industry,
      years_in_business, monthly_revenue, annual_revenue, ar_outstanding, existing_debt,
      crm_lead_id, expires_at
    ) values (
      $1, $2, $3, $4, $5, $6, $7,
      $8, $9, $10, $11, $12,
      $13, $14
    )`,
    [
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
    ]
  );

  return { sessionId: id, token, reused: false, crmLeadId: crmLead.id };
}

export async function getActiveReadinessSessionByToken(sessionId: string): Promise<null | {
  sessionId: string;
  readinessToken: string;
  leadId: string | null;
  email: string;
  phone: string | null;
  companyName: string;
  fullName: string;
  industry: string | null;
  yearsInBusiness: number | null;
  monthlyRevenue: string | null;
  annualRevenue: string | null;
  arOutstanding: string | null;
  existingDebt: boolean | null;
  expiresAt: Date;
}> {
  const result = await dbQuery<{
    id: string;
    token: string;
    crm_lead_id: string | null;
    email: string;
    phone: string | null;
    company_name: string;
    full_name: string;
    industry: string | null;
    years_in_business: number | null;
    monthly_revenue: string | null;
    annual_revenue: string | null;
    ar_outstanding: string | null;
    existing_debt: boolean | null;
    expires_at: Date;
  }>(
    `select id, token, crm_lead_id, email, phone, company_name, full_name, industry,
            years_in_business, monthly_revenue, annual_revenue, ar_outstanding, existing_debt,
            expires_at
     from readiness_sessions
     where id = $1 and is_active = true and expires_at > now()
     limit 1`,
    [sessionId]
  );

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
