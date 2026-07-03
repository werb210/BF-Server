// BF_SERVER_SEND_QUEUE_v1 - drains queued large marketing blasts so they neither
// block the HTTP request nor get capped. Claims one job at a time with FOR UPDATE
// SKIP LOCKED (safe across instances) and persists progress as it sends. Email
// channel here; SMS reuses this worker once its runner lands.
import type { Pool } from "pg";
import { runEmailSend, runSmsSend } from "../services/marketingSendRunner.js";

const TICK_MS = 30_000;

type ClaimedJob = { id: string; channel: string; silo: string; tag: string | null; created_by: string | null; payload: { subject?: string; html?: string; body?: string; linkUrl?: string | null; fbSubject?: string | null; fbHtml?: string | null; tags?: string[] | null; excludeTags?: string[] | null } };

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
             WHERE status='queued'
             ORDER BY created_at ASC
             FOR UPDATE SKIP LOCKED
             LIMIT 1
          )
          RETURNING id, channel, silo, tag, payload, created_by`,
      );
      const job = claim.rows[0];
      if (!job) return;
      const progress = async (sent: number, failed: number) => {
        await pool.query(`UPDATE marketing_send_jobs SET sent=$2, failed=$3, updated_at=now() WHERE id=$1`, [job.id, sent, failed]);
      };
      try {
        const p = job.payload || {};
        if (job.channel === "sms") {
          const result = await runSmsSend(pool, { silo: job.silo, tag: job.tag, body: String(p.body || ""), linkUrl: p.linkUrl ?? null, fbSubject: p.fbSubject ?? null, fbHtml: p.fbHtml ?? null, createdBy: job.created_by ?? null }, progress);
          await pool.query(
            `UPDATE marketing_send_jobs SET status='done', total=$2, sent=$3, failed=$4, finished_at=now(), updated_at=now() WHERE id=$1`,
            [job.id, result.total, result.smsSent + result.emailSent, result.failed],
          );
        } else {
          const result = await runEmailSend(pool, { silo: job.silo, tag: job.tag, subject: String(p.subject || ""), html: String(p.html || ""), tags: (p.tags as string[] | undefined) ?? null, excludeTags: (p.excludeTags as string[] | undefined) ?? null }, progress); // BF_SERVER_EMAIL_AUDIENCE_INCL_EXCL_v1
          await pool.query(
            `UPDATE marketing_send_jobs SET status='done', total=$2, sent=$3, failed=$4, finished_at=now(), updated_at=now() WHERE id=$1`,
            [job.id, result.total, result.sent, result.failed],
          );
        }
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
