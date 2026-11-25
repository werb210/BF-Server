// BF_SERVER_CRM_FLOWS_v1 (2026-11-24) - runs the Boreal Financial and Keystone email flows (flowEngine.ts has the rules),
// the same way BI-Server runs Boreal Risk Management's. Every minute: stop people who replied, read new opens and clicks,
// ask the owner to call a real click, start today's new people, send what is due. Both slots run this worker, so a tick
// only works while it holds a database advisory lock.
import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../db.js";
import { isSendableAt } from "./sendWindow.js";
import {
  FLOW_WINDOW, dailyNewCap, flowJobId, htmlToText, isFlowKey, nextAfterSend, onClick, onOpen, withFooter,
  type Click, type FlowKey, type Track,
} from "./flowEngine.js";
import { loadFlowAttachments, sendFlowEmail, mailboxReplies, type FlowAttachment } from "./flowSend.js";
import { mergeFields } from "../services/sendgridService.js";

type Db = Pick<Pool, "query"> | Pick<PoolClient, "query">;
export type FlowDeps = {
  send: (m: { to: string; subject: string; html: string; text: string; fromName: string; fromEmail?: string | null; replyTo?: string | null; customArgs: Record<string, string>; attachments?: FlowAttachment[] }) => Promise<{ ok: boolean; error?: string }>;
  attachments?: (ids: unknown, silo: string) => Promise<FlowAttachment[]>;
  replies?: (mailbox: string, since: Date) => Promise<{ connected: boolean; replies: Array<{ from: string; at: string }> }>;
};
const liveDeps: FlowDeps = {
  send: (m) => sendFlowEmail(m),
  attachments: (ids, silo) => loadFlowAttachments(ids, silo),
  replies: (mailbox, since) => mailboxReplies(mailbox, since),
};

const LOCK_KEY = 772_031_952; // BI-Server's flow worker uses ...951 on its own database
const MAX_FAILURES = 3;
const SENDS_PER_TICK = 60;
const LISTEN_DAYS = 30;
const REPLY_POLL_MS = 5 * 60_000;
let lastReplyPoll = 0;

const DEFAULT_FROM: Record<string, string> = { BF: "Boreal Financial", KS: "Keystone", SLF: "Site Level Financial" };
const fromNameFor = (silo: string, name: unknown) => String(name ?? "").trim() || DEFAULT_FROM[String(silo).toUpperCase()] || "Boreal Financial";

async function timeline(db: Db, contactId: string, type: string, payload: Record<string, unknown>): Promise<void> {
  await db.query(`INSERT INTO crm_timeline_events (contact_id, event_type, payload) VALUES ($1, $2, $3)`, [contactId, type, JSON.stringify(payload)])
    .catch((err: unknown) => console.warn("[flows] timeline write failed", { message: (err as Error)?.message }));
}

/** A reply to the flow's reply-to mailbox stops that person's flow. */
export async function stopRepliedMembers(db: Db, deps: FlowDeps, now: Date): Promise<number> {
  if (!deps.replies) return 0;
  let stopped = 0;
  const boxes = await db.query(
    `SELECT lower(btrim(f.reply_to)) AS mailbox, min(m.first_sent_at) AS since
       FROM crm_flows f JOIN crm_flow_members m ON m.flow_id = f.id
      WHERE f.status = 'active' AND coalesce(btrim(f.reply_to), '') <> '' AND m.status IN ('active', 'done') AND m.first_sent_at IS NOT NULL
      GROUP BY 1`,
  );
  for (const b of boxes.rows) {
    const since = new Date(Math.max(new Date(b.since).getTime(), now.getTime() - 14 * 86_400_000));
    let res;
    try { res = await deps.replies(b.mailbox, since); }
    catch (err) { console.warn("[flows] replies read failed", { mailbox: b.mailbox, message: (err as Error)?.message }); continue; }
    for (const rep of res.replies) {
      const r = await db.query(
        `UPDATE crm_flow_members m SET status = 'stopped', stop_reason = 'replied', next_key = NULL, next_at = NULL, updated_at = now()
           FROM crm_flows f
          WHERE f.id = m.flow_id AND lower(btrim(f.reply_to)) = $1 AND m.email = $2 AND m.status IN ('active', 'done')
            AND m.first_sent_at IS NOT NULL AND m.first_sent_at < $3::timestamptz AND coalesce(m.stop_reason, '') <> 'replied'
          RETURNING m.contact_id, f.name`,
        [b.mailbox, rep.from, rep.at],
      );
      for (const row of r.rows) {
        stopped += 1;
        await timeline(db, row.contact_id, "flow_replied", { body: `Replied by email. The "${row.name}" emails have stopped for them.`, at: rep.at });
      }
    }
  }
  return stopped;
}

