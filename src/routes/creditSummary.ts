import { Router } from "express";
import { AppError } from "../middleware/errors";
import { safeHandler } from "../middleware/safeHandler";

const router = Router();

router.post(
  "/",
  safeHandler(async (req, res) => {
    const applicationId = typeof req.body?.applicationId === "string" ? req.body.applicationId.trim() : "";
    if (!applicationId) {
      throw new AppError("validation_error", "applicationId is required.", 400);
    }

    const payload = req.body ?? {};
    const sections = {
      Transaction: payload.Transaction ?? "Transaction details compiled from submitted package.",
      Overview: payload.Overview ?? "Business overview generated for underwriting review.",
      Collateral: payload.Collateral ?? "Collateral position summarized from provided documents.",
      "Financial Summary": payload["Financial Summary"] ?? "Financial summary generated from statements and application data.",
      "Risks & Mitigants": payload["Risks & Mitigants"] ?? "Risk signals reviewed with mitigating factors documented.",
      "Rationale for Approval": payload["Rationale for Approval"] ?? "Recommendation rationale prepared for lender review.",
    };

    res.status(200).json({
      applicationId,
      sections,
    });
  })
);

export default router;
