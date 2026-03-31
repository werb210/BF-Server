import { Router } from "express";
import { dbQuery } from "../db";
import { requireFields } from "../middleware/validate";
import { LeadSchema } from "../validation";

const router = Router();

type LeadPayload = {
  email?: string;
  phone?: string;
  productType?: string;
  businessName?: string;
  companyName?: string;
  requestedAmount?: number;
};

async function createLead(payload: LeadPayload): Promise<{ leadId?: string }> {
  const normalizedPayload = {
    ...payload,
    businessName: payload.businessName ?? payload.companyName,
  };

  const parsed = LeadSchema.safeParse(normalizedPayload ?? {});

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

router.get("/test", (_req, res) => {
  return res.json({ ok: true });
});

router.post(
  "/lead",
  requireFields(["companyName", "email"]),
  async (req, res, next) => {
    try {
      const result = await createLead(req.body);

      if (!result?.leadId) {
        return res.status(400).json({ error: "INVALID_INPUT" });
      }

      return res.json({ leadId: result.leadId });
    } catch (error) {
      return next(error);
    }
  },
);

router.all("/lead", (_req, res) => {
  return res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
});

export default router;
