import { randomUUID } from "crypto";
import { Router } from "express";
import { getClientSubmissionOwnerUserId } from "../config";
import { pool } from "../db";
import { ApplicationStage } from "../modules/applications/pipelineState";
import { upsertStructuredApplicationData } from "../services/v1StructuredPersistence";

const router = Router();

type PublicApplicationStartBody = {
  companyName?: string;
  fullName?: string;
  email?: string;
  phone?: string;
  yearsInBusiness?: number | string;
  annualRevenue?: number | string;
  monthlyRevenue?: number | string;
  requestedAmount?: number | string;
  creditRange?: string;
  source?: string;
};

function normalizeRequestedAmount(value: number | string | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

router.post("/application/start", async (req, res) => {
  try {
    const {
      companyName,
      fullName,
      email,
      phone,
      yearsInBusiness,
      annualRevenue,
      monthlyRevenue,
      requestedAmount,
      creditRange,
      source,
    } = (req.body ?? {}) as PublicApplicationStartBody;

    if (!companyName || !fullName || !email) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const applicationId = randomUUID();
    const normalizedRequestedAmount = normalizeRequestedAmount(requestedAmount);

    await pool.query(
      `insert into applications
       (id, owner_user_id, name, metadata, product_type, pipeline_state, status, requested_amount, source, created_at, updated_at)
       values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, now(), now())`,
      [
        applicationId,
        getClientSubmissionOwnerUserId(),
        companyName,
        JSON.stringify({
          contactName: fullName,
          email,
          phone: phone ?? null,
          yearsInBusiness: yearsInBusiness ?? null,
          annualRevenue: annualRevenue ?? null,
          monthlyRevenue: monthlyRevenue ?? null,
          creditRange: creditRange ?? null,
          intakeSource: source ?? "website",
        }),
        "standard",
        ApplicationStage.RECEIVED,
        "draft",
        normalizedRequestedAmount,
        source ?? "website",
      ]
    );


    await upsertStructuredApplicationData({
      applicationId,
      companyName,
      annualRevenue: typeof annualRevenue === "number" ? annualRevenue : Number(annualRevenue ?? NaN) || null,
      timeInBusinessMonths: typeof yearsInBusiness === "number"
        ? Math.round(yearsInBusiness * 12)
        : (Number(yearsInBusiness ?? NaN) ? Math.round(Number(yearsInBusiness) * 12) : null),
      owners: [
        {
          name: fullName,
          email,
          phone: phone ?? null,
        },
      ],
    });
    return res.status(200).json({ applicationId });
  } catch (error) {
    console.error("Error creating draft application:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
