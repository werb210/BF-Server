import { Router } from "express";
import { dbQuery } from "../db";
import { requireFields } from "../middleware/validate";
import { LeadSchema } from "../validation";
import { fail, ok } from "../lib/apiResponse";
import { wrap } from "../lib/routeWrap";
import { stripUndefined } from "../utils/clean";

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

  return stripUndefined({ leadId: result.rows[0]?.id });
}

router.get("/test", wrap(async () => ok({ ok: true })));

router.post(
  "/lead",
  requireFields(["companyName", "email"]),
  wrap(async (req, res) => {
      const result = await createLead(req.body);

      if (!result?.leadId) {
        return fail(res, "INVALID_INPUT");
      }

      return ok({ leadId: result.leadId });
    }),
);

router.all("/lead", wrap(async (_req, res) => fail(res, "METHOD_NOT_ALLOWED")));

export default router;
