import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { db, pool } from "../db.js";
import { config } from "../config/index.js";
import { ApplicationStage } from "../modules/applications/pipelineState.js";
import { sendSms } from "../modules/notifications/sms.service.js";
import { createContinuation } from "../models/continuation.js";
import { createOrReuseReadinessSession } from "../modules/readiness/readinessSession.service.js";
import { upsertCrmLead } from "../modules/crm/leadUpsert.service.js";
import { findOrCreateContactByEmailAndCompany } from "../services/contacts.js";
import { retry } from "../utils/retry.js";
import { logError } from "../observability/logger.js";
import { stripUndefined, toNullable } from "../utils/clean.js";

const router = Router();

// BF_SERVER_BLOCK_v650_TEST2_FIX_PACK_v1 — accept all 13 fields the
// website's CreditReadiness page sends. The previous schema's key names
// did not match the website payload; most financial fields silently
// dropped because zod just ignored the unknown keys.
const payloadSchema = z.object({
  companyName: z.string().min(1),
  fullName: z.string().min(1),
  phone: z.string().min(1),
  email: z.string().email(),
  industry: z.string().optional(),
  // New fields (migration 091 added the columns; code never wired them):
  businessLocation: z.string().optional(),
  requestedAmount: z.union([z.string(), z.number()]).optional(),
  purposeOfFunds: z.string().optional(),
  // Range/string fields from website (form sends range strings like ">$1M"):
  salesHistoryYears: z.string().optional(),
  annualRevenueRange: z.string().optional(),
  avgMonthlyRevenueRange: z.string().optional(),
  accountsReceivableRange: z.string().optional(),
  fixedAssetsValueRange: z.string().optional(),
  // Legacy keys still accepted for backward compat (if any caller uses them):
  yearsInBusiness: z.union([z.string(), z.number()]).optional(),
  monthlyRevenue: z.union([z.string(), z.number()]).optional(),
  annualRevenue: z.union([z.string(), z.number()]).optional(),
  arOutstanding: z.union([z.string(), z.number()]).optional(),
  existingDebt: z.union([z.string(), z.boolean()]).optional(),
});

