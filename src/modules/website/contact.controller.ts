import { Request, Response } from "express";
import { createCrmLead } from "../crm/crm.service";
import { sendSms } from "../notifications/sms.service";
import { createContinuation } from "../continuation/continuation.service";
import { logError } from "../../observability/logger";
import { stripUndefined } from "../../utils/clean";

export async function submitContactForm(req: Request, res: Response) {
  try {
    const { companyName, fullName, phone, email, message, productInterest, industryInterest } = req.body as Record<
      string,
      string | undefined
    >;

    if (!companyName || !fullName || !phone || !email) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const lead = await createCrmLead(stripUndefined({
      companyName,
      fullName,
      phone,
      email,
      notes: message,
      productInterest,
      industryInterest,
      source: "website_contact",
      tags: ["contact_form"],
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
    logError("website_contact_form_failed", { message: err instanceof Error ? err.message : String(err) });
    return res.status(500).json({ error: "Server error" });
  }
}
