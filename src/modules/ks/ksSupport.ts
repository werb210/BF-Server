// BF_SERVER_v853_KS_PHONE_SUPPORT - the Keystone support ticket queue (silo KS).
//
// A ticket has a number (#1001 up), the licensee company and contact (Keystone CRM records), a subject, the channel it
// came in on (phone, email, in_app, manual), a priority, a status (New, Open, Waiting on customer, Resolved, Closed),
// an assignee, and an SLA due time for the first reply, worked out from the licensee's support level (KS-Ops: email,
// priority, premium, dedicated; unknown = the Email level's target). The thread holds customer messages, staff replies
// (sent by email or SMS), internal notes, support-line calls (with their transcript and AI summary once those exist)
// and voicemails.
//
// Tickets come from: support-line calls and voicemails (routes/ksVoice.ts), KS-Ops / KS-server in-app help
// (POST /api/ks/support/ingest, X-KS-Ops-Key) and staff (manual). Everything here only reads or writes KS records.
import { createContact } from "../../services/contacts.js";
import { notifyAllStaff, type NotifyAllStaffCtx } from "../../services/notifications/notifyAllStaff.js";
import { pool as defaultPool } from "../../db.js";
import { e164, last10, type KsCaller, type Q } from "./ksPhone.js";
import { KS_STAFF_SQL, loadQueueSettings, queueAlertUserIds } from "./ksPhone.js";
import { ALBERTA_TZ } from "../../lib/albertaTime.js";

export const KS_TICKET_STATUSES = ["new", "open", "waiting", "resolved", "closed"] as const;
export type KsTicketStatus = (typeof KS_TICKET_STATUSES)[number];
export const KS_TICKET_STATUS_LABELS: Record<KsTicketStatus, string> = {
  new: "New",
  open: "Open",
  waiting: "Waiting on customer",
  resolved: "Resolved",
  closed: "Closed",
};
export const KS_ACTIVE_STATUSES: KsTicketStatus[] = ["new", "open", "waiting"];
export const KS_TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type KsTicketPriority = (typeof KS_TICKET_PRIORITIES)[number];
export const KS_TICKET_CHANNELS = ["phone", "email", "in_app", "manual"] as const;
export type KsTicketChannel = (typeof KS_TICKET_CHANNELS)[number];
export const KS_SUPPORT_LEVELS = ["email", "priority", "premium", "dedicated"] as const;
export type KsSupportLevel = (typeof KS_SUPPORT_LEVELS)[number];

export const isTicketStatus = (v: unknown): v is KsTicketStatus => typeof v === "string" && (KS_TICKET_STATUSES as readonly string[]).includes(v);
export const isTicketPriority = (v: unknown): v is KsTicketPriority => typeof v === "string" && (KS_TICKET_PRIORITIES as readonly string[]).includes(v);
export const isTicketChannel = (v: unknown): v is KsTicketChannel => typeof v === "string" && (KS_TICKET_CHANNELS as readonly string[]).includes(v);
export const isSupportLevel = (v: unknown): v is KsSupportLevel => typeof v === "string" && (KS_SUPPORT_LEVELS as readonly string[]).includes(v);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------------------------------------------------------
// SLA: first-reply targets from the KS-Ops support levels (Oct 20 pricing draft).
// ---------------------------------------------------------------------------------------------------------------
export type SlaWindow = { timezone: string; days: string[]; start: number; end: number };
const WEEKDAYS_8_TO_5: SlaWindow = { timezone: ALBERTA_TZ, days: ["mon", "tue", "wed", "thu", "fri"], start: 8 * 60, end: 17 * 60 };
const EVERY_DAY_7_TO_9: SlaWindow = { timezone: ALBERTA_TZ, days: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"], start: 7 * 60, end: 21 * 60 };

export const KS_SLA_POLICY: Record<KsSupportLevel, { label: string; target: string; minutes: number; window: SlaWindow }> = {
  email: { label: "Email", target: "1 business day", minutes: 9 * 60, window: WEEKDAYS_8_TO_5 },
  priority: { label: "Priority", target: "4 business hours", minutes: 4 * 60, window: WEEKDAYS_8_TO_5 },
  premium: { label: "Premium", target: "1 business hour", minutes: 60, window: WEEKDAYS_8_TO_5 },
  dedicated: { label: "Dedicated", target: "30 minutes (7 am to 9 pm Alberta time, every day)", minutes: 30, window: EVERY_DAY_7_TO_9 },
};

/** `minutes` of working time after `start`, counting only the window's days and hours (local time, DST-aware). */
export function addWorkingMinutes(start: Date, minutes: number, window: SlaWindow): Date {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: window.timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const local = (d: Date) => {
    const parts = fmt.formatToParts(d);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return { day: get("weekday").slice(0, 3).toLowerCase(), minute: (Number(get("hour")) % 24) * 60 + Number(get("minute")) };
  };
  let t = new Date(Math.floor(start.getTime() / 60_000) * 60_000);
  let remaining = Math.max(0, Math.round(minutes));
  let guard = 0;
  while (remaining > 0 && guard < 40_000) {
    guard += 1;
    const { day, minute } = local(t);
    if (window.days.includes(day) && minute >= window.start && minute < window.end) {
      // Inside the window: use up to the rest of today's window in one step.
      const step = Math.min(remaining, window.end - minute);
      remaining -= step;
      t = new Date(t.getTime() + step * 60_000);
    } else {
      t = new Date(t.getTime() + 60_000);
    }
  }
  return t;
}

/** The first-reply due time for a ticket opened at `openedAt` by a licensee on `level` (null = Email's target). */
export function slaDueAt(level: string | null | undefined, openedAt: Date = new Date()): Date {
  const policy = KS_SLA_POLICY[isSupportLevel(level) ? level : "email"];
  return addWorkingMinutes(openedAt, policy.minutes, policy.window);
}

export type SlaState = "met" | "missed" | "overdue" | "due_soon" | "on_track" | "none";

/** met / missed once answered; overdue / due soon (within an hour) / on track while waiting for the first reply. */
export function slaState(t: { sla_due_at: string | Date | null; responded_at: string | Date | null; status: string }, now: Date = new Date()): SlaState {
  if (!t.sla_due_at) return "none";
  const due = new Date(t.sla_due_at).getTime();
  if (t.responded_at) return new Date(t.responded_at).getTime() <= due ? "met" : "missed";
  if (t.status === "resolved" || t.status === "closed") return "none";
  const left = due - now.getTime();
  if (left < 0) return "overdue";
  if (left <= 60 * 60_000) return "due_soon";
  return "on_track";
}

// ---------------------------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------------------------
const TICKET_SELECT = `
  SELECT t.id::text AS id, t.number, t.company_id::text AS company_id, t.contact_id::text AS contact_id, t.subject, t.channel,
         t.priority, t.status, t.assignee_user_id::text AS assignee_user_id, t.support_level, t.sla_due_at, t.first_response_at,
         t.from_phone, t.from_email, t.from_name, t.external_source, t.external_id, t.last_message_at, t.resolved_at, t.closed_at,
         t.created_at, t.updated_at,
         co.name AS company_name, co.ks_support_level AS company_support_level, co.ks_plan AS company_plan,
         NULLIF(TRIM(COALESCE(NULLIF(TRIM(c.name), ''), TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')))), '') AS contact_name,
         c.email AS contact_email, c.phone AS contact_phone,
         NULLIF(TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), '') AS assignee_name, u.email AS assignee_email,
         ans.answered_at,
         (SELECT count(*) FROM ks_support_ticket_messages mc WHERE mc.ticket_id = t.id)::int AS message_count
    FROM ks_support_tickets t
    LEFT JOIN companies co ON co.id = t.company_id
    LEFT JOIN contacts c ON c.id = t.contact_id
    LEFT JOIN users u ON u.id = t.assignee_user_id
    LEFT JOIN LATERAL (
      SELECT min(m.created_at) AS answered_at
        FROM ks_support_ticket_messages m JOIN call_logs cl ON cl.twilio_call_sid = m.call_sid
       WHERE m.ticket_id = t.id AND m.kind = 'call' AND cl.answered IS TRUE
    ) ans ON true`;

const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);

