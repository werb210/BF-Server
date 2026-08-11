// BF_SERVER_SENT_ITEMS_v39
// Mail sent from Apple Mail, Outlook desktop or a phone never reached the CRM.
// crm_email_log is written inside POST /api/o365/mail/send, so anything sent
// outside the portal was invisible on the contact timeline - which broke the
// standing rule that all staff activity lands on the timeline wherever it
// happens. A Graph subscription on Sent Items closes that.
//
// Two deliberate limits:
//   - Only existing contacts are matched. The portal send path auto-creates a
//     lead for an unknown recipient; doing that here would mine every personal
//     email out of a staff mailbox and turn it into a CRM record.
//   - Portal-sent mail is skipped via a header stamped at send time, so the
//     same message is never logged twice by two different paths.
import type { Pool } from "pg";

export const SENT_LOGGED_HEADER = "X-Boreal-Logged";

export type GraphHeader = { name?: string; value?: string };

export type SentMessage = {
  id?: string;
  subject?: string;
  body?: { content?: string };
  from?: { emailAddress?: { address?: string } };
  toRecipients?: { emailAddress?: { address?: string } }[];
  ccRecipients?: { emailAddress?: { address?: string } }[];
  internetMessageHeaders?: GraphHeader[];
};

export function wasLoggedAtSendTime(message: SentMessage): boolean {
  return (message.internetMessageHeaders ?? []).some(
    (header) => String(header?.name ?? "").toLowerCase() === SENT_LOGGED_HEADER.toLowerCase(),
  );
}

export function addressesOf(list: { emailAddress?: { address?: string } }[] | undefined): string[] {
  return (list ?? [])
    .map((entry) => String(entry?.emailAddress?.address ?? "").trim().toLowerCase())
    .filter(Boolean);
}

export function externalRecipients(message: SentMessage): string[] {
  const all = [...addressesOf(message.toRecipients), ...addressesOf(message.ccRecipients)];
  return [...new Set(all)].filter((address) => !/@boreal\.(financial|insure)$/i.test(address));
}

export async function logSentMessage(pool: Pool, userId: string, message: SentMessage): Promise<number> {
  if (!message?.id) return 0;
  if (wasLoggedAtSendTime(message)) return 0;
  const recipients = externalRecipients(message);
  if (!recipients.length) return 0;

  const owner = await pool.query<{ silo: string | null }>(
    `SELECT silo FROM users WHERE id = $1 LIMIT 1`,
    [userId],
  );
  const silo = owner.rows[0]?.silo || "BF";
  const matched = await pool.query<{ id: string }>(
    `SELECT id FROM contacts
      WHERE silo = $1
        AND (lower(email) = ANY($2::text[]) OR lower(secondary_email) = ANY($2::text[]))`,
    [silo, recipients],
  );
  if (!matched.rows.length) return 0;

  const from = String(message.from?.emailAddress?.address ?? "").toLowerCase();
  let written = 0;
  for (const contact of matched.rows) {
    const result = await pool.query(
      `INSERT INTO crm_email_log
         (from_address,to_addresses,cc_addresses,bcc_addresses,subject,body_html,
          owner_id,contact_id,company_id,silo,graph_message_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9,$10)
       ON CONFLICT (graph_message_id, contact_id) WHERE graph_message_id IS NOT NULL
       DO NOTHING`,
      [from, addressesOf(message.toRecipients), addressesOf(message.ccRecipients), [], String(message.subject ?? ""), String(message.body?.content ?? ""), userId, contact.id, silo, message.id],
    ).catch(() => ({ rowCount: 0 }));
    written += result.rowCount ?? 0;
  }
  return written;
}
