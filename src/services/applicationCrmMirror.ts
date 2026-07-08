// BF_APP_TO_CRM_v38 - Block 38-E
// On wizard submit, upsert a companies row (matched by name+silo) and a
// contacts row (matched by phone or email+silo), then update the application
// with company_id / contact_id. Best-effort: never throws.
import { pool } from "../db.js";
import { resolveAndStoreAdAttribution } from "./googleAdsAttribution.js";

type Wizard = {
  // BF_SERVER_ATTRIBUTION_TO_CONTACT_v1 - the ad click (gclid + UTMs) captured
  // on the marketing site and stored on applications.metadata.attribution is
  // stamped onto the CRM contact timeline so staff can see which ad/campaign
  // produced the contact.
  attribution?: Record<string, unknown> | null;
  applicationId: string;
  silo: string;
  business?: {
    companyName?: string | null;
    industry?: string | null;
    phone?: string | null;
    email?: string | null;
    website?: string | null;
    city?: string | null;
    province?: string | null;
    country?: string | null;
  } | null;
  applicant?: {
    firstName?: string | null;
    lastName?: string | null;
    fullName?: string | null;
    email?: string | null;
    phone?: string | null;
  } | null;
  // OTP-verified login phone (proven to receive SMS); authoritative for the contact.
  verifiedPhone?: string | null;
};

