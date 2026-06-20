// BF_SERVER_BLOCK_v750_TEAM_CHAT — data access for the internal staff "Team" chat.
import { runQuery } from "../../db.js";

export type TeamChannelKind = "channel" | "dm" | "group";

export interface TeamAttachment {
  name: string;
  contentType: string;
  dataUrl: string;
}

export interface TeamReaction {
  emoji: string;
  user_ids: string[];
}

export interface TeamReplyPreview {
  id: string;
  sender_id: string | null;
  body: string;
}

export interface TeamMessage {
  id: string;
  channel_id: string;
  sender_id: string | null;
  body: string;
  created_at: string;
  attachments?: TeamAttachment[] | null; // BF_SERVER_TEAM_ATTACH_v1
  // BF_SERVER_TEAM_LIFECYCLE_v1
  edited_at?: string | null;
  deleted_at?: string | null;
  reply_to_id?: string | null;
  reactions?: TeamReaction[];
  reply_to?: TeamReplyPreview | null;
  // BF_SERVER_TEAM_MENTIONS_v1
  mentions?: string[] | null;
  pinned_at?: string | null;
}

export interface TeamChannelSummary {
  id: string;
  kind: TeamChannelKind;
  name: string | null;
  dm_key: string | null;
  created_by: string | null;
  created_at: string;
  member_ids: string[];
  last_read_at: string | null;
  last_message: TeamMessage | null;
  unread_count: number;
  has_mention: boolean; // BF_SERVER_TEAM_MENTIONS_v1
}

export interface TeamUser {
  id: string;
  name: string;
  email: string | null;
}

function uniqueUserIds(userIds: string[]): string[] {
  return Array.from(new Set(userIds.map((uid) => uid.trim()).filter(Boolean)));
}

export async function listChannelsForUser(userId: string): Promise<TeamChannelSummary[]> {
  const r = await runQuery<TeamChannelSummary>(
    `SELECT c.id, c.kind, c.name, c.dm_key, c.created_by, c.created_at,
            m.last_read_at,
            COALESCE((SELECT json_agg(cm.user_id) FROM team_channel_members cm WHERE cm.channel_id = c.id), '[]'::json) AS member_ids,
            (SELECT row_to_json(x) FROM (
               SELECT tm.id, tm.channel_id, tm.sender_id, tm.body, tm.created_at
                 FROM team_messages tm WHERE tm.channel_id = c.id
                ORDER BY tm.created_at DESC LIMIT 1
             ) x) AS last_message,
            (SELECT COUNT(*)::int FROM team_messages tm
              WHERE tm.channel_id = c.id
                AND tm.sender_id IS DISTINCT FROM $1
                AND (m.last_read_at IS NULL OR tm.created_at > m.last_read_at)) AS unread_count,
            (SELECT EXISTS(
               SELECT 1 FROM team_messages tm
                WHERE tm.channel_id = c.id
                  AND $1::uuid = ANY(tm.mentions)
                  AND tm.sender_id IS DISTINCT FROM $1
                  AND (m.last_read_at IS NULL OR tm.created_at > m.last_read_at)
             )) AS has_mention
       FROM team_channel_members m
       JOIN team_channels c ON c.id = m.channel_id
      WHERE m.user_id = $1
      ORDER BY COALESCE((SELECT MAX(tm.created_at) FROM team_messages tm WHERE tm.channel_id = c.id), c.created_at) DESC`,
    [userId],
  );
  return r.rows;
}

export async function memberIdsOf(channelId: string): Promise<string[]> {
  const r = await runQuery<{ user_id: string }>(
    `SELECT user_id FROM team_channel_members WHERE channel_id = $1`,
    [channelId],
  );
  return r.rows.map((x: { user_id: string }) => x.user_id);
}

export async function isMember(channelId: string, userId: string): Promise<boolean> {
  const r = await runQuery<{ one: number }>(
    `SELECT 1 AS one FROM team_channel_members WHERE channel_id = $1 AND user_id = $2`,
    [channelId, userId],
  );
  return Boolean(r.rows[0]);
}