export type KsTicket = ReturnType<typeof rowToTicket>;

export function rowToTicket(r: any, now: Date = new Date()) {
  const respondedRaw = [r.first_response_at, r.answered_at].filter(Boolean).map((v) => new Date(v).getTime());
  const responded = respondedRaw.length ? new Date(Math.min(...respondedRaw)).toISOString() : null;
  const level: KsSupportLevel | null = isSupportLevel(r.support_level) ? r.support_level : null;
  return {
    id: String(r.id),
    number: Number(r.number),
    subject: String(r.subject ?? ""),
    channel: String(r.channel ?? "manual"),
    priority: String(r.priority ?? "normal"),
    status: String(r.status ?? "new"),
    status_label: KS_TICKET_STATUS_LABELS[(isTicketStatus(r.status) ? r.status : "new") as KsTicketStatus],
    company_id: r.company_id ?? null,
    company_name: r.company_name ?? null,
    company_plan: r.company_plan ?? null,
    contact_id: r.contact_id ?? null,
    contact_name: r.contact_name ?? null,
    contact_email: r.contact_email ?? null,
    contact_phone: r.contact_phone ?? null,
    from_phone: r.from_phone ?? null,
    from_email: r.from_email ?? null,
    from_name: r.from_name ?? null,
    assignee_user_id: r.assignee_user_id ?? null,
    assignee_name: r.assignee_name ?? r.assignee_email ?? null,
    support_level: level,
    support_level_label: level ? KS_SLA_POLICY[level].label : null,
    sla_target: KS_SLA_POLICY[level ?? "email"].target,
    sla_due_at: iso(r.sla_due_at),
    responded_at: responded,
    sla_state: slaState({ sla_due_at: r.sla_due_at, responded_at: responded, status: String(r.status ?? "") }, now),
    external_source: r.external_source ?? null,
    external_id: r.external_id ?? null,
    message_count: Number(r.message_count ?? 0),
    last_message_at: iso(r.last_message_at),
    resolved_at: iso(r.resolved_at),
    closed_at: iso(r.closed_at),
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
    silo: "KS" as const,
  };
}

export type TicketFilter = {
  status?: string | null;
  assignee?: string | null;
  priority?: string | null;
  channel?: string | null;
  companyId?: string | null;
  contactId?: string | null;
  search?: string | null;
  userId?: string | null;
};

export async function listTickets(q: Q, f: TicketFilter = {}, now: Date = new Date()): Promise<KsTicket[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const status = String(f.status ?? "active");
  if (status === "active") where.push(`t.status IN ('new', 'open', 'waiting')`);
  else if (isTicketStatus(status)) where.push(`t.status = ${add(status)}`);
  if (f.assignee === "me" && isUuid(f.userId)) where.push(`t.assignee_user_id = ${add(f.userId)}::uuid`);
  else if (f.assignee === "unassigned") where.push(`t.assignee_user_id IS NULL`);
  else if (isUuid(f.assignee)) where.push(`t.assignee_user_id = ${add(f.assignee)}::uuid`);
  if (isTicketPriority(f.priority)) where.push(`t.priority = ${add(f.priority)}`);
  if (isTicketChannel(f.channel)) where.push(`t.channel = ${add(f.channel)}`);
  if (isUuid(f.companyId)) where.push(`t.company_id = ${add(f.companyId)}::uuid`);
  if (isUuid(f.contactId)) where.push(`t.contact_id = ${add(f.contactId)}::uuid`);
  const search = String(f.search ?? "").trim().slice(0, 200);
  if (search) {
    const p = add(`%${search}%`);
    const num = /^#?\d{1,12}$/.test(search) ? add(Number(search.replace("#", ""))) : null;
    where.push(`(t.subject ILIKE ${p} OR coalesce(co.name, '') ILIKE ${p} OR coalesce(c.name, '') ILIKE ${p} OR coalesce(c.email, '') ILIKE ${p}
                 OR coalesce(t.from_phone, '') ILIKE ${p} OR coalesce(t.from_email, '') ILIKE ${p}${num ? ` OR t.number = ${num}` : ""})`);
  }
  const sql = `${TICKET_SELECT}
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY (t.status IN ('new', 'open', 'waiting')) DESC, t.sla_due_at ASC NULLS LAST, t.last_message_at DESC
    LIMIT 500`;
  const { rows } = await q.query(sql, params);
  return rows.map((r: any) => rowToTicket(r, now));
}

export async function getTicketRow(q: Q, id: string, now: Date = new Date()): Promise<KsTicket | null> {
  if (!isUuid(id)) return null;
  const { rows } = await q.query(`${TICKET_SELECT} WHERE t.id = $1::uuid`, [id]);
  return rows[0] ? rowToTicket(rows[0], now) : null;
}

export type KsTicketMessage = {
  id: string;
  kind: string;
  channel: string | null;
  body: string;
  author_user_id: string | null;
  author_name: string | null;
  call_sid: string | null;
  recording_url: string | null;
  created_at: string | null;
  call?: {
    status: string | null;
    duration_seconds: number | null;
    answered: boolean;
    answered_by: string | null;
    summary: string | null;
    transcript: string | null;
  };
};

