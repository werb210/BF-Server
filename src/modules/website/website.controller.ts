import { Request, Response } from "express";
import { createCrmLead } from "../crm/crm.service";
import { sendSms } from "../notifications/sms.service";
import { createContinuation } from "../continuation/continuation.service";
import { stripUndefined } from "../../utils/clean";

export async function submitCreditReadiness(req: Request, res: Response) {
  try {
    const {
      companyName,
      fullName,
      phone,
      email,
      industry,
      yearsInBusiness,
      monthlyRevenue,
      annualRevenue,
      requestedAmount,
      creditScoreRange,
      productInterest,
      industryInterest,
      arOutstanding,
      existingDebt,
    } = req.body as Record<string, string | undefined>;

    if (!companyName || !fullName || !phone || !email) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const lead = await createCrmLead(stripUndefined({
      companyName,
      fullName,
      phone,
      email,
      industry,
      yearsInBusiness,
      monthlyRevenue,
      annualRevenue,
      requestedAmount,
      creditScoreRange,
      productInterest,
      industryInterest,
      arOutstanding,
      existingDebt,
      source: "website_credit_readiness",
      tags: ["credit_readiness"],
    }));

    const token = await createContinuation(req.body, lead.id);

    await sendSms({
      to: "+15878881837",
      message: `New continuation lead: ${companyName}`,
    });

    return res["json"]({
      success: true,
      leadId: lead.id,
      redirect: `https://client.boreal.financial/apply?continue=${token}`,
    });
  } catch (err) {
    console.error("Credit readiness error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
