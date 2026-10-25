// BF_SERVER_v854_KS_WIDGETS - the Keystone (KS) figures for the staff home-screen widget: GET /api/widget/summary
// with X-Silo: KS (or ?silo=KS). Keystone is a sales operation, not a lender pipeline, so its tiles mean:
//   pipelineCount       open Keystone deals: pipeline cards (KS companies, and KS contacts with no company - the same
//                       cards as GET /api/ks/crm/pipeline) that are not Paying or Lost
//   tasksDueToday       KS tasks due today or earlier, not completed, mine or unclaimed (as the BF figure)
//   tasksOverdue        KS tasks due before today (the Tasks page's "overdue" rule)
//   unreadMessages      unread inbound KS messages, skipping orphaned threads (as the BF figure)
//   payingLicensees     cards at Paying. This replaces Commission: the KS data carries plan and seats but no prices,
//                       so monthly recurring revenue cannot be worked out here.
//   demosNeedFollowUp   cards at Demo finished with no open KS task on the company, its contacts or the contact
//   openSupportTickets  Keystone support tickets still new / open / waiting, once the support table exists (v853);
//                       null until then
//   nextTask            the next open KS task (mine or unclaimed), overdue first
//   nextMeeting         the next KS booking (Microsoft Bookings) that has not failed
// Only staff allowed into the Keystone CRM (canUseKsCrm: Admins, or KS in their silo access) get these figures;
// anyone else gets an empty Keystone summary with the reason (200, so the app's background refresh keeps its session).
import type { Q } from "./ksCrm.js";
import { canUseKsCrm, KS_SILO } from "./ksCrm.js";

export const KS_WIDGET_KIND = "keystone";
export const KS_WIDGET_NO_ACCESS =
  "Keystone isn't turned on for your account. An Admin can add Keystone (KS) to your silo access in Settings > Users.";

// The support tickets table arrives with the v853 Keystone phone + support block. The name is kept in a constant so
// this file builds, and the query runs, only when that table is really there.
const SUPPORT_TABLE = "ks_support_tickets";

export type KsWidgetTask = { id: string; title: string; type: string | null; dueAt: string | null; contactName: string | null };
export type KsWidgetMeeting = { id: string; title: string; start: string };
export type KsWidgetSummary = {
  kind: typeof KS_WIDGET_KIND;
  silo: "KS";
  available: boolean;
  reason: string | null;
  pipelineCount: number;
  tasksDueToday: number;
  tasksOverdue: number;
  unreadMessages: number;
  payingLicensees: number;
  demosNeedFollowUp: number;
  openSupportTickets: number | null;
  commissionEarned: 0;
  currency: "CAD";
  nextTask: KsWidgetTask | null;
  nextMeeting: KsWidgetMeeting | null;
  asOf: string;
};

/** The silo the caller asked for (X-Silo header, then ?silo=), upper-cased; null when none. */
export function requestedWidgetSilo(req: { headers?: Record<string, unknown>; query?: Record<string, unknown> }): string | null {
  const header = req.headers?.["x-silo"];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  if (typeof fromHeader === "string" && fromHeader.trim()) return fromHeader.trim().toUpperCase();
  const q = req.query?.silo;
  if (typeof q === "string" && q.trim()) return q.trim().toUpperCase();
  return null;
}

/**
 * True when this widget call is for Keystone: asked for by name, or the caller's own silo is KS. Asked for by name
 * matters: the silo middleware quietly falls back to the caller's primary silo when KS is not in their access, and
 * the widget must never show BF numbers under the Keystone heading.
 */
export function isKeystoneWidgetCall(requested: string | null, resolvedSilo: string): boolean {
  return requested === KS_SILO || resolvedSilo === KS_SILO;
}

