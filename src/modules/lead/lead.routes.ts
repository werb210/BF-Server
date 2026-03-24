import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { createLead, getLeads } from "./lead.service";

const router = Router();

router.post("/", requireAuth, async (req, res) => {
  const source = typeof req.body?.source === "string" ? req.body.source.trim() : "";
  if (!source) {
    res.status(400).json({ message: "source is required" });
    return;
  }

  try {
    const lead = await createLead({
      source,
      companyName: req.body?.companyName,
      fullName: req.body?.fullName,
      email: req.body?.email,
      phone: req.body?.phone,
      yearsInBusiness: req.body?.yearsInBusiness,
      annualRevenue: req.body?.annualRevenue,
      monthlyRevenue: req.body?.monthlyRevenue,
      requestedAmount: req.body?.requestedAmount,
      creditScoreRange: req.body?.creditScoreRange,
      productInterest: req.body?.productInterest,
      industryInterest: req.body?.industryInterest,
      notes: req.body?.notes,
      tags: req.body?.tags,
    });

    res.status(201).json(lead);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create lead";
    res.status(500).json({ message });
  }
});

router.get("/", requireAuth, async (_req, res) => {
  try {
    const leads = await getLeads();
    res.json(leads);
  } catch {
    res.status(500).json({ message: "Failed to fetch leads" });
  }
});

export default router;