/** The ticket and its thread. A call message carries the call's outcome, AI summary and transcript once they exist. */
export async function getTicket(q: Q, id: string, now: Date = new Date()): Promise<{ ticket: KsTicket; messages: KsTicketMessage[] } | null> {
  const ticket = await getTicketRow(q, id, now);
  if (!ticket) return null;
  const { rows } = await q.query(
    `SELECT m.id::text AS id, m.kind, m.channel, m.body, m.author_user_id::text AS author_user_id,
            coalesce(m.author_name, NULLIF(TRIM(COALESCE(au.first_name, '') || ' ' || COALESCE(au.last_name, '')), '')) AS author_name,
            m.call_sid, m.recording_url, m.created_at,
            cl.status AS call_status, coalesce(cl.duration_seconds, cl.duration) AS call_duration, coalesce(cl.answered, false) AS call_answered,
            NULLIF(TRIM(COALESCE(su.first_name, '') || ' ' || COALESCE(su.last_name, '')), '') AS call_answered_by,
            tr.full_text AS call_transcript, tr.voice_intelligence_summary AS call_summary
       FROM ks_support_ticket_messages m
       LEFT JOIN users au ON au.id = m.author_user_id
       LEFT JOIN call_logs cl ON m.kind = 'call' AND cl.twilio_call_sid = m.call_sid
       LEFT JOIN users su ON su.id = cl.staff_user_id
       LEFT JOIN conferences cf ON m.kind = 'call' AND cf.friendly_name = 'rx_' || m.call_sid
       LEFT JOIN LATERAL (
         SELECT ct.full_text, ct.voice_intelligence_summary FROM call_transcripts ct
          WHERE ct.conference_id = cf.id ORDER BY ct.updated_at DESC LIMIT 1
       ) tr ON true
      WHERE m.ticket_id = $1::uuid
      ORDER BY m.created_at ASC, m.id ASC`,
    [id],
  );
  const messages: KsTicketMessage[] = rows.map((r: any) => {
    const m: KsTicketMessage = {
      id: String(r.id),
      kind: String(r.kind),
      channel: r.channel ?? null,
      body: String(r.body ?? ""),
      author_user_id: r.author_user_id ?? null,
      author_name: r.author_name ?? null,
      call_sid: r.call_sid ?? null,
      recording_url: r.recording_url ?? null,
      created_at: iso(r.created_at),
    };
    if (r.kind === "call") {
      m.call = {
        status: r.call_status ?? null,
        duration_seconds: r.call_duration == null ? null : Number(r.call_duration),
        answered: r.call_answered === true,
        answered_by: r.call_answered_by ?? null,
        summary: r.call_summary ?? null,
        transcript: r.call_transcript ?? null,
      };
    }
    return m;
  });
  return { ticket, messages };
}

// ---------------------------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------------------------
export type NotifyFn = (args: { userIds: string[]; title: string; body: string; ticketId?: string | null; contextUrl?: string | null; staffAlert?: NotifyAllStaffCtx["staffAlert"] }) => Promise<void>;

/** Bell + push + dialler alert to the named staff (best effort, never throws). */
export const notifyStaff: NotifyFn = async ({ userIds, title, body, ticketId, contextUrl, staffAlert }) => {
  const ids = Array.from(new Set(userIds.filter(isUuid)));
  if (!ids.length) return;
  try {
    await notifyAllStaff({
      pool: defaultPool as any,
      silo: "KS",
      skipSms: true,
      userIds: ids,
      notificationType: ticketId ? "ks_support_ticket" : "ks_phone",
      title: title.slice(0, 120),
      body: body.slice(0, 300),
      ...(isUuid(ticketId) ? { refTable: "ks_support_tickets", refId: ticketId } : {}),
      contextUrl: contextUrl ?? (isUuid(ticketId) ? `/silo/ks/crm/support/${ticketId}` : "/silo/ks/crm/support"),
      ...(staffAlert ? { staffAlert } : {}),
    });
  } catch (err) {
    console.warn("[ks-support] notify failed", { ticketId, message: err instanceof Error ? err.message : String(err) });
  }
};

async function timelineNote(q: Q, body: string, ids: { contactId: string | null; companyId: string | null }): Promise<void> {
  if (!ids.contactId && !ids.companyId) return;
  try {
    await q.query(
      `INSERT INTO crm_notes (body, contact_id, company_id, silo, created_at, updated_at) VALUES ($1, $2::uuid, $3::uuid, 'KS', now(), now())`,
      [body.slice(0, 5000), ids.contactId, ids.companyId],
    );
  } catch (err) {
    console.warn("[ks-support] timeline note failed", { message: err instanceof Error ? err.message : String(err) });
  }
}

export type NewTicketInput = {
  subject: string;
  channel: KsTicketChannel;
  priority?: KsTicketPriority;
  status?: KsTicketStatus;
  companyId?: string | null;
  contactId?: string | null;
  assigneeUserId?: string | null;
  supportLevel?: string | null;
  fromPhone?: string | null;
  fromEmail?: string | null;
  fromName?: string | null;
  externalSource?: string | null;
  externalId?: string | null;
  createdByUserId?: string | null;
  firstMessage?: { kind: "customer" | "note" | "call" | "voicemail" | "system"; body: string; channel?: string | null; callSid?: string | null; recordingUrl?: string | null; externalId?: string | null; authorUserId?: string | null; authorName?: string | null } | null;
  at?: Date;
};

/** The licensee's support level on record (KS company), else null. */
async function companySupportLevel(q: Q, companyId: string | null | undefined): Promise<string | null> {
  if (!isUuid(companyId)) return null;
  const r = await q.query(`SELECT ks_support_level FROM companies WHERE id = $1::uuid AND silo = 'KS'`, [companyId]);
  return isSupportLevel(r.rows[0]?.ks_support_level) ? r.rows[0].ks_support_level : null;
}

export async function addMessage(
  q: Q,
  ticketId: string,
  m: NonNullable<NewTicketInput["firstMessage"]> | { kind: "reply"; body: string; channel?: string | null; authorUserId?: string | null; authorName?: string | null; callSid?: null; recordingUrl?: null; externalId?: null },
): Promise<string | null> {
  const r = await q.query(
    `INSERT INTO ks_support_ticket_messages (ticket_id, kind, channel, body, author_user_id, author_name, call_sid, recording_url, external_id)
     VALUES ($1::uuid, $2, $3, $4, $5::uuid, $6, $7, $8, $9)
     ON CONFLICT DO NOTHING
     RETURNING id::text AS id`,
    [ticketId, m.kind, m.channel ?? null, String(m.body ?? "").slice(0, 20000), isUuid(m.authorUserId) ? m.authorUserId : null, m.authorName ?? null,
      m.callSid ?? null, m.recordingUrl ?? null, m.externalId ?? null],
  );
  return r.rows[0]?.id ?? null;
}