const num = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};
const iso = (value: unknown): string | null => {
  if (!value) return null;
  const d = new Date(value as string);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

function emptySummary(available: boolean, reason: string | null): KsWidgetSummary {
  return {
    kind: KS_WIDGET_KIND,
    silo: "KS",
    available,
    reason,
    pipelineCount: 0,
    tasksDueToday: 0,
    tasksOverdue: 0,
    unreadMessages: 0,
    payingLicensees: 0,
    demosNeedFollowUp: 0,
    openSupportTickets: null,
    commissionEarned: 0,
    currency: "CAD",
    nextTask: null,
    nextMeeting: null,
    asOf: new Date().toISOString(),
  };
}

/** The empty Keystone summary for someone without Keystone access. */
export function ksWidgetUnavailable(): KsWidgetSummary {
  return emptySummary(false, KS_WIDGET_NO_ACCESS);
}

async function openSupportTickets(q: Q): Promise<number | null> {
  try {
    const present = await q.query(`SELECT to_regclass('public.${SUPPORT_TABLE}') IS NOT NULL AS present`);
    if (!present.rows[0]?.present) return null;
    const r = await q.query(
      `SELECT COUNT(*)::text AS count FROM ${SUPPORT_TABLE} WHERE status IN ('new', 'open', 'waiting')`,
    );
    return num(r.rows[0]?.count);
  } catch (err) {
    // The tile is optional: a failure here is logged and the rest of the widget still renders.
    console.warn("[ks-widget] support ticket count failed", err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** Every Keystone figure for the widget, for this staff member. The caller has already checked access. */
export async function ksWidgetSummary(q: Q, userId: string | null): Promise<KsWidgetSummary> {
  const [cards, tasks, unread, next, booking, tickets] = await Promise.all([
    // The pipeline board's cards: KS companies, plus KS contacts with no company (not merged, not archived).
    q.query(
      `WITH ks_cards AS (
         SELECT coalesce(co.ks_stage, 'lead') AS stage, co.id AS company_id, NULL::uuid AS contact_id
           FROM companies co
          WHERE co.silo = 'KS'
         UNION ALL
         SELECT coalesce(c.ks_stage, 'lead'), NULL::uuid, c.id
           FROM contacts c
          WHERE c.silo = 'KS' AND c.company_id IS NULL AND c.merged_into_id IS NULL AND coalesce(c.status, '') <> 'archived'
       )
       SELECT COUNT(*) FILTER (WHERE k.stage NOT IN ('paying', 'lost'))::text AS open_deals,
              COUNT(*) FILTER (WHERE k.stage = 'paying')::text AS paying,
              COUNT(*) FILTER (WHERE k.stage = 'demo_finished' AND NOT EXISTS (
                SELECT 1 FROM tasks t
                 WHERE t.silo = 'KS' AND t.deleted_at IS NULL AND t.status <> 'COMPLETED'
                   AND (t.company_id = k.company_id
                        OR t.contact_id = k.contact_id
                        OR (k.company_id IS NOT NULL AND t.contact_id IN (
                              SELECT kc.id FROM contacts kc WHERE kc.company_id = k.company_id AND kc.silo = 'KS')))
              ))::text AS demos_no_follow_up
         FROM ks_cards k`,
    ),

    // Due today (or earlier) and overdue, mine or unclaimed - the same rules as the BF tile and the Tasks page.
    q.query(
      `SELECT COUNT(*) FILTER (WHERE t.due_at::date <= now()::date)::text AS due,
              COUNT(*) FILTER (WHERE t.due_at < now() AND t.due_at::date < now()::date)::text AS overdue
         FROM tasks t
        WHERE t.silo = 'KS'
          AND t.deleted_at IS NULL
          AND t.status <> 'COMPLETED'
          AND (t.assignee_user_id = $1 OR t.assignee_user_id IS NULL)`,
      [userId],
    ),

    q.query(
      `SELECT COUNT(*)::text AS count FROM communications_messages m
        WHERE m.silo = 'KS'
          AND m.read_at IS NULL
          AND m.direction = 'inbound'
          AND m.contact_id IS NOT NULL`,
    ),

    q.query(
      `SELECT t.id::text AS id, t.title, t.type, t.due_at,
              coalesce(nullif(trim(c.name), ''), co.name) AS contact_name
         FROM tasks t
         LEFT JOIN contacts c ON c.id = t.contact_id
         LEFT JOIN companies co ON co.id = t.company_id
        WHERE t.silo = 'KS'
          AND t.deleted_at IS NULL
          AND t.status <> 'COMPLETED'
          AND t.due_at IS NOT NULL
          AND (t.assignee_user_id = $1 OR t.assignee_user_id IS NULL)
        ORDER BY t.due_at ASC
        LIMIT 1`,
      [userId],
    ),

    q.query(
      `SELECT b.id::text AS id, coalesce(nullif(trim(b.subject), ''), nullif(trim(b.service_name), ''), b.customer_name, 'Keystone booking') AS title,
              b.scheduled_at
         FROM booking_events b
        WHERE b.silo = 'KS'
          AND b.scheduled_at >= now()
          AND b.status <> 'failed'
        ORDER BY b.scheduled_at ASC
        LIMIT 1`,
    ),

    openSupportTickets(q),
  ]);

  const out = emptySummary(true, null);
  const c = cards.rows[0] ?? {};
  out.pipelineCount = num(c.open_deals);
  out.payingLicensees = num(c.paying);
  out.demosNeedFollowUp = num(c.demos_no_follow_up);
  out.tasksDueToday = num(tasks.rows[0]?.due);
  out.tasksOverdue = num(tasks.rows[0]?.overdue);
  out.unreadMessages = num(unread.rows[0]?.count);
  out.openSupportTickets = tickets;
  const t = next.rows[0];
  if (t) {
    out.nextTask = {
      id: String(t.id),
      title: String(t.title ?? "Task"),
      type: t.type ?? null,
      dueAt: iso(t.due_at),
      contactName: t.contact_name ?? null,
    };
  }
  const b = booking.rows[0];
  const start = b ? iso(b.scheduled_at) : null;
  if (b && start) out.nextMeeting = { id: String(b.id), title: String(b.title ?? "Keystone booking"), start };
  return out;
}

/** Access first, then the figures. */
export async function ksWidgetFor(q: Q, user: unknown, userId: string | null): Promise<KsWidgetSummary> {
  if (!canUseKsCrm(user as { role?: unknown; silos?: unknown; silo?: unknown } | null)) return ksWidgetUnavailable();
  return ksWidgetSummary(q, userId);
}
