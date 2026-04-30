import { Router } from "express";
import { dbQuery } from "../db.js";
import { requireFields } from "../middleware/validate.js";
import { LeadSchema } from "../validation.js";
import { fail, ok } from "../lib/apiResponse.js";
import { wrap } from "../lib/routeWrap.js";
import { stripUndefined } from "../utils/clean.js";

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

// BF_SERVER_v68_LEAD_RES_JSON — every branch must explicitly call
// res.status(N).json(envelope). `wrap()` only catches errors; `ok`/`fail`
// only build envelope objects. Without an explicit res.json the response
// is never sent and the client hangs until timeout.
router.post(
  "/lead",
  requireFields(["companyName", "email"]),
  wrap(async (req, res) => {
      const result = await createLead(req.body);

      if (!result?.leadId) {
        return res.status(400).json(fail(res, "INVALID_INPUT"));
      }

      return res.status(200).json(ok({ leadId: result.leadId }));
    }),
);

// BF_SERVER_v66_LENDER_COUNT — GET /api/public/lender-count
// Lightweight public endpoint used by the client wizard's Step 6 to
// render "Submitted to our network of {N}+ lenders." Returns
// { count: number } where N is the count of active lenders. Tolerant
// of an environment where the `active` column might be missing.
// Calls res.json() explicitly because wrap() in this codebase does
// not inspect the handler's return value and ok() from apiResponse
// only builds the envelope object without sending it.
router.get(
  "/lender-count",
  wrap(async (_req, res) => {
    let count = 0;
    try {
      const result = await dbQuery<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM lenders WHERE COALESCE(active, true) = true`,
      );
      count = Number(result.rows?.[0]?.count ?? 0) || 0;
    } catch {
      // Defensive: if the active column is missing or the query fails for any
      // reason, fall back to a plain count so the wizard doesn't show a 404.
      try {
        const result = await dbQuery<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM lenders`,
        );
        count = Number(result.rows?.[0]?.count ?? 0) || 0;
      } catch {
        count = 0;
      }
    }
    return res.status(200).json(ok({ count }));
  }),
);

router.all("/lead", wrap(async (_req, res) => res.status(405).json(fail(res, "METHOD_NOT_ALLOWED"))));

export default router;
