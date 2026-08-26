import { pool } from "../db.js";
import { sendSms } from "../modules/notifications/sms.service.js";
import { pushLeadToCRM } from "../services/crmWebhook.js";
import { sendSlackAlert } from "../observability/alerts.js";
import { isPermanentSmsFailure, isUndeliverableNumber } from "../lib/smsDeliverability.js";

async function processJob(job: { type: string; data: any }): Promise<void> {
  switch (job.type) {
    case "sms":
      // Do not enqueue another dead letter while processing a dead letter.
      await sendSms({ to: job.data?.to, message: job.data?.body ?? job.data?.message }, { enqueueOnFailure: false });
      return;
    case "partner_webhook":
      await pushLeadToCRM(job.data);
      return;
    case "slack_webhook":
      await sendSlackAlert(String(job.data?.message ?? ""));
      return;
    default:
      throw new Error(`unknown_dead_letter_job_type:${job.type}`);
  }
}

export async function processDeadLetters(): Promise<void> {
  const MAX_RETRIES = 10;
  // BF_SERVER_DEADLETTER_UNJAM_v1 - only pull jobs still under the retry cap.
  // Previously abandoned jobs (retry_count >= MAX) stayed at the head of the
  // ORDER BY created_at queue forever, so the worker could loop over them every
  // tick and never reach newer jobs.
  const res = await pool.query<{ id: string; retry_count: number; type: string; data: any }>(
    `SELECT * FROM failed_jobs WHERE retry_count < $1 ORDER BY created_at ASC LIMIT 20`,
    [MAX_RETRIES],
  );
  // Prune long-abandoned jobs (kept 7 days for debugging) so the table cannot grow forever.
  await pool.query(`DELETE FROM failed_jobs WHERE retry_count >= $1 AND created_at < now() - interval '7 days'`, [MAX_RETRIES]).catch(() => {});

  for (const job of res.rows) {
    if (job.retry_count >= MAX_RETRIES) {
      console.error("Dead letter abandoned", job.id);
      continue;
    }

    // BF_SERVER_SMS_LOOP_KILL_v121 - retire invalid destinations without Twilio.
    if (job.type === "sms" && isUndeliverableNumber(job.data?.to)) {
      await pool.query(`UPDATE failed_jobs SET retry_count = $2 WHERE id = $1`, [job.id, MAX_RETRIES]).catch(() => {});
      continue;
    }

    try {
      await processJob(job);
      await pool.query(`DELETE FROM failed_jobs WHERE id = $1`, [job.id]);
    } catch (err) {
      const retire = job.type === "sms" && isPermanentSmsFailure(err);
      await pool.query(
        retire
          ? `UPDATE failed_jobs SET retry_count = $2 WHERE id = $1`
          : `UPDATE failed_jobs SET retry_count = retry_count + 1 WHERE id = $1`,
        retire ? [job.id, MAX_RETRIES] : [job.id],
      );
    }
  }
}

async function safeProcess(): Promise<void> {
  try {
    await processDeadLetters();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("dead-letter-failed", message);
  }
}

// BF_SERVER_DEAD_LETTER_WORKER_v110
// Returned a bare NodeJS.Timeout. index.ts registers workers as { stop } so it
// can shut them down cleanly, so this could not be added to that list without
// changing shape - which is part of why it was never wired up at all.
//
// 15s was the original interval and is kept. The queue is small and bounded
// (LIMIT 20 per tick, jobs pruned after 7 days), so the tick is cheap.
export function startDeadLetterWorker(): { stop: () => void } {
  const timer = setInterval(safeProcess, 15000);
  // Do not hold the process open on shutdown.
  if (typeof timer.unref === "function") timer.unref();
  return { stop: () => clearInterval(timer) };
}
