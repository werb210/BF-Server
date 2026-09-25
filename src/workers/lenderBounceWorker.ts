// BF_SERVER_BLOCK_v494_LENDER_EMAIL_BOUNCES - every 15 minutes, read new bounce
// notices from the send-as mailbox and record which lender package email bounced
// and why. Only size bounces were ever handled (v456 sends big packages as a
// link); a wrong address or full mailbox looked like a successful send.
import type { Pool } from "pg";
import { graphAppToken, graphSendAsMailbox } from "../services/email/graphSendService.js";
import { isBounce, bounceReason, failedRecipients } from "../services/lenders/bounceDetect.js";

const TICK_MS = 15 * 60 * 1000;

type GraphMsg = { id: string; internetMessageId?: string; subject?: string; receivedDateTime: string;
  from?: { emailAddress?: { address?: string; name?: string } }; body?: { content?: string } };

export async function readBouncesOnce(pool: Pool): Promise<number> {
  const mailbox = graphSendAsMailbox();
  if (!mailbox) return 0;
  const last = await pool.query<{ t: string | null }>(`SELECT MAX(received_at)::text AS t FROM lender_email_bounces`); // swallow-ok: errors propagate to startLenderBounceWorker, which logs them
  const since = last.rows[0]?.t ? new Date(last.rows[0].t) : new Date(Date.now() - 3 * 24 * 3600 * 1000);
  const token = await graphAppToken();
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/mailFolders/inbox/messages` +
    `?$filter=${encodeURIComponent(`receivedDateTime ge ${since.toISOString()}`)}` +
    `&$orderby=receivedDateTime%20asc&$top=50&$select=id,internetMessageId,subject,from,receivedDateTime,body`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.body-content-type="text"' } });
  if (!resp.ok) throw new Error(`graph_inbox_read_failed status=${resp.status} body=${(await resp.text().catch(() => "")).slice(0, 200)}`);
  const json = await resp.json() as { value?: GraphMsg[] };
  let recorded = 0;
  for (const msg of json.value ?? []) {
    if (!isBounce(msg.subject, msg.from?.emailAddress?.address, msg.from?.emailAddress?.name)) continue;
    const text = `${msg.subject ?? ""}\n${msg.body?.content ?? ""}`;
    const reason = bounceReason(text);
    const recipients = failedRecipients(text, [mailbox]);
    let lenderId: string | null = null;
    let applicationId: string | null = null;
    let recipient: string | null = recipients[0] ?? null;
    for (const addr of recipients) {
      const l = await pool.query<{ id: string }>(
        `SELECT id::text AS id FROM lenders WHERE lower(trim(submission_email)) = $1 LIMIT 1`, [addr]);
      if (!l.rows[0]) continue;
      lenderId = l.rows[0].id;
      recipient = addr;
      const a = await pool.query<{ application_id: string }>(
        `SELECT application_id::text AS application_id FROM application_packages
          WHERE lender_id::text = $1 AND sent_at IS NOT NULL AND COALESCE(sent_manually, FALSE) = FALSE
            AND sent_at <= $2::timestamptz AND sent_at >= $2::timestamptz - interval '14 days'
          ORDER BY sent_at DESC LIMIT 1`, [lenderId, msg.receivedDateTime]);
      applicationId = a.rows[0]?.application_id ?? null;
      break;
    }
    const ins = await pool.query(
      `INSERT INTO lender_email_bounces (ndr_message_id, application_id, lender_id, recipient, reason, detail, received_at)
       VALUES ($1, $2, $3::uuid, $4, $5, $6, $7::timestamptz)
       ON CONFLICT (ndr_message_id) DO NOTHING`,
      [msg.internetMessageId || msg.id, applicationId, lenderId, recipient, reason, text.slice(0, 2000), msg.receivedDateTime]);
    if (ins.rowCount) {
      recorded += 1;
      console.warn("[lender-bounce] recorded", { applicationId, lenderId, recipient, reason });
    }
  }
  return recorded;
}

export function startLenderBounceWorker(pool: Pool): { stop: () => void } {
  const run = () => { readBouncesOnce(pool).catch((err) => console.error("[lender-bounce] read failed", { error: err?.message ?? String(err) })); };
  run();
  const t = setInterval(run, TICK_MS);
  return { stop: () => clearInterval(t) };
}
