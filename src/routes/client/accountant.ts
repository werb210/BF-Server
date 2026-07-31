// BF_SERVER_STEP5_ACCOUNTANT_v1 - Step 5 "have my accountant upload the
// documents" capture. Merges the accounting firm into the professional_advisors
// cpa row without submitting that form, then mirrors the firm and the person
// into the BF CRM the same way the Stage-2 advisors submit does.
import { Router } from "express";
import { pool } from "../../db.js";
import { safeHandler } from "../../middleware/safeHandler.js";
import { findOrCreateCompanyByNameAndSilo } from "../../services/companies.js";
import { findOrCreateContactByEmailAndCompany } from "../../services/contacts.js";
import { sendAccountantInvite } from "../../services/accountantInvite.js"; // BF_SERVER_ACCOUNTANT_INVITE_v1

const router: Router = Router();

const SILO = "BF";
const SENTINEL = "00000000-0000-0000-0000-000000000000";
const FORM_KEY = "professional_advisors";
const ROLE_TAG = "Accountant/advisor";

function clean(value: unknown, max = 200): string {
  return String(value ?? "").trim().slice(0, max);
}

router.post(
  "/accountant",
  safeHandler(async (req: any, res: any) => {
    const applicationId = clean(req.body?.applicationId, 64);
    const firm = clean(req.body?.firm);
    const contact = clean(req.body?.contact);
    const email = clean(req.body?.email);
    const phone = clean(req.body?.phone, 40);

    if (!applicationId) {
      res.status(400).json({ error: "applicationId_required" });
      return;
    }
    if (!firm || !contact || !email || !phone) {
      res.status(400).json({ error: "accountant_fields_required" });
      return;
    }

    const row = { firm, contact, email, phone };

    // Merge into the cpa slot only. jsonb_set with create_if_missing builds the
    // advisors object on a first-touch application, and the submission stamp is
    // left untouched, so Stage 2 can still fill the remaining advisor rows.
    await pool.query(
      `INSERT INTO application_form_responses (application_id, doc_type, data, updated_at)
       VALUES ($1, $2, jsonb_build_object('advisors', jsonb_build_object('cpa', $3::jsonb)), NOW())
       ON CONFLICT (application_id, doc_type) DO UPDATE
         SET data = jsonb_set(
                      COALESCE(application_form_responses.data, '{}'::jsonb),
                      '{advisors,cpa}',
                      $3::jsonb,
                      true
                    ),
             updated_at = NOW()`,
      [applicationId, FORM_KEY, JSON.stringify(row)]
    );

    // The CRM mirror must never fail the capture - the applicant is mid-wizard.
    let contactId: string | null = null;
    try {
      const company = await findOrCreateCompanyByNameAndSilo(pool, firm, SILO, { name: firm, silo: SILO });
      const companyId = company.row.id;
      const parts = contact.split(/\s+/);
      const first = parts[0] ?? "Accountant";
      const last = parts.slice(1).join(" ");
      const { row: crmContact } = await findOrCreateContactByEmailAndCompany(
        pool,
        email,
        companyId ?? SENTINEL,
        SILO,
        {
          first_name: first,
          last_name: last,
          email,
          phone,
          company_id: companyId,
          silo: SILO,
          role: "other",
        }
      );
      contactId = String(crmContact.id);
      // BF_SERVER_ACCOUNTANT_CONTACT_PHONE_v1 - write the phone and email as
      // well as the tag. find-or-create returns an existing contact untouched,
      // so without this an accountant we already knew keeps whatever number was
      // on file and can never sign in with the one the invitation quotes.
      // COALESCE(NULLIF(...)) so a blank capture cannot erase a good number.
      await pool.query(
        `UPDATE contacts
            SET tags = (SELECT array(SELECT DISTINCT unnest(COALESCE(tags, '{}'::text[]) || $2::text[]))),
                phone = COALESCE(NULLIF($3, ''), phone),
                email = COALESCE(NULLIF($4, ''), email),
                updated_at = NOW()
          WHERE id = $1`,
        [crmContact.id, [ROLE_TAG], phone, email]
      );
    } catch (err: any) {
      console.warn("[client.accountant] crm mirror failed", {
        applicationId,
        message: err?.message,
      });
    }

    // BF_SERVER_ACCOUNTANT_INVITE_v1 - detached on purpose. The applicant is
    // waiting on this response to reach Step 6; email delivery is not their
    // problem and must never hold the wizard open.
    if (contactId) {
      const inviteContactId = contactId;
      void (async () => {
        try {
          const outcome = await sendAccountantInvite({
            applicationId,
            contactId: inviteContactId,
            accountantName: contact,
            accountantEmail: email,
            accountantPhone: phone,
          });
          if (!outcome.sent) {
            console.warn("[client.accountant] invite not sent", { applicationId, reason: outcome.reason });
          }
        } catch (err: any) {
          console.warn("[client.accountant] invite threw", { applicationId, message: err?.message });
        }
      })();
    }

    res.json({ ok: true, contactId });
  })
);

export default router;