router.post("/", async (req: any, res: any, next: any) => {
  const parsed = payloadSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload" });
    return;
  }

  const {
    companyName,
    fullName,
    phone: rawPhone,
    email,
    industry,
    businessLocation,
    requestedAmount,
    purposeOfFunds,
    salesHistoryYears,
    annualRevenueRange,
    avgMonthlyRevenueRange,
    accountsReceivableRange,
    fixedAssetsValueRange,
    yearsInBusiness: legacyYears,
    monthlyRevenue: legacyMonthly,
    annualRevenue: legacyAnnual,
    arOutstanding: legacyAr,
    existingDebt,
  } = parsed.data;
  function toE164Server(input: string): string {
    const digits = String(input ?? "").replace(/\D/g, "");
    if (!digits) return String(input ?? "");
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
    if (String(input ?? "").startsWith("+")) return String(input);
    return `+${digits}`;
  }
  const phone = toE164Server(rawPhone);
  const yearsInBusiness = legacyYears ?? salesHistoryYears ?? null;
  const monthlyRevenue = legacyMonthly ?? avgMonthlyRevenueRange ?? null;
  const annualRevenue = legacyAnnual ?? annualRevenueRange ?? null;
  const arOutstanding = legacyAr ?? accountsReceivableRange ?? null;

  const applicationId = randomUUID();
  await db.query(
    `
      insert into applications
      (id, owner_user_id, name, metadata, product_type, pipeline_state, status, source, created_at, updated_at)
      values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, now(), now())
    `,
    [
      applicationId,
      config.client.submissionOwnerUserId,
      companyName,
      JSON.stringify({
        // BF_SERVER_BLOCK_v650_TEST2_FIX_PACK_v1 — full readiness payload.
        contactName: fullName,
        phone,
        email,
        industry: industry ?? null,
        businessLocation: businessLocation ?? null,
        requestedAmount: requestedAmount ?? null,
        purposeOfFunds: purposeOfFunds ?? null,
        salesHistoryYears: salesHistoryYears ?? yearsInBusiness ?? null,
        annualRevenueRange: annualRevenueRange ?? annualRevenue ?? null,
        avgMonthlyRevenueRange: avgMonthlyRevenueRange ?? monthlyRevenue ?? null,
        accountsReceivableRange: accountsReceivableRange ?? arOutstanding ?? null,
        fixedAssetsValueRange: fixedAssetsValueRange ?? null,
        yearsInBusiness: yearsInBusiness ?? null,
        monthlyRevenue: monthlyRevenue ?? null,
        annualRevenue: annualRevenue ?? null,
        arOutstanding: arOutstanding ?? null,
        existingDebt: existingDebt ?? null,
      }),
      "standard",
      ApplicationStage.RECEIVED,
      ApplicationStage.RECEIVED,
      "website_credit_readiness",
    ]
  );

  const crmLead = await upsertCrmLead(stripUndefined({
    companyName,
    fullName,
    phone,
    email,
    industry,
    yearsInBusiness: toNullable(yearsInBusiness),
    monthlyRevenue: toNullable(monthlyRevenue),
    annualRevenue: toNullable(annualRevenue),
    arOutstanding: toNullable(arOutstanding),
    existingDebt: toNullable(existingDebt),
    source: "website_credit_readiness",
    tags: ["readiness"],
    activityType: "credit_readiness_submission",
    activityPayload: { applicationId },
  }));

  // #6 — make the readiness lead usable in the CRM. Ensure a BF contact exists
  // (dedups on email/phone, v725 — no duplicates), tag it credit_readiness, and
  // link the readiness application so its answers surface on the contact.
  try {
    if (email || phone) {
      const SENTINEL = "00000000-0000-0000-0000-000000000000";
      const nameParts = String(fullName ?? "").trim().split(/\s+/).filter(Boolean);
      const first = nameParts[0] ?? (companyName ?? "Lead");
      const last = nameParts.slice(1).join(" ");
      const { row: rdContact } = await findOrCreateContactByEmailAndCompany(
        pool,
        email ?? "",
        SENTINEL,
        "BF",
        { first_name: first, last_name: last, email: email || null, phone: phone || null, company_id: SENTINEL, silo: "BF", role: "applicant" },
      );
      await pool.query(
        `UPDATE contacts
            SET tags = (SELECT array(SELECT DISTINCT unnest(COALESCE(tags, '{}'::text[]) || ARRAY['credit_readiness']::text[]))),
                updated_at = now()
          WHERE id = $1`,
        [rdContact.id],
      );
      await pool.query(`UPDATE applications SET contact_id = $2 WHERE id = $1`, [applicationId, rdContact.id]);
    }
  } catch (err) {
    logError("readiness_contact_link_failed", err as Error);
  }

  const readinessSession = await createOrReuseReadinessSession(stripUndefined({
    companyName,
    fullName,
    phone,
    email,
    industry,
    businessLocation,
    requestedAmount,
    purposeOfFunds,
    salesHistoryYears,
    annualRevenueRange,
    avgMonthlyRevenueRange,
    accountsReceivableRange,
    fixedAssetsValueRange,
    yearsInBusiness,
    monthlyRevenue,
    annualRevenue,
    arOutstanding,
    existingDebt,
  }));

  const continuationToken = await createContinuation(applicationId);

  await retry(
    () =>
      sendSms({
        to: "+15878881837",
        message: `Credit Readiness: ${fullName} | ${phone} | ${industry ?? "N/A"} | Monthly ${monthlyRevenue ?? "N/A"} / Annual ${annualRevenue ?? "N/A"}`,
      }),
    2
  ).catch((error) => {
    logError("credit_readiness_sms_failed", {
      message: error instanceof Error ? error.message : String(error),
      email,
    });
  });

  res["json"]({
    success: true,
    continuationToken,
    sessionId: readinessSession.sessionId,
    token: readinessSession.token,
    crmLeadId: crmLead.id,
  });
});

export default router;