/** Creates a ticket (and its first message), notes it on the CRM timeline and tells the assignee or the support team. */
export async function createTicket(q: Q, input: NewTicketInput, deps: { notify?: NotifyFn } = {}): Promise<{ id: string; number: number; created: boolean }> {
  const notify = deps.notify ?? notifyStaff;
  const at = input.at ?? new Date();
  const level = isSupportLevel(input.supportLevel) ? input.supportLevel : await companySupportLevel(q, input.companyId);
  const due = slaDueAt(level, at);
  const ins = await q.query(
    `INSERT INTO ks_support_tickets
       (company_id, contact_id, subject, channel, priority, status, assignee_user_id, support_level, sla_due_at,
        from_phone, from_email, from_name, external_source, external_id, created_by_user_id, last_message_at, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid, $8, $9, $10, $11, $12, $13, $14, $15::uuid, $16, $16, now())
     ON CONFLICT DO NOTHING
     RETURNING id::text AS id, number`,
    [
      isUuid(input.companyId) ? input.companyId : null,
      isUuid(input.contactId) ? input.contactId : null,
      input.subject.trim().slice(0, 200) || "Support request",
      input.channel,
      input.priority ?? "normal",
      input.status ?? (input.assigneeUserId ? "open" : "new"),
      isUuid(input.assigneeUserId) ? input.assigneeUserId : null,
      level,
      due.toISOString(),
      input.fromPhone ?? null,
      input.fromEmail ?? null,
      input.fromName ?? null,
      input.externalSource ?? null,
      input.externalId ?? null,
      isUuid(input.createdByUserId) ? input.createdByUserId : null,
      at.toISOString(),
    ],
  );
  const row = ins.rows[0];
  if (!row) {
    // The same KS-Ops ticket arrived twice at once: the other request created it.
    const ex = await q.query(
      `SELECT id::text AS id, number FROM ks_support_tickets WHERE external_source = $1 AND external_id = $2`,
      [input.externalSource ?? null, input.externalId ?? null],
    );
    if (!ex.rows[0]) throw new Error("ks_ticket_insert_failed");
    return { id: ex.rows[0].id, number: Number(ex.rows[0].number), created: false };
  }
  const id = String(row.id);
  const number = Number(row.number);
  if (input.firstMessage && (input.firstMessage.body || input.firstMessage.callSid)) await addMessage(q, id, input.firstMessage);
  await timelineNote(q, `Keystone support ticket #${number} opened (${input.channel.replace("_", "-")}): ${input.subject.trim().slice(0, 200)}`, {
    contactId: isUuid(input.contactId) ? input.contactId : null,
    companyId: isUuid(input.contactId) ? null : isUuid(input.companyId) ? input.companyId : null,
  });
  const who = input.fromName || input.fromEmail || input.fromPhone || "a Keystone customer";
  if (isUuid(input.assigneeUserId)) {
    if (input.assigneeUserId !== input.createdByUserId) {
      await notify({ userIds: [input.assigneeUserId], title: `Keystone ticket #${number} assigned to you`, body: input.subject, ticketId: id });
    }
  } else {
    const settings = await loadQueueSettings(q, "support");
    const team = (await queueAlertUserIds(q, settings)).filter((u) => u !== input.createdByUserId);
    await notify({ userIds: team, title: `New Keystone support ticket #${number}`, body: `${input.subject} (from ${who})`, ticketId: id });
  }
  return { id, number, created: true };
}

/** A customer message on an existing ticket: reopens a Waiting / Resolved ticket and tells the assignee. */
export async function appendCustomerMessage(
  q: Q,
  ticketId: string,
  m: NonNullable<NewTicketInput["firstMessage"]>,
  deps: { notify?: NotifyFn } = {},
): Promise<boolean> {
  const notify = deps.notify ?? notifyStaff;
  const added = await addMessage(q, ticketId, m);
  if (!added) return false;
  const r = await q.query(
    `UPDATE ks_support_tickets
        SET last_message_at = now(), updated_at = now(),
            status = CASE WHEN status IN ('waiting', 'resolved') THEN 'open' ELSE status END,
            resolved_at = CASE WHEN status = 'resolved' THEN NULL ELSE resolved_at END
      WHERE id = $1::uuid
      RETURNING number, subject, assignee_user_id::text AS assignee_user_id`,
    [ticketId],
  );
  const t = r.rows[0];
  if (t?.assignee_user_id) {
    const what = m.kind === "voicemail" ? "New voicemail" : m.kind === "call" ? "New call" : "New message";
    await notify({ userIds: [t.assignee_user_id], title: `${what} on Keystone ticket #${Number(t.number)}`, body: String(m.body || t.subject || ""), ticketId });
  }
  return true;
}

/** The newest active ticket for this caller (contact, else company-only, else the same number) in the last 14 days. */
export async function findActiveTicketFor(q: Q, who: { contactId: string | null; companyId: string | null; phone: string | null }): Promise<string | null> {
  const p10 = last10(who.phone);
  if (!who.contactId && !who.companyId && !p10) return null;
  const { rows } = await q.query(
    `SELECT id::text AS id FROM ks_support_tickets
      WHERE status IN ('new', 'open', 'waiting')
        AND last_message_at > now() - interval '14 days'
        AND (($1::uuid IS NOT NULL AND contact_id = $1::uuid)
          OR ($1::uuid IS NULL AND $2::uuid IS NOT NULL AND company_id = $2::uuid AND contact_id IS NULL)
          OR ($3::text <> '' AND right(regexp_replace(coalesce(from_phone, ''), '[^0-9]', '', 'g'), 10) = $3))
      ORDER BY last_message_at DESC
      LIMIT 1`,
    [isUuid(who.contactId) ? who.contactId : null, isUuid(who.companyId) ? who.companyId : null, p10],
  );
  return rows[0]?.id ?? null;
}

function callerLabel(caller: KsCaller, from: string): string {
  const name = caller.contactName ?? caller.companyName;
  return name ? `${name} (${e164(from) ?? from})` : e164(from) ?? (from || "an unknown number");
}

