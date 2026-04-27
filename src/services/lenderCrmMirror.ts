// BF_LENDER_TO_CRM_v38 — Block 38-D
// Dual-write helper: keep a companies row and (if present) a primary contact
// row in sync with every lender create/update. Failures are logged but do
// not propagate — the lender CRUD never blocks on CRM mirroring.
import { pool } from "../db.js";

type LenderForMirror = {
  id: string;
  name: string | null;
  phone: string | null;
  silo: string | null;
  country: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
};

export async function mirrorLenderToCrm(lender: LenderForMirror): Promise<void> {
  try {
    const silo = lender.silo ?? "BF";
    const name = (lender.name ?? "").trim() || "Unnamed Lender";

    // Upsert the companies row. We anchor on companies.lender_id added by
    // the backfill migration. RETURNING id gives us the company FK.
    const companyResult = await pool.query<{ id: string }>(
      `INSERT INTO companies (
         id, name, phone, status, country, silo, types_of_financing,
         lender_id, created_at, updated_at
       )
       VALUES (
         gen_random_uuid(), $1, $2, 'active', COALESCE($3, 'CA'),
         COALESCE($4, 'BF'), ARRAY['LENDER']::text[], $5, now(), now()
       )
       ON CONFLICT (lender_id) DO UPDATE SET
         name       = EXCLUDED.name,
         phone      = EXCLUDED.phone,
         country    = EXCLUDED.country,
         silo       = EXCLUDED.silo,
         updated_at = now()
       RETURNING id`,
      [name, lender.phone, lender.country, silo, lender.id]
    );

    let companyId: string | undefined = companyResult.rows[0]?.id;
    if (!companyId) {
      const existing = await pool.query<{ id: string }>(
        `SELECT id FROM companies WHERE lender_id = $1 LIMIT 1`,
        [lender.id]
      );
      companyId = existing.rows[0]?.id;
    }
    if (!companyId) return;

    // Mirror the primary contact if any contact field is present.
    const contactName = (lender.contact_name ?? "").trim();
    const contactEmail = (lender.contact_email ?? "").trim();
    const contactPhone = (lender.contact_phone ?? "").trim();
    if (!contactName && !contactEmail && !contactPhone) return;

    await pool.query(
      `INSERT INTO contacts (
         id, company_id, name, email, phone, status, silo, lead_status, tags,
         lifecycle_stage, role, created_at, updated_at
       )
       SELECT
         gen_random_uuid(), $1, $2, NULLIF($3,''), NULLIF($4,''),
         'active', $5, 'Lender', ARRAY['lender']::text[],
         'lender', 'lender_primary', now(), now()
       WHERE NOT EXISTS (
         SELECT 1 FROM contacts ct
         WHERE ct.company_id = $1 AND ct.role = 'lender_primary'
       )`,
      [companyId, contactName || "Lender Contact", contactEmail, contactPhone, silo]
    );

    // If the primary contact already exists, refresh its fields.
    await pool.query(
      `UPDATE contacts SET
         name       = COALESCE(NULLIF($2,''), name),
         email      = COALESCE(NULLIF($3,''), email),
         phone      = COALESCE(NULLIF($4,''), phone),
         updated_at = now()
       WHERE company_id = $1 AND role = 'lender_primary'`,
      [companyId, contactName, contactEmail, contactPhone]
    );
  } catch (err) {
    // Mirror failure must not break lender CRUD. Log and move on.
    // eslint-disable-next-line no-console
    console.warn("[lenderCrmMirror] mirror failed:", (err as Error)?.message ?? err);
  }
}
