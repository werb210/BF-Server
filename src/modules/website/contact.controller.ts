import { Request, Response } from "express";
import { createCrmLead } from "../crm/crm.service.js";
import { createContinuation } from "../continuation/continuation.service.js";
import { logError } from "../../observability/logger.js";
import { stripUndefined } from "../../utils/clean.js";
import { pool } from "../../db.js";
import { notifyAllStaff } from "../../services/notifications/notifyAllStaff.js";

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

    const body = `Boreal: New contact form — ${companyName ?? "Unknown company"}. ${fullName} (${phone}). ${email}. Open the staff portal.`;
    await notifyAllStaff({
      pool,
      notificationType: "website_contact",
      // BF_SERVER_BLOCK_1_24_NOTIFICATIONS_TITLE — explicit title for the portal bell.
      title: "New website contact form submission",
      body,
      refTable: "crm_leads",
      refId: lead.id,
      contextUrl: `/crm/leads/${encodeURIComponent(lead.id)}`,
      silo: "BF",
    }).catch((err) => {
      console.warn("[website_contact] notifyAllStaff failed", err);
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
