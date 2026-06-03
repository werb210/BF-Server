// BF_SERVER_BLOCK_v705_SCHEDULED_SEND — sends scheduled emails when due. Each row
// points at an Outlook draft (already fully built at schedule time). When send_at
// passes we call Graph /me/messages/{id}/send, then mark the row sent.
import type { Pool } from "pg";
import { getGraphForUser } from "../modules/o365/graphClient.js";

const TICK_MS = 60_000;

export function startScheduledEmailWorker(pool: Pool): { stop: () => void } {
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const { rows } = await pool.query<{ id: string; user_id: string; draft_id: string }>(
        `UPDATE scheduled_emails
            SET status = 'sending'
          WHERE id IN (
            SELECT id FROM scheduled_emails
             WHERE status = 'pending' AND send_at <= now()
             ORDER BY send_at ASC
             LIMIT 10
             FOR UPDATE SKIP LOCKED
          )
          RETURNING id, user_id, draft_id`,
      );
      for (const row of rows) {
        try {
          const graph = await getGraphForUser(pool, row.user_id);
          if (!graph) {
            await pool.query(`UPDATE scheduled_emails SET status = 'failed', error = $2 WHERE id = $1`, [row.id, "o365_not_connected"]);
            continue;
          }
          const r = await graph.fetch(`/me/messages/${encodeURIComponent(row.draft_id)}/send`, { method: "POST" });
          if (r.ok) {
            await pool.query(`UPDATE scheduled_emails SET status = 'sent', sent_at = now() WHERE id = $1`, [row.id]);
          } else {
            const detail = (await r.text()).slice(0, 500);
            await pool.query(`UPDATE scheduled_emails SET status = 'failed', error = $2 WHERE id = $1`, [row.id, detail]);
          }
        } catch (err: any) {
          await pool.query(`UPDATE scheduled_emails SET status = 'failed', error = $2 WHERE id = $1`, [row.id, String(err?.message ?? err).slice(0, 500)]);
        }
      }
    } catch (err) {
      console.error("[scheduledEmailWorker] tick failed:", err);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => { void tick(); }, TICK_MS);
  setTimeout(() => { void tick(); }, 5_000);
  return { stop: () => { stopped = true; clearInterval(timer); } };
}
