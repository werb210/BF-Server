import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { db } from "../db";
import { config } from "@/config";
import { ApplicationStage } from "../modules/applications/pipelineState";
import { sendSms } from "../modules/notifications/sms.service";
import { createContinuation } from "../models/continuation";
import { createOrReuseReadinessSession } from "../modules/readiness/readinessSession.service";
import { upsertCrmLead } from "../modules/crm/leadUpsert.service";
import { retry } from "../utils/retry";
import { logError } from "../observability/logger";

const router = Router();

const payloadSchema = z.object({
  companyName: z.string().min(1),
  fullName: z.string().min(1),
  phone: z.string().min(1),
  email: z.string().email(),
  industry: z.string().optional(),
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
    phone,
    email,
    industry,
    yearsInBusiness,
    monthlyRevenue,
    annualRevenue,
    arOutstanding,
    existingDebt,
  } = parsed.data;

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
        contactName: fullName,
        phone,
        email,
        industry: industry ?? null,
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

  const crmLead = await upsertCrmLead({
    companyName,
    fullName,
    phone,
    email,
    industry,
    yearsInBusiness,
    monthlyRevenue,
    annualRevenue,
    arOutstanding,
    existingDebt,
    source: "website_credit_readiness",
    tags: ["readiness"],
    activityType: "credit_readiness_submission",
    activityPayload: { applicationId },
  });

  const readinessSession = await createOrReuseReadinessSession({
    companyName,
    fullName,
    phone,
    email,
    industry,
    yearsInBusiness,
    monthlyRevenue,
    annualRevenue,
    arOutstanding,
    existingDebt,
  });

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

  res.json({
    success: true,
    continuationToken,
    sessionId: readinessSession.sessionId,
    token: readinessSession.token,
    crmLeadId: crmLead.id,
  });
});

export default router;
