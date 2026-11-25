// BF_SERVER_CRM_FLOWS_v1 (2026-11-24) - runs the Boreal Financial and Keystone email flows (flowEngine.ts has the rules),
// the same way BI-Server runs Boreal Risk Management's. Every minute: stop people who replied, read new opens and clicks,
// ask the owner to call a real click, start today's new people, send what is due. Both slots run this worker, so a tick
// only works while it holds a database advisory lock.
import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../db.js";
import { isSendableAt } from "./sendWindow.js";
import {
  FLOW_WINDOW, dailyNewCap, endsFirstRoundUnopened, secondAddressStartAt, flowJobId, htmlToText, isFlowKey, nextAfterSend, onClick, onOpen, withFooter,
  type Click, type FlowKey, type Track,
} from "./flowEngine.js";
import { loadFlowAttachments, sendFlowEmail, mailboxReplies, type FlowAttachment, type MailboxReply } from "./flowSend.js";
import { mergeFields } from "../services/sendgridService.js";
import { logError } from "../observability/logger.js";

type Db = Pick<Pool, "query"> | Pick<PoolClient, "query">;
export type FlowDeps = {
  send: (m: { to: string; subject: string; html: string; text: string; fromName: string; fromEmail?: string | null; replyTo?: string | null; customArgs: Record<string, string>; attachments?: FlowAttachment[] }) => Promise<{ ok: boolean; error?: string }>;
  attachments?: (ids: unknown, silo: string) => Promise<FlowAttachment[]>;
  replies?: (mailbox: string, since: Date) => Promise<{ connected: boolean; replies: MailboxReply[] }>;
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
  // BF_SERVER_REPLIES_FROM_MAILBOX_v1 - out-of-office replies go back to the sending address, not the reply-to, so each flow's
  // sending address is read too (the flow's own from address, else the default sender).
  const fallbackFrom = String(process.env.SENDGRID_FROM ?? "").trim().toLowerCase();
  const boxes = await db.query(
    `SELECT mailbox, min(since) AS since FROM (
       SELECT lower(btrim(f.reply_to)) AS mailbox, m.first_sent_at AS since
         FROM crm_flows f JOIN crm_flow_members m ON m.flow_id = f.id
        WHERE f.status = 'active' AND coalesce(btrim(f.reply_to), '') <> '' AND m.status IN ('active', 'done') AND m.first_sent_at IS NOT NULL
       UNION ALL
       SELECT lower(btrim(coalesce(nullif(btrim(f.from_email), ''), $1))), m.first_sent_at
         FROM crm_flows f JOIN crm_flow_members m ON m.flow_id = f.id
        WHERE f.status = 'active' AND m.status IN ('active', 'done') AND m.first_sent_at IS NOT NULL
     ) x WHERE coalesce(mailbox, '') <> '' GROUP BY 1`,
    [fallbackFrom],
  );
  for (const b of boxes.rows) {
    const since = new Date(Math.max(new Date(b.since).getTime(), now.getTime() - 14 * 86_400_000));
    let res;
    try { res = await deps.replies(b.mailbox, since); }
    catch (err) { console.warn("[flows] replies read failed", { mailbox: b.mailbox, message: (err as Error)?.message }); continue; }
    for (const rep of res.replies) {
      if (rep.auto_reply) await addCrmReferrals(db, rep);
      // An out-of-office is not an answer: the person is only away, so their emails carry on. A real reply, or an automatic
      // one saying they have left, stops them.
      if (rep.auto_reply && !rep.left) continue;
      const r = await db.query(
        `UPDATE crm_flow_members m SET status = 'stopped', stop_reason = 'replied', next_key = NULL, next_at = NULL, updated_at = now()
           FROM crm_flows f
          WHERE f.id = m.flow_id AND $1 IN (lower(btrim(coalesce(f.reply_to, ''))), lower(btrim(coalesce(nullif(btrim(f.from_email), ''), $4))))
            AND m.email = $2 AND m.status IN ('active', 'done')
            AND m.first_sent_at IS NOT NULL AND m.first_sent_at < $3::timestamptz AND coalesce(m.stop_reason, '') <> 'replied'
          RETURNING m.contact_id, f.name`,
        [b.mailbox, rep.from, rep.at, fallbackFrom],
      );
      for (const row of r.rows) {
        stopped += 1;
        await timeline(db, row.contact_id, "flow_replied", { body: `Replied by email. The "${row.name}" emails have stopped for them.`, at: rep.at });
      }
    }
  }
  return stopped;
}

