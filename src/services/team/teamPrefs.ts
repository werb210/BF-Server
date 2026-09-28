// BF_SERVER_TEAM_PREFS_v643 - Team chat: mute, mark unread, status (custom / DND / away) and
// push alerts for people who do not have the portal open.
import { runQuery } from "../../db.js";
import { logError } from "../../observability/logger.js";
import { isConnected } from "../../ws/teamSocket.js";
import { pushToUser } from "../notifications/pushToUser.js";

export type TeamStatus = {
  user_id: string;
  status_text: string | null;
  status_emoji: string | null;
  status_until: string | null;
  dnd: boolean;
  dnd_until: string | null;
  away: boolean;
};

export async function setMuted(channelId: string, userId: string, muted: boolean): Promise<void> {
  await runQuery(`UPDATE team_channel_members SET muted = $3 WHERE channel_id = $1 AND user_id = $2`, [channelId, userId, muted]);
}

/** Unread again from this message on (read up to just before it). */
export async function markUnread(channelId: string, userId: string, messageId: string): Promise<boolean> {
  const r = await runQuery(
    `UPDATE team_channel_members m
        SET last_read_at = t.created_at - interval '1 millisecond'
       FROM team_messages t
      WHERE m.channel_id = $1 AND m.user_id = $2 AND t.id = $3 AND t.channel_id = $1`,
    [channelId, userId, messageId],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function listStatuses(): Promise<TeamStatus[]> {
  const r = await runQuery<TeamStatus>(
    `SELECT user_id::text AS user_id,
            CASE WHEN status_until IS NULL OR status_until > now() THEN status_text END AS status_text,
            CASE WHEN status_until IS NULL OR status_until > now() THEN status_emoji END AS status_emoji,
            CASE WHEN status_until IS NULL OR status_until > now() THEN status_until END AS status_until,
            COALESCE(dnd_until > now(), false) AS dnd,
            CASE WHEN dnd_until > now() THEN dnd_until END AS dnd_until,
            away
       FROM team_user_status`,
  );
  return r.rows;
}

/** Only the fields present in `patch` change; null clears a field. */
export async function setStatus(userId: string, patch: {
  status_text?: string | null; status_emoji?: string | null; status_until?: string | null;
  dnd_until?: string | null; away?: boolean;
}): Promise<TeamStatus | null> {
  await runQuery(`INSERT INTO team_user_status (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [userId]);
  const sets: string[] = [];
  const vals: unknown[] = [userId];
  const put = (col: string, v: unknown) => { vals.push(v); sets.push(col + " = $" + vals.length); };
  if ("status_text" in patch) put("status_text", patch.status_text ? String(patch.status_text).slice(0, 100) : null);
  if ("status_emoji" in patch) put("status_emoji", patch.status_emoji ? String(patch.status_emoji).slice(0, 16) : null);
  if ("status_until" in patch) put("status_until", patch.status_until || null);
  if ("dnd_until" in patch) put("dnd_until", patch.dnd_until || null);
  if ("away" in patch) put("away", Boolean(patch.away));
  if (sets.length) await runQuery(`UPDATE team_user_status SET ${sets.join(", ")}, updated_at = now() WHERE user_id = $1`, vals);
  return (await listStatuses()).find((s) => s.user_id === userId) ?? null;
}

export function pushRecipients(input: {
  senderId: string;
  members: Array<{ user_id: string; muted: boolean }>;
  mentions: string[];
  dndUserIds: Set<string>;
  connected: (userId: string) => boolean;
}): Array<{ userId: string; mentioned: boolean }> {
  const out: Array<{ userId: string; mentioned: boolean }> = [];
  for (const m of input.members) {
    if (m.user_id === input.senderId) continue;
    if (input.dndUserIds.has(m.user_id)) continue;
    const mentioned = input.mentions.includes(m.user_id);
    if (m.muted && !mentioned) continue;
    if (input.connected(m.user_id)) continue;
    out.push({ userId: m.user_id, mentioned });
  }
  return out;
}

export async function pushTeamMessage(channelId: string, message: { sender_id: string | null; body: string; mentions?: string[] | null }): Promise<number> {
  try {
    const [members, statuses, meta] = await Promise.all([
      runQuery<{ user_id: string; muted: boolean }>(
        `SELECT user_id::text AS user_id, COALESCE((to_jsonb(m)->>'muted')::boolean, false) AS muted FROM team_channel_members m WHERE channel_id = $1`, [channelId]),
      listStatuses(),
      runQuery<{ kind: string; name: string | null; sender: string | null }>(
        `SELECT c.kind, c.name, NULLIF(TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), '') AS sender
           FROM team_channels c LEFT JOIN users u ON u.id = $2 WHERE c.id = $1`, [channelId, message.sender_id]),
    ]);
    const who = pushRecipients({
      senderId: String(message.sender_id ?? ""),
      members: members.rows,
      mentions: (message.mentions ?? []).map(String),
      dndUserIds: new Set(statuses.filter((s) => s.dnd).map((s) => s.user_id)),
      connected: isConnected,
    });
    const sender = meta.rows[0]?.sender ?? "Team";
    const where = meta.rows[0]?.kind === "dm" ? sender : (meta.rows[0]?.name ? "#" + meta.rows[0].name : "Team chat");
    const snippet = String(message.body ?? "").replace(/\s+/g, " ").trim().slice(0, 140) || "Sent an attachment";
    for (const r of who) {
      const title = r.mentioned ? sender + " mentioned you" + (where !== sender ? " in " + where : "") : where;
      void pushToUser(r.userId, title, (where !== sender ? sender + ": " : "") + snippet, "/communications?tab=team&channel=" + channelId);
    }
    return who.length;
  } catch (err: any) {
    logError("team_push_failed", { channelId, message: err?.message });
    return 0;
  }
}
