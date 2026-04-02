import { Router } from "express";
import { LeadSchema } from "../schemas";
import { validate } from "../middleware/validate";
import { ok } from "../lib/response";
import { dbQuery } from "../db";

const router = Router();

type CreatedLeadRow = {
  id: string;
  email: string | null;
  phone: string | null;
  company_name: string | null;
  product_interest: string | null;
  source: string;
};

router.post("/lead", validate(LeadSchema), async (req, res, next) => {
  try {
    const lead = req.validated as {
      name: string;
      email: string;
      phone: string;
      businessName?: string;
      productType?: string;
    };

    const created = await dbQuery<CreatedLeadRow>(
      `insert into crm_leads (email, phone, company_name, product_interest, source)
       values ($1, $2, $3, $4, $5)
       returning id, email, phone, company_name, product_interest, source`,
      [lead.email, lead.phone, lead.businessName ?? lead.name, lead.productType ?? null, "crm_api"],
    );

    return ok(res, {
      id: created.rows[0]?.id,
      name: lead.name,
      email: created.rows[0]?.email ?? lead.email,
      phone: created.rows[0]?.phone ?? lead.phone,
      businessName: created.rows[0]?.company_name ?? lead.businessName ?? lead.name,
      productType: created.rows[0]?.product_interest ?? lead.productType ?? null,
      source: created.rows[0]?.source ?? "crm_api",
    });
  } catch (error) {
    return next(error);
  }
});

export default router;
