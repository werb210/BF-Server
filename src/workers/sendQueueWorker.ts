// BF_SERVER_SEND_QUEUE_v1 - drains queued large marketing blasts so they neither
// block the HTTP request nor get capped. Claims one job at a time with FOR UPDATE
// SKIP LOCKED (safe across instances) and persists progress as it sends. Email
// channel here; SMS reuses this worker once its runner lands.
import type { Pool } from "pg";
import { runEmailSend } from "../services/marketingSendRunner.js";

const TICK_MS = 30_000;

type ClaimedJob = { id: string; channel: string; silo: string; tag: string | null; payload: { subject?: string; html?: string } };

export function startSendQueueWorker(pool: Pool): { stop: () => void } {
  let stopped = false, running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const claim = await pool.query<ClaimedJob>(
        `UPDATE marketing_send_jobs SET status='running', started_at=now(), updated_at=now()
          WHERE id = (
            SELECT id FROM marketing_send_jobs
             WHERE status='queued' AND channel='email'
             ORDER BY created_at ASC
             FOR UPDATE SKIP LOCKED
             LIMIT 1
          )
          RETURNING id, channel, silo, tag, payload`,
      );
      const job = claim.rows[0];
      if (!job) return;
      const progress = async (sent: number, failed: number) => {
        await pool.query(`UPDATE marketing_send_jobs SET sent=$2, failed=$3, updated_at=now() WHERE id=$1`, [job.id, sent, failed]);
      };
      try {
        const p = job.payload || {};
        const result = await runEmailSend(pool, { silo: job.silo, tag: job.tag, subject: String(p.subject || ""), html: String(p.html || "") }, progress);
        await pool.query(
          `UPDATE marketing_send_jobs SET status='done', total=$2, sent=$3, failed=$4, finished_at=now(), updated_at=now() WHERE id=$1`,
          [job.id, result.total, result.sent, result.failed],
        );
      } catch (err) {
        await pool.query(
          `UPDATE marketing_send_jobs SET status='failed', error=$2, finished_at=now(), updated_at=now() WHERE id=$1`,
          [job.id, err instanceof Error ? err.message : "send failed"],
        ).catch(() => {});
      }
    } catch { /* next tick */ } finally { running = false; }
  };
  const timer = setInterval(() => { void tick(); }, TICK_MS);
  void tick();
  return { stop: () => { stopped = true; clearInterval(timer); } };
}
