import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { createCRMLead } from "../services/crmService.js";
import { sendSMS } from "../services/smsService.js";
import { config } from "../config/index.js";
import { stripUndefined } from "../utils/clean.js";
import { safeKeyGenerator } from "../middleware/rateLimit.js";

const router = Router();

// BF_SERVER_BLOCK_v332_SETTINGS_AND_AUDIT_HARDENING_v1 -- Edit 6
// /api/credit/score is an UNAUTHENTICATED endpoint that:
//   1. Inserts a lead into CRM (createCRMLead)
//   2. Sends an SMS via Twilio (sendSMS)
// Both are billable actions and both run on every successful POST. Without
// rate limiting, an attacker can flood the endpoint with valid-looking
// payloads to burn Twilio credit or poison the CRM. The rest of the public
// surface (website contact form, public application start) has rate limits;
// this one was missed. 10 req/min/IP gives legitimate retries headroom while
// stopping volumetric abuse.
const creditScoreLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  validate: {
    xForwardedForHeader: false,
    trustProxy: false,
  },
  skip: () => config.env === "test",
  keyGenerator: safeKeyGenerator,
});

const creditSchema = z.object({
  companyName: z.string().min(1),
  fullName: z.string().min(1),
  email: z.string().email(),
  phone: z.string().min(1),
  industry: z.string().optional(),
  yearsInBusiness: z.number().nonnegative().default(0),
  monthlyRevenue: z.number().nonnegative().optional(),
  annualRevenue: z.number().nonnegative().default(0),
  arOutstanding: z.number().nonnegative().optional(),
  existingDebt: z.boolean().default(false),
});

router.post("/score", creditScoreLimiter, async (req: any, res: any, next: any) => {
  const parsed = creditSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid payload" });
    return;
  }

  const {
    companyName,
    fullName,
    email,
    phone,
    industry,
    yearsInBusiness,
    monthlyRevenue,
    annualRevenue,
    arOutstanding,
    existingDebt,
  } = parsed.data;

  let score = 50;

  if (yearsInBusiness > 2) score += 10;
  if (annualRevenue > 500000) score += 15;
  if (!existingDebt) score += 10;

  score = Math.min(score, 85);

  await createCRMLead(stripUndefined({
    companyName,
    fullName,
    email,
    phone,
    industry,
    source: "website_credit_check",
    metadata: {
      yearsInBusiness,
      monthlyRevenue,
      annualRevenue,
      arOutstanding,
      existingDebt,
      score,
    },
  }));

  if (config.intake.smsNumber) {
    await sendSMS(
      config.intake.smsNumber,
      `New Credit Check Lead: ${companyName} (${score})`
    );
  }

  res["json"]({
    score,
    message: "Preliminary assessment complete.",
  });
});

export default router;
