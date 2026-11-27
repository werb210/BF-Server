// BF_SERVER_ENGAGEMENT_v1 (2026-11-27) - marketing follow-through for the BF-Server CRMs (Keystone today), the same
// engine BI-Server runs for PGI. Every contact a silo's email flows reach gets one crm_engagement row that climbs:
//   sent -> opened -> clicked -> replied -> booked -> met -> signed_up      (or lost: unsubscribed / not interested)
// Sends, opens, clicks and replies come from crm_flow_members; bookings from Microsoft Bookings and meetings; meetings
// held and "followed up" from staff; sign-ups from the Keystone trial and customer tags. Replies, bookings and clicks
// open a follow-up with an owner (the silo's follow-up people in turn, else the flow's owner); replies and bookings
// also make a task.
import type { Pool } from "pg";
import { classifyReply, closesFollowUp, replyBody, type ReplyKind } from "./classifyReply.js";
import { ALBERTA_TZ } from "../lib/albertaTime.js";

type Db = Pick<Pool, "query">;

export const STAGES = ["sent", "opened", "clicked", "replied", "booked", "met", "signed_up"] as const;
export type Stage = (typeof STAGES)[number] | "lost";
const LABELS: Record<string, Record<Stage, string>> = {
  KS: { sent: "Sent", opened: "Opened", clicked: "Clicked", replied: "Replied", booked: "Demo booked", met: "Demo held", signed_up: "Trial / customer", lost: "Not interested" },
  DEFAULT: { sent: "Sent", opened: "Opened", clicked: "Clicked", replied: "Replied", booked: "Booked", met: "Call held", signed_up: "Signed up", lost: "Not interested" },
};
export const stageLabels = (silo: string) => LABELS[String(silo).toUpperCase()] ?? LABELS.DEFAULT!;
const DUE_HOURS = { replied: 24, booked: 24, clicked: 48 };

export const STAGE_SQL = `CASE WHEN e.lost_at IS NOT NULL THEN 'lost' WHEN e.signed_up_at IS NOT NULL THEN 'signed_up'
  WHEN e.met_at IS NOT NULL THEN 'met' WHEN e.booked_at IS NOT NULL THEN 'booked' WHEN e.replied_at IS NOT NULL THEN 'replied'
  WHEN e.clicked_at IS NOT NULL THEN 'clicked' WHEN e.opened_at IS NOT NULL THEN 'opened' ELSE 'sent' END`;
const STAGE_AT_SQL = `CASE WHEN e.lost_at IS NOT NULL THEN e.lost_at WHEN e.signed_up_at IS NOT NULL THEN e.signed_up_at
  WHEN e.met_at IS NOT NULL THEN e.met_at WHEN e.booked_at IS NOT NULL THEN e.booked_at WHEN e.replied_at IS NOT NULL THEN e.replied_at
  WHEN e.clicked_at IS NOT NULL THEN e.clicked_at WHEN e.opened_at IS NOT NULL THEN e.opened_at ELSE e.sent_at END`;

