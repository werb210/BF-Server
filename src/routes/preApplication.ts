import { Router } from "express";
import jwt from "jsonwebtoken";
import { dbQuery } from "../db";
import { config } from "../config";

type ContinuationJwt = {
  preAppId: string;
};

const router = Router();

function fetchJwtSecret(): string {
  const secret = config.jwt.secret;
  if (!secret) {
    throw new Error("JWT_SECRET is not configured");
  }
  return secret;
}

/**
 * WEBSITE → Store pre-application and return continuation token.
 */
router.post("/continue-application", async (req: any, res: any, next: any) => {
  try {
    const data = (req.body ?? {}) as Record<string, string | undefined>;

    const inserted = await dbQuery<{
      id: string;
    }>(
      `insert into pre_applications (
        company_name,
        full_name,
        email,
        phone,
        years_in_business,
        annual_revenue,
        monthly_revenue,
        requested_amount,
        credit_score_range,
        ai_score
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      returning id`,
      [
        data.companyName ?? null,
        data.fullName ?? null,
        data.email ?? null,
        data.phone ?? null,
        data.yearsInBusiness ?? null,
        data.annualRevenue ?? null,
        data.monthlyRevenue ?? null,
        data.requestedAmount ?? null,
        data.creditScoreRange ?? null,
        data.aiScore ?? null,
      ]
    );

    const record = inserted.rows[0];
    if (!record?.id) {
      return res.status(500).json({ error: "Failed to create pre-application" });
    }

    const token = jwt.sign({ preAppId: record.id }, fetchJwtSecret(), {
      expiresIn: "30m",
    });

    return res.json({ continuationToken: token });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to create pre-application" });
  }
});

/**
 * CLIENT → Fetch continuation data.
 */
router.get("/continue-application", async (req: any, res: any, next: any) => {
  try {
    const token = req.headers.authorization?.replace("Bearer ", "");
    if (!token) {
      return res.status(401).json({ error: "Missing token" });
    }

    const decoded = jwt.verify(token, fetchJwtSecret()) as ContinuationJwt;

    const result = await dbQuery(
      `select
          id,
          company_name as "companyName",
          full_name as "fullName",
          email,
          phone,
          years_in_business as "yearsInBusiness",
          annual_revenue as "annualRevenue",
          monthly_revenue as "monthlyRevenue",
          requested_amount as "requestedAmount",
          credit_score_range as "creditScoreRange",
          ai_score as "aiScore",
          consumed,
          created_at as "createdAt"
        from pre_applications
        where id = $1
        limit 1`,
      [decoded.preAppId]
    );

    const record = result.rows[0] as { consumed?: boolean } | undefined;

    if (!record || record.consumed) {
      return res.status(404).json({ error: "Invalid session" });
    }

    return res.json(record);
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
});

/**
 * CLIENT → Mark as consumed once application created.
 */
router.post("/consume-pre-application", async (req: any, res: any, next: any) => {
  try {
    const { id } = (req.body ?? {}) as { id?: string };
    if (!id) {
      return res.status(400).json({ error: "Missing id" });
    }

    await dbQuery(
      `update pre_applications
       set consumed = true
       where id = $1`,
      [id]
    );

    return res.json({ success: true });
  } catch {
    return res.status(500).json({ error: "Failed to consume" });
  }
});

export default router;