export async function mirrorApplicationToCrm(input: Wizard): Promise<void> {
  try {
    const silo = (input.silo || "BF").toUpperCase();
    const biz = input.business ?? {};
    const app = input.applicant ?? {};

    const businessName = (biz.companyName ?? "").trim();
    const applicantName =
      (app.fullName ?? `${app.firstName ?? ""} ${app.lastName ?? ""}`).trim() || null;
    const applicantEmail = (app.email ?? "").trim() || null;
    const applicantPhone = (app.phone ?? "").trim() || null;
    // OTP-verified phone wins over anything the applicant typed in the form.
    const authoritativePhone = (input.verifiedPhone ?? "").trim() || null;

    // BF_SERVER_CRM_MIRROR_NORMALIZED_FALLBACKS_v1 - a silent no-op here is how
    // a submitted application ends up with no CRM record; make skips visible.
    if (!businessName && !applicantName && !applicantEmail && !applicantPhone && !authoritativePhone) {
      console.warn("[crm_mirror] skipped - no business/applicant data", { applicationId: input.applicationId });
      return;
    }

    // BF_SERVER_v70_BLOCK_1_3 - company dedup keyed on email primary,
    // phone secondary, name+silo last resort. Email is the canonical
    // company identifier per locked spec; previous code matched on
    // lowercased name only, which created duplicates whenever the
    // applicant typed the same business with different spelling/casing.
    let companyId: string | null = null;
    const businessEmail = (biz.email ?? "").trim().toLowerCase() || null;
    const businessPhone = (biz.phone ?? "").trim() || null;
    if (businessName || businessEmail || businessPhone) {
      // 1) email match (lowercased)
      let existing: { rows: { id: string }[] } = { rows: [] };
      if (businessEmail) {
        existing = await pool.query<{ id: string }>(
          `SELECT id FROM companies
            WHERE silo = $1
              AND email IS NOT NULL
              AND lower(email) = $2
            ORDER BY created_at DESC LIMIT 1`,
          [silo, businessEmail]
        );
      }
      // 2) phone match
      if (existing.rows.length === 0 && businessPhone) {
        existing = await pool.query<{ id: string }>(
          `SELECT id FROM companies
            WHERE silo = $1 AND phone = $2
            ORDER BY created_at DESC LIMIT 1`,
          [silo, businessPhone]
        );
      }
      // 3) name + silo last resort (case-insensitive, trimmed)
      if (existing.rows.length === 0 && businessName) {
        existing = await pool.query<{ id: string }>(
          `SELECT id FROM companies
            WHERE silo = $1 AND lower(trim(name)) = lower(trim($2))
            ORDER BY created_at DESC LIMIT 1`,
          [silo, businessName]
        );
      }

      if (existing.rows[0]) {
        companyId = existing.rows[0].id;
        await pool.query(
          `UPDATE companies SET
             name       = COALESCE(NULLIF($2,''), name),
             email      = COALESCE(NULLIF($3,''), email),
             phone      = COALESCE(NULLIF(phone,''), NULLIF($4,'')) /* BF_SERVER_CRM_MIRROR_PHONE_NO_CLOBBER_v1: fill empty, never overwrite a known-good number */,
             website    = COALESCE(NULLIF($5,''), website),
             industry   = COALESCE(NULLIF($6,''), industry),
             city       = COALESCE(NULLIF($7,''), city),
             province   = COALESCE(NULLIF($8,''), province),
             country    = COALESCE(NULLIF($9,''), country),
             updated_at = now()
           WHERE id = $1`,
          [
            companyId,
            businessName ?? "",
            biz.email ?? "",
            biz.phone ?? "",
            biz.website ?? "",
            biz.industry ?? "",
            biz.city ?? "",
            biz.province ?? "",
            biz.country ?? "",
          ]
        );
      } else if (businessName) {
        const created = await pool.query<{ id: string }>(
          `INSERT INTO companies (
             id, name, email, phone, website, industry, city, province, country,
             status, silo, types_of_financing, created_at, updated_at
           )
           VALUES (
             gen_random_uuid(), $1, NULLIF($2,''), NULLIF($3,''), NULLIF($4,''),
             NULLIF($5,''), NULLIF($6,''), NULLIF($7,''), NULLIF($8,''),
             'prospect', $9,
             ARRAY['APPLICANT']::text[], now(), now()
           )
           RETURNING id`,
          [
            businessName,
            biz.email ?? "",
            biz.phone ?? "",
            biz.website ?? "",
            biz.industry ?? "",
            biz.city ?? "",
            biz.province ?? "",
            biz.country ?? "",
            silo,
          ]
        );
        companyId = created.rows[0]?.id ?? null;
      }
    }

    let contactId: string | null = null;
    if (applicantPhone || applicantEmail || authoritativePhone) {
      // BF_SERVER_CRM_MIRROR_OTP_PHONE_AUTHORITATIVE_v1
      // Match the applicant's existing contact. Prefer the OTP-verified phone
      // (proven to receive SMS), then the form phone, then email; match on the
      // last 10 digits so format differences (E.164 vs hyphenated) don't miss.
      const matchPhone = authoritativePhone ?? applicantPhone;
      const matchSql = matchPhone
        ? `SELECT id, phone FROM contacts
             WHERE silo = $1
               AND right(regexp_replace(coalesce(phone,''),'[^0-9]','','g'),10)
                 = right(regexp_replace($2,'[^0-9]','','g'),10)
             LIMIT 1`
        : `SELECT id, phone FROM contacts WHERE silo = $1 AND lower(email) = lower($2) LIMIT 1`;
      const matchVal = matchPhone ? matchPhone : applicantEmail!;
      let existing = await pool.query<{ id: string; phone: string | null }>(matchSql, [silo, matchVal]);
      if (!existing.rows[0] && matchPhone && applicantEmail) {
        existing = await pool.query<{ id: string; phone: string | null }>(
          `SELECT id, phone FROM contacts WHERE silo = $1 AND lower(email) = lower($2) LIMIT 1`,
          [silo, applicantEmail]
        );
      }
      // Phone precedence: OTP-verified wins (proven), else keep the contact's
      // existing number, else fall back to the form-entered one. A form-entered
      // number can therefore never clobber a known-good phone.
      const existingPhone = (existing.rows[0]?.phone ?? "").trim() || null;
      const finalPhone = authoritativePhone ?? existingPhone ?? applicantPhone ?? null;
      if (existing.rows[0]) {
        contactId = existing.rows[0].id;
        await pool.query(
          `UPDATE contacts SET
             name       = COALESCE(NULLIF(name,''),  NULLIF($2,'')),
             email      = COALESCE(NULLIF(email,''), NULLIF($3,'')),
             phone      = NULLIF($4,''),
             company_id = COALESCE($5, company_id),
             updated_at = now()
           WHERE id = $1`,
          [contactId, applicantName ?? "", applicantEmail ?? "", finalPhone ?? "", companyId]
        );
      } else {
        const created = await pool.query<{ id: string }>(
          `INSERT INTO contacts (
             id, company_id, name, email, phone, status, silo, lead_status,
             tags, lifecycle_stage, role, created_at, updated_at
           )
           VALUES (
             gen_random_uuid(), $1, NULLIF($2,''), NULLIF($3,''), NULLIF($4,''),
             'active', $5, 'New', ARRAY['applicant']::text[], 'lead',
             'applicant', now(), now() -- BF_SERVER_v63_CRM_MIRROR_ROLE
           )
           RETURNING id`,
          [companyId, applicantName ?? "", applicantEmail ?? "", finalPhone ?? "", silo]
        );
        contactId = created.rows[0]?.id ?? null;
      }
    }

    // Link the application. Use COALESCE so we don't overwrite a manual link.
    if (companyId || contactId) {
      // applications.contact_id may not exist on every deploy - guard via
      // information_schema.
      const hasContactId = await pool.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_name = 'applications' AND column_name = 'contact_id'
         ) AS exists`
      );
      if (hasContactId.rows[0]?.exists) {
        await pool.query(
          `UPDATE applications SET
             company_id = COALESCE(company_id, $2),
             contact_id = COALESCE(contact_id, $3),
             updated_at = now()
           WHERE id = $1`,
          [input.applicationId, companyId, contactId]
        );
        // BF_SERVER_ATTRIBUTION_TO_CONTACT_v1 - visible on the contact card.
        if (contactId && input.attribution && Object.values(input.attribution).some((v) => v)) {
          const attributionPayload = { applicationId: input.applicationId, ...input.attribution };
          await pool.query(
            `INSERT INTO crm_timeline_events (contact_id, event_type, payload) VALUES ($1, 'attribution', $2)`,
            [contactId, JSON.stringify(attributionPayload)]
          ).catch((e) => console.warn("[crm_mirror] attribution event failed", e instanceof Error ? e.message : String(e)));
          // BF_SERVER_VISITOR_JOURNEY_v1 - stitch the anonymous pre-application session to this contact.
          const sessionId = typeof (input.attribution as any).sessionId === "string" ? String((input.attribution as any).sessionId).trim() : "";
          if (sessionId) {
            void pool.query(
              `UPDATE visitor_sessions SET contact_id = $2, stitched_at = now() WHERE session_id = $1 AND contact_id IS NULL`,
              [sessionId, contactId],
            ).catch((e) => console.warn("[crm_mirror] journey stitch failed", e instanceof Error ? e.message : String(e)));
          }
          const gclid = typeof input.attribution.gclid === "string" ? input.attribution.gclid.trim() : "";
          if (gclid) {
            void resolveAndStoreAdAttribution({
              contactId,
              gclid,
              applicationId: input.applicationId,
              occurredAt: typeof input.attribution.capturedAt === "string" ? input.attribution.capturedAt : null,
            });
          }
        }
        // BF_SERVER_LEG_CRM_PROPAGATION_v1 - companion/equipment legs are
        // INSERTed at submit time and copy the parent's contact_id via
        // subselect, but this mirror links the parent asynchronously AFTER
        // submit - so the legs copied NULL and stayed orphaned (Equipment
        // leg - Trucking Co, 08533f8c). Propagate the fresh link to any
        // children that still lack it.
        await pool.query(
          `UPDATE applications SET
             company_id = COALESCE(company_id, $2),
             contact_id = COALESCE(contact_id, $3),
             updated_at = now()
           WHERE parent_application_id = $1
             AND (contact_id IS NULL OR company_id IS NULL)`,
          [input.applicationId, companyId, contactId]
        );
      } else {
        await pool.query(
          `UPDATE applications SET
             company_id = COALESCE(company_id, $2),
             updated_at = now()
           WHERE id = $1`,
          [input.applicationId, companyId]
        );
      }
    }
  } catch (err) {
    // Best-effort: never break the submit path.
    // eslint-disable-next-line no-console
    console.warn("[applicationCrmMirror] mirror failed:", (err as Error)?.message ?? err);
  }
}