async function addMembers(channelId: string, userIds: string[]): Promise<void> {
  for (const uid of uniqueUserIds(userIds)) {
    await runQuery(
      `INSERT INTO team_channel_members (channel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [channelId, uid],
    );
  }
}

export async function createNamedChannel(name: string, createdBy: string, memberIds: string[]): Promise<string> {
  const c = await runQuery<{ id: string }>(
    `INSERT INTO team_channels (kind, name, created_by) VALUES ('channel', $1, $2) RETURNING id`,
    [name, createdBy],
  );
  const id = c.rows[0].id;
  await addMembers(id, [createdBy, ...memberIds]);
  return id;
}

export async function createGroup(name: string | null, createdBy: string, memberIds: string[]): Promise<string> {
  const c = await runQuery<{ id: string }>(
    `INSERT INTO team_channels (kind, name, created_by) VALUES ('group', $1, $2) RETURNING id`,
    [name, createdBy],
  );
  const id = c.rows[0].id;
  await addMembers(id, [createdBy, ...memberIds]);
  return id;
}

export async function findOrCreateDm(userA: string, userB: string): Promise<string> {
  const key = uniqueUserIds([userA, userB]).sort().join(":");
  const existing = await runQuery<{ id: string }>(`SELECT id FROM team_channels WHERE dm_key = $1`, [key]);
  if (existing.rows[0]) return existing.rows[0].id;
  try {
    const c = await runQuery<{ id: string }>(
      `INSERT INTO team_channels (kind, dm_key, created_by) VALUES ('dm', $1, $2) RETURNING id`,
      [key, userA],
    );
    const id = c.rows[0].id;
    await addMembers(id, [userA, userB]);
    return id;
  } catch {
    const again = await runQuery<{ id: string }>(`SELECT id FROM team_channels WHERE dm_key = $1`, [key]);
    if (again.rows[0]) return again.rows[0].id;
    throw new Error("dm_create_failed");
  }
}

export async function listMessages(channelId: string, opts: { before?: string; limit?: number }): Promise<TeamMessage[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const params: unknown[] = [channelId];
  let beforeClause = "";
  if (opts.before) {
    params.push(opts.before);
    beforeClause = `AND created_at < $2`;
  }
  const r = await runQuery<TeamMessage>(
    `SELECT id, channel_id, sender_id,
            CASE WHEN deleted_at IS NOT NULL THEN '' ELSE body END AS body,
            created_at, edited_at, deleted_at, reply_to_id, mentions, pinned_at,
            CASE WHEN deleted_at IS NOT NULL THEN NULL ELSE attachments END AS attachments
       FROM team_messages
      WHERE channel_id = $1 ${beforeClause}
      ORDER BY created_at DESC
      LIMIT ${limit}`,
    params,
  );
  const rows = r.rows.reverse();
  if (rows.length === 0) return rows;
  const ids = rows.map((m) => m.id);
  const rx = await runQuery<{ message_id: string; emoji: string; user_ids: string[] }>(
    `SELECT message_id, emoji, json_agg(user_id ORDER BY created_at) AS user_ids
       FROM team_message_reactions WHERE message_id = ANY($1::uuid[])
      GROUP BY message_id, emoji ORDER BY MIN(created_at)`,
    [ids],
  );
  const rxByMsg = new Map<string, TeamReaction[]>();
  for (const row of rx.rows) {
    const arr = rxByMsg.get(row.message_id) ?? [];
    arr.push({ emoji: row.emoji, user_ids: row.user_ids });
    rxByMsg.set(row.message_id, arr);
  }
  const replyIds = Array.from(new Set(rows.map((m) => m.reply_to_id).filter((x): x is string => Boolean(x))));
  const replyMap = new Map<string, TeamReplyPreview>();
  if (replyIds.length) {
    const rep = await runQuery<TeamReplyPreview>(
      `SELECT id, sender_id, CASE WHEN deleted_at IS NOT NULL THEN '' ELSE body END AS body
         FROM team_messages WHERE id = ANY($1::uuid[])`,
      [replyIds],
    );
    for (const row of rep.rows) replyMap.set(row.id, row);
  }
  for (const m of rows) {
    m.reactions = rxByMsg.get(m.id) ?? [];
    m.reply_to = m.reply_to_id ? (replyMap.get(m.reply_to_id) ?? null) : null;
  }
  return rows;
}

export async function reactionsForOne(messageId: string): Promise<TeamReaction[]> {
  const r = await runQuery<TeamReaction>(
    `SELECT emoji, json_agg(user_id ORDER BY created_at) AS user_ids
       FROM team_message_reactions WHERE message_id = $1
      GROUP BY emoji ORDER BY MIN(created_at)`,
    [messageId],
  );
  return r.rows;
}

async function replyPreview(replyToId: string | null): Promise<TeamReplyPreview | null> {
  if (!replyToId) return null;
  const r = await runQuery<TeamReplyPreview>(
    `SELECT id, sender_id, CASE WHEN deleted_at IS NOT NULL THEN '' ELSE body END AS body
       FROM team_messages WHERE id = $1`,
    [replyToId],
  );
  return r.rows[0] ?? null;
}

export async function getMessageMeta(messageId: string): Promise<{ channel_id: string; sender_id: string | null } | null> {
  const r = await runQuery<{ channel_id: string; sender_id: string | null }>(
    `SELECT channel_id, sender_id FROM team_messages WHERE id = $1`,
    [messageId],
  );
  return r.rows[0] ?? null;
}

export async function editMessage(messageId: string, userId: string, body: string): Promise<TeamMessage | null> {
  const r = await runQuery<TeamMessage>(
    `UPDATE team_messages SET body = $3, edited_at = now()
      WHERE id = $1 AND sender_id = $2 AND deleted_at IS NULL
      RETURNING id, channel_id, sender_id, body, created_at, edited_at, deleted_at, reply_to_id, mentions, pinned_at, attachments`,
    [messageId, userId, body],
  );
  const msg = r.rows[0] ?? null;
  if (msg) {
    msg.reactions = await reactionsForOne(messageId);
    msg.reply_to = await replyPreview(msg.reply_to_id ?? null);
  }
  return msg;
}

export async function deleteMessage(messageId: string, userId: string): Promise<TeamMessage | null> {
  const r = await runQuery<TeamMessage>(
    `UPDATE team_messages SET deleted_at = now(), body = ''
      WHERE id = $1 AND sender_id = $2 AND deleted_at IS NULL
      RETURNING id, channel_id, sender_id, body, created_at, edited_at, deleted_at, reply_to_id, mentions, pinned_at, attachments`,
    [messageId, userId],
  );
  const msg = r.rows[0] ?? null;
  if (msg) {
    msg.reactions = [];
    msg.reply_to = null;
    msg.attachments = null;
  }
  return msg;
}

export async function addReaction(messageId: string, userId: string, emoji: string): Promise<void> {
  await runQuery(
    `INSERT INTO team_message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [messageId, userId, emoji],
  );
}

export async function removeReaction(messageId: string, userId: string, emoji: string): Promise<void> {
  await runQuery(
    `DELETE FROM team_message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3`,
    [messageId, userId, emoji],
  );
}

export async function postMessage(channelId: string, senderId: string, body: string, attachments?: TeamAttachment[] | null, replyToId?: string | null, mentions?: string[] | null): Promise<TeamMessage> {
  const r = await runQuery<TeamMessage>(
    `INSERT INTO team_messages (channel_id, sender_id, body, attachments, reply_to_id, mentions) VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, channel_id, sender_id, body, created_at, edited_at, deleted_at, reply_to_id, mentions, pinned_at, attachments`,
    [channelId, senderId, body, attachments && attachments.length ? JSON.stringify(attachments) : null, replyToId ?? null, mentions && mentions.length ? mentions : null],
  );
  const msg = r.rows[0];
  msg.reactions = [];
  msg.reply_to = await replyPreview(msg.reply_to_id ?? null);
  return msg;
}

export async function setPinned(messageId: string, channelId: string, pinned: boolean): Promise<TeamMessage | null> {
  const r = await runQuery<TeamMessage>(
    `UPDATE team_messages SET pinned_at = ${pinned ? "now()" : "NULL"}
      WHERE id = $1 AND channel_id = $2 AND deleted_at IS NULL
      RETURNING id, channel_id, sender_id, body, created_at, edited_at, deleted_at, reply_to_id, mentions, pinned_at, attachments`,
    [messageId, channelId],
  );
  const msg = r.rows[0] ?? null;
  if (msg) {
    msg.reactions = await reactionsForOne(messageId);
    msg.reply_to = await replyPreview(msg.reply_to_id ?? null);
  }
  return msg;
}

export async function listPins(channelId: string): Promise<TeamMessage[]> {
  const r = await runQuery<TeamMessage>(
    `SELECT id, channel_id, sender_id, body, created_at, edited_at, deleted_at, reply_to_id, mentions, pinned_at, attachments
       FROM team_messages
      WHERE channel_id = $1 AND pinned_at IS NOT NULL AND deleted_at IS NULL
      ORDER BY pinned_at DESC LIMIT 50`,
    [channelId],
  );
  return r.rows;
}

export async function searchMessages(channelId: string, q: string): Promise<TeamMessage[]> {
  const r = await runQuery<TeamMessage>(
    `SELECT id, channel_id, sender_id, body, created_at, edited_at, deleted_at, reply_to_id, mentions, pinned_at, attachments
       FROM team_messages
      WHERE channel_id = $1 AND deleted_at IS NULL AND body ILIKE $2
      ORDER BY created_at DESC LIMIT 50`,
    [channelId, `%${q}%`],
  );
  return r.rows.reverse();
}

export async function markRead(channelId: string, userId: string): Promise<void> {
  await runQuery(
    `UPDATE team_channel_members SET last_read_at = now() WHERE channel_id = $1 AND user_id = $2`,
    [channelId, userId],
  );
}

// BF_SERVER_TEAM_PRESENCE_v1 — read receipts + presence (typing is ephemeral, WS-only).
export async function listReads(channelId: string): Promise<Array<{ user_id: string; last_read_at: string | null }>> {
  const r = await runQuery<{ user_id: string; last_read_at: string | null }>(
    `SELECT user_id, last_read_at FROM team_channel_members WHERE channel_id = $1`,
    [channelId],
  );
  return r.rows;
}

export async function listPresence(): Promise<Array<{ user_id: string; status: string }>> {
  const r = await runQuery<{ user_id: string; status: string }>(
    `SELECT user_id,
            CASE WHEN last_heartbeat < now() - interval '5 minutes' THEN 'offline' ELSE status END AS status
       FROM staff_presence`,
  );
  return r.rows;
}

export async function listStaffUsers(): Promise<TeamUser[]> {
  const r = await runQuery<{ id: string; first_name: string | null; last_name: string | null; email: string | null }>(
    `SELECT id, first_name, last_name, email FROM users
      WHERE COALESCE(is_active, true) = true
        AND deleted_at IS NULL
        AND role IN ('Admin', 'Staff', 'Ops', 'Marketing')
      ORDER BY COALESCE(NULLIF(TRIM(first_name), ''), email, id::text) ASC LIMIT 500`,
  );
  return r.rows.map((u: { id: string; first_name: string | null; last_name: string | null; email: string | null }) => ({
    id: u.id,
    name: [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || (u.email ?? "Staff"),
    email: u.email,
  }));
}