type MemberRow = { id: string; flow_id: string; contact_id: string; track: Track; sent_keys: string[]; last_sent_at: Date | null };

/** Opens and clicks that arrived since each person was last looked at. */
export async function ingestEvents(db: Db): Promise<{ opened: number; clicked: number }> {
  const r = await db.query(
    `SELECT m.id, m.flow_id, m.contact_id, m.track, m.sent_keys, m.last_sent_at, ev.event_type, ev.created_at AS ev_at, ev.url
       FROM crm_flow_events ev
       JOIN crm_flow_members m ON m.flow_id = ev.flow_id AND m.contact_id = ev.contact_id
      WHERE ev.event_type IN ('open', 'click') AND ev.created_at > m.events_seen_at AND m.track <> 'clicked'
        AND (m.status = 'active' OR (m.status = 'done' AND m.last_sent_at > now() - interval '${LISTEN_DAYS} days'))
      ORDER BY ev.created_at
      LIMIT 1000`,
  );
  const state = new Map<string, MemberRow>();
  const clicksBy = new Map<string, Click[]>();
  for (const row of r.rows) {
    if (row.event_type !== "click") continue;
    const list = clicksBy.get(row.id) ?? [];
    list.push({ at: new Date(row.ev_at), url: String(row.url ?? "") });
    clicksBy.set(row.id, list);
  }
  let opened = 0;
  let clicked = 0;
  for (const row of r.rows) {
    const m: MemberRow = state.get(row.id) ?? { ...row, sent_keys: row.sent_keys ?? [], last_sent_at: row.last_sent_at ? new Date(row.last_sent_at) : null };
    state.set(row.id, m);
    const at = new Date(row.ev_at);
    const cur = { track: m.track, sentKeys: m.sent_keys, lastSentAt: m.last_sent_at };
    const change = row.event_type === "click" ? onClick(cur, { at, url: String(row.url ?? "") }, clicksBy.get(row.id) ?? []) : onOpen(cur, at);
    if (!change) {
      await db.query(`UPDATE crm_flow_members SET events_seen_at = GREATEST(events_seen_at, $2) WHERE id = $1`, [m.id, at]);
      continue;
    }
    const isClick = change.track === "clicked";
    await db.query(
      `UPDATE crm_flow_members
          SET track = $2, events_seen_at = GREATEST(events_seen_at, $3), updated_at = now(),
              opened_at = COALESCE(opened_at, $3), clicked_at = CASE WHEN $4 THEN COALESCE(clicked_at, $3) ELSE clicked_at END,
              next_key = COALESCE($5, next_key), next_at = COALESCE($6, next_at), status = CASE WHEN $5::text IS NULL THEN status ELSE 'active' END
        WHERE id = $1`,
      [m.id, change.track, at, isClick, change.next?.key ?? null, change.next?.at ?? null],
    );
    m.track = change.track;
    if (isClick) clicked += 1; else opened += 1;
  }
  return { opened, clicked };
}

/** One call task per person who really clicked, for the flow's owner. */
export async function createCallTasks(db: Db): Promise<number> {
  const r = await db.query(
    `UPDATE crm_flow_members m SET task_created_at = now()
       FROM crm_flows f, contacts c
      WHERE m.flow_id = f.id AND c.id = m.contact_id AND m.track = 'clicked' AND m.task_created_at IS NULL AND m.failures < ${MAX_FAILURES}
      RETURNING m.id, m.contact_id, f.silo, f.name AS flow_name, f.owner_user_id, c.name, c.company_name, c.phone, c.owner_id`,
  );
  let made = 0;
  for (const row of r.rows) {
    const who = [row.name, row.company_name].filter(Boolean).join(", ");
    await timeline(db, row.contact_id, "flow_clicked", { body: `Clicked a link in the "${row.flow_name}" emails. Call them.`, flow_member_id: row.id });
    const assignee = row.owner_user_id ?? row.owner_id ?? null;
    if (!assignee) { console.warn("[flows] no owner for call task", { memberId: row.id }); continue; }
    try {
      await db.query(
        `INSERT INTO tasks (silo, title, body, type, priority, due_at, assignee_user_id, contact_id, source, source_ref_id)
         VALUES ($1, $2, $3, 'CALL', 'HIGH', now(), $4::uuid, $5::uuid, 'SEQUENCE', $6::uuid)`,
        [row.silo, `Call ${who || "a contact"} - clicked the ${row.flow_name} email`.slice(0, 200),
          `They clicked a link in the "${row.flow_name}" emails and have been sent the booking link.${row.phone ? ` Phone: ${row.phone}.` : ""}`,
          assignee, row.contact_id, row.id],
      );
      made += 1;
    } catch (err) {
      console.warn("[flows] call task failed", { memberId: row.id, message: (err as Error)?.message });
      await db.query(`UPDATE crm_flow_members SET task_created_at = NULL, failures = failures + 1 WHERE id = $1`, [row.id]);
    }
  }
  return made;
}

