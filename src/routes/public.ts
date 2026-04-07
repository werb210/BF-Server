import { Router } from "express";
import { dbQuery } from "../db";
import { requireFields } from "../middleware/validate";
import { LeadSchema } from "../validation";
import { fail, ok } from "../lib/response";
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

router.get("/test", wrap(async (req: any, res: any) => res.status(200).json(ok({ ok: true }, req.rid))));

router.post(
  "/lead",
  requireFields(["companyName", "email"]),
  wrap(async (req: any, res: any) => {
    const result = await createLead(req.body);

    if (!result?.leadId) {
      return res.status(400).json(fail("INVALID_INPUT", req.rid));
    }

    return res.status(200).json(ok({ leadId: result.leadId }, req.rid));
  }),
);

router.all("/lead", wrap(async (req: any, res: any) => res.status(405).json(fail("METHOD_NOT_ALLOWED", req.rid))));

export default router;
