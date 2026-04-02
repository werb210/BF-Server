import { Router } from "express";
import rateLimit from "express-rate-limit";
import { pool, runQuery } from "../../db";
import { recordAuditEvent } from "../audit/audit.service";
import { upsertLead } from "./chat.service";
import { config } from "../../config";

const router = Router();

const readinessLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many readiness requests" },
  skip: () => config.env === "test",
});

type ReadinessPayload = {
  companyName: string;
  fullName: string;
  email: string;
  phone: string;
  industry: string;
  yearsInBusiness: string;
  annualRevenue: string;
  monthlyRevenue: string;
  arOutstanding: string;
  existingDebt: string;
};

function toAmount(raw: string): number {
  const parsed = Number(String(raw).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function calculateScore(payload: ReadinessPayload): number {
  let score = 0;

  const years = Number(payload.yearsInBusiness);
  const annual = toAmount(payload.annualRevenue);
  const monthly = toAmount(payload.monthlyRevenue);
  const ar = toAmount(payload.arOutstanding);
  const debt = toAmount(payload.existingDebt);

  if (years >= 5) score += 25;
  else if (years >= 2) score += 15;
  else if (years >= 1) score += 8;

  if (annual >= 1_000_000) score += 20;
  else if (annual >= 500_000) score += 14;
  else if (annual >= 250_000) score += 8;

  if (monthly >= 100_000) score += 20;
  else if (monthly >= 50_000) score += 14;
  else if (monthly >= 20_000) score += 8;

  if (ar >= 50_000) score += 20;
  else if (ar >= 15_000) score += 12;
  else if (ar > 0) score += 5;

  if (debt <= monthly * 3) score += 15;
  else if (debt <= monthly * 8) score += 8;

  return Math.max(0, Math.min(100, score));
}

function scoreToTier(score: number): "Strong" | "Moderate" | "Emerging" {
  if (score >= 80) return "Strong";
  if (score >= 60) return "Moderate";
  return "Emerging";
}

function recommendations(score: number): string[] {
  if (score >= 80) return ["line-of-credit", "term-loan", "asset-based-lending"];
  if (score >= 60) return ["line-of-credit", "term-loan"];
  return ["invoice-financing", "revenue-advance"];
}

router.post("/capital-readiness", readinessLimiter, async (req: any, res: any, next: any) => {
  const payload = req.body as ReadinessPayload;
  const score = calculateScore(payload);
  const tier = scoreToTier(score);

  const leadId = await upsertLead({
    fullName: payload.fullName,
    email: payload.email,
    phone: payload.phone,
    companyName: payload.companyName,
    tag: "capital_readiness",
  });

  await runQuery(
    `insert into capital_readiness (id, lead_id, score, tier, payload)
     values (gen_random_uuid(), $1, $2, $3, $4::jsonb)`,
    [leadId, score, tier, JSON.stringify(payload)]
  );

  if (leadId) {
    await recordAuditEvent({
      actorUserId: null,
      targetUserId: null,
      targetType: "contact",
      targetId: leadId,
      action: "crm_timeline",
      eventType: "crm_timeline",
      eventAction: "capital_readiness_submitted",
      success: true,
      metadata: { score, tier, tag: "capital_readiness" },
    });
  }

  res["json"]({ score, tier, recommendedProducts: recommendations(score) });
});

export default router;
