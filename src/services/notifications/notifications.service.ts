// BF_NOTIFICATIONS_v50 — in-app notification fan-out.
import { runQuery } from "../../lib/db.js";

export interface NotifyMentionsParams {
  newMentions: string[];          // resolved user ids
  previousMentions?: string[];    // resolved user ids on the prior version (omit on create)
  refTable: string;               // 'crm_notes'
  refId: string;                  // note id
  body: string | null | undefined;
  contextUrl?: string | null;     // e.g. /applications/<id>
}

/** Returns the diff list of user ids who should be newly notified. */
export function diffMentions(newM: string[], prev: string[] = []): string[] {
  const seen = new Set(prev);
  const out: string[] = [];
  for (const u of newM) {
    if (!u) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

/** Best-effort fan-out. Never throws — notifications are advisory. */
export async function notifyMentions(p: NotifyMentionsParams): Promise<{ inserted: number }> {
  const targets = diffMentions(p.newMentions, p.previousMentions ?? []);
  if (targets.length === 0) return { inserted: 0 };
  const snippet = (p.body ?? "").trim().slice(0, 280);
  let inserted = 0;
  for (const userId of targets) {
    try {
      const r = await runQuery<{ id: string }>(
        `INSERT INTO notifications (user_id, type, ref_table, ref_id, body, context_url)
         VALUES ($1, 'mention', $2, $3, $4, $5)
         ON CONFLICT ON CONSTRAINT notifications_unique_per_ref DO NOTHING
         RETURNING id`,
        [userId, p.refTable, p.refId, snippet, p.contextUrl ?? null]
      );
      if (r.rows[0]) inserted += 1;
    } catch {
      // swallow — notifications are advisory
    }
  }
  return { inserted };
}

export interface Notification {
  id: string;
  user_id: string;
  type: string;
  ref_table: string;
  ref_id: string;
  body: string | null;
  context_url: string | null;
  is_read: boolean;
  created_at: Date;
  read_at: Date | null;
}

export async function listForUser(userId: string, opts: { unreadOnly?: boolean; limit?: number } = {}): Promise<Notification[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const where = opts.unreadOnly ? "AND is_read = false" : "";
  const r = await runQuery<Notification>(
    `SELECT id, user_id, type, ref_table, ref_id, body, context_url, is_read, created_at, read_at
       FROM notifications
      WHERE user_id = $1 ${where}
      ORDER BY created_at DESC
      LIMIT $2`,
    [userId, limit]
  );
  return r.rows;
}

export async function markRead(userId: string, id: string): Promise<boolean> {
  const r = await runQuery<{ id: string }>(
    `UPDATE notifications
        SET is_read = true, read_at = now()
      WHERE id = $1 AND user_id = $2 AND is_read = false
      RETURNING id`,
    [id, userId]
  );
  return Boolean(r.rows[0]);
}

export async function markAllRead(userId: string): Promise<number> {
  const r = await runQuery<{ id: string }>(
    `UPDATE notifications
        SET is_read = true, read_at = now()
      WHERE user_id = $1 AND is_read = false
      RETURNING id`,
    [userId]
  );
  return r.rows.length;
}

export async function unreadCount(userId: string): Promise<number> {
  const r = await runQuery<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM notifications WHERE user_id = $1 AND is_read = false`,
    [userId]
  );
  return Number(r.rows[0]?.c ?? 0);
}
