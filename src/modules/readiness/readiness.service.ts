import { randomUUID } from "node:crypto";
import { z } from "zod";
import { dbQuery } from "../../db";
import { normalizePhoneNumber } from "../auth/phone";
import { createApplication } from "../applications/applications.repo";
import { upsertCrmLead } from "../crm/leadUpsert.service";
import { stripUndefined, toNullable } from "../../utils/clean";

const readinessSourceSchema = z.enum(["website", "client"]);

const numericFromUnknown = z.preprocess((value) => {
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
}, z.number().finite().nonnegative().optional());

const integerFromUnknown = z.preprocess((value) => {
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
}, z.number().int().nonnegative().optional());

const booleanFromUnknown = z.preprocess((value) => {
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
}, z.boolean().optional());

export const createReadinessLeadSchema = z.object({
  companyName: z.string().trim().min(2),
  fullName: z.string().trim().min(2),
  phone: z.string().trim().min(7),
  email: z.string().trim().email(),
  industry: z.string().trim().min(2).optional(),
  yearsInBusiness: integerFromUnknown,
  monthlyRevenue: numericFromUnknown,
  annualRevenue: numericFromUnknown,
  arOutstanding: numericFromUnknown,
  existingDebt: booleanFromUnknown,
});

export type CreateReadinessLeadInput = z.infer<typeof createReadinessLeadSchema> & {
  source?: z.infer<typeof readinessSourceSchema>;
};

type ReadinessLeadRow = {
  id: string;
  company_name: string;
  full_name: string;
  phone: string;
  email: string;
  industry: string | null;
  years_in_business: number | null;
  monthly_revenue: string | null;
  annual_revenue: string | null;
  ar_outstanding: string | null;
  existing_debt: boolean | null;
  source: string;
  status: string;
  crm_contact_id: string | null;
  application_id: string | null;
  created_at: Date;
  updated_at: Date;
};

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeRequiredPhone(phone: string): string {
  const normalized = normalizePhoneNumber(phone);
  if (!normalized) {
    throw new Error("invalid_phone");
  }
  return normalized;
}

async function findExistingContactId(params: {
  email: string;
  phone: string;
}): Promise<string | null> {
  const result = await dbQuery<{ id: string }>(
    `select id
     from contacts
     where lower(email) = lower($1)
        or phone = $2
     order by created_at asc
     limit 1`,
    [params.email, params.phone]
  );
  return result.rows[0]?.id ?? null;
}

async function createContact(params: {
  fullName: string;
  email: string;
  phone: string;
  sourceTag: "readiness_v1" | "startup_interest";
}): Promise<string> {
  const id = randomUUID();
  await dbQuery(
    `insert into contacts (id, name, email, phone, status, created_at, updated_at)
     values ($1, $2, $3, $4, $5, now(), now())`,
    [id, params.fullName, params.email, params.phone, params.sourceTag]
  );
  return id;
}

export async function linkCrmContact(params: {
  fullName: string;
  email: string;
  phone: string;
  startupInterest?: boolean;
}): Promise<string> {
  const existingId = await findExistingContactId({
    email: params.email,
    phone: params.phone,
  });

  if (existingId) {
    await dbQuery(
      `update contacts
       set status = $2,
           updated_at = now()
       where id = $1`,
      [existingId, params.startupInterest ? "startup_interest" : "readiness_v1"]
    );
    return existingId;
  }

  return createContact({
    fullName: params.fullName,
    email: params.email,
    phone: params.phone,
    sourceTag: params.startupInterest ? "startup_interest" : "readiness_v1",
  });
}

export async function createReadinessLead(input: CreateReadinessLeadInput): Promise<{ leadId: string }> {
  const parsed = createReadinessLeadSchema.parse(input);
  const email = normalizeEmail(parsed.email);
  const phone = normalizeRequiredPhone(parsed.phone);

  const leadId = randomUUID();
  const source = readinessSourceSchema.parse(input.source ?? "website");

  const crmContactId = await linkCrmContact({
    fullName: parsed.fullName,
    email,
    phone,
  });

  await upsertCrmLead(stripUndefined({
    companyName: parsed.companyName,
    fullName: parsed.fullName,
    email,
    phone,
    industry: parsed.industry,
    yearsInBusiness: toNullable(parsed.yearsInBusiness),
    monthlyRevenue: toNullable(parsed.monthlyRevenue),
    annualRevenue: toNullable(parsed.annualRevenue),
    arOutstanding: toNullable(parsed.arOutstanding),
    existingDebt: toNullable(parsed.existingDebt),
    source: `readiness_${source}`,
    tags: ["readiness"],
    activityType: "readiness_submission",
    activityPayload: { source },
  }));

  await dbQuery(
    `insert into readiness_leads (
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
    )`,
    [
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
    ]
  );

  return { leadId };
}

export async function listReadinessLeads(): Promise<ReadinessLeadRow[]> {
  const result = await dbQuery<ReadinessLeadRow>(
    `select id, company_name, full_name, phone, email, industry, years_in_business,
            monthly_revenue, annual_revenue, ar_outstanding, existing_debt, source,
            status, crm_contact_id, application_id, created_at, updated_at
     from readiness_leads
     order by created_at desc`
  );
  return result.rows;
}

export async function convertReadinessLeadToApplication(id: string, ownerUserId: string): Promise<{ applicationId: string }> {
  const leadResult = await dbQuery<ReadinessLeadRow>(
    `select id, company_name, full_name, phone, email, industry, years_in_business,
            monthly_revenue, annual_revenue, ar_outstanding, existing_debt, source,
            status, crm_contact_id, application_id, created_at, updated_at
     from readiness_leads
     where id = $1
     limit 1`,
    [id]
  );

  const lead = leadResult.rows[0];
  if (!lead) {
    throw new Error("not_found");
  }

  if (lead.application_id) {
    return { applicationId: lead.application_id };
  }

  const app = await createApplication({
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

  await dbQuery(
    `update readiness_leads
     set application_id = $2,
         status = 'converted',
         updated_at = now()
     where id = $1`,
    [lead.id, app.id]
  );

  try {
    await dbQuery(
      `with matched_session as (
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
       where id in (select id from matched_session)`,
      [lead.email, app.id]
    );

    await dbQuery(
      `insert into readiness_application_mappings (readiness_session_id, application_id)
       select id, $2
       from readiness_sessions
       where lower(email) = lower($1)
         and converted_application_id = $2
       on conflict (readiness_session_id) do nothing`,
      [lead.email, app.id]
    );
  } catch {
    // Backward-compatible in environments where readiness session mapping tables are not yet present.
  }

  return { applicationId: app.id };
}

export async function fetchReadinessLeadByApplicationId(applicationId: string): Promise<ReadinessLeadRow | null> {
  const result = await dbQuery<ReadinessLeadRow>(
    `select id, company_name, full_name, phone, email, industry, years_in_business,
            monthly_revenue, annual_revenue, ar_outstanding, existing_debt, source,
            status, crm_contact_id, application_id, created_at, updated_at
     from readiness_leads
     where application_id = $1
     limit 1`,
    [applicationId]
  );

  return result.rows[0] ?? null;
}
