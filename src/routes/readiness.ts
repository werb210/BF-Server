import { Router } from "express";
import { z } from "zod";
import { safeHandler } from "../middleware/safeHandler.js";
import { upsertCrmLead } from "../modules/crm/leadUpsert.service.js";
import { linkCrmContact } from "../modules/readiness/readiness.service.js";
import { randomUUID } from "node:crypto";
import { dbQuery } from "../db.js";
import { parseExpressCaslConsent, recordExpressCaslConsent } from "../services/smsConsent.js"; // BF_SERVER_v789_CASL_EXPRESS_CONSENT

const router = Router();

const readinessSchema = z.object({
  fullName: z.string().trim().min(2),
  phone: z.string().trim().min(7),
  email: z.string().trim().email(),
  yearsInBusiness: z.number().optional(),
  annualRevenue: z.number().optional(),
  profitable: z.boolean().optional(),
  estimatedCreditScore: z.number().optional(),
  score: z.enum(["Strong", "Moderate", "Needs Structuring"]).optional(),
});

router.post(
  "/crm/readiness",
  safeHandler(async (req: any, res: any) => {
    const parsed = readinessSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_payload" });
      return;
    }

    const {
      fullName,
      phone,
      email,
      yearsInBusiness,
      annualRevenue,
      profitable,
      estimatedCreditScore,
      score,
    } = parsed.data;

    const readinessContactId = await linkCrmContact({ fullName, email, phone });
    // BF_SERVER_v789_CASL_EXPRESS_CONSENT - only an explicit casl_consent === true.
    await recordExpressCaslConsent(
      (sql, params) => dbQuery(sql, params as any[]),
      { contactId: readinessContactId, email, silo: "BF" },
      parseExpressCaslConsent(req.body),
      "readiness_website",
    );

    const { id: crmLeadId } = await upsertCrmLead({
      fullName,
      email,
      phone,
      source: "readiness_website",
      tags: ["readiness"],
      activityType: "readiness_submission",
      activityPayload: { yearsInBusiness, annualRevenue, profitable, estimatedCreditScore, score },
    });

    const sessionToken = randomUUID();
    await dbQuery(
      `insert into readiness_sessions (
         id,
         token,
         email,
         phone,
         company_name,
         full_name,
         years_in_business,
         annual_revenue,
         existing_debt,
         crm_lead_id,
         is_active,
         expires_at,
         created_at,
         updated_at
       )
       values ($1, $1, $2, $3, $4, $5, $6, $7, $8, $9, true, now() + interval '30 days', now(), now())
       on conflict (id) do update set
         email = excluded.email,
         phone = excluded.phone,
         full_name = excluded.full_name,
         years_in_business = excluded.years_in_business,
         annual_revenue = excluded.annual_revenue,
         existing_debt = excluded.existing_debt,
         is_active = true,
         updated_at = now()`,
      [
        sessionToken,
        email,
        phone,
        fullName,
        fullName,
        yearsInBusiness ?? null,
        annualRevenue ?? null,
        profitable ?? null,
        crmLeadId,
      ]
    );

    res.status(200).json({ sessionToken, score: score ?? null, crmLeadId });
  })
);

export default router;
