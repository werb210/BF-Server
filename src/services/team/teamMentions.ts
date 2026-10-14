// BF_SERVER_v803_TEAM_MENTIONS - @mentions in Team chat did not reach anyone unless the sender picked
// the name from the portal's pop-up list: the server only used the ids the client sent, the thread
// panel never sent any, and a mention was only a push (dropped when the person had the portal open,
// and never seen on the dialer). Now:
//   1. the server also finds "@First Last" and "@First" typed by hand, among the conversation's members;
//   2. every mentioned person gets a notification in the portal bell (notifications table), which the
//      bell and the dialer both read, and a push.
import { runQuery } from "../../db.js";
import { logError, logWarn } from "../../observability/logger.js";

export type MemberName = { user_id: string; first_name: string | null; last_name: string | null };

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Members whose name is written as @First Last or @First (case-insensitive, not inside another word). */
export function mentionedMemberIds(body: string, members: MemberName[]): string[] {
  const text = String(body ?? "");
  if (!text.includes("@")) return [];
  const out = new Set<string>();
  for (const m of members) {
    const first = String(m.first_name ?? "").trim();
    const last = String(m.last_name ?? "").trim();
    if (!first) continue;
    const names = last ? [first + " " + last, first] : [first];
    for (const name of names) {
      const re = new RegExp("(^|[^A-Za-z0-9_])@" + escapeRe(name).replace(/\s+/g, "\\s+") + "(?![A-Za-z0-9_])", "i");
      if (re.test(text)) { out.add(String(m.user_id)); break; }
    }
  }
  return [...out];
}

/** Client-sent ids (kept only when they are members) plus names typed in the text. Never the sender. */
export async function resolveTeamMentions(channelId: string, senderId: string, body: string, clientIds: string[]): Promise<string[]> {
  const r = await runQuery<MemberName>(
    `SELECT m.user_id::text AS user_id, u.first_name, u.last_name
       FROM team_channel_members m JOIN users u ON u.id = m.user_id
      WHERE m.channel_id = $1`,
    [channelId],
  );
  const memberIds = new Set(r.rows.map((m) => String(m.user_id)));
  const ids = new Set<string>();
  for (const id of clientIds.map(String)) if (memberIds.has(id)) ids.add(id);
  for (const id of mentionedMemberIds(body, r.rows)) ids.add(id);
  ids.delete(String(senderId));
  return [...ids].slice(0, 50);
}

/** A bell notification for each mentioned person (one per message), plus a push. */
export async function notifyTeamMentions(input: { channelId: string; messageId: string; senderId: string; body: string; mentions: string[] }): Promise<number> {
  if (!input.mentions.length) return 0;
  try {
    const meta = await runQuery<{ kind: string; name: string | null; sender: string | null }>(
      `SELECT c.kind, c.name, NULLIF(TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), '') AS sender
         FROM team_channels c LEFT JOIN users u ON u.id = $2 WHERE c.id = $1`,
      [input.channelId, input.senderId],
    );
    const sender = meta.rows[0]?.sender ?? "Someone";
    const where = meta.rows[0]?.kind === "channel" && meta.rows[0]?.name ? " in #" + meta.rows[0].name : "";
    const title = sender + " mentioned you" + where;
    const snippet = String(input.body ?? "").replace(/\s+/g, " ").trim().slice(0, 280) || "Sent an attachment";
    const url = "/communications?tab=team&channel=" + encodeURIComponent(input.channelId);
    const { pushToUser } = await import("../notifications/pushToUser.js");
    let inserted = 0;
    for (const userId of input.mentions) {
      const r = await runQuery<{ id: string }>(
        `INSERT INTO notifications (user_id, type, title, ref_table, ref_id, body, context_url)
         VALUES ($1, 'mention', $2, 'team_messages', $3, $4, $5)
         ON CONFLICT ON CONSTRAINT notifications_unique_per_ref DO NOTHING
         RETURNING id`,
        [userId, title, input.messageId, snippet, url],
      );
      if (r.rows[0]) {
        inserted += 1;
        void pushToUser(userId, title, snippet, url);
      }
    }
    return inserted;
  } catch (err: any) {
    logError("team_mention_notify_failed", { channelId: input.channelId, messageId: input.messageId, message: err?.message });
    return 0;
  }
}

/** Resolve, then return the ids; failures are logged and fall back to the ids the client sent. */
export async function teamMentionsFor(channelId: string, senderId: string, body: string, clientIds: string[]): Promise<string[]> {
  try {
    return await resolveTeamMentions(channelId, senderId, body, clientIds);
  } catch (err: any) {
    logWarn("team_mention_resolve_failed", { channelId, message: err?.message });
    return clientIds.filter((id) => id !== senderId);
  }
}
