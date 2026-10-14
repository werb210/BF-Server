// BF_SERVER_v808_STAGE_ADVANCE - "Additional Steps Required" means Boreal is waiting on the client. Once the client
// has nothing left in their to-do list (every requested document uploaded and every requested form submitted), the
// file moves on by itself: to "In Review" so staff can check it, or back to "Off to Lender" when a package already
// went to a lender. Before this the card sat in Additional Steps until staff moved it by hand.
import { pool } from "../db.js";

export async function advanceWhenClientItemsDone(applicationId: string, outstandingCount: number, reason: string): Promise<string | null> {
  if (outstandingCount > 0) return null;
  try {
    const sent = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM application_packages WHERE application_id::text = ($1)::text AND sent_at IS NOT NULL`,
      [applicationId],
    );
    const next = Number(sent.rows[0]?.n ?? 0) > 0 ? "Off to Lender" : "In Review";
    const moved = await pool.query(
      `UPDATE applications SET pipeline_state = $2, updated_at = now()
        WHERE id::text = ($1)::text AND pipeline_state = 'Additional Steps Required'
        RETURNING id`,
      [applicationId, next],
    );
    if (!moved.rows.length) return null;
    await pool.query(
      `INSERT INTO application_stage_events (id, application_id, from_stage, to_stage, trigger, triggered_by, reason, created_at)
       VALUES (gen_random_uuid(), $1, 'Additional Steps Required', $2, 'auto', 'system', $3, now())`,
      [applicationId, next, reason],
    );
    console.info("[stage-advance] client items done", { applicationId, next });
    return next;
  } catch (err) {
    console.error("[stage-advance] failed", { applicationId, message: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
