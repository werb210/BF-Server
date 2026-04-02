import { pool } from "../db";
import { withRetry } from "../lib/retry";
import { sendSms } from "../modules/notifications/sms.service";
import { pushLeadToCRM } from "../services/crmWebhook";
import { sendSlackAlert } from "../observability/alerts";

async function processJob(job: { type: string; data: any }): Promise<void> {
  switch (job.type) {
    case "sms":
      await sendSms(job.data);
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
  const res = await pool.query<{ id: string; retry_count: number; type: string; data: any }>(
    `SELECT * FROM failed_jobs ORDER BY created_at ASC LIMIT 20`
  );

  for (const job of res.rows) {
    if (job.retry_count >= MAX_RETRIES) {
      console.error("Dead letter abandoned", job.id);
      continue;
    }

    try {
      await withRetry(async () => {
        await processJob(job);
      });

      await pool.query(`DELETE FROM failed_jobs WHERE id = $1`, [job.id]);
    } catch {
      await pool.query(
        `UPDATE failed_jobs SET retry_count = retry_count + 1 WHERE id = $1`,
        [job.id]
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

export function startDeadLetterWorker(): NodeJS.Timeout {
  return setInterval(safeProcess, 15000);
}