/** A support-line call: appended to the caller's active ticket, else a new phone ticket. Returns the ticket id. */
export async function recordSupportCall(q: Q, args: { callSid: string; from: string; caller: KsCaller; afterHours?: boolean }, deps: { notify?: NotifyFn } = {}): Promise<string | null> {
  if (!args.callSid) return null;
  const existing = await q.query(`SELECT ticket_id::text AS id FROM ks_support_ticket_messages WHERE call_sid = $1 AND kind = 'call' LIMIT 1`, [args.callSid]);
  if (existing.rows[0]?.id) return existing.rows[0].id;
  const body = `Support line call from ${callerLabel(args.caller, args.from)}${args.afterHours ? " (after hours)" : ""}.`;
  const message = { kind: "call" as const, channel: "phone", body, callSid: args.callSid };
  const active = await findActiveTicketFor(q, { contactId: args.caller.contactId, companyId: args.caller.companyId, phone: args.from });
  if (active) {
    await appendCustomerMessage(q, active, message, deps);
    return active;
  }
  const created = await createTicket(q, {
    subject: `Phone call from ${args.caller.contactName ?? args.caller.companyName ?? e164(args.from) ?? "unknown caller"}`,
    channel: "phone",
    companyId: args.caller.companyId,
    contactId: args.caller.contactId,
    supportLevel: args.caller.supportLevel,
    fromPhone: e164(args.from) ?? (args.from || null),
    fromName: args.caller.contactName ?? args.caller.companyName,
    firstMessage: message,
  }, deps);
  return created.id;
}

/** A support-line voicemail: onto the ticket its call opened (else the caller's active ticket, else a new one). */
export async function recordSupportVoicemail(
  q: Q,
  args: { callSid: string; from: string; caller: KsCaller; transcript: string | null; recordingUrl: string | null; contactId?: string | null },
  deps: { notify?: NotifyFn } = {},
): Promise<string | null> {
  const contactId = args.caller.contactId ?? (isUuid(args.contactId) ? args.contactId : null);
  const body = args.transcript?.trim() ? `Voicemail: ${args.transcript.trim()}` : "Voicemail (no transcript).";
  const message = { kind: "voicemail" as const, channel: "phone", body, callSid: args.callSid || null, recordingUrl: args.recordingUrl };
  let ticketId: string | null = null;
  if (args.callSid) {
    const byCall = await q.query(`SELECT ticket_id::text AS id FROM ks_support_ticket_messages WHERE call_sid = $1 ORDER BY created_at ASC LIMIT 1`, [args.callSid]);
    ticketId = byCall.rows[0]?.id ?? null;
  }
  if (!ticketId) ticketId = await findActiveTicketFor(q, { contactId, companyId: args.caller.companyId, phone: args.from });
  if (ticketId) {
    await appendCustomerMessage(q, ticketId, message, deps);
    // The voicemail pipeline may have just created the caller's contact: put it on the ticket.
    if (contactId) {
      await q.query(`UPDATE ks_support_tickets SET contact_id = coalesce(contact_id, $2::uuid), updated_at = now() WHERE id = $1::uuid`, [ticketId, contactId]);
    }
    return ticketId;
  }
  const created = await createTicket(q, {
    subject: `Voicemail from ${args.caller.contactName ?? args.caller.companyName ?? e164(args.from) ?? "unknown caller"}`,
    channel: "phone",
    companyId: args.caller.companyId,
    contactId,
    supportLevel: args.caller.supportLevel,
    fromPhone: e164(args.from) ?? (args.from || null),
    fromName: args.caller.contactName ?? args.caller.companyName,
    firstMessage: message,
  }, deps);
  return created.id;
}

// ---------------------------------------------------------------------------------------------------------------
// KS-Ops / KS-server in-app help: POST /api/ks/support/ingest
// ---------------------------------------------------------------------------------------------------------------
export type KsIngestInput = {
  source: "ks_ops" | "ks_server";
  external_id: string;
  message_id: string | null;
  subject: string | null;
  message: string;
  priority: KsTicketPriority | null;
  at: string | null;
  licensee: { company_code: string | null; name: string | null; support_level: KsSupportLevel | null; phone: string | null } | null;
  requester: { name: string | null; email: string | null; phone: string | null } | null;
};

function text(errors: Record<string, string>, key: string, v: unknown, max: number): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" && typeof v !== "number") {
    errors[key] = "must be text";
    return null;
  }
  const t = String(v).trim();
  if (t.length > max) {
    errors[key] = `must be ${max} characters or fewer`;
    return null;
  }
  return t || null;
}

const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function parseKsIngest(body: unknown): { ok: true; value: KsIngestInput } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const b = obj(body) ? body : {};
  if (!obj(body)) errors.body = "must be a JSON object";
  const source = b.source === undefined || b.source === null ? "ks_ops" : b.source;
  if (source !== "ks_ops" && source !== "ks_server") errors.source = "must be ks_ops or ks_server";
  const externalId = text(errors, "external_id", b.external_id, 100);
  if (!externalId && !errors.external_id) errors.external_id = "is required";
  const messageId = text(errors, "message_id", b.message_id, 100);
  const subject = text(errors, "subject", b.subject, 200);
  const message = text(errors, "message", b.message ?? b.body, 10000);
  if (!message && !errors.message) errors.message = "is required";
  let priority: KsTicketPriority | null = null;
  if (b.priority !== undefined && b.priority !== null) {
    if (isTicketPriority(b.priority)) priority = b.priority;
    else errors.priority = "must be low, normal, high or urgent";
  }
  let at: string | null = null;
  if (b.at !== undefined && b.at !== null) {
    const d = typeof b.at === "string" ? new Date(b.at) : null;
    if (!d || Number.isNaN(d.getTime())) errors.at = "must be an ISO-8601 date";
    else at = d.toISOString();
  }
  let licensee: KsIngestInput["licensee"] = null;
  if (b.licensee !== undefined && b.licensee !== null) {
    if (!obj(b.licensee)) errors.licensee = "must be an object";
    else {
      const l = b.licensee;
      const level = l.support_level === undefined || l.support_level === null ? null : l.support_level;
      if (level !== null && !isSupportLevel(level)) errors["licensee.support_level"] = "must be email, priority, premium or dedicated";
      licensee = {
        company_code: text(errors, "licensee.company_code", l.company_code, 100),
        name: text(errors, "licensee.name", l.name, 200),
        support_level: isSupportLevel(level) ? level : null,
        phone: text(errors, "licensee.phone", l.phone, 40),
      };
      if (!licensee.company_code && !licensee.name && !errors["licensee.company_code"] && !errors["licensee.name"]) errors.licensee = "needs a company_code or name";
    }
  }
  let requester: KsIngestInput["requester"] = null;
  if (b.requester !== undefined && b.requester !== null) {
    if (!obj(b.requester)) errors.requester = "must be an object";
    else {
      const r = b.requester;
      const email = text(errors, "requester.email", r.email, 254);
      if (email && !EMAIL_RE.test(email)) errors["requester.email"] = "is not a valid email";
      const phone = text(errors, "requester.phone", r.phone, 40);
      if (phone && phone.replace(/\D/g, "").length < 7) errors["requester.phone"] = "is not a valid phone number";
      requester = { name: text(errors, "requester.name", r.name, 200), email: email ? email.toLowerCase() : null, phone };
    }
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { source: source as KsIngestInput["source"], external_id: externalId!, message_id: messageId, subject, message: message!, priority, at, licensee, requester } };
}

