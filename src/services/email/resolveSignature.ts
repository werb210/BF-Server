// v693: resolve the deal owner's saved HTML signature for AUTOMATED sends
// (sent via the shared submissions@ mailbox). Falls back to a configurable
// default user, then to empty (== today's behaviour: no signature).
import type { Pool } from "pg";

export async function resolveOwnerSignatureHtml(pool: Pool, applicationId?: string | null): Promise<string> {
  try {
    let userId: string | null = null;
    if (applicationId) {
      const r = await pool.query<{ owner_user_id: string | null }>(
        `SELECT owner_user_id FROM applications WHERE id = $1 LIMIT 1`, [applicationId]
      );
      userId = r.rows[0]?.owner_user_id ?? null;
    }
    if (!userId) {
      const def = (process.env.DEFAULT_SIGNATURE_USER_ID ?? "").trim();
      userId = def || null;
    }
    if (!userId) return "";
    const s = await pool.query<{ email_signature_html: string | null }>(
      `SELECT email_signature_html FROM user_settings WHERE user_id = $1 LIMIT 1`, [userId]
    );
    return (s.rows[0]?.email_signature_html ?? "").toString();
  } catch {
    return "";
  }
}
