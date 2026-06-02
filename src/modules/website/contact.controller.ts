import { Request, Response } from "express";
import { createCrmLead } from "../crm/crm.service.js";
import { createContinuation } from "../continuation/continuation.service.js";
import { logError } from "../../observability/logger.js";
import { stripUndefined } from "../../utils/clean.js";
import { pool } from "../../db.js";
import { findOrCreateContactByEmailAndCompany } from "../../services/contacts.js";
import { findOrCreateCompanyByNameAndSilo } from "../../services/companies.js";
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

    // BF_SERVER_BLOCK_v736_WEBSITE_CONTACT_AND_COMPANY_INTO_CRM
    // Create/link the COMPANY (previously never created) and upsert the
    // CONTACT linked to it, so website submissions land in CRM Contacts AND
    // Companies. Idempotent on re-submit (find-or-create by name / email),
    // which also fixes the old silent duplicate-email failure.
    const [firstName, ...lastNameParts] = fullName.trim().split(/\s+/);
    try {
      const { row: company } = await findOrCreateCompanyByNameAndSilo(pool, companyName, "BF", {
        name: companyName,
        phone: phone ?? null,
        email: email ?? null,
        silo: "BF",
      });
      await findOrCreateContactByEmailAndCompany(pool, email ?? "", company.id, "BF", {
        first_name: firstName || fullName,
        last_name: lastNameParts.join(" "),
        email,
        phone,
        company_id: company.id,
        silo: "BF",
      });
    } catch (e) {
      console.warn("[website_contact] CRM contact/company upsert failed", e);
    }

    // BF_SERVER_BLOCK_v123_READINESS_SQL_AND_SILO_AUTH_RESOLUTION_v1
    // Q5: contact form Continue → main page; no apply hand-off. Keep the
    // continuation row write for parity with other lead funnels but drop
    // the token from the response so the client doesn't redirect.
    await createContinuation(req.body, lead.id);

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
    });
  } catch (err) {
    logError("website_contact_form_failed", { message: err instanceof Error ? err.message : String(err) });
    return res.status(500).json({ error: "Server error" });
  }
}