async function resolveIngestCompany(q: Q, l: NonNullable<KsIngestInput["licensee"]>): Promise<string | null> {
  if (l.company_code) {
    const r = await q.query(
      `SELECT id::text AS id FROM companies WHERE silo = 'KS' AND lower(ks_company_code) = lower($1) ORDER BY created_at ASC LIMIT 1`,
      [l.company_code],
    );
    if (r.rows[0]) return r.rows[0].id;
  }
  if (l.name) {
    const r = await q.query(`SELECT id::text AS id FROM companies WHERE silo = 'KS' AND lower(name) = lower($1) ORDER BY created_at ASC LIMIT 1`, [l.name]);
    if (r.rows[0]) return r.rows[0].id;
  }
  const ins = await q.query(
    `INSERT INTO companies (id, name, phone, silo, ks_company_code, ks_support_level, status, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, 'KS', $3, $4, 'prospect', now(), now())
     RETURNING id::text AS id`,
    [l.name ?? l.company_code, l.phone, l.company_code, l.support_level],
  );
  return ins.rows[0]?.id ?? null;
}

async function resolveIngestContact(q: Q, r: NonNullable<KsIngestInput["requester"]>, companyId: string | null): Promise<string | null> {
  if (r.email) {
    const hit = await q.query(
      `SELECT id::text AS id FROM contacts
        WHERE silo = 'KS' AND lower(email) = lower($1) AND merged_into_id IS NULL AND coalesce(status, '') <> 'archived'
        ORDER BY created_at ASC LIMIT 1`,
      [r.email],
    );
    if (hit.rows[0]) return hit.rows[0].id;
  }
  const p10 = last10(r.phone);
  if (p10) {
    const hit = await q.query(
      `SELECT id::text AS id FROM contacts
        WHERE silo = 'KS' AND merged_into_id IS NULL AND coalesce(status, '') <> 'archived'
          AND (right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10) = $1
               OR right(regexp_replace(coalesce(secondary_phone, ''), '[^0-9]', '', 'g'), 10) = $1)
        ORDER BY created_at ASC LIMIT 1`,
      [p10],
    );
    if (hit.rows[0]) return hit.rows[0].id;
  }
  if (!r.email && !p10) return null;
  const full = (r.name ?? "").trim();
  const parts = full ? full.split(/\s+/) : [];
  const row = await createContact(q as any, {
    first_name: parts[0] ?? (r.email ? r.email.split("@")[0]! : r.phone ?? "Keystone contact"),
    last_name: parts.slice(1).join(" "),
    email: r.email,
    phone: r.phone,
    role: "other",
    is_primary_applicant: false,
    company_id: companyId,
    silo: "KS",
    owner_id: null,
  } as any);
  return row?.id ? String(row.id) : null;
}

/** Creates the ticket for a KS-Ops / KS-server help request, or appends the new message to it (idempotent per message). */
export async function ingestKsTicket(q: Q, input: KsIngestInput, deps: { notify?: NotifyFn } = {}): Promise<{ ticket_id: string; number: number; created: boolean; appended: boolean }> {
  await q.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`ks_support:${input.source}:${input.external_id}`]);
  const companyId = input.licensee ? await resolveIngestCompany(q, input.licensee) : null;
  if (companyId && input.licensee?.support_level) {
    await q.query(`UPDATE companies SET ks_support_level = $2, updated_at = now() WHERE id = $1::uuid AND ks_support_level IS DISTINCT FROM $2`, [companyId, input.licensee.support_level]);
  }
  const contactId = input.requester ? await resolveIngestContact(q, input.requester, companyId) : null;
  const msgExternal = input.message_id ?? `${input.external_id}:${input.at ?? "first"}`;
  const message = {
    kind: "customer" as const,
    channel: "in_app",
    body: input.message,
    externalId: msgExternal,
    authorName: input.requester?.name ?? input.requester?.email ?? null,
  };
  const existing = await q.query(
    `SELECT id::text AS id, number FROM ks_support_tickets WHERE external_source = $1 AND external_id = $2`,
    [input.source, input.external_id],
  );
  if (existing.rows[0]) {
    const id = String(existing.rows[0].id);
    const appended = await appendCustomerMessage(q, id, message, deps);
    return { ticket_id: id, number: Number(existing.rows[0].number), created: false, appended };
  }
  const created = await createTicket(q, {
    subject: input.subject ?? input.message.split(/\r?\n/)[0]!.slice(0, 120),
    channel: "in_app",
    priority: input.priority ?? "normal",
    companyId,
    contactId,
    supportLevel: input.licensee?.support_level ?? null,
    fromEmail: input.requester?.email ?? null,
    fromPhone: e164(input.requester?.phone) ?? null,
    fromName: input.requester?.name ?? input.licensee?.name ?? null,
    externalSource: input.source,
    externalId: input.external_id,
    firstMessage: message,
    at: input.at ? new Date(input.at) : undefined,
  }, deps);
  return { ticket_id: created.id, number: created.number, created: created.created, appended: !created.created };
}

// ---------------------------------------------------------------------------------------------------------------
// Staff changes
// ---------------------------------------------------------------------------------------------------------------
export type TicketPatch = {
  status?: KsTicketStatus;
  priority?: KsTicketPriority;
  assignee_user_id?: string | null;
  subject?: string;
  contact_id?: string | null;
  company_id?: string | null;
};

export function parseTicketPatch(body: unknown): { ok: true; value: TicketPatch } | { ok: false; errors: Record<string, string> } {
  const b = obj(body) ? body : {};
  const errors: Record<string, string> = {};
  const out: TicketPatch = {};
  if (b.status !== undefined) {
    if (isTicketStatus(b.status)) out.status = b.status;
    else errors.status = "must be new, open, waiting, resolved or closed";
  }
  if (b.priority !== undefined) {
    if (isTicketPriority(b.priority)) out.priority = b.priority;
    else errors.priority = "must be low, normal, high or urgent";
  }
  for (const key of ["assignee_user_id", "contact_id", "company_id"] as const) {
    if (b[key] === undefined) continue;
    if (b[key] === null || b[key] === "") out[key] = null;
    else if (isUuid(b[key])) out[key] = b[key] as string;
    else errors[key] = "must be an id or null";
  }
  if (b.subject !== undefined) {
    if (typeof b.subject !== "string" || !b.subject.trim() || b.subject.trim().length > 200) errors.subject = "must be 1 to 200 characters";
    else out.subject = b.subject.trim();
  }
  if (!Object.keys(out).length && !Object.keys(errors).length) errors.body = "nothing to change";
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: out };
}