/** BF_SERVER_REPLIES_FROM_MAILBOX_v1 - the colleagues an auto-reply names become contacts in the same CRM, at the same
 *  company, with the same tags, so they join the same flow on its next hourly pass. A colleague already on file under another
 *  address gets this one as their second address. Records only - nobody is emailed from here. */
export async function addCrmReferrals(db: Db, rep: MailboxReply): Promise<number> {
  const src = (await db.query(
    `SELECT c.id, c.silo, c.company_id, c.company_name, c.tags, c.address_country, c.name
       FROM contacts c JOIN crm_flow_members m ON m.contact_id = c.id
      WHERE lower(m.email) = $1 AND c.merged_into_id IS NULL ORDER BY m.created_at LIMIT 1`, [rep.from])).rows[0];
  if (!src) return 0;
  let added = 0;
  for (const ref of (rep.referrals ?? []).slice(0, 5)) {
    const email = String(ref.email ?? "").trim().toLowerCase();
    if (!email) continue;
    const exists = await db.query(
      `SELECT 1 FROM contacts WHERE silo = $1 AND merged_into_id IS NULL AND (lower(btrim(email)) = $2 OR lower(btrim(coalesce(secondary_email, ''))) = $2) LIMIT 1`,
      [src.silo, email]);
    if (exists.rowCount) continue;
    if (ref.name) {
      const same = await db.query(
        `UPDATE contacts SET secondary_email = $3, updated_at = now()
          WHERE id = (SELECT id FROM contacts WHERE silo = $1 AND merged_into_id IS NULL AND lower(btrim(coalesce(company_name, ''))) = lower(btrim($4))
                       AND lower(btrim(name)) = lower(btrim($2)) ORDER BY created_at LIMIT 1)
            AND coalesce(btrim(secondary_email), '') = '' RETURNING id`,
        [src.silo, ref.name, email, src.company_name ?? ""]);
      if (same.rowCount) continue;
    }
    const name = ref.name || email.split("@")[0]!.replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    const [first, ...rest] = name.split(/\s+/);
    const tags = Array.from(new Set([...(src.tags ?? []), "referred by auto-reply"]));
    const ins = await db.query(
      `INSERT INTO contacts (id, name, first_name, last_name, email, company_id, company_name, address_country, tags, silo, role, status)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::uuid, $6, $7, $8::text[], $9, 'other', 'prospect') RETURNING id`,
      [name, first || null, rest.join(" ") || null, email, src.company_id, src.company_name, src.address_country, tags, src.silo]);
    added += ins.rowCount ?? 0;
  }
  const stillActive = rep.left && !added ? (await db.query(`SELECT 1 FROM crm_flow_members WHERE lower(email) = $1 AND status IN ('active', 'queued') LIMIT 1`, [rep.from])).rowCount : 0;
  if (added || stillActive) { // a "has left" note once, while their flow is still running
    await timeline(db, src.id, "flow_auto_reply", { body: rep.left
      ? `Automatic reply says they have left${added ? `; added ${added} colleague(s) it named` : ""}.`
      : `Automatic reply named ${added} colleague(s); they were added as contacts.`, referrals: rep.referrals ?? [] });
  }
  return added;
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
export async function isSuppressed(db: Db, contactId: string, email: string, silo = "BF"): Promise<boolean> {
  // BF_SERVER_BRAND_UNSUBSCRIBES_v1 - an unsubscribe from another brand does not stop this flow; bounces and spam do.
  const r = await db.query(
    `SELECT 1 WHERE EXISTS (SELECT 1 FROM email_suppressions WHERE lower(email) = lower($2) AND (brands IS NULL OR $3 = ANY (brands)))
        OR EXISTS (SELECT 1 FROM contacts WHERE id = $1::uuid AND marketing_opt_out = true)`,
    [contactId, email, String(silo ?? "BF").toUpperCase()],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Send every email that is due, inside sending hours. */
export async function sendDue(db: Db, deps: FlowDeps, now: Date): Promise<{ sent: number; failed: number; stopped: number }> {
  const out = { sent: 0, failed: 0, stopped: 0 };
  if (!isSendableAt(now, FLOW_WINDOW)) return out;
  const due = await db.query(
    `SELECT m.id, m.flow_id, m.contact_id, m.track, m.next_key, m.failures, m.round, m.email AS member_email,
            f.silo, f.name AS flow_name, f.emails, f.from_name, f.from_email, f.reply_to, f.link_url, f.booking_url,
            c.first_name, c.name AS full_name, c.company_name, c.email AS contact_email, c.secondary_email
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
    // BF_SERVER_FLOW_SECOND_ADDRESS_v1 - the second round goes to the address it was started on.
    const round = Number(row.round ?? 1);
    const to = String((round >= 2 ? row.member_email : row.contact_email) ?? "").trim();
    if (!to || !to.includes("@")) { await stop(row.id, "no_email"); continue; }
    if (await isSuppressed(db, row.contact_id, to, row.silo)) { await stop(row.id, "unsubscribed_or_bounced"); continue; }
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
    if (!next && endsFirstRoundUnopened(key as FlowKey, row.track as Track, round)) await startSecondRound(db, row, to, now);
  }
  return out;
}

/** BF_SERVER_FLOW_SECOND_ADDRESS_v1 - four weeks with no open on the first address: if the contact has a different second
 *  address (not already in this flow), the flow starts again at "e1" on it, a week after the last email. Unsubscribes and
 *  bounces are still checked at each send. */
export async function startSecondRound(db: Db, row: { id: string; flow_id: string; contact_id: string; flow_name?: string; secondary_email?: string | null }, firstAddress: string, now: Date): Promise<boolean> {
  const second = String(row.secondary_email ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(second) || second === firstAddress.trim().toLowerCase()) return false;
  const taken = await db.query(`SELECT 1 FROM crm_flow_members WHERE flow_id = $1 AND lower(email) = $2 AND id <> $3 LIMIT 1`, [row.flow_id, second, row.id]);
  if (taken.rowCount) return false;
  const at = secondAddressStartAt(now);
  await db.query(
    `UPDATE crm_flow_members
        SET round = 2, email = $2, prior_keys = prior_keys || sent_keys, sent_keys = ARRAY[]::text[], track = 'none',
            next_key = 'e1', next_at = $3, status = 'active', updated_at = $4
      WHERE id = $1 AND round < 2`,
    [row.id, second, at, now],
  );
  await timeline(db, row.contact_id, "flow_second_address", { body: `No opens on ${firstAddress} after four weeks. The "${row.flow_name ?? "email"}" flow starts again at ${second}.`, flow_id: row.flow_id });
  return true;
}

let lastAudienceAdd = 0;
/** Every running flow picks up the people who match it and are not in it yet. */
export async function addRunningAudiences(db: Db): Promise<number> {
  const { audienceSql } = await import("./flowRoutes.js");
  const flows = await db.query(`SELECT id::text AS id, silo, audience_tags, market FROM crm_flows WHERE status = 'active'`);
  let added = 0;
  for (const f of flows.rows as Array<{ id: string; silo: string; audience_tags: string[] | null; market: string }>) {
    const r = await db.query(
      `INSERT INTO crm_flow_members (flow_id, contact_id, email)
       SELECT DISTINCT ON (lower(btrim(c.email))) $3::uuid, c.id, lower(btrim(c.email)) ${audienceSql(f.market)}
          AND NOT EXISTS (SELECT 1 FROM crm_flow_members m WHERE m.flow_id = $3 AND lower(m.email) = lower(btrim(c.email)))
        ORDER BY lower(btrim(c.email)), c.created_at
       ON CONFLICT (flow_id, contact_id) DO NOTHING`,
      [f.silo, (f.audience_tags ?? []).map((t) => String(t).toLowerCase().trim()), f.id],
    );
    added += r.rowCount ?? 0;
  }
  return added;
}

export async function runFlowTick(db: Db, deps: FlowDeps, now = new Date(), pollReplies = true): Promise<Record<string, number>> {
  const replied = pollReplies ? await stopRepliedMembers(db, deps, now) : 0;
  const events = await ingestEvents(db);
  const tasks = await createCallTasks(db);
  // BF_SERVER_CRM_FLOWS_AUTO_ADD_v1 - new people who match a running flow join it by themselves, once an hour.
  let joined = 0;
  if (pollReplies && now.getTime() - lastAudienceAdd >= 60 * 60_000) { lastAudienceAdd = now.getTime(); joined = await addRunningAudiences(db); }
  const started = await startNewPeople(db, now);
  const sends = await sendDue(db, deps, now);
  return { replied, ...events, tasks, joined, started, ...sends };
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
      await client.query(`SELECT pg_advisory_unlock($1)`, [LOCK_KEY]).catch((err) => { logError("crm_flow_unlock_failed", { message: err?.message }); });
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
