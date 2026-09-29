// BF_SERVER_TEAM_PHASE_C_v671 - Team chat Phase C: deal and contact cards, automatic posts into
// channels (new Google Ads lead -> #leads, application submitted -> #deals, missed call -> #calls,
// plus a "Post in a Team channel" automation action), Save for later / Remind me, and @Maya.
// Schema: migrations/2026_09_28_v671_team_phase_c.sql.
import { runQuery } from "../../db.js";
import { logError } from "../../observability/logger.js";
import { broadcastToUsers } from "../../ws/teamSocket.js";
import { pushToUser } from "../notifications/pushToUser.js";
import { memberIdsOf } from "./team.service.js";
import { threadSummaries } from "./teamChannels.js";

export type CardRef = { kind: "contact" | "application"; id: string };
const REF = /\/(crm\/contacts|contacts|applications)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
const COLS = `id, channel_id, sender_id, body, created_at, edited_at, deleted_at, reply_to_id, mentions, pinned_at, attachments, thread_root_id, bot`;

/** Portal links to contacts and applications inside a message, in order, at most five. */
export function extractCardRefs(text: string): CardRef[] {
  const out: CardRef[] = [];
  for (const m of String(text ?? "").matchAll(REF)) {
    const ref: CardRef = { kind: String(m[1]).toLowerCase() === "applications" ? "application" : "contact", id: String(m[2]).toLowerCase() };
    if (!out.some((r) => r.kind === ref.kind && r.id === ref.id)) out.push(ref);
    if (out.length >= 5) break;
  }
  return out;
}

export function parseCardIds(raw: unknown): CardRef[] {
  return String(raw ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 20).flatMap((s) => {
    const [kind, id] = s.split(":");
    return (kind === "contact" || kind === "application") && id && /^[0-9a-f-]{36}$/i.test(id) ? [{ kind, id: id.toLowerCase() } as CardRef] : [];
  });
}

/** One line of detail for each linked contact or application. */
export async function loadCards(refs: CardRef[]) {
  const contactIds = refs.filter((r) => r.kind === "contact").map((r) => r.id);
  const appIds = refs.filter((r) => r.kind === "application").map((r) => r.id);
  const cards: Array<Record<string, unknown>> = [];
  if (contactIds.length) {
    const r = await runQuery<{ c: any; company: string | null }>(
      `SELECT to_jsonb(c) AS c, co.name AS company FROM contacts c LEFT JOIN companies co ON co.id = c.company_id WHERE c.id::text = ANY($1::text[])`, [contactIds]);
    for (const { c, company } of r.rows) {
      const title = String(c?.name || [c?.first_name, c?.last_name].filter(Boolean).join(" ") || c?.phone || "Contact");
      cards.push({ kind: "contact", id: c.id, title, subtitle: [company, c?.lifecycle_stage || c?.status, c?.phone].filter(Boolean).join(" · "), url: "/crm/contacts/" + c.id });
    }
  }
  if (appIds.length) {
    const r = await runQuery<{ a: any; contact: string | null }>(
      `SELECT to_jsonb(a) AS a, COALESCE(NULLIF(c.name, ''), trim(concat_ws(' ', c.first_name, c.last_name))) AS contact
         FROM applications a LEFT JOIN contacts c ON c.id = a.contact_id WHERE a.id::text = ANY($1::text[])`, [appIds]);
    for (const { a, contact } of r.rows) {
      const amount = Number(a?.requested_amount);
      const money = Number.isFinite(amount) && amount > 0 ? "$" + Math.round(amount).toLocaleString("en-US") : null;
      cards.push({ kind: "application", id: a.id, title: String(a?.name || a?.business_legal_name || "Application"),
        subtitle: [a?.pipeline_state || a?.current_stage, money, contact].filter(Boolean).join(" · "), url: "/applications/" + a.id });
    }
  }
  return refs.map((ref) => cards.find((c) => c.kind === ref.kind && c.id === ref.id)).filter(Boolean);
}

async function ensureChannel(name: string): Promise<string> {
  const found = await runQuery<{ id: string }>(`SELECT id FROM team_channels WHERE kind = 'channel' AND lower(name) = lower($1) LIMIT 1`, [name]);
  if (found.rows[0]) return found.rows[0].id;
  const made = await runQuery<{ id: string }>(`INSERT INTO team_channels (kind, name, topic) VALUES ('channel', $1, 'Posted automatically by Boreal') RETURNING id`, [name]);
  return made.rows[0]!.id;
}

/** A message from Boreal or Maya (no human sender), in a channel or as a thread reply. */
export async function postBotMessage(channelId: string, body: string, bot: string, threadRootId: string | null = null) {
  const r = await runQuery(`INSERT INTO team_messages (channel_id, sender_id, body, thread_root_id, bot) VALUES ($1, NULL, $2, $3, $4) RETURNING ${COLS}`,
    [channelId, body.slice(0, 8000), threadRootId, bot]);
  const message: any = { ...r.rows[0], reactions: [], reply_to: null, thread: null };
  const members = await memberIdsOf(channelId);
  if (threadRootId) {
    const summary = (await threadSummaries([threadRootId])).get(threadRootId) ?? null;
    broadcastToUsers(members, { type: "thread_message", channel_id: channelId, root_id: threadRootId, message, summary });
  } else {
    broadcastToUsers(members, { type: "message", channel_id: channelId, message });
  }
  return message;
}