/** Is this user someone a Keystone ticket can be assigned to (Admin, or staff with KS access)? */
export async function isKsStaff(q: Q, userId: string): Promise<boolean> {
  if (!isUuid(userId)) return false;
  const r = await q.query(`SELECT 1 FROM users u WHERE u.id = $1::uuid AND ${KS_STAFF_SQL}`, [userId]);
  return r.rows.length > 0;
}

export async function listKsStaff(q: Q): Promise<Array<{ id: string; name: string; email: string | null; role: string | null }>> {
  const { rows } = await q.query(
    `SELECT u.id::text AS id, NULLIF(TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), '') AS name, u.email, u.role
       FROM users u WHERE ${KS_STAFF_SQL}
      ORDER BY lower(coalesce(u.first_name, u.email, '')), u.id
      LIMIT 200`,
    [],
  );
  return rows.map((r: any) => ({ id: String(r.id), name: String(r.name ?? r.email ?? "Staff"), email: r.email ?? null, role: r.role ?? null }));
}

export async function updateTicket(
  q: Q,
  id: string,
  patch: TicketPatch,
  actor: { userId: string | null; name: string | null },
  deps: { notify?: NotifyFn } = {},
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const notify = deps.notify ?? notifyStaff;
  const cur = await q.query(
    `SELECT id::text AS id, number, subject, status, priority, assignee_user_id::text AS assignee_user_id,
            contact_id::text AS contact_id, company_id::text AS company_id
       FROM ks_support_tickets WHERE id = $1::uuid`,
    [id],
  );
  const t = cur.rows[0];
  if (!t) return { ok: false, error: "not_found", status: 404 };
  if (patch.assignee_user_id && !(await isKsStaff(q, patch.assignee_user_id))) return { ok: false, error: "assignee_not_keystone_staff", status: 400 };
  if (patch.contact_id) {
    const c = await q.query(`SELECT 1 FROM contacts WHERE id = $1::uuid AND silo = 'KS'`, [patch.contact_id]);
    if (!c.rows.length) return { ok: false, error: "contact_not_keystone", status: 400 };
  }
  if (patch.company_id) {
    const c = await q.query(`SELECT 1 FROM companies WHERE id = $1::uuid AND silo = 'KS'`, [patch.company_id]);
    if (!c.rows.length) return { ok: false, error: "company_not_keystone", status: 400 };
  }
  const sets: string[] = [];
  const params: unknown[] = [id];
  const set = (col: string, v: unknown, cast = "") => {
    params.push(v);
    sets.push(`${col} = $${params.length}${cast}`);
  };
  const notes: string[] = [];
  if (patch.status && patch.status !== t.status) {
    set("status", patch.status);
    if (patch.status === "resolved") sets.push("resolved_at = now()");
    if (patch.status === "closed") sets.push("closed_at = now()");
    if (patch.status !== "resolved" && patch.status !== "closed") sets.push("resolved_at = NULL", "closed_at = NULL");
    notes.push(`Status: ${KS_TICKET_STATUS_LABELS[t.status as KsTicketStatus] ?? t.status} -> ${KS_TICKET_STATUS_LABELS[patch.status]}`);
  }
  if (patch.priority && patch.priority !== t.priority) {
    set("priority", patch.priority);
    notes.push(`Priority: ${t.priority} -> ${patch.priority}`);
  }
  let newAssignee: string | null = null;
  if (patch.assignee_user_id !== undefined && patch.assignee_user_id !== t.assignee_user_id) {
    set("assignee_user_id", patch.assignee_user_id, "::uuid");
    if (patch.assignee_user_id && t.status === "new" && !patch.status) set("status", "open");
    newAssignee = patch.assignee_user_id;
    notes.push(patch.assignee_user_id ? "Assigned" : "Unassigned");
  }
  if (patch.subject && patch.subject !== t.subject) {
    set("subject", patch.subject);
    notes.push("Subject changed");
  }
  if (patch.contact_id !== undefined && patch.contact_id !== t.contact_id) {
    set("contact_id", patch.contact_id, "::uuid");
    notes.push(patch.contact_id ? "Contact linked" : "Contact removed");
  }
  if (patch.company_id !== undefined && patch.company_id !== t.company_id) {
    set("company_id", patch.company_id, "::uuid");
    notes.push(patch.company_id ? "Company linked" : "Company removed");
  }
  if (!sets.length) return { ok: true };
  sets.push("updated_at = now()");
  await q.query(`UPDATE ks_support_tickets SET ${sets.join(", ")} WHERE id = $1::uuid`, params);
  if (notes.length) {
    await addMessage(q, id, { kind: "system", body: `${notes.join("; ")}${actor.name ? ` (by ${actor.name})` : ""}`, authorUserId: actor.userId, authorName: actor.name });
  }
  if (patch.status === "resolved" && t.status !== "resolved") {
    const contactId = patch.contact_id !== undefined ? patch.contact_id : t.contact_id;
    const companyId = patch.company_id !== undefined ? patch.company_id : t.company_id;
    await timelineNote(q, `Keystone support ticket #${Number(t.number)} resolved: ${patch.subject ?? t.subject}`, { contactId, companyId: contactId ? null : companyId });
  }
  if (newAssignee && newAssignee !== actor.userId) {
    await notify({ userIds: [newAssignee], title: `Keystone ticket #${Number(t.number)} assigned to you`, body: String(patch.subject ?? t.subject), ticketId: id });
  }
  return { ok: true };
}

export async function addNote(q: Q, id: string, body: string, actor: { userId: string | null; name: string | null }): Promise<string | null> {
  const msgId = await addMessage(q, id, { kind: "note", body, channel: "internal", authorUserId: actor.userId, authorName: actor.name });
  await q.query(`UPDATE ks_support_tickets SET updated_at = now() WHERE id = $1::uuid`, [id]);
  return msgId;
}