/** Start today's share of the people still waiting, per flow. */
export async function startNewPeople(db: Db, now: Date): Promise<number> {
  const flows = await db.query(`SELECT id, daily_new, started_at FROM crm_flows WHERE status = 'active'`);
  let started = 0;
  for (const f of flows.rows) {
    const cap = dailyNewCap(Number(f.daily_new), f.started_at ? new Date(f.started_at) : null, now);
    const used = await db.query(
      `SELECT count(*)::int AS n FROM crm_flow_members
        WHERE flow_id = $1 AND status <> 'queued'
          AND (COALESCE(first_sent_at, updated_at) AT TIME ZONE 'America/Regina')::date = ($2::timestamptz AT TIME ZONE 'America/Regina')::date
          AND (first_sent_at IS NOT NULL OR next_key = 'e1')`,
      [f.id, now],
    );
    const room = cap - Number(used.rows[0]?.n ?? 0);
    if (room <= 0) continue;
    const r = await db.query(
      `UPDATE crm_flow_members SET status = 'active', next_key = 'e1', next_at = $2, events_seen_at = $2, updated_at = $2
        WHERE id IN (SELECT id FROM crm_flow_members WHERE flow_id = $1 AND status = 'queued' ORDER BY created_at, id LIMIT $3)`,
      [f.id, now, room],
    );
    started += r.rowCount ?? 0;
  }
  return started;
}

/** BF_SERVER_UNIVERSAL_SUPPRESSION_v1 - one list for every business: an address that unsubscribed, bounced or complained
 *  anywhere (email_suppressions), or a contact opted out, is never emailed by a flow. */
