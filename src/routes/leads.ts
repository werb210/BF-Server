import { Router } from "express";
import { requireAuth, requireCapability } from "../middleware/auth";
import { CAPABILITIES } from "../auth/capabilities";
import { createCrmLead, listCrmLeads } from "../modules/crm/crm.service";

const router = Router();

router.post("/", async (req: any, res: any, next: any) => {
  try {
    const source = typeof req.body?.source === "string" ? req.body.source.trim() : "";
    if (!source) {
      res.status(400).json({ message: "source is required" });
      return;
    }

    const lead = await createCrmLead({
      companyName: req.body?.companyName ?? "",
      fullName: req.body?.fullName ?? "",
      email: req.body?.email ?? "",
      phone: req.body?.phone ?? "",
      yearsInBusiness: req.body?.yearsInBusiness,
      annualRevenue: req.body?.annualRevenue,
      monthlyRevenue: req.body?.monthlyRevenue,
      requestedAmount: req.body?.requestedAmount,
      creditScoreRange: req.body?.creditScoreRange,
      productInterest: req.body?.productInterest,
      industryInterest: req.body?.industryInterest,
      source,
      notes: req.body?.notes,
      tags: Array.isArray(req.body?.tags) ? req.body.tags : [],
    });

    res.status(201).json(lead);
  } catch (_err) {
    res.status(500).json({ message: "Failed to create lead" });
  }
});

router.use(requireAuth);
router.use(requireCapability([CAPABILITIES.CRM_READ]));

router.get("/", async (_req: any, res: any) => {
  try {
    const leads = await listCrmLeads();
    res.json(leads);
  } catch (_err) {
    res.status(500).json({ message: "Failed to fetch leads" });
  }
});

export default router;
