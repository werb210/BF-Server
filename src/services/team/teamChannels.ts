// BF_SERVER_TEAM_PHASE_B_v658 - Team chat Phase B data access.
import { runQuery } from "../../db.js";
import { logError } from "../../observability/logger.js";
import { isConnected } from "../../ws/teamSocket.js";
import { pushToUser } from "../notifications/pushToUser.js";
import { listStatuses, pushRecipients } from "./teamPrefs.js";

export type ChannelMeta = { id: string; kind: string; name: string | null; topic: string | null; is_private: boolean; archived_at: string | null; created_by: string | null };
export type ThreadSummary = { reply_count: number; last_reply_at: string | null; participant_ids: string[] };
const MSG_COLS = `id, channel_id, sender_id, CASE WHEN deleted_at IS NOT NULL THEN '' ELSE body END AS body, created_at, edited_at, deleted_at,
  reply_to_id, mentions, pinned_at, CASE WHEN deleted_at IS NOT NULL THEN NULL ELSE attachments END AS attachments, thread_root_id, bot`; // BF_SERVER_TEAM_PHASE_C_v671

export function normalizeChannelName(raw: unknown): string | null {
  const name = String(raw ?? "").trim().replace(/^#+/, "").toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return name || null;
}
export async function channelMeta(channelId: string): Promise<ChannelMeta | null> {
  const r = await runQuery<ChannelMeta>(`SELECT id, kind, name, topic, COALESCE(is_private, false) AS is_private, archived_at, created_by FROM team_channels WHERE id = $1`, [channelId]);
  return r.rows[0] ?? null;
}
export async function nameTaken(name: string, exceptId: string | null): Promise<boolean> {
  const r = await runQuery(`SELECT 1 FROM team_channels WHERE kind = 'channel' AND lower(name) = lower($1) AND ($2::uuid IS NULL OR id <> $2::uuid)`, [name, exceptId]);
  return (r.rowCount ?? r.rows.length) > 0;
}
export async function browseChannels(userId: string) {
  const r = await runQuery(`SELECT c.id, c.name, c.topic, COALESCE(c.is_private, false) AS is_private, c.archived_at, c.created_at,
    (SELECT count(*)::int FROM team_channel_members cm WHERE cm.channel_id = c.id) AS member_count,
    EXISTS (SELECT 1 FROM team_channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = $1) AS is_member
    FROM team_channels c WHERE c.kind = 'channel' AND (COALESCE(c.is_private, false) = false OR EXISTS
    (SELECT 1 FROM team_channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = $1))
    ORDER BY (c.archived_at IS NOT NULL), lower(c.name)`, [userId]);
  return r.rows;
}
export async function joinChannel(channelId: string, userId: string): Promise<"joined" | "not_found" | "private" | "archived"> {
  const meta = await channelMeta(channelId);
  if (!meta || meta.kind !== "channel") return "not_found";
  if (meta.archived_at) return "archived";
  if (meta.is_private) return "private";
  await runQuery(`INSERT INTO team_channel_members (channel_id, user_id, last_read_at) VALUES ($1, $2, now()) ON CONFLICT DO NOTHING`, [channelId, userId]);
  return "joined";
}
export async function leaveChannel(channelId: string, userId: string): Promise<"left" | "not_member" | "dm"> {
  const meta = await channelMeta(channelId);
  if (!meta) return "not_member";
  if (meta.kind === "dm") return "dm";
  const r = await runQuery(`DELETE FROM team_channel_members WHERE channel_id = $1 AND user_id = $2`, [channelId, userId]);
  return (r.rowCount ?? 0) > 0 ? "left" : "not_member";
}
export async function addChannelMembers(channelId: string, userIds: string[]): Promise<void> {
  for (const uid of Array.from(new Set(userIds.map(String).filter(Boolean))))
    await runQuery(`INSERT INTO team_channel_members (channel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [channelId, uid]);
}
export async function updateChannel(channelId: string, patch: { name?: string; topic?: string | null; is_private?: boolean }): Promise<ChannelMeta | null> {
  const sets: string[] = []; const vals: unknown[] = [channelId];
  const put = (col: string, v: unknown) => { vals.push(v); sets.push(col + " = $" + vals.length); };
  if (patch.name !== undefined) put("name", patch.name);
  if (patch.topic !== undefined) put("topic", patch.topic ? String(patch.topic).trim().slice(0, 250) : null);
  if (patch.is_private !== undefined) put("is_private", Boolean(patch.is_private));
  if (sets.length) await runQuery(`UPDATE team_channels SET ${sets.join(", ")} WHERE id = $1`, vals);
  return channelMeta(channelId);
}
export async function setArchived(channelId: string, archived: boolean): Promise<ChannelMeta | null> {
  await runQuery(`UPDATE team_channels SET archived_at = CASE WHEN $2 THEN COALESCE(archived_at, now()) ELSE NULL END WHERE id = $1`, [channelId, archived]);
  return channelMeta(channelId);
}
export async function threadSummaries(rootIds: string[]): Promise<Map<string, ThreadSummary>> {
  const out = new Map<string, ThreadSummary>(); if (!rootIds.length) return out;
  try {
    const r = await runQuery<{ root: string; reply_count: number; last_reply_at: string; participant_ids: string[] }>(`SELECT thread_root_id::text AS root, count(*)::int AS reply_count, max(created_at) AS last_reply_at,
      COALESCE(json_agg(DISTINCT sender_id) FILTER (WHERE sender_id IS NOT NULL), '[]'::json) AS participant_ids
      FROM team_messages WHERE thread_root_id = ANY($1::uuid[]) AND deleted_at IS NULL GROUP BY thread_root_id`, [rootIds]);
    for (const row of r.rows) out.set(row.root, { reply_count: row.reply_count, last_reply_at: row.last_reply_at, participant_ids: row.participant_ids ?? [] });
  } catch (err: any) { logError("team_thread_summaries_failed", { message: err?.message }); }
  return out;
}
export async function loadThread(channelId: string, rootId: string) {
  const root = await runQuery(`SELECT ${MSG_COLS} FROM team_messages WHERE id = $1 AND channel_id = $2 AND thread_root_id IS NULL`, [rootId, channelId]);
  if (!root.rows[0]) return null;
  const replies = await runQuery(`SELECT ${MSG_COLS} FROM team_messages WHERE thread_root_id = $1 ORDER BY created_at ASC LIMIT 500`, [rootId]);
  return { root: root.rows[0], replies: replies.rows };
}
export async function postThreadReply(channelId: string, rootId: string, senderId: string, body: string, attachments: unknown[] | null, mentions: string[] | null) {
  const ok = await runQuery(`SELECT 1 FROM team_messages WHERE id = $1 AND channel_id = $2 AND thread_root_id IS NULL AND deleted_at IS NULL`, [rootId, channelId]);
  if (!ok.rows[0]) return null;
  const r = await runQuery(`INSERT INTO team_messages (channel_id, sender_id, body, attachments, mentions, thread_root_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${MSG_COLS}`, [channelId, senderId, body, attachments ? JSON.stringify(attachments) : null, mentions, rootId]);
  const summary = (await threadSummaries([rootId])).get(rootId) ?? { reply_count: 1, last_reply_at: null, participant_ids: [senderId] };
  return { message: r.rows[0], summary };
}
export async function pushThreadReply(channelId: string, rootId: string, message: { sender_id: string | null; body: string; mentions?: string[] | null }): Promise<number> {
  try {
    const [people, members, statuses, meta] = await Promise.all([
      runQuery<{ user_id: string }>(`SELECT DISTINCT sender_id::text AS user_id FROM team_messages WHERE (id = $1 OR thread_root_id = $1) AND sender_id IS NOT NULL`, [rootId]),
      runQuery<{ user_id: string; muted: boolean }>(`SELECT user_id::text AS user_id, COALESCE(muted, false) AS muted FROM team_channel_members WHERE channel_id = $1`, [channelId]),
      listStatuses(), runQuery<{ kind: string; name: string | null; sender: string | null }>(`SELECT c.kind, c.name, NULLIF(TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), '') AS sender FROM team_channels c LEFT JOIN users u ON u.id = $2 WHERE c.id = $1`, [channelId, message.sender_id]),
    ]);
    const involved = new Set([...people.rows.map((p) => p.user_id), ...(message.mentions ?? []).map(String)]);
    const who = pushRecipients({ senderId: String(message.sender_id ?? ""), members: members.rows.filter((m) => involved.has(m.user_id)), mentions: (message.mentions ?? []).map(String), dndUserIds: new Set(statuses.filter((s) => s.dnd).map((s) => s.user_id)), connected: isConnected });
    const sender = meta.rows[0]?.sender ?? "Team";
    const where = meta.rows[0]?.kind === "channel" && meta.rows[0]?.name ? " in #" + meta.rows[0].name : "";
    const snippet = String(message.body ?? "").replace(/\s+/g, " ").trim().slice(0, 140) || "Sent an attachment";
    for (const r of who) void pushToUser(r.userId, sender + " replied in a thread" + where, snippet, "/communications?tab=team&channel=" + channelId + "&thread=" + rootId);
    return who.length;
  } catch (err: any) { logError("team_thread_push_failed", { channelId, rootId, message: err?.message }); return 0; }
}
export async function searchEverything(userId: string, q: string) {
  const term = "%" + q.replace(/[%_]/g, (c) => "\\" + c) + "%";
  const messages = await runQuery(`SELECT t.id, t.channel_id, t.sender_id, t.body, t.created_at, t.thread_root_id, t.attachments, c.kind AS channel_kind, c.name AS channel_name
    FROM team_messages t JOIN team_channel_members m ON m.channel_id = t.channel_id AND m.user_id = $1 JOIN team_channels c ON c.id = t.channel_id
    WHERE t.deleted_at IS NULL AND (t.body ILIKE $2 OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t.attachments) = 'array' THEN t.attachments ELSE '[]'::jsonb END) a WHERE a->>'name' ILIKE $2)) ORDER BY t.created_at DESC LIMIT 50`, [userId, term]);
  const channels = await runQuery(`SELECT c.id, c.name, c.topic, c.archived_at FROM team_channels c WHERE c.kind = 'channel' AND (c.name ILIKE $2 OR c.topic ILIKE $2)
    AND (COALESCE(c.is_private, false) = false OR EXISTS (SELECT 1 FROM team_channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = $1)) ORDER BY lower(c.name) LIMIT 20`, [userId, term]);
  return { messages: messages.rows.map((m: any) => ({ ...m, files: Array.isArray(m.attachments) ? m.attachments.map((a: any) => a?.name).filter(Boolean) : [], attachments: undefined })), channels: channels.rows };
}
