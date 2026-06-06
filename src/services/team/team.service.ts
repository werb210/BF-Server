// BF_SERVER_BLOCK_v750_TEAM_CHAT — data access for the internal staff "Team" chat.
import { runQuery } from "../../db.js";

export type TeamChannelKind = "channel" | "dm" | "group";

export interface TeamMessage {
  id: string;
  channel_id: string;
  sender_id: string | null;
  body: string;
  created_at: string;
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
                AND (m.last_read_at IS NULL OR tm.created_at > m.last_read_at)) AS unread_count
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
    `SELECT id, channel_id, sender_id, body, created_at
       FROM team_messages
      WHERE channel_id = $1 ${beforeClause}
      ORDER BY created_at DESC
      LIMIT ${limit}`,
    params,
  );
  return r.rows.reverse();
}

export async function postMessage(channelId: string, senderId: string, body: string): Promise<TeamMessage> {
  const r = await runQuery<TeamMessage>(
    `INSERT INTO team_messages (channel_id, sender_id, body) VALUES ($1, $2, $3)
     RETURNING id, channel_id, sender_id, body, created_at`,
    [channelId, senderId, body],
  );
  return r.rows[0];
}

export async function markRead(channelId: string, userId: string): Promise<void> {
  await runQuery(
    `UPDATE team_channel_members SET last_read_at = now() WHERE channel_id = $1 AND user_id = $2`,
    [channelId, userId],
  );
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
