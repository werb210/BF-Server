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
        `UPDATE marketing_send_jobs SET status='running', started_at=COALESCE(started_at, now()), updated_at=now()
          WHERE id = (
            SELECT id FROM marketing_send_jobs
             WHERE ((status='queued' AND (not_before IS NULL OR not_before <= now()))
                OR (status='running' AND updated_at < now() - interval '10 minutes')) -- BF_SERVER_SEND_HOLD_WINDOW_v1
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
      // BF_SERVER_SEND_KILL_SWITCH_v1 - between-recipient abort: stop this blast
      // if a cancel was requested while it is actively sending.
      const abortCheck = async (): Promise<boolean> => {
        try { const c = await pool.query<{ cancel_requested: boolean }>(`SELECT cancel_requested FROM marketing_send_jobs WHERE id=$1`, [job.id]); return Boolean(c.rows[0]?.cancel_requested); } catch { return false; }
      };
      try {
        const p = job.payload || {};
        if (job.channel === "sms") {
          const result = await runSmsSend(pool, { silo: job.silo, tag: job.tag, body: String(p.body || ""), linkUrl: p.linkUrl ?? null, fbSubject: p.fbSubject ?? null, fbHtml: p.fbHtml ?? null, createdBy: job.created_by ?? null, templateId: (p as any).templateId ?? null }, progress, abortCheck);
          await pool.query(
            `UPDATE marketing_send_jobs SET status=$5, total=$2, sent=$3, failed=$4, finished_at=now(), updated_at=now() WHERE id=$1`,
            [job.id, result.total, result.smsSent + result.emailSent, result.failed, result.aborted ? 'canceled' : 'done'],
          ); // BF_SERVER_SEND_KILL_SWITCH_v1
        } else {
          const result = await runEmailSend(pool, { silo: job.silo, tag: job.tag, subject: String(p.subject || ""), html: String(p.html || ""), tags: (p.tags as string[] | undefined) ?? null, excludeTags: (p.excludeTags as string[] | undefined) ?? null, templateId: (p as any).templateId ?? null }, progress, abortCheck); // BF_SERVER_EMAIL_AUDIENCE_INCL_EXCL_v1 BF_SERVER_TEMPLATE_ANALYTICS_v1 BF_SERVER_SEND_KILL_SWITCH_v1
          await pool.query(
            `UPDATE marketing_send_jobs SET status=$6, total=$2, sent=$3, failed=$4, error=$5, finished_at=now(), updated_at=now() WHERE id=$1`,
            [job.id, result.total, result.sent, result.failed, result.rejectError ? `rejected (status ${result.rejectStatus ?? "unknown"}): ${result.rejectError}` : null, result.aborted ? 'canceled' : 'done'],
          ); // BF_SERVER_SEND_KILL_SWITCH_v1
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
