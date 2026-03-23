import { Router } from "express";
import { upsertCrmLead } from "../crm/leadUpsert.service";
import { sendSMS } from "../../services/smsService";
import { logWarn } from "../../observability/logger";

const router = Router();

router.post("/ai/confidence", async (req: any, res: any, next: any) => {
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
  } = req.body ?? {};

  const years = Number(yearsInBusiness ?? 0);
  const monthly = Number(monthlyRevenue ?? 0);
  const score = years > 2 && monthly > 20000 ? "Strong" : "Needs Review";

  await upsertCrmLead({
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
    source: "confidence_check",
    tags: ["startup_interest"],
    activityType: "confidence_check",
    activityPayload: { score },
  });

  await sendSMS(
    "+15878881837",
    `Lead type: confidence_check | Name: ${fullName ?? "unknown"} | Phone: ${phone ?? "unknown"}`
  ).catch((error) => {
    logWarn("confidence_sms_failed", {
      message: error instanceof Error ? error.message : String(error),
      email,
      phone,
    });
  });

  res.json({
    score,
    message:
      score === "Strong"
        ? "Based on the information provided, your business appears aligned with common underwriting parameters."
        : "We recommend speaking with an advisor to explore structuring options.",
  });
});

router.post("/ai/voice/token", async (_req, res) => {
  res.json({ token: "voice-ready-placeholder" });
});

export default router;