/** Posts into #name (created if missing). Never throws: a failed alert must not break the event behind it. */
export async function postTeamAlert(channelName: string, body: string): Promise<boolean> {
  try {
    const name = channelName.trim().replace(/^#/, "").toLowerCase();
    if (!name || !body.trim()) return false;
    await postBotMessage(await ensureChannel(name), body.trim(), "Boreal");
    return true;
  } catch (err: any) {
    logError("team_alert_failed", { channel: channelName, message: err?.message });
    return false;
  }
}

export async function saveMessage(userId: string, messageId: string, remindAt: string | null) {
  const allowed = await runQuery(`SELECT 1 FROM team_messages m JOIN team_channel_members cm ON cm.channel_id = m.channel_id AND cm.user_id = $2 WHERE m.id = $1`, [messageId, userId]);
  if (!allowed.rows[0]) return null;
  const r = await runQuery(
    `INSERT INTO team_saved (user_id, message_id, remind_at) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, message_id) DO UPDATE SET remind_at = EXCLUDED.remind_at, reminded_at = NULL
     RETURNING id, message_id, remind_at, reminded_at, created_at`, [userId, messageId, remindAt]);
  return r.rows[0];
}

export async function unsaveMessage(userId: string, messageId: string): Promise<boolean> {
  const r = await runQuery(`DELETE FROM team_saved WHERE user_id = $1 AND message_id = $2`, [userId, messageId]);
  return (r.rowCount ?? 0) > 0;
}

export async function listSaved(userId: string) {
  const r = await runQuery(
    `SELECT s.message_id, s.remind_at, s.reminded_at, s.created_at AS saved_at, m.channel_id, m.sender_id, m.bot, m.thread_root_id,
            CASE WHEN m.deleted_at IS NOT NULL THEN '' ELSE m.body END AS body, m.created_at, c.kind AS channel_kind, c.name AS channel_name
       FROM team_saved s JOIN team_messages m ON m.id = s.message_id JOIN team_channels c ON c.id = m.channel_id
      WHERE s.user_id = $1 ORDER BY (s.remind_at IS NULL), s.remind_at ASC, s.created_at DESC LIMIT 200`, [userId]);
  return r.rows;
}

/** Sends every reminder that is due (push + live event) and marks it sent. */
export async function runDueReminders(limit = 50): Promise<number> {
  const r = await runQuery<{ user_id: string; message_id: string; channel_id: string; body: string; thread_root_id: string | null }>(
    `UPDATE team_saved s SET reminded_at = now()
       FROM team_messages m
      WHERE m.id = s.message_id AND s.id IN (SELECT id FROM team_saved WHERE reminded_at IS NULL AND remind_at <= now() ORDER BY remind_at LIMIT $1)
      RETURNING s.user_id::text AS user_id, m.id::text AS message_id, m.channel_id::text AS channel_id, m.body, m.thread_root_id::text AS thread_root_id`, [limit]);
  for (const row of r.rows) {
    const snippet = String(row.body ?? "").replace(/\s+/g, " ").trim().slice(0, 140) || "A saved message";
    const url = "/communications?tab=team&channel=" + row.channel_id + (row.thread_root_id ? "&thread=" + row.thread_root_id : "");
    void pushToUser(row.user_id, "Reminder", snippet, url);
    broadcastToUsers([row.user_id], { type: "reminder", channel_id: row.channel_id, message_id: row.message_id, body: snippet });
  }
  return r.rows.length;
}

export function mentionsMaya(body: unknown): boolean {
  return /(^|[^a-z0-9_])@maya\b/i.test(String(body ?? ""));
}

/** When a message says @Maya, ask the Maya agent (staff audience, as the person asking) and reply in its thread. */
export async function askMaya(channelId: string, message: { id: string; body: string; thread_root_id?: string | null }, askerId: string): Promise<boolean> {
  if (!mentionsMaya(message.body)) return false;
  const rootId = message.thread_root_id || message.id;
  const mayaUrl = (process.env.MAYA_URL || process.env.MAYA_SERVICE_URL || "").replace(/\/+$/, "");
  let reply = "I'm not connected right now, so I can't answer in chat. Try the Maya panel in the portal.";
  if (mayaUrl) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30_000);
    try {
      const u = await runQuery<any>(`SELECT id::text AS id, first_name, last_name, email, role, silo FROM users WHERE id::text = $1`, [askerId]);
      const me = u.rows[0] ?? {};
      const question = String(message.body).replace(/@maya\b/gi, "").trim() || "Hello";
      const resp = await fetch(mayaUrl + "/api/maya/message", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Maya-Audience": "staff", "X-Silo": String(me.silo || "BF").toUpperCase() },
        body: JSON.stringify({ message: question, session_id: "team-" + rootId, staff: { id: me.id ?? askerId, name: [me.first_name, me.last_name].filter(Boolean).join(" ") || null, email: me.email ?? null, role: me.role ?? null } }),
        signal: ctrl.signal,
      });
      const data: any = await resp.json().catch(() => ({}));
      reply = typeof data?.reply === "string" && data.reply.trim() ? data.reply.trim() : "Sorry, I couldn't answer that just now.";
    } catch (err: any) {
      logError("team_maya_failed", { channelId, message: err?.message });
      reply = "Sorry, I couldn't answer that just now.";
    } finally {
      clearTimeout(timer);
    }
  }
  try {
    await postBotMessage(channelId, reply, "Maya", rootId);
    return true;
  } catch (err: any) {
    logError("team_maya_post_failed", { channelId, message: err?.message });
    return false;
  }
}
