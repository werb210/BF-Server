import { randomUUID } from "node:crypto";
import { Router } from "express";
import { db } from "../db";
import { sendSMS } from "../services/smsService";
import { type ContinuationRecord } from "../db/schema/continuation";
import { upsertCrmLead } from "../modules/crm/leadUpsert.service";

const router = Router();

type ContinuationPayload = {
  companyName?: string;
  fullName?: string;
  email?: string;
  phone?: string;
  industry?: string;
  yearsInBusiness?: string;
  monthlyRevenue?: string;
  annualRevenue?: string;
  arOutstanding?: string;
  existingDebt?: string;
};

router.post("/", async (req: any, res: any, next: any) => {
  const data = (req.body ?? {}) as ContinuationPayload;

  if (!data.companyName || !data.fullName || !data.email || !data.phone || !data.industry) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }

  const continuationId = randomUUID();
  const { rows } = await db.query<ContinuationRecord>(
    `
      insert into continuation (
        id,
        company_name,
        full_name,
        email,
        phone,
        industry,
        years_in_business,
        monthly_revenue,
        annual_revenue,
        ar_outstanding,
        existing_debt
      )
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      returning *
    `,
    [
      continuationId,
      data.companyName,
      data.fullName,
      data.email,
      data.phone,
      data.industry,
      data.yearsInBusiness ?? null,
      data.monthlyRevenue ?? null,
      data.annualRevenue ?? null,
      data.arOutstanding ?? null,
      data.existingDebt ?? null,
    ]
  );

  await upsertCrmLead({
    companyName: data.companyName,
    fullName: data.fullName,
    email: data.email,
    phone: data.phone,
    industry: data.industry,
    yearsInBusiness: data.yearsInBusiness,
    monthlyRevenue: data.monthlyRevenue,
    annualRevenue: data.annualRevenue,
    arOutstanding: data.arOutstanding,
    existingDebt: data.existingDebt,
    source: "capital_readiness",
    tags: ["readiness"],
    activityType: "capital_readiness_submission",
  });

  await sendSMS(
    "+15878881837",
    `New Capital Readiness Lead: ${data.companyName} (${data.fullName})`
  );

  res.json(rows[0]);
});

router.get("/by-email", async (req: any, res: any, next: any) => {
  const email = req.query.email;
  if (typeof email !== "string" || !email.trim()) {
    res.status(400).json({ error: "Missing email" });
    return;
  }

  const { rows } = await db.query<ContinuationRecord>(
    `
      select *
      from continuation
      where email = $1
      order by created_at desc
      limit 1
    `,
    [email]
  );

  if (!rows[0]) {
    res.status(404).json({});
    return;
  }

  res.json(rows[0]);
});

router.get("/:id", async (req: any, res: any, next: any) => {
  const { id } = req.params;

  const { rows } = await db.query<ContinuationRecord>(
    `select * from continuation where id = $1 limit 1`,
    [id]
  );

  if (!rows[0]) {
    res.status(404).json({});
    return;
  }

  res.json(rows[0]);
});

router.patch("/:id/mark-used", async (req: any, res: any, next: any) => {
  const { id } = req.params;

  await db.query(
    `
      update continuation
      set used_in_application = true
      where id = $1
    `,
    [id]
  );

  res.json({ success: true });
});

export default router;
