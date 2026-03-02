import { Router } from "express";
import { z } from "zod";
import { createReadinessLead } from "../modules/readiness/readiness.service";
import { createOrReuseReadinessSession, getActiveReadinessSessionByToken } from "../modules/readiness/readinessSession.service";
import { db } from "../db";

const router = Router();

const readinessSchema = z.object({
  companyName: z.string().trim().min(2),
  fullName: z.string().trim().min(2),
  phone: z.string().trim().min(7),
  email: z.string().trim().email(),
  industry: z.string().trim().optional(),
  yearsInBusiness: z.union([z.number(), z.string()]).optional(),
  monthlyRevenue: z.union([z.number(), z.string()]).optional(),
  annualRevenue: z.union([z.number(), z.string()]).optional(),
  arOutstanding: z.union([z.number(), z.string()]).optional(),
  existingDebt: z.union([z.boolean(), z.string()]).optional(),
});

router.post("/", async (req, res) => {
  try {
    const parsed = readinessSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request" });
    }

    const payload = parsed.data;
    const { leadId } = await createReadinessLead(payload as any);
    const session = await createOrReuseReadinessSession(payload);

    return res.status(201).json({
      success: true,
      data: {
        leadId,
        sessionId: session.sessionId,
        readinessToken: session.token,
        reused: session.reused,
      },
    });
  } catch {
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/continue", async (req, res) => {
  try {
    const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
    if (!email) {
      return res.status(400).json({ error: "Invalid request" });
    }

    const result = await db.query(
      `select *
       from continuation
       where lower(email) = lower($1)
       order by created_at desc
       limit 1`,
      [email]
    );
    const session = result.rows[0] ?? null;
    if (!session) {
      return res.status(200).json({ success: true, data: { session: null } });
    }

    return res.status(200).json({ success: true, data: { session } });
  } catch {
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/:sessionId", async (req, res) => {
  try {
    const sessionId = typeof req.params.sessionId === "string" ? req.params.sessionId.trim() : "";
    if (!sessionId) {
      return res.status(400).json({ error: "Invalid request" });
    }

    const session = await getActiveReadinessSessionByToken(sessionId);
    if (!session) {
      return res.status(404).json({ error: "Not found" });
    }

    return res.status(200).json({
      success: true,
      data: {
        leadId: session.leadId,
        kyc: {
          companyName: session.companyName,
          fullName: session.fullName,
          email: session.email,
          phone: session.phone,
          industry: session.industry,
        },
        financial: {
          yearsInBusiness: session.yearsInBusiness,
          monthlyRevenue: session.monthlyRevenue,
          annualRevenue: session.annualRevenue,
          arOutstanding: session.arOutstanding,
          existingDebt: session.existingDebt,
        },
      },
    });
  } catch {
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
