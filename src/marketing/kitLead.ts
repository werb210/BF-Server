// BF_SERVER_v874_MARKETING_TOOLS - a website kit form submission becomes a CRM lead in the kit's silo (ported from
// KS-server #48):
//   * the contact is matched in that silo by email or phone (or made), tagged "website_form" and the form's tag, and
//     linked to its company when a business name was given
//   * a new contact gets an owner from the silo's lead rotation (source "website") when the Admin turned rotation on
//   * a ticked consent box is recorded as express CASL consent with the exact wording shown next to the box; an
//     unticked box records nothing (the person is then only reachable about their inquiry, as before)
//   * the submission is on the contact's timeline, the visit (if the visitor agreed to tracking) is linked to the
//     contact, a new contact fires the contact.created automation, and the silo's staff are notified
// Side effects after the contact exists are best effort and logged: the person's details are never lost.
import type { Pool } from "pg";
import { createContact } from "../services/contacts.js";
import { findOrCreateCompanyByNameAndSilo } from "../services/companies.js";
import { parseExpressCaslConsent, recordExpressCaslConsent } from "../services/smsConsent.js";
import { logWarnSwallowed } from "../lib/logWarnSwallowed.js";
import { KIT_BRAND, kitConsentText, splitName, type KitForm, type KitSilo, type Submission } from "./websiteKit.js";

export async function submitKitLead(
  pool: Pool, silo: KitSilo, form: KitForm, sub: Submission,
): Promise<{ contactId: string; created: boolean }> {
  const v = sub.values;
  const email = (v.email ?? "").trim().toLowerCase();
  const phone = (v.phone ?? "").trim();
  const digits = phone.replace(/\D/g, "");
  const { first, last } = splitName(v.full_name, email);

  let companyId: string | null = null;
  if (v.company) {
    try {
      const { row } = await findOrCreateCompanyByNameAndSilo(pool, v.company, silo, { name: v.company, phone: phone || null, email: email || null, silo } as any);
      companyId = (row as { id?: string } | undefined)?.id ?? null;
    } catch (err) {
      companyId = logWarnSwallowed(err, "marketing/kitLead.ts:company", null);
    }
  }

  const found = await pool.query<{ id: string }>(
    `SELECT id::text AS id FROM contacts
      WHERE silo = $1 AND merged_into_id IS NULL
        AND (($2 <> '' AND lower(email) = $2) OR ($3 <> '' AND regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g') = $3))
      ORDER BY created_at ASC LIMIT 1`,
    [silo, email, digits.length >= 7 ? digits : ""],
  );
  let contactId = found.rows[0]?.id ?? null;
  const created = !contactId;
  if (!contactId) {
    const row = await createContact(pool, { first_name: first, last_name: last, email: email || null, phone: phone || null, company_id: companyId, silo });
    contactId = String(row.id);
  } else if (companyId) {
    await pool.query(`UPDATE contacts SET company_id = COALESCE(company_id, $2::uuid), updated_at = now() WHERE id::text = $1`, [contactId, companyId]);
  }
  const tags = ["website_form", ...(form.tag ? [form.tag] : [])];
  await pool.query(
    `UPDATE contacts SET tags = (SELECT ARRAY(SELECT DISTINCT unnest(COALESCE(tags, '{}') || $2::text[]))),
            company_name = COALESCE(NULLIF(company_name, ''), $3), updated_at = now()
      WHERE id::text = $1`,
    [contactId, tags, v.company ?? null],
  );

  const brand = KIT_BRAND[silo];
  const steps: Array<[string, () => Promise<unknown>]> = [
    ["timeline", () => pool.query(
      `INSERT INTO crm_timeline_events (contact_id, event_type, payload) VALUES ($1, 'website_form_submitted', $2)`,
      [contactId, JSON.stringify({ formId: form.id, form: form.name, silo, page: sub.page, values: { ...v, email: undefined, phone: undefined }, consent: sub.consent })],
    )],
    ["counter", () => pool.query(`UPDATE website_kit_forms SET submissions = submissions + 1 WHERE id::text = $1 AND silo = $2`, [form.id, silo])],
    // The wording recorded is the server's own (the text the kit shows next to the box), never what the page sent.
    ["consent", () => recordExpressCaslConsent(
      (sql, params) => pool.query(sql, params as any[]),
      { contactId, email: email || null, silo },
      parseExpressCaslConsent({ casl_consent: sub.consent, casl_consent_text: kitConsentText(brand) }),
      "website_kit_form",
    )],
    ["visit", async () => {
      if (!sub.sessionId) return;
      await pool.query(`UPDATE visitor_sessions SET contact_id = $2 WHERE session_id = $1 AND contact_id IS NULL`, [sub.sessionId, contactId]);
    }],
  ];
  if (created) {
    steps.push(["rotation", async () => {
      const { assignRotatingOwner } = await import("../leads/leadRotation.js");
      await assignRotatingOwner(pool as any, contactId, "website", { silo });
    }]);
    steps.push(["automation", async () => {
      const m = await import("../modules/automation/automationEngine.js");
      await m.emitAutomationEvent("contact.created", { silo, contactId: contactId!, data: { source: "website_kit_form", form: form.name } });
    }]);
  }
  steps.push(["notify", async () => {
    const { notifyAllStaff } = await import("../services/notifications/notifyAllStaff.js");
    const who = [v.full_name, v.company].filter(Boolean).join(", ") || email || phone;
    await notifyAllStaff({
      pool,
      notificationType: "website_contact",
      title: `New lead from the website form "${form.name}"`,
      body: `${brand}: ${who} filled in "${form.name}" on a website. Open the staff portal.`,
      refTable: "contacts",
      refId: contactId!,
      contextUrl: `/crm/contacts/${encodeURIComponent(contactId!)}`,
      silo,
    });
  }]);
  for (const [name, run] of steps) {
    try { await run(); } catch (err) { logWarnSwallowed(err, `marketing/kitLead.ts:${name}`); }
  }
  return { contactId: contactId!, created };
}