// ---------------------------------------------------------------------------------------------------------------
// Replies (email through Microsoft Graph, SMS through Twilio) - the same senders BF uses.
// ---------------------------------------------------------------------------------------------------------------
export type ReplySenders = {
  email: (args: { to: string; subject: string; text: string }) => Promise<{ ok: true; from: string } | { ok: false; error: string }>;
  sms: (args: { to: string; text: string }) => Promise<{ ok: true; sid: string | null; from: string | null; status: string | null } | { ok: false; error: string }>;
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Where Keystone support email comes from: KS_SUPPORT_EMAIL, else the server's usual Graph send-as mailbox. */
export function ksSupportFromAddress(env: NodeJS.ProcessEnv = process.env): string {
  return String(env.KS_SUPPORT_EMAIL ?? "").trim() || String(env.MS_GRAPH_SEND_AS ?? "").trim();
}

/** The number Keystone support texts come from: KS_SMS_FROM, else the Keystone line, else the usual Twilio number. */
export function ksSmsFrom(env: NodeJS.ProcessEnv = process.env): string | null {
  return e164(env.KS_SMS_FROM) ?? e164(env.KS_VOICE_NUMBER)
    ?? (String(env.TWILIO_FROM_NUMBER ?? env.TWILIO_PHONE_NUMBER ?? env.TWILIO_FROM ?? env.TWILIO_PHONE ?? env.TWILIO_NUMBER ?? "").trim() || null);
}

export const defaultReplySenders: ReplySenders = {
  email: async ({ to, subject, text: bodyText }) => {
    const { sendViaGraph } = await import("../../services/email/graphSendService.js");
    const from = ksSupportFromAddress();
    if (!from) return { ok: false, error: "Set KS_SUPPORT_EMAIL (or MS_GRAPH_SEND_AS) on the server to send support email." };
    const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#111827">${escapeHtml(bodyText).replace(/\r?\n/g, "<br/>")}</div>`;
    const r = await sendViaGraph({ to, subject, bodyText, bodyHtml: html, sendAs: from });
    return r.ok ? { ok: true, from } : { ok: false, error: r.error };
  },
  sms: async ({ to, text: body }) => {
    const sid = String(process.env.TWILIO_ACCOUNT_SID ?? "").trim();
    const token = String(process.env.TWILIO_AUTH_TOKEN ?? "").trim();
    const from = ksSmsFrom();
    if (!sid || !token || !from) return { ok: false, error: "SMS is not configured on the server." };
    try {
      const { sharedTwilio } = await import("../../lib/sharedClients.js");
      const statusCallback = `${(process.env.PUBLIC_BASE_URL || "https://server.boreal.financial").replace(/\/+$/, "")}/api/r/status`;
      const msg: any = await sharedTwilio(sid, token).messages.create({ to, from, body, statusCallback });
      return { ok: true, sid: msg?.sid ?? null, from, status: msg?.status ?? null };
    } catch (err: any) {
      console.error("[ks-support] sms send failed", { code: err?.code, message: err?.message });
      return { ok: false, error: err?.message ? String(err.message) : "SMS could not be sent." };
    }
  },
};

export type ReplyInput = { channel: "email" | "sms"; body: string; status: KsTicketStatus };

export function parseReply(body: unknown): { ok: true; value: ReplyInput } | { ok: false; errors: Record<string, string> } {
  const b = obj(body) ? body : {};
  const errors: Record<string, string> = {};
  if (b.channel !== "email" && b.channel !== "sms") errors.channel = "must be email or sms";
  const text = typeof b.body === "string" ? b.body.trim() : "";
  if (!text) errors.body = "is required";
  else if (b.channel === "sms" && text.length > 1500) errors.body = "a text must be 1500 characters or fewer";
  else if (text.length > 20000) errors.body = "must be 20000 characters or fewer";
  const status = b.status === undefined || b.status === null || b.status === "" ? "waiting" : b.status;
  if (!isTicketStatus(status)) errors.status = "must be a ticket status";
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: { channel: b.channel as "email" | "sms", body: text, status: status as KsTicketStatus } };
}

/** Sends the reply to the ticket's contact (else the address / number the ticket came from) and records it. */
export async function replyToTicket(
  q: Q,
  id: string,
  input: ReplyInput,
  actor: { userId: string | null; name: string | null },
  senders: ReplySenders = defaultReplySenders,
): Promise<{ ok: true; to: string } | { ok: false; status: number; error: string; message?: string }> {
  const ticket = await getTicketRow(q, id);
  if (!ticket) return { ok: false, status: 404, error: "not_found" };
  const to = input.channel === "email"
    ? (ticket.contact_email || ticket.from_email || "").trim()
    : (e164(ticket.contact_phone) ?? e164(ticket.from_phone) ?? "");
  if (!to) {
    return { ok: false, status: 400, error: "no_recipient", message: input.channel === "email" ? "This ticket has no email address. Link a contact with an email first." : "This ticket has no phone number. Link a contact with a phone number first." };
  }
  let from: string | null = null;
  if (input.channel === "email") {
    const subject = `Re: [Keystone #${ticket.number}] ${ticket.subject}`;
    const sent = await senders.email({ to, subject, text: input.body });
    if (!sent.ok) return { ok: false, status: 502, error: "send_failed", message: sent.error };
    from = sent.from;
    try {
      await q.query(
        `INSERT INTO crm_email_log (from_address, to_addresses, subject, body_html, owner_id, contact_id, company_id, silo)
         VALUES ($1, $2::text[], $3, $4, $5::uuid, $6::uuid, $7::uuid, 'KS')`,
        [from, [to], subject, escapeHtml(input.body).replace(/\r?\n/g, "<br/>"), isUuid(actor.userId) ? actor.userId : null, ticket.contact_id, ticket.company_id],
      );
    } catch (err) {
      console.warn("[ks-support] email log failed", { ticketId: id, message: err instanceof Error ? err.message : String(err) });
    }
  } else {
    const sent = await senders.sms({ to, text: input.body });
    if (!sent.ok) return { ok: false, status: 502, error: "send_failed", message: sent.error };
    from = sent.from;
    try {
      await q.query(
        `INSERT INTO communications_messages (id, type, direction, status, body, phone_number, from_number, to_number, twilio_sid, contact_id, staff_name, silo, created_at)
         VALUES (gen_random_uuid(), 'sms', 'outbound', $1, $2, $3, $4, $3, $5, $6::uuid, $7, 'KS', now())`,
        [sent.status ?? "queued", input.body, to, sent.from, sent.sid, ticket.contact_id, actor.name],
      );
    } catch (err) {
      console.warn("[ks-support] sms log failed", { ticketId: id, message: err instanceof Error ? err.message : String(err) });
    }
  }
  await addMessage(q, id, { kind: "reply", channel: input.channel, body: input.body, authorUserId: actor.userId, authorName: actor.name });
  await q.query(
    `UPDATE ks_support_tickets
        SET first_response_at = coalesce(first_response_at, now()), last_message_at = now(), updated_at = now(),
            status = $2,
            resolved_at = CASE WHEN $2 = 'resolved' THEN coalesce(resolved_at, now()) ELSE NULL END,
            closed_at = CASE WHEN $2 = 'closed' THEN coalesce(closed_at, now()) ELSE NULL END
      WHERE id = $1::uuid`,
    [id, input.status],
  );
  return { ok: true, to };
}
