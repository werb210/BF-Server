import { pool, runQuery } from "../../db.js";

export const REFERRAL_CONVERSION_RATE = 20;

// BF_SERVER_REFERRAL_ATTRIBUTION_v1 - a cold link-apply carries the referral code in
// metadata.attribution.ref, but nothing tagged the applicant's contact, so it never
// showed under the referrer or earned the conversion credit. Resolve the ref code to
// its referrer (contacts.ref_code is unique) and stamp the application's contact with
// referrer_id + ref_code when it is not already tagged. Idempotent.
export async function attributeReferralFromRef(applicationId: string): Promise<void> {
  await runQuery(
    `WITH app AS (
       SELECT a.contact_id::text AS contact_id,
              NULLIF(trim(a.metadata->'attribution'->>'ref'), '') AS ref
         FROM applications a
        WHERE a.id::text = $1
        LIMIT 1
     ),
     resolved AS (
       SELECT app.contact_id, app.ref, rc.referrer_id
         FROM app
         JOIN contacts rc ON rc.ref_code = app.ref
        WHERE app.ref IS NOT NULL AND app.contact_id IS NOT NULL
        LIMIT 1
     )
     UPDATE contacts c
        SET referrer_id = resolved.referrer_id,
            ref_code = COALESCE(c.ref_code, resolved.ref),
            updated_at = now()
       FROM resolved
      WHERE c.id::text = resolved.contact_id
        AND resolved.referrer_id IS NOT NULL
        AND c.referrer_id IS NULL`,
    [applicationId],
  );
}

export async function creditReferralConversion(params: {
  applicationId: string;
  sourceSilo?: string | null;
  externalApplicationId?: string | null;
  dealAmount?: number | null;
}): Promise<{ id: string } | null> {
  // BF_SERVER_REFERRAL_ATTRIBUTION_v1 - tag the contact from the ref before crediting.
  await attributeReferralFromRef(params.applicationId).catch(() => undefined);
  const result = await runQuery<{ id: string }>(
    `WITH app AS (
       SELECT a.id::text AS application_id,
              a.contact_id::text AS contact_id,
              COALESCE($4::numeric, a.requested_amount::numeric) AS deal_amount,
              COALESCE($2::text, a.silo, 'BF') AS source_silo,
              c.referrer_id::text AS referrer_id,
              c.ref_code AS ref_code
         FROM applications a
         LEFT JOIN contacts c ON c.id = a.contact_id
        WHERE a.id::text = $1
        LIMIT 1
     )
     INSERT INTO referral_conversions
       (application_id, contact_id, referrer_id, ref_code, source_silo, external_application_id,
        conversion_rate, deal_amount, credit_amount, status, credited_at, created_at, updated_at)
     SELECT application_id::uuid, contact_id::uuid, referrer_id::uuid, ref_code, source_silo, $3::text,
            $5::numeric, deal_amount, deal_amount * ($5::numeric / 100), 'credited', now(), now(), now()
       FROM app
      WHERE referrer_id IS NOT NULL
     ON CONFLICT (application_id) WHERE application_id IS NOT NULL DO UPDATE
       SET updated_at = now()
     RETURNING id::text AS id`,
    [params.applicationId, params.sourceSilo ?? null, params.externalApplicationId ?? null, params.dealAmount ?? null, REFERRAL_CONVERSION_RATE],
  );
  return result.rows[0] ?? null;
}

export async function creditBiReferralConversion(params: {
  refCode: string;
  externalApplicationId: string;
  dealAmount: number | null;
}): Promise<{ id: string } | null> {
  const result = await pool.query<{ id: string }>(
    `WITH ref AS (
       SELECT id::text AS contact_id, referrer_id::text AS referrer_id, ref_code
         FROM contacts
        WHERE ref_code = $1
        LIMIT 1
     )
     INSERT INTO referral_conversions
       (contact_id, referrer_id, ref_code, source_silo, external_application_id,
        conversion_rate, deal_amount, credit_amount, status, credited_at, created_at, updated_at)
     SELECT contact_id::uuid, referrer_id::uuid, ref_code, 'BI', $2::text,
            $4::numeric, $3::numeric, COALESCE($3::numeric, 0) * ($4::numeric / 100), 'credited', now(), now(), now()
       FROM ref
      WHERE referrer_id IS NOT NULL
     ON CONFLICT (source_silo, external_application_id) WHERE external_application_id IS NOT NULL DO UPDATE
       SET updated_at = now()
     RETURNING id::text AS id`,
    [params.refCode, params.externalApplicationId, params.dealAmount, REFERRAL_CONVERSION_RATE],
  );
  return result.rows[0] ?? null;
}
