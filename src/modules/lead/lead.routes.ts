import { type Request, type Response, Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth";
import { idempotencyMiddleware } from "../../middleware/idempotency";
import { createLead, getLeads } from "./lead.service";

const createLeadSchema = z.object({
  source: z.string().trim().min(1),
  companyName: z.string().trim().optional(),
  fullName: z.string().trim().optional(),
  email: z.string().trim().optional(),
  phone: z.string().trim().optional(),
  yearsInBusiness: z.string().trim().optional(),
  annualRevenue: z.string().trim().optional(),
  monthlyRevenue: z.string().trim().optional(),
  requestedAmount: z.string().trim().optional(),
  creditScoreRange: z.string().trim().optional(),
  productInterest: z.string().trim().optional(),
  industryInterest: z.string().trim().optional(),
  notes: z.string().trim().optional(),
  tags: z.unknown().optional(),
});

type CreateLeadBody = z.infer<typeof createLeadSchema>;

const router = Router();

router.post(
  "/",
  requireAuth,
  idempotencyMiddleware,
  async (req: Request<{}, {}, CreateLeadBody>, res: Response, next) => {
    if (
      !req.body ||
      typeof req.body !== "object" ||
      !("source" in req.body) ||
      typeof req.body.source !== "string" ||
      !req.body.source.trim()
    ) {
      return res.status(400).json({
        error: {
          message: "invalid_lead_body",
          code: "invalid_input",
        },
      });
    }

    const parseResult = createLeadSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        error: {
          message: "invalid_lead_body",
          code: "invalid_input",
        },
      });
    }

    const body = parseResult.data;

    try {
      const lead = await createLead({
        source: body.source,
        companyName: body.companyName,
        fullName: body.fullName,
        email: body.email,
        phone: body.phone,
        yearsInBusiness: body.yearsInBusiness,
        annualRevenue: body.annualRevenue,
        monthlyRevenue: body.monthlyRevenue,
        requestedAmount: body.requestedAmount,
        creditScoreRange: body.creditScoreRange,
        productInterest: body.productInterest,
        industryInterest: body.industryInterest,
        notes: body.notes,
        tags: body.tags,
      });

      res.status(201).json(lead);
    } catch (err) {
      next(err);
    }
  },
);

router.get("/", requireAuth, async (_req, res, next) => {
  try {
    const leads = await getLeads();
    res.json(leads);
  } catch (err) {
    next(err);
  }
});

export default router;