export async function isSuppressed(db: Db, contactId: string, email: string): Promise<boolean> {
  const r = await db.query(
    `SELECT 1 WHERE EXISTS (SELECT 1 FROM email_suppressions WHERE lower(email) = lower($2))
        OR EXISTS (SELECT 1 FROM contacts WHERE id = $1::uuid AND marketing_opt_out = true)`,
    [contactId, email],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Send every email that is due, inside sending hours. */
export async function sendDue(db: Db, deps: FlowDeps, now: Date): Promise<{ sent: number; failed: number; stopped: number }> {
  const out = { sent: 0, failed: 0, stopped: 0 };
  if (!isSendableAt(now, FLOW_WINDOW)) return out;
  const due = await db.query(
    `SELECT m.id, m.flow_id, m.contact_id, m.track, m.next_key, m.failures,
            f.silo, f.name AS flow_name, f.emails, f.from_name, f.from_email, f.reply_to, f.link_url, f.booking_url,
            c.first_name, c.name AS full_name, c.company_name, c.email AS contact_email
       FROM crm_flow_members m
       JOIN crm_flows f ON f.id = m.flow_id AND f.status = 'active'
       LEFT JOIN contacts c ON c.id = m.contact_id
      WHERE m.status = 'active' AND m.next_key IS NOT NULL AND m.next_at <= $1
      ORDER BY m.next_at LIMIT ${SENDS_PER_TICK}`,
    [now],
  );
  const stop = async (id: string, reason: string) => {
    out.stopped += 1;
    await db.query(`UPDATE crm_flow_members SET status = 'stopped', stop_reason = $2, next_key = NULL, next_at = NULL, updated_at = now() WHERE id = $1`, [id, reason]);
  };
  for (const row of due.rows) {
    const key = row.next_key as string;
    const to = String(row.contact_email ?? "").trim();
    if (!to || !to.includes("@")) { await stop(row.id, "no_email"); continue; }
    if (await isSuppressed(db, row.contact_id, to)) { await stop(row.id, "unsubscribed_or_bounced"); continue; }
    const content = isFlowKey(key) ? (row.emails ?? {})[key] : null;
    if (!content?.subject || !content?.body) { await stop(row.id, "no_email_wording"); continue; }
    const full = String(row.full_name ?? "").trim();
    const merge = {
      first_name: String(row.first_name ?? "").trim() || full.split(/\s+/)[0] || "there",
      full_name: full, name: full, company: String(row.company_name ?? "").trim() || "your firm",
      link: String(row.link_url ?? ""), booking_link: String(row.booking_url ?? ""), email: to,
    };
    const fromName = fromNameFor(row.silo, row.from_name);
    const html = withFooter(mergeFields(String(content.body), merge), fromName, row.silo);
    let result: { ok: boolean; error?: string };
    try {
      const files = Array.isArray(content.attachments) && content.attachments.length && deps.attachments ? await deps.attachments(content.attachments, row.silo) : [];
      result = await deps.send({
        to, subject: mergeFields(String(content.subject), merge), html, text: htmlToText(html), fromName, fromEmail: row.from_email,
        replyTo: row.reply_to, customArgs: { job_id: flowJobId(row.flow_id, key as FlowKey), contact_id: String(row.contact_id) },
        ...(files.length ? { attachments: files } : {}),
      });
    } catch (err) {
      result = { ok: false, error: (err as Error)?.message };
    }
    if (!result.ok) {
      out.failed += 1;
      console.warn("[flows] send failed", { memberId: row.id, key, error: result.error });
      if (Number(row.failures) + 1 >= MAX_FAILURES) await stop(row.id, "send_failed");
      else await db.query(`UPDATE crm_flow_members SET failures = failures + 1, next_at = $2 WHERE id = $1`, [row.id, new Date(now.getTime() + 15 * 60_000)]);
      continue;
    }
    const next = nextAfterSend(key as FlowKey, row.track as Track, now);
    await db.query(
      `UPDATE crm_flow_members
          SET sent_keys = array_append(sent_keys, $2), last_sent_at = $3, first_sent_at = COALESCE(first_sent_at, $3), failures = 0,
              next_key = $4, next_at = $5, status = CASE WHEN $4::text IS NULL THEN 'done' ELSE 'active' END, updated_at = $3
        WHERE id = $1`,
      [row.id, key, now, next?.key ?? null, next?.at ?? null],
    );
    await timeline(db, row.contact_id, "flow_email_sent", { body: `${row.flow_name}: ${mergeFields(String(content.subject), merge)}`.slice(0, 1000), flow_id: row.flow_id, key });
    out.sent += 1;
  }
  return out;
}

export async function runFlowTick(db: Db, deps: FlowDeps, now = new Date(), pollReplies = true): Promise<Record<string, number>> {
  const replied = pollReplies ? await stopRepliedMembers(db, deps, now) : 0;
  const events = await ingestEvents(db);
  const tasks = await createCallTasks(db);
  const started = await startNewPeople(db, now);
  const sends = await sendDue(db, deps, now);
  return { replied, ...events, tasks, started, ...sends };
}

let timer: NodeJS.Timeout | null = null;
let busy = false;
async function tick(pool: Pool): Promise<void> {
  if (busy) return;
  busy = true;
  let client: PoolClient | null = null;
  try {
    const any = await pool.query(`SELECT 1 FROM crm_flows WHERE status = 'active' LIMIT 1`);
    if (!any.rowCount) return;
    client = await pool.connect();
    const lock = await client.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock($1) AS ok`, [LOCK_KEY]);
    if (!lock.rows[0]?.ok) return;
    try {
      const poll = Date.now() - lastReplyPoll >= REPLY_POLL_MS;
      if (poll) lastReplyPoll = Date.now();
      const result = await runFlowTick(client, liveDeps, new Date(), poll);
      if (Object.values(result).some((n) => n > 0)) console.info("[flows] tick", result);
    } finally {
      await client.query(`SELECT pg_advisory_unlock($1)`, [LOCK_KEY]).catch(() => undefined);
    }
  } catch (err) {
    console.error("[flows] tick failed", { message: (err as Error)?.message });
  } finally {
    client?.release();
    busy = false;
  }
}

export function startCrmFlowWorker(pool: Pool = defaultPool as unknown as Pool): void {
  if (timer) return;
  timer = setInterval(() => { void tick(pool); }, 60_000);
  timer.unref?.();
}
