import { randomUUID } from "node:crypto";
import { dbQuery } from "../../db.js";

export interface CreateLeadInput {
  companyName: string;
  fullName: string;
  phone: string;
  email: string;
  industry?: string;
  yearsInBusiness?: string;
  monthlyRevenue?: string;
  annualRevenue?: string;
  requestedAmount?: string;
  creditScoreRange?: string;
  productInterest?: string;
  industryInterest?: string;
  arOutstanding?: string;
  existingDebt?: string;
  notes?: string;
  source: string;
  tags?: string[];
}

export interface CrmLeadRecord {
  id: string;
  companyName: string | null;
  fullName: string | null;
  phone: string | null;
  email: string;
  industry: string | null;
  yearsInBusiness: string | null;
  monthlyRevenue: string | null;
  annualRevenue: string | null;
  requestedAmount: string | null;
  creditScoreRange: string | null;
  productInterest: string | null;
  industryInterest: string | null;
  arOutstanding: string | null;
  existingDebt: string | null;
  notes: string | null;
  source: string;
  tags: string[];
  createdAt: string;
}

export async function createCrmLead(input: CreateLeadInput): Promise<{ id: string }> {
  // BF_SERVER_LEAD_DEDUPE_v72 - was an unconditional INSERT. If this person is
  // already a lead, update that row rather than making a second one.
  //
  // Matching is by email OR phone, which is what upsertCrmLead does and what
  // the application mirror does. A person who fills the credit-readiness form
  // and later the contact form is one lead, not two.
  //
  // Deliberately NOT delegating wholesale to upsertCrmLead: that function takes
  // a narrower input shape and would silently drop the dozen financial fields
  // this one carries. The lookup is borrowed; the write stays here.
  const dedupeEmail = (input.email ?? "").trim().toLowerCase() || null;
  const dedupePhone = (input.phone ?? "").replace(/\D/g, "") || null;

  if (dedupeEmail || dedupePhone) {
    try {
      const found = await dbQuery<{ id: string }>(
        `select id
           from crm_leads
          where ($1::text is not null and lower(email) = $1)
             or ($2::text is not null
                 and length($2) >= 10
                 and right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 10) = right($2, 10))
          order by created_at asc
          limit 1`,
        [dedupeEmail, dedupePhone],
      );
      const existingId = found.rows?.[0]?.id;
      if (existingId) {
        // COALESCE(NULLIF(...)) so a later submission that omits a field cannot
        // erase what an earlier one supplied. Tags accumulate rather than
        // replace, which is how the readiness and contact tags coexist.
        await dbQuery(
          `update crm_leads set
             company_name      = coalesce(nullif($2,''), company_name),
             full_name         = coalesce(nullif($3,''), full_name),
             phone             = coalesce(nullif($4,''), phone),
             email             = coalesce(nullif($5,''), email),
             industry          = coalesce(nullif($6,''), industry),
             product_interest  = coalesce(nullif($7,''), product_interest),
             notes             = coalesce(nullif($8,''), notes),
             tags              = (
               select to_jsonb(array(
                 select distinct e from unnest(
                   coalesce(array(select jsonb_array_elements_text(coalesce(tags,'[]'::jsonb))), '{}')
                   || coalesce($9::text[], '{}')
                 ) e
               ))
             )
           where id = $1`,
          [
            existingId,
            input.companyName ?? "",
            input.fullName ?? "",
            input.phone ?? "",
            input.email ?? "",
            input.industry ?? "",
            input.productInterest ?? "",
            input.notes ?? "",
            input.tags ?? [],
          ],
        );
        return { id: existingId };
      }
    } catch (err) {
      // A dedupe failure must not lose the lead. Fall through and insert - a
      // duplicate is recoverable, a dropped enquiry is not.
      console.warn("[crm] lead dedupe lookup failed, inserting new", String(err));
    }
  }

  const id = randomUUID();
  await dbQuery(
    `insert into crm_leads (
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
    )`,
    [
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
    ]
  );

  return { id };
}

export async function listCrmLeads(): Promise<CrmLeadRecord[]> {
  const result = await dbQuery<{
    id: string;
    company_name: string | null;
    full_name: string | null;
    phone: string | null;
    email: string;
    industry: string | null;
    years_in_business: string | null;
    monthly_revenue: string | null;
    annual_revenue: string | null;
    requested_amount: string | null;
    credit_score_range: string | null;
    product_interest: string | null;
    industry_interest: string | null;
    ar_outstanding: string | null;
    existing_debt: string | null;
    notes: string | null;
    source: string;
    tags: unknown;
    created_at: string;
  }>(
    `select
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
    order by created_at desc`
  );

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
    tags: Array.isArray(row.tags) ? (row.tags as string[]) : [],
    createdAt: row.created_at,
  }));
}
