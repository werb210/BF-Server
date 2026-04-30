// BF_APP_TO_CRM_v38 — Block 38-E
// On wizard submit, upsert a companies row (matched by name+silo) and a
// contacts row (matched by phone or email+silo), then update the application
// with company_id / contact_id. Best-effort: never throws.
import { pool } from "../db.js";

type Wizard = {
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

    // BF_SERVER_v70_BLOCK_1_3 — company dedup keyed on email primary,
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
             phone      = COALESCE(NULLIF($4,''), phone),
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
    if (applicantPhone || applicantEmail) {
      // BF_SERVER_v65_CRM_DEDUP_EMAIL — match by phone first; if that misses
      // and we also have an email, retry with the email lookup before
      // falling through to INSERT. The previous code chose ONE strategy
      // (phone OR email, not both), so a returning applicant whose phone
      // is stored in a different format (E.164 vs hyphenated, +1 prefix,
      // etc.) showed up as a duplicate next to the existing email match.
      const matchSql = applicantPhone
        ? `SELECT id FROM contacts WHERE silo = $1 AND phone = $2 LIMIT 1`
        : `SELECT id FROM contacts WHERE silo = $1 AND lower(email) = lower($2) LIMIT 1`;
      const matchVal = applicantPhone ? applicantPhone : applicantEmail!;
      let existing = await pool.query<{ id: string }>(matchSql, [silo, matchVal]);
      if (!existing.rows[0] && applicantPhone && applicantEmail) {
        existing = await pool.query<{ id: string }>(
          `SELECT id FROM contacts WHERE silo = $1 AND lower(email) = lower($2) LIMIT 1`,
          [silo, applicantEmail]
        );
      }
      if (existing.rows[0]) {
        contactId = existing.rows[0].id;
        await pool.query(
          `UPDATE contacts SET
             name       = COALESCE(NULLIF($2,''), name),
             email      = COALESCE(NULLIF($3,''), email),
             phone      = COALESCE(NULLIF($4,''), phone),
             company_id = COALESCE($5, company_id),
             updated_at = now()
           WHERE id = $1`,
          [contactId, applicantName ?? "", applicantEmail ?? "", applicantPhone ?? "", companyId]
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
          [companyId, applicantName ?? "", applicantEmail ?? "", applicantPhone ?? "", silo]
        );
        contactId = created.rows[0]?.id ?? null;
      }
    }

    // Link the application. Use COALESCE so we don't overwrite a manual link.
    if (companyId || contactId) {
      // applications.contact_id may not exist on every deploy — guard via
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
