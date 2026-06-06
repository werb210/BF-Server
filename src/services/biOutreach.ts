import { pool } from "../db.js";

// BF_SERVER_BLOCK_v344_BI_OUTREACH_AUTOADVANCE_v1
// When staff first reach out to a BI outreach lead (call or email), advance their
// pipeline stage New -> Contacted. Forward-only: only bumps a contact still at new/null,
// so it never drags an Engaged/Demo/etc contact backward. Silo-safe by construction:
// bi_contacts holds only BI outreach leads, so a BF contact id matches zero rows.
// Best-effort — never throws into the comms path that called it.
export async function bumpBiOutreachToContacted(contactId: string | null | undefined): Promise<void> {
  if (!contactId) return;
  try {
    await pool.query(
      `UPDATE bi_contacts
          SET outreach_status = 'contacted',
              outreach_updated_at = now()
        WHERE id::text = $1
          AND COALESCE(outreach_status, 'new') = 'new'`,
      [String(contactId)],
    );
  } catch {
    /* best-effort: pipeline auto-advance must never block comms logging */
  }
}
