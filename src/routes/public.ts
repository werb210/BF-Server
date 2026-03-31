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

router.post("/lead", limiter, async (req, res, next) => {
  try {
    const parsed = LeadSchema.safeParse(req.body ?? {});

    if (!parsed.success) {
      return res.status(400).json({ error: "INVALID_PAYLOAD" });
    }

    const data = parsed.data;
    const result = await dbQuery<{ id: string }>(
      `insert into crm_leads (email, phone, company_name, product_interest, requested_amount, source)
       values ($1, $2, $3, $4, $5, 'public_api')
       returning id`,
      [data.email, data.phone, data.businessName, data.productType, data.requestedAmount ?? null],
    );

    const lead = result.rows[0];

    if (!lead || !lead.id) {
      throw new Error("LEAD_CREATION_FAILED");
    }

    return res.status(201).json({ leadId: lead.id });
  } catch (error) {
    return next(error);
  }
});

export default router;
