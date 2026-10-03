// BF_SERVER_BROKER_SPLIT_LOCK_v716 - a file that came from a partner broker cannot
// go to a lender until the commission split is accepted.
import { pool } from "../../db.js";

export async function brokerSplitBlocker(applicationId: string): Promise<{ blocked: false } | { blocked: true; status: string | null; broker: string | null }> {
  const r = await pool.query<{ broker: string | null; status: string | null }>(
    `SELECT a.metadata->'broker_import'->>'broker_name' AS broker, d.status
       FROM applications a LEFT JOIN broker_deal_confirmations d ON d.application_id = a.id::text
      WHERE a.id::text = $1 AND a.source = 'broker_import' LIMIT 1`,
    [applicationId],
  );
  const row = r.rows[0];
  if (!row) return { blocked: false };
  if (row.status === "accepted") return { blocked: false };
  return { blocked: true, status: row.status ?? null, broker: row.broker ?? null };
}
