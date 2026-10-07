// BF_SERVER_READ_THIS_v776 - a team message flagged "Read this": each recipient taps "Mark as read"
// and the sender sees who has and has not read it. Send it in Team chat for everyone, or in a DM
// for one person.
import { runQuery } from "../../db.js";

export type ReadReceipt = { user_id: string; read_at: string };

export async function flagReadThis(messageId: string): Promise<void> {
  await runQuery("UPDATE team_messages SET read_this = true WHERE id = $1", [messageId]);
}

export async function recordRead(messageId: string, userId: string): Promise<ReadReceipt> {
  const r = await runQuery<ReadReceipt>(
    "INSERT INTO team_message_reads (message_id, user_id) VALUES ($1, $2) ON CONFLICT (message_id, user_id) DO UPDATE SET read_at = team_message_reads.read_at RETURNING user_id::text AS user_id, read_at",
    [messageId, userId],
  );
  return r.rows[0];
}

export async function readsFor(messageIds: string[]): Promise<Map<string, ReadReceipt[]>> {
  const out = new Map<string, ReadReceipt[]>();
  if (!messageIds.length) return out;
  const r = await runQuery<{ message_id: string; user_id: string; read_at: string }>(
    "SELECT message_id::text AS message_id, user_id::text AS user_id, read_at FROM team_message_reads WHERE message_id = ANY($1::uuid[]) ORDER BY read_at",
    [messageIds],
  );
  for (const row of r.rows) {
    const list = out.get(row.message_id) ?? [];
    list.push({ user_id: row.user_id, read_at: row.read_at });
    out.set(row.message_id, list);
  }
  return out;
}