export type Follower = { id: string; name: string };
export async function getSettings(db: Db, silo: string): Promise<{ followers: Follower[]; digest: boolean }> {
  const r = await db.query(`SELECT value FROM crm_engagement_settings WHERE silo = $1 AND key = 'follow_up'`, [silo]);
  const v = r.rows[0]?.value ?? {};
  const followers = Array.isArray(v.followers)
    ? v.followers.filter((f: any) => f && f.id).map((f: any) => ({ id: String(f.id), name: String(f.name ?? f.id) }))
    : [];
  return { followers, digest: v.digest !== false };
}
export async function saveSettings(db: Db, silo: string, s: { followers?: Follower[]; digest?: boolean }): Promise<void> {
  const cur = await getSettings(db, silo);
  const next = { followers: s.followers ?? cur.followers, digest: s.digest ?? cur.digest };
  await db.query(
    `INSERT INTO crm_engagement_settings (silo, key, value, updated_at) VALUES ($1, 'follow_up', $2::jsonb, now())
     ON CONFLICT (silo, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [silo, JSON.stringify(next)],
  );
}

/** Brings every row up to date, for every silo with flows. Safe to run as often as you like. */
export async function syncEngagement(db: Db): Promise<Record<string, number>> {
  const flows = await db.query(
    `INSERT INTO crm_engagement AS e (contact_id, silo, flow_id, sent_at, opened_at, clicked_at, replied_at)
     SELECT m.contact_id, (array_agg(f.silo ORDER BY m.first_sent_at DESC))[1], (array_agg(m.flow_id ORDER BY m.first_sent_at DESC))[1],
            min(m.first_sent_at), min(m.opened_at), min(m.clicked_at), min(CASE WHEN m.stop_reason = 'replied' THEN m.updated_at END)
       FROM crm_flow_members m JOIN crm_flows f ON f.id = m.flow_id WHERE m.first_sent_at IS NOT NULL GROUP BY m.contact_id
     ON CONFLICT (contact_id) DO UPDATE SET
       silo = EXCLUDED.silo, flow_id = EXCLUDED.flow_id,
       sent_at = LEAST(e.sent_at, EXCLUDED.sent_at),
       opened_at = COALESCE(e.opened_at, EXCLUDED.opened_at),
       clicked_at = COALESCE(e.clicked_at, EXCLUDED.clicked_at),
       replied_at = COALESCE(e.replied_at, EXCLUDED.replied_at),
       updated_at = now()
     WHERE e.flow_id IS DISTINCT FROM EXCLUDED.flow_id OR e.sent_at IS DISTINCT FROM LEAST(e.sent_at, EXCLUDED.sent_at)
        OR (e.opened_at IS NULL AND EXCLUDED.opened_at IS NOT NULL) OR (e.clicked_at IS NULL AND EXCLUDED.clicked_at IS NOT NULL)
        OR (e.replied_at IS NULL AND EXCLUDED.replied_at IS NOT NULL)`,
  );
  // Keystone: a trial or customer tag after the first email is a sign-up.
  const signed = await db.query(
    `UPDATE crm_engagement e SET signed_up_at = coalesce(c.updated_at, now()), updated_at = now()
       FROM contacts c
      WHERE c.id = e.contact_id AND e.silo = 'KS' AND e.signed_up_at IS NULL AND e.sent_at IS NOT NULL
        AND coalesce(c.updated_at, now()) >= e.sent_at
        AND EXISTS (SELECT 1 FROM unnest(coalesce(c.tags, '{}'::text[])) t WHERE bf_norm_tag(t) IN ('ks_trial', 'ks_customer'))`,
  );
  const staged = await db.query(
    `UPDATE crm_engagement e SET stage = ${STAGE_SQL}, stage_at = ${STAGE_AT_SQL}, updated_at = now()
      WHERE e.stage IS DISTINCT FROM ${STAGE_SQL} OR e.stage_at IS DISTINCT FROM ${STAGE_AT_SQL}`,
  );
  const opened = await db.query(
    `UPDATE crm_engagement e SET follow_up_due_at = x.trig + make_interval(hours => CASE x.reason WHEN 'clicked' THEN ${DUE_HOURS.clicked} ELSE ${DUE_HOURS.replied} END),
            follow_up_reason = x.reason, updated_at = now()
       FROM (SELECT contact_id, GREATEST(replied_at, booked_at, clicked_at) AS trig,
                    CASE WHEN replied_at IS NOT NULL AND replied_at >= COALESCE(GREATEST(booked_at, clicked_at), replied_at) THEN 'replied'
                         WHEN booked_at IS NOT NULL AND booked_at >= COALESCE(clicked_at, booked_at) THEN 'booked' ELSE 'clicked' END AS reason
               FROM crm_engagement) x
      WHERE e.contact_id = x.contact_id AND x.trig IS NOT NULL AND e.lost_at IS NULL AND e.signed_up_at IS NULL AND e.met_at IS NULL
        AND e.follow_up_due_at IS NULL AND x.trig > COALESCE(e.followed_up_at, 'epoch'::timestamptz)`,
  );
  const cleared = await db.query(
    `UPDATE crm_engagement SET follow_up_due_at = NULL, updated_at = now()
      WHERE follow_up_due_at IS NOT NULL AND (lost_at IS NOT NULL OR signed_up_at IS NOT NULL)`,
  );
  const owners = await assignOwners(db);
  return { flows: flows.rowCount ?? 0, signed: signed.rowCount ?? 0, staged: staged.rowCount ?? 0, opened: opened.rowCount ?? 0, cleared: cleared.rowCount ?? 0, owners };
}

export async function assignOwners(db: Db): Promise<number> {
  const need = await db.query(
    `SELECT e.contact_id, e.silo, f.owner_user_id::text AS owner_user_id, f.owner_name FROM crm_engagement e LEFT JOIN crm_flows f ON f.id = e.flow_id
      WHERE e.follow_up_due_at IS NOT NULL AND e.owner_user_id IS NULL ORDER BY e.follow_up_due_at LIMIT 500`,
  );
  if (!need.rows.length) return 0;
  const bySilo = new Map<string, { followers: Follower[]; load: Map<string, number> }>();
  let n = 0;
  for (const row of need.rows) {
    let s = bySilo.get(row.silo);
    if (!s) {
      const { followers } = await getSettings(db, row.silo);
      const load = new Map<string, number>(followers.map((f) => [f.id, 0]));
      if (followers.length) {
        const r = await db.query(
          `SELECT owner_user_id, count(*)::int AS n FROM crm_engagement WHERE silo = $1 AND follow_up_due_at IS NOT NULL AND owner_user_id = ANY($2::text[]) GROUP BY 1`,
          [row.silo, followers.map((f) => f.id)],
        );
        for (const x of r.rows) load.set(String(x.owner_user_id), Number(x.n));
      }
      s = { followers, load };
      bySilo.set(row.silo, s);
    }
    let owner: Follower | null = null;
    if (s.followers.length) {
      owner = s.followers.reduce((best, f) => ((s!.load.get(f.id) ?? 0) < (s!.load.get(best.id) ?? 0) ? f : best), s.followers[0]!);
      s.load.set(owner.id, (s.load.get(owner.id) ?? 0) + 1);
    } else if (row.owner_user_id) owner = { id: String(row.owner_user_id), name: String(row.owner_name ?? "") };
    if (!owner) continue;
    await db.query(`UPDATE crm_engagement SET owner_user_id = $2, owner_name = $3, updated_at = now() WHERE contact_id = $1`, [row.contact_id, owner.id, owner.name || null]);
    n += 1;
  }
  return n;
}

/** Contacts in this silo's outreach (a row, or emailed by a flow) with this address. */
export async function reachedContactsByEmail(db: Db, email: string, silo?: string | null): Promise<Array<{ id: string; silo: string }>> {
  const e = String(email ?? "").trim().toLowerCase();
  if (!e.includes("@")) return [];
  const r = await db.query(
    `SELECT c.id::text AS id, c.silo FROM contacts c
      WHERE (lower(btrim(c.email)) = $1 OR lower(btrim(coalesce(c.secondary_email, ''))) = $1) AND c.merged_into_id IS NULL
        AND ($2::text IS NULL OR c.silo = $2)
        AND (EXISTS (SELECT 1 FROM crm_engagement e WHERE e.contact_id = c.id)
             OR EXISTS (SELECT 1 FROM crm_flow_members m WHERE m.contact_id = c.id AND m.first_sent_at IS NOT NULL))`,
    [e, silo ?? null],
  );
  return r.rows.map((x) => ({ id: String(x.id), silo: String(x.silo) }));
}

async function ensureRow(db: Db, contactId: string): Promise<void> {
  await db.query(
    `INSERT INTO crm_engagement (contact_id, silo) SELECT id, silo FROM contacts WHERE id = $1 ON CONFLICT (contact_id) DO NOTHING`, [contactId]);
}
async function logEvent(db: Db, contactId: string, kind: string, detail: Record<string, unknown>, actor: string | null, at: Date) {
  await db.query(`INSERT INTO crm_engagement_events (contact_id, kind, detail, actor_name, at) VALUES ($1, $2, $3::jsonb, $4, $5)`,
    [contactId, kind, JSON.stringify(detail), actor, at]);
}

export async function recordReply(db: Db, input: { contactId: string; at: Date; subject?: string | null; body?: string | null; mailbox?: string | null }): Promise<ReplyKind | null> {
  const ex = await db.query(
    `SELECT 1 FROM crm_engagement WHERE contact_id = $1 UNION ALL
     SELECT 1 FROM crm_flow_members WHERE contact_id = $1 AND first_sent_at IS NOT NULL LIMIT 1`, [input.contactId]);
  if (!ex.rowCount) return null;
  await ensureRow(db, input.contactId);
  const kind = classifyReply(input.subject, input.body);
  const snippet = replyBody(input.body, 600) || null;
  const closes = closesFollowUp(kind);
  await db.query(
    `UPDATE crm_engagement SET replied_at = COALESCE(replied_at, $2), reply_kind = $3, reply_subject = $4, reply_snippet = $5,
            reply_mailbox = $6, lost_at = CASE WHEN $7 THEN COALESCE(lost_at, $2) ELSE lost_at END,
            lost_reason = CASE WHEN $7 THEN $3 ELSE lost_reason END,
            follow_up_due_at = CASE WHEN $7 THEN NULL WHEN $2 > COALESCE(followed_up_at, 'epoch'::timestamptz) THEN $2 + interval '${DUE_HOURS.replied} hours' ELSE follow_up_due_at END,
            follow_up_reason = CASE WHEN $7 THEN follow_up_reason ELSE 'replied' END, updated_at = now()
      WHERE contact_id = $1`,
    [input.contactId, input.at, kind, input.subject ? String(input.subject).slice(0, 300) : null, snippet, input.mailbox ?? null, closes],
  );
  await logEvent(db, input.contactId, "replied", { kind, subject: input.subject ?? null, mailbox: input.mailbox ?? null }, null, input.at);
  return kind;
}

export type EventKind = "booked" | "met" | "no_show" | "followed_up" | "lost" | "reopen" | "signed_up" | "reply_kind";
export async function recordEvent(db: Db, input: { contactId: string; kind: EventKind; at?: Date; detail?: Record<string, any>; actor?: string | null }): Promise<boolean> {
  const at = input.at ?? new Date();
  const d = input.detail ?? {};
  if (input.kind === "booked") await ensureRow(db, input.contactId);
  const sets: Record<EventKind, string> = {
    booked: `booked_at = COALESCE(booked_at, $2), meeting_at = COALESCE($3::timestamptz, meeting_at), meeting_outcome = NULL`,
    met: `met_at = COALESCE(met_at, $2), meeting_outcome = 'held', follow_up_due_at = NULL, followed_up_at = $2`,
    no_show: `meeting_outcome = 'no_show', follow_up_due_at = $2, follow_up_reason = 'no_show'`,
    followed_up: `followed_up_at = $2, follow_up_due_at = NULL`,
    lost: `lost_at = COALESCE(lost_at, $2), lost_reason = COALESCE($3::text, 'staff'), follow_up_due_at = NULL`,
    reopen: `lost_at = NULL, lost_reason = NULL`,
    signed_up: `signed_up_at = COALESCE(signed_up_at, $2), follow_up_due_at = NULL`,
    reply_kind: `reply_kind = $3::text`,
  };
  const third = input.kind === "booked" ? (d.start ?? null) : input.kind === "lost" ? (d.reason ?? null) : input.kind === "reply_kind" ? (d.kind ?? null) : null;
  let sql = `UPDATE crm_engagement SET ${sets[input.kind]}, updated_at = now() WHERE contact_id = $1`;
  // Only send the parameters the statement uses: Postgres refuses one it cannot type.
  let params: unknown[] = [input.contactId, at, third];
  if (!sql.includes("$3")) params = params.slice(0, 2);
  if (!sql.includes("$2")) { if (sql.includes("$3")) { sql = sql.replace(/\$3/g, "$2"); params = [input.contactId, third]; } else params = [input.contactId]; }
  const r = await db.query(sql, params);
  if (!r.rowCount) return false;
  await logEvent(db, input.contactId, input.kind, d, input.actor ?? null, at);
  await db.query(`UPDATE crm_engagement e SET stage = ${STAGE_SQL}, stage_at = ${STAGE_AT_SQL} WHERE e.contact_id = $1`, [input.contactId]);
  return true;
}

export async function createFollowUpTasks(db: Db, task: (owner: string, silo: string, title: string, notes: string, contactId: string) => Promise<{ ok: boolean }>): Promise<number> {
  const r = await db.query(
    `SELECT e.contact_id, e.silo, e.owner_user_id, e.follow_up_reason, e.reply_kind, e.reply_snippet, e.meeting_at,
            GREATEST(e.replied_at, e.booked_at) AS trig, c.name, c.company_name, c.email, c.phone
       FROM crm_engagement e JOIN contacts c ON c.id = e.contact_id
      WHERE e.follow_up_due_at IS NOT NULL AND e.owner_user_id IS NOT NULL AND e.follow_up_reason IN ('replied', 'booked')
        AND e.task_for IS DISTINCT FROM GREATEST(e.replied_at, e.booked_at) LIMIT 100`,
  );
  let n = 0;
  for (const row of r.rows) {
    const who = [row.name, row.company_name].filter(Boolean).join(", ") || row.email || "a contact";
    const brand = row.silo === "KS" ? "Keystone" : "the";
    const title = row.follow_up_reason === "booked" ? `Prepare for the ${row.silo === "KS" ? "demo" : "call"} with ${who} (booked)` : `Reply to ${who} - answered the ${brand} email`;
    const notes = row.follow_up_reason === "booked"
      ? `${who} booked a time${row.meeting_at ? ` for ${new Date(row.meeting_at).toISOString().slice(0, 16).replace("T", " ")} UTC` : ""}. Open Marketing > Outreach.`
      : `${row.reply_kind ? `Reply type: ${row.reply_kind}. ` : ""}${row.reply_snippet ? `They wrote: "${String(row.reply_snippet).slice(0, 300)}". ` : ""}${row.phone ? `Phone: ${row.phone}. ` : ""}Open Marketing > Outreach.`;
    const res = await task(String(row.owner_user_id), String(row.silo), title, notes, String(row.contact_id)).catch(() => ({ ok: false }));
    if (!res.ok) continue;
    await db.query(`UPDATE crm_engagement SET task_for = $2 WHERE contact_id = $1`, [row.contact_id, row.trig]);
    n += 1;
  }
  return n;
}

const CARD_SQL = `e.contact_id, e.stage, e.stage_at, e.flow_id, f.name AS flow_name, e.reply_kind, e.reply_subject, e.reply_snippet,
  e.owner_user_id, e.owner_name, e.follow_up_due_at, e.follow_up_reason, e.meeting_at, e.meeting_outcome, e.sent_at, e.opened_at,
  e.clicked_at, e.replied_at, e.booked_at, e.met_at, e.signed_up_at, e.lost_at, c.name AS full_name, c.company_name AS organization_name,
  c.email, c.phone AS phone_e164`;
const FROM_SQL = `FROM crm_engagement e JOIN contacts c ON c.id = e.contact_id LEFT JOIN crm_flows f ON f.id = e.flow_id`;

type Filters = { silo: string; flowId?: string | null; owner?: string | null; q?: string | null };
function where(f: Filters, params: unknown[]): string {
  params.push(f.silo);
  const w: string[] = [`e.silo = $${params.length}`];
  if (f.flowId) { params.push(f.flowId); w.push(`e.flow_id = $${params.length}`); }
  if (f.owner) { params.push(f.owner); w.push(`e.owner_user_id = $${params.length}`); }
  if (f.q) { params.push(`%${f.q}%`); w.push(`(c.name ILIKE $${params.length} OR c.email ILIKE $${params.length} OR c.company_name ILIKE $${params.length})`); }
  return `WHERE ${w.join(" AND ")}`;
}

export async function board(db: Db, f: Filters, perStage = 50) {
  const p: unknown[] = [];
  const w = where(f, p);
  const counts = await db.query(`SELECT e.stage, count(*)::int AS n ${FROM_SQL} ${w} GROUP BY 1`, p);
  const p2 = [...p, perStage];
  const cards = await db.query(
    `SELECT * FROM (SELECT ${CARD_SQL}, row_number() OVER (PARTITION BY e.stage ORDER BY e.stage_at DESC NULLS LAST) AS rn ${FROM_SQL} ${w}) x
      WHERE rn <= $${p2.length} AND stage <> 'sent' ORDER BY stage_at DESC NULLS LAST`, p2);
  const n = new Map(counts.rows.map((r) => [r.stage, r.n]));
  const labels = stageLabels(f.silo);
  return [...STAGES, "lost" as const].map((s) => ({ key: s, label: labels[s], count: n.get(s) ?? 0, cards: cards.rows.filter((c) => c.stage === s) }));
}

export async function queue(db: Db, f: Filters) {
  const p: unknown[] = [];
  const w = where(f, p);
  const r = await db.query(`SELECT ${CARD_SQL} ${FROM_SQL} ${w} AND e.follow_up_due_at IS NOT NULL ORDER BY e.follow_up_due_at LIMIT 500`, p);
  const now = Date.now();
  return r.rows.map((x) => ({ ...x, overdue: new Date(x.follow_up_due_at).getTime() < now }));
}

export async function funnel(db: Db, silo: string, since?: Date | null) {
  const p: unknown[] = [silo];
  let w = `WHERE e.silo = $1`;
  if (since) { p.push(since); w += ` AND e.sent_at >= $2`; }
  const cols = `count(*)::int AS sent, count(e.opened_at)::int AS opened, count(e.clicked_at)::int AS clicked, count(e.replied_at)::int AS replied,
    count(e.booked_at)::int AS booked, count(e.met_at)::int AS met, count(e.signed_up_at)::int AS signed_up, count(e.lost_at)::int AS lost`;
  const total = await db.query(`SELECT ${cols} FROM crm_engagement e ${w}`, p);
  const byFlow = await db.query(`SELECT e.flow_id, coalesce(f.name, 'No flow') AS name, ${cols} FROM crm_engagement e LEFT JOIN crm_flows f ON f.id = e.flow_id ${w} GROUP BY 1, 2 ORDER BY sent DESC`, p);
  const kinds = await db.query(`SELECT coalesce(e.reply_kind, 'other') AS kind, count(*)::int AS n FROM crm_engagement e ${w} AND e.replied_at IS NOT NULL GROUP BY 1`, p);
  const leaks = await db.query(
    `SELECT count(*) FILTER (WHERE e.follow_up_due_at < now())::int AS overdue,
            count(*) FILTER (WHERE e.clicked_at IS NOT NULL AND e.followed_up_at IS NULL AND e.replied_at IS NULL AND e.lost_at IS NULL)::int AS clickers_not_called,
            count(*) FILTER (WHERE e.booked_at IS NOT NULL AND e.met_at IS NULL AND e.meeting_outcome IS NULL AND coalesce(e.meeting_at, e.booked_at) < now() - interval '1 day')::int AS meetings_no_outcome,
            round(avg(extract(epoch FROM (e.followed_up_at - e.replied_at)) / 3600) FILTER (WHERE e.followed_up_at > e.replied_at)::numeric, 1) AS avg_reply_hours
       FROM crm_engagement e ${w}`, p);
  return { total: total.rows[0], byFlow: byFlow.rows, replyKinds: kinds.rows, leaks: leaks.rows[0] };
}

export async function contactDetail(db: Db, silo: string, contactId: string) {
  const r = await db.query(`SELECT ${CARD_SQL} ${FROM_SQL} WHERE e.contact_id = $1 AND e.silo = $2`, [contactId, silo]);
  if (!r.rows[0]) return null;
  const ev = await db.query(`SELECT kind, detail, actor_name, at FROM crm_engagement_events WHERE contact_id = $1 ORDER BY at DESC LIMIT 100`, [contactId]);
  return { ...r.rows[0], events: ev.rows };
}

export async function digestFor(db: Db, ownerId: string) {
  const r = await db.query(
    `SELECT silo, count(*) FILTER (WHERE follow_up_due_at IS NOT NULL)::int AS open,
            count(*) FILTER (WHERE follow_up_due_at < now())::int AS overdue,
            count(*) FILTER (WHERE follow_up_due_at IS NOT NULL AND follow_up_reason = 'replied')::int AS replies,
            count(*) FILTER (WHERE follow_up_due_at IS NOT NULL AND follow_up_reason = 'booked')::int AS bookings,
            count(*) FILTER (WHERE follow_up_due_at IS NOT NULL AND follow_up_reason = 'clicked')::int AS clickers,
            count(*) FILTER (WHERE meeting_at::date = (now() AT TIME ZONE '${ALBERTA_TZ}')::date)::int AS meetings_today
       FROM crm_engagement WHERE owner_user_id = $1 GROUP BY silo`, [ownerId]);
  const top = await db.query(
    `SELECT e.silo, c.name AS full_name, c.company_name AS organization_name, e.follow_up_reason, e.reply_kind, e.follow_up_due_at
       FROM crm_engagement e JOIN contacts c ON c.id = e.contact_id
      WHERE e.owner_user_id = $1 AND e.follow_up_due_at IS NOT NULL ORDER BY e.follow_up_due_at LIMIT 10`, [ownerId]);
  return { bySilo: r.rows, top: top.rows };
}
export async function owners(db: Db): Promise<Follower[]> {
  const r = await db.query(`SELECT owner_user_id AS id, max(owner_name) AS name FROM crm_engagement WHERE owner_user_id IS NOT NULL AND follow_up_due_at IS NOT NULL GROUP BY 1`);
  return r.rows.map((x) => ({ id: String(x.id), name: String(x.name ?? "") }));
}
