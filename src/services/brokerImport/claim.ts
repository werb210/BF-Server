// BF_SERVER_v828_CLIENT_CLAIM_IMPORT - a broker or lender file Boreal imported is a draft that waits for the client.
// The client takes it over either by starting an application with that phone (the wizard's OTP start) or, when they
// are already signed in to the client portal, by tapping Continue on it in the application switcher.
import { pool } from "../../db.js";

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

const DRAFT_FOR_PHONE = `source = 'broker_import' AND pipeline_state = 'draft'
  AND right(regexp_replace(coalesce(metadata->>'readiness_phone', ''), '[^0-9]', '', 'g'), 10) = right(regexp_replace($1, '[^0-9]', '', 'g'), 10)`;

/** Imported drafts waiting for this phone (newest first), shaped for the client portal's switcher. */
export async function importedDraftsForPhone(phone: string, db: Q = pool): Promise<any[]> {
  if (String(phone).replace(/\D/g, "").length < 10) return [];
  const r = await db.query(
    `SELECT id, pipeline_state, NULL::timestamptz AS submitted_at, name AS business_name, product_category, requested_amount,
            updated_at, false AS signature_needed, (metadata->>'broker_claimed_at') IS NULL AS ready_to_finish
       FROM applications
      WHERE ${DRAFT_FOR_PHONE}
      ORDER BY created_at DESC
      LIMIT 10`,
    [phone],
  );
  return r.rows;
}

export type ClaimedDraft = { applicationId: string; brokerPrefill: unknown; brokerName: string | null };

/** What the wizard is told about who prepared the file. Never the lender that declined it. */
export function preparedBy(metadata: any): string | null {
  if (metadata?.lender_referral) return "the documents you provided"; // BF_SERVER_v825_LENDER_REFERRALS
  return metadata?.broker_import?.broker_name ?? null;
}

/** Hands an imported draft to the client: the wizard opens it pre-filled. It stays a draft (pipeline_state is NOT
 *  NULL - clearing it, as the old claim did, failed) until the client submits. Claiming again is harmless. */
export async function claimImportedDraft(applicationId: string, db: Q = pool): Promise<ClaimedDraft> {
  const r = await db.query(
    `UPDATE applications
        SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('broker_claimed_at', COALESCE(metadata->>'broker_claimed_at', now()::text)),
            updated_at = now()
      WHERE id::text = $1
      RETURNING id::text AS id, metadata`,
    [applicationId],
  );
  try {
    await db.query(`UPDATE broker_imports SET status = 'claimed', updated_at = now() WHERE application_id = $1`, [applicationId]);
  } catch (error) {
    console.warn("[broker-import] could not mark the import claimed", { applicationId, error: (error as Error).message });
  }
  const md = r.rows[0]?.metadata ?? {};
  return { applicationId, brokerPrefill: md?.broker_prefill ?? null, brokerName: preparedBy(md) };
}

/** Claim one draft for the signed-in client's phone; null when it is not an imported draft waiting for that phone. */
export async function claimImportedDraftForPhone(applicationId: string, phone: string, db: Q = pool): Promise<ClaimedDraft | null> {
  if (String(phone).replace(/\D/g, "").length < 10) return null;
  const r = await db.query(`SELECT id::text AS id FROM applications WHERE id::text = $2 AND ${DRAFT_FOR_PHONE} LIMIT 1`, [phone, applicationId]);
  if (!r.rows[0]) return null;
  return claimImportedDraft(applicationId, db);
}
