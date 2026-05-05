import type { Request, Response } from "express";
import { createCrmLead } from "../crm/crm.service.js";
import { createContinuation } from "../continuation/continuation.service.js";
import { stripUndefined } from "../../utils/clean.js";
import { pool } from "../../db.js";
import { notifyAllStaff } from "../../services/notifications/notifyAllStaff.js";
// BF_SERVER_BLOCK_v129a_READINESS_PHONE_NORMALIZE_v1
import { normalizePhoneNumber } from "../auth/phone.js";

// BF_SERVER_BLOCK_v134_READINESS_FLOW_FIX_v1
// Three fixes vs. v133 to make the website -> wizard -> staff pipeline
// handoff actually work end-to-end. See script header for full
// discussion. Code-level summary:
//   - (A) ::text casts on $3,$4 inside the draft INSERT's jsonb_build_object
//   - (A) RETURNING id captures the draft application uuid
//   - (B) UPDATE application_continuations SET converted_application_id
//         links the continuation row to the draft so submit-by-token works

// BF_SERVER_v?_BLOCK_1_14_V1_READINESS_AND_STAFF_NOTIFY
export async function submitCreditReadiness(req: Request, res: Response) {
  try {
    const {
      // identity
      companyName,
      fullName,
      phone,
      email,
      // business profile
      industry,
      businessLocation,
      // funding profile
      fundingType,
      requestedAmount,
      purposeOfFunds,
      // financial profile
      salesHistoryYears,
      annualRevenueRange,
      avgMonthlyRevenueRange,
      accountsReceivableRange,
      fixedAssetsValueRange,
    } = req.body as Record<string, string | number | undefined>;

    if (!companyName || !fullName || !phone || !email) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // BF_SERVER_BLOCK_v129a_READINESS_PHONE_NORMALIZE_v1
    const normalizedPhone =
      normalizePhoneNumber(String(phone)) ?? String(phone);

    const lead = await createCrmLead(
      stripUndefined({
        companyName: String(companyName),
        fullName: String(fullName),
        phone: normalizedPhone,
        email: String(email),
        industry: industry ? String(industry) : undefined,
        productInterest: fundingType ? String(fundingType) : undefined,
        notes: purposeOfFunds ? `Purpose: ${purposeOfFunds}` : undefined,
        source: "website_credit_readiness",
        tags: ["credit_readiness"],
      }),
    );

    const requestedAmountNumber =
      requestedAmount === undefined || requestedAmount === null || requestedAmount === ""
        ? null
        : Number(requestedAmount);

    await pool.query(
      `INSERT INTO readiness_sessions (
         id, token, email, phone, company_name, full_name, industry,
         business_location, funding_type, requested_amount, purpose_of_funds,
         sales_history_years, annual_revenue_range, avg_monthly_revenue_range,
         accounts_receivable_range, fixed_assets_value_range,
         crm_lead_id, expires_at, is_active
       )
       VALUES (
         gen_random_uuid(), gen_random_uuid()::text, $1, $2, $3, $4, $5,
         $6, $7, $8, $9,
         $10, $11, $12,
         $13, $14,
         $15, now() + interval '30 days', true
       )
       ON CONFLICT (lower(email)) WHERE is_active = true
       DO UPDATE SET
         phone = EXCLUDED.phone,
         company_name = EXCLUDED.company_name,
         full_name = EXCLUDED.full_name,
         industry = EXCLUDED.industry,
         business_location = EXCLUDED.business_location,
         funding_type = EXCLUDED.funding_type,
         requested_amount = EXCLUDED.requested_amount,
         purpose_of_funds = EXCLUDED.purpose_of_funds,
         sales_history_years = EXCLUDED.sales_history_years,
         annual_revenue_range = EXCLUDED.annual_revenue_range,
         avg_monthly_revenue_range = EXCLUDED.avg_monthly_revenue_range,
         accounts_receivable_range = EXCLUDED.accounts_receivable_range,
         fixed_assets_value_range = EXCLUDED.fixed_assets_value_range,
         crm_lead_id = EXCLUDED.crm_lead_id,
         updated_at = now()`,
      [
        String(email).toLowerCase(),
        normalizedPhone,
        String(companyName),
        String(fullName),
        industry ?? null,
        businessLocation ?? null,
        fundingType ?? null,
        requestedAmountNumber,
        purposeOfFunds ?? null,
        salesHistoryYears ?? null,
        annualRevenueRange ?? null,
        avgMonthlyRevenueRange ?? null,
        accountsReceivableRange ?? null,
        fixedAssetsValueRange ?? null,
        lead.id,
      ],
    );

    const fundingTypeStr =
      typeof fundingType === "string" ? fundingType.trim().toUpperCase() : "";
    const draftCategory =
      fundingTypeStr.length > 0 ? fundingTypeStr : "TERM";
    let draftApplicationId: string | null = null;
    try {
      const draftRes = await pool.query<{ id: string }>(
        `INSERT INTO applications
           (id, owner_user_id, name, metadata, product_type, product_category,
            pipeline_state, current_stage, status, requested_amount, source,
            startup_flag, silo, created_at, updated_at)
         VALUES (
           gen_random_uuid(),
           NULL,
           $1,
           jsonb_build_object(
             'source','website_credit_readiness',
             'crm_lead_id', $2::text,
             'readiness_email', $3::text,
             'readiness_phone', $4::text
           ),
           $5, $5,
           'draft', 'draft', 'draft',
           $6, 'website_credit_readiness',
           false, 'BF', now(), now()
         )
         RETURNING id`,
        [
          String(companyName),
          lead.id,
          String(email).toLowerCase(),
          normalizedPhone,
          draftCategory,
          requestedAmountNumber,
        ]
      );
      draftApplicationId = draftRes.rows[0]?.id ?? null;
    } catch (err) {
      console.warn("[website_readiness] draft application insert failed", err);
    }

    const token = await createContinuation(req.body as any, lead.id);

    if (draftApplicationId) {
      await pool
        .query(
          `UPDATE application_continuations
              SET converted_application_id = $1
            WHERE token = $2 AND converted_application_id IS NULL`,
          [draftApplicationId, token]
        )
        .catch((err) => {
          console.warn(
            "[website_readiness] continuation->application link failed",
            err
          );
        });
    }

    const amountText = requestedAmountNumber
      ? ` ($${requestedAmountNumber.toLocaleString("en-US", { maximumFractionDigits: 0 })})`
      : "";
    const body = `Boreal: New readiness lead — ${companyName}${amountText}. ${fullName} (${normalizedPhone}). Open the staff portal.`;

    await notifyAllStaff({
      pool,
      notificationType: "website_readiness",
      title: `New readiness lead — ${companyName}`,
      body,
      refTable: "crm_leads",
      refId: lead.id,
      contextUrl: `/crm/leads/${encodeURIComponent(lead.id)}`,
      silo: "BF",
    }).catch((err) => {
      console.warn("[website_readiness] notifyAllStaff failed", err);
    });

    return res.json({
      success: true,
      leadId: lead.id,
      redirect: `https://client.boreal.financial/apply?continue=${token}`,
    });
  } catch (err) {
    console.error("[website_credit_readiness] error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
