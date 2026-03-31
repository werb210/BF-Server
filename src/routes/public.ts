import { Router } from "express";
import rateLimit from "express-rate-limit";
import { dbQuery } from "../db";
import { LeadSchema } from "../validation";

const router = Router();

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

async function createLead(payload: unknown): Promise<{ leadId?: string }> {
  const parsed = LeadSchema.safeParse(payload ?? {});

  if (!parsed.success) {
    return {};
  }

  const data = parsed.data;
  const result = await dbQuery<{ id: string }>(
    `insert into crm_leads (email, phone, company_name, product_interest, requested_amount, source)
       values ($1, $2, $3, $4, $5, 'public_api')
       returning id`,
    [data.email, data.phone, data.businessName, data.productType, data.requestedAmount ?? null],
  );

  return { leadId: result.rows[0]?.id };
}

router.post("/lead", limiter, async (req, res, next) => {
  try {
    const result = await createLead(req.body);

    if (!result?.leadId) {
      return res.status(500).json({ error: "LEAD_CREATION_FAILED" });
    }

    return res.json({ leadId: result.leadId });
  } catch (error) {
    return next(error);
  }
});

router.all("/lead", (_req, res) => {
  return res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
});

export default router;
