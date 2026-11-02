// BF_SERVER_v871_CALL_QUEUES - call queues on the 866 main line and phone-menu options. Ported from KS-server #47
// (src/callQueues/queues.ts) without Keystone's plan gate; each queue belongs to a silo (BF or BI) for its records.
//
// Why <Enqueue>/<Queue> and not TaskRouter: the phone menu, direct lines and group ringing are plain TwiML with
// <Dial><Client>, presence lives in staff_presence and call hours in BF-Server. TaskRouter would need a Workspace,
// Workers kept in step with that presence, Activities, TaskQueues, a Workflow and its assignment callback.
// <Enqueue> needs nothing set up in Twilio (a queue exists once a caller is put in it), and BF-Server keeps choosing
// who rings with the same presence and call-hours rules every other inbound call uses.
//
// The flow:
//   1. A menu option (or the main line) puts the caller in the queue: <Enqueue waitUrl=/wait action=/left>.
//   2. /wait plays the greeting once, then "you are caller number N", the hold message and hold music, and it is
//      re-requested after each round. Each round (and a 15-second sweep) runs the dispatcher.
//   3. The dispatcher (one at a time, under an advisory lock) takes the oldest waiting caller and offers it to the
//      queue member who has been free the longest: available for queue calls, signed in to the app, not busy or on a
//      call, inside their call hours, not already offered a call, and not one who missed this caller already. The
//      offer is a REST call to the person's app; when they answer, /bridge dials <Queue> and they are connected.
//   4. An unanswered offer (no-answer, busy, declined) goes to the next person; after everyone was tried the round
//      starts again. A person who misses an offer is skipped for a minute.
//   5. At the queue's longest wait the caller leaves the queue (<Leave/>, or the sweep dequeues them) and gets the
//      overflow: voicemail, a callback request, or the choice ("press 1 for a callback, or stay on the line to leave
//      a message"). Hang-ups while waiting are "abandoned".
import type { Pool, PoolClient } from "pg";
import { getCallerId, getPublicBaseUrl, getTwilioClient } from "../voice/twilioClient.js";
import { ringableStaffSql } from "../modules/presence/presenceService.js";
import { identitiesOutsideHours } from "../voice/callHours.js";

export type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

export const OVERFLOWS = ["voicemail", "callback", "ask"] as const;
export type Overflow = (typeof OVERFLOWS)[number];
export const DEFAULT_HOLD_MUSIC = "http://com.twilio.music.classical.s3.amazonaws.com/BusyStrings.mp3";
export const WEBHOOK_BASE = "/api/webhooks/twilio/queue";
export const MISSED_COOLDOWN_SECONDS = 60;
export const LIVE_STATUSES = ["waiting", "offered", "connected"] as const;
export const twilioQueueName = (queueId: string) => `bf-q-${queueId}`;

export type QueueSettings = {
  id: string; name: string; greeting: string; hold_message: string; hold_audio_id: string | null; announce_position: boolean;
  max_wait_seconds: number; ring_seconds: number; overflow: Overflow; overflow_user_id: string | null; archived_at: string | null; member_ids: string[]; silo: string;
};
export const QUEUE_SILOS = ["BF", "BI"] as const;

const str = (v: unknown) => String(v ?? "").trim();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Checks an edited queue against the brokerage's active users and phone-menu recordings. */
export function validateQueue(raw: any, ctx: { userIds: Iterable<string>; audioIds: Iterable<string> }):
  { ok: true; value: Omit<QueueSettings, "id" | "archived_at"> } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const users = new Set(ctx.userIds), audio = new Set(ctx.audioIds);
  const name = str(raw?.name);
  if (!name) errors.name = "Name the queue (for example: Sales).";
  else if (name.length > 60) errors.name = "Keep the name under 60 characters.";
  const greeting = str(raw?.greeting).slice(0, 600);
  const hold_message = str(raw?.hold_message).slice(0, 600);
  const hold_audio_id = str(raw?.hold_audio_id) || null;
  if (hold_audio_id && !audio.has(hold_audio_id)) errors.hold_audio_id = "Choose one of your uploaded recordings, or the standard hold music.";
  const wait = Math.round(Number(raw?.max_wait_seconds ?? 300));
  if (!Number.isFinite(wait) || wait < 30 || wait > 3600) errors.max_wait_seconds = "Callers can wait 30 seconds to 60 minutes.";
  const ring = Math.round(Number(raw?.ring_seconds ?? 20));
  if (!Number.isFinite(ring) || ring < 10 || ring > 60) errors.ring_seconds = "Ring each person for 10 to 60 seconds.";
  const overflow = (OVERFLOWS as readonly string[]).includes(str(raw?.overflow)) ? (str(raw.overflow) as Overflow) : "voicemail";
  const overflow_user_id = str(raw?.overflow_user_id) || null;
  const silo = (QUEUE_SILOS as readonly string[]).includes(str(raw?.silo).toUpperCase()) ? str(raw.silo).toUpperCase() : "BF";
  if (overflow_user_id && !users.has(overflow_user_id)) errors.overflow_user_id = "Choose an active team member's voicemail, or the shared voicemail.";
  const member_ids = Array.from(new Set((Array.isArray(raw?.member_ids) ? raw.member_ids : []).map(str).filter(Boolean))) as string[];
  if (!member_ids.length) errors.member_ids = "Add at least one person who answers this queue.";
  else if (member_ids.some((id) => !users.has(id))) errors.member_ids = "Every member must be an active team member.";
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { name, greeting, hold_message, hold_audio_id, announce_position: raw?.announce_position !== false, max_wait_seconds: wait, ring_seconds: ring, overflow, overflow_user_id, member_ids, silo } };
}

function rowToQueue(r: any, members: string[]): QueueSettings {
  return {
    id: String(r.id), name: r.name, greeting: r.greeting ?? "", hold_message: r.hold_message ?? "", hold_audio_id: r.hold_audio_id ?? null,
    announce_position: r.announce_position !== false, max_wait_seconds: Number(r.max_wait_seconds), ring_seconds: Number(r.ring_seconds),
    overflow: r.overflow, overflow_user_id: r.overflow_user_id ? String(r.overflow_user_id) : null,
    archived_at: r.archived_at ? new Date(r.archived_at).toISOString() : null, member_ids: members, silo: String(r.silo ?? "BF"),
  };
}

export async function listQueues(db: Q, opts: { includeArchived?: boolean } = {}): Promise<QueueSettings[]> {
  const r = await db.query(`SELECT * FROM call_queues WHERE ($1::boolean OR archived_at IS NULL) ORDER BY archived_at NULLS FIRST, lower(name)`, [opts.includeArchived === true]);
  if (!r.rows.length) return [];
  const m = await db.query(`SELECT queue_id::text AS queue_id, user_id::text AS user_id FROM call_queue_members WHERE queue_id = ANY($1::uuid[])`, [r.rows.map((x: any) => x.id)]);
  return r.rows.map((x: any) => rowToQueue(x, m.rows.filter((y: any) => y.queue_id === String(x.id)).map((y: any) => y.user_id)));
}

export async function getQueue(db: Q, id: string): Promise<QueueSettings | null> {
  if (!UUID.test(id)) return null;
  return (await listQueues(db, { includeArchived: true })).find((q) => q.id === id) ?? null;
}

export async function saveQueue(db: Q, id: string | null, v: Omit<QueueSettings, "id" | "archived_at">, actor: string | null): Promise<string> {
  const params = [v.name, v.greeting, v.hold_message, v.hold_audio_id, v.announce_position, v.max_wait_seconds, v.ring_seconds, v.overflow, v.overflow_user_id, v.silo];
  const qid = id
    ? (await db.query(`UPDATE call_queues SET name = $2, greeting = $3, hold_message = $4, hold_audio_id = $5, announce_position = $6, max_wait_seconds = $7,
         ring_seconds = $8, overflow = $9, overflow_user_id = $10::uuid, silo = $11, updated_at = now() WHERE id = $1::uuid RETURNING id::text AS id`, [id, ...params])).rows[0].id
    : (await db.query(`INSERT INTO call_queues (name, greeting, hold_message, hold_audio_id, announce_position, max_wait_seconds, ring_seconds, overflow, overflow_user_id, silo, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::uuid, $10, $11::uuid) RETURNING id::text AS id`, [...params, actor])).rows[0].id;
  await db.query(`DELETE FROM call_queue_members WHERE queue_id = $1::uuid AND NOT (user_id = ANY($2::uuid[]))`, [qid, v.member_ids]);
  for (const u of v.member_ids) await db.query(`INSERT INTO call_queue_members (queue_id, user_id) VALUES ($1::uuid, $2::uuid) ON CONFLICT DO NOTHING`, [qid, u]);
  return String(qid);
}

// ------------------------------------------------------------------ availability
export async function setAvailable(db: Q, userId: string, available: boolean): Promise<void> {
  await db.query(
    `INSERT INTO call_queue_agents (user_id, available, available_since, updated_at) VALUES ($1::uuid, $2, CASE WHEN $2 THEN now() END, now())
     ON CONFLICT (user_id) DO UPDATE SET available = $2,
       available_since = CASE WHEN $2 AND NOT call_queue_agents.available THEN now() WHEN $2 THEN call_queue_agents.available_since ELSE NULL END,
       last_missed_at = CASE WHEN $2 THEN NULL ELSE call_queue_agents.last_missed_at END, updated_at = now()`,
    [userId, available]);
}

// ------------------------------------------------------------------ Twilio seam
export type TwilioLike = {
  createCall: (args: Record<string, unknown>) => Promise<{ sid: string }>;
  updateCall: (sid: string, args: Record<string, unknown>) => Promise<void>;
  dequeueMember: (queueSid: string, callSid: string, url: string) => Promise<void>;
};
const realTwilio: TwilioLike = {
  async createCall(args) { const c = await getTwilioClient().calls.create(args as any); return { sid: String(c.sid) }; },
  async updateCall(sid, args) { await getTwilioClient().calls(sid).update(args as any); },
  async dequeueMember(queueSid, callSid, url) { await getTwilioClient().queues(queueSid).members(callSid).update({ url, method: "POST" } as any); },
};
let twilioImpl: TwilioLike = realTwilio;
export function setQueueTwilioForTests(t: TwilioLike | null): void { twilioImpl = t ?? realTwilio; }

// ------------------------------------------------------------------ the dispatcher
export type Candidate = { user_id: string; identity: string; idle_since: string | null };

/** Members who could take a call now, longest idle first (pure SQL part; call hours are checked after). */
export const CANDIDATES_SQL = `
  SELECT m.user_id::text AS user_id, sp.twilio_identity AS identity,
         GREATEST(COALESCE(ag.available_since, 'epoch'::timestamptz), COALESCE(ag.last_call_ended_at, 'epoch'::timestamptz)) AS idle_since
    FROM call_queue_members m
    JOIN call_queue_agents ag ON ag.user_id = m.user_id AND ag.available = true
    JOIN users u ON u.id = m.user_id AND COALESCE(u.active, true) = true
    JOIN staff_presence sp ON sp.user_id = m.user_id
   WHERE m.queue_id = $1::uuid
     AND ${ringableStaffSql("sp", "u")}
     AND (ag.last_missed_at IS NULL OR ag.last_missed_at < now() - make_interval(secs => ${MISSED_COOLDOWN_SECONDS}))
     AND NOT (m.user_id = ANY($2::uuid[]))
     AND NOT EXISTS (SELECT 1 FROM call_queue_calls c WHERE c.status IN ('offered', 'connected')
                      AND (c.offered_user_id = m.user_id OR c.answered_user_id = m.user_id))
   ORDER BY idle_since ASC, m.user_id`;

export type Offer = { callId: string; userId: string; identity: string };

/** Chooses the next offer for one queue under a global lock (so two dispatchers never pick the same person). */
export async function pickOffer(client: PoolClient | Q, queueId: string, now = new Date()): Promise<Offer | null> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('bf_call_queue_dispatch'))`);
  const call = (await client.query(
    `SELECT id::text AS id, skipped_user_ids::text[] AS skipped FROM call_queue_calls WHERE queue_id = $1::uuid AND status = 'waiting' ORDER BY enqueued_at ASC LIMIT 1`, [queueId])).rows[0];
  if (!call) return null;
  let skipped: string[] = call.skipped ?? [];
  for (let round = 0; round < 2; round++) {
    const rows = (await client.query(CANDIDATES_SQL, [queueId, skipped])).rows as Candidate[];
    const away = await identitiesOutsideHours(client as any, rows.map((r) => r.identity), now);
    const pick = rows.find((r) => r.identity && !away.has(r.identity));
    if (pick) {
      const upd = await client.query(
        `UPDATE call_queue_calls SET status = 'offered', offered_user_id = $2::uuid, offered_at = now(), offer_attempts = offer_attempts + 1, skipped_user_ids = $3::uuid[]
          WHERE id = $1::uuid AND status = 'waiting' RETURNING id`, [call.id, pick.user_id, skipped]);
      return upd.rows.length ? { callId: call.id, userId: pick.user_id, identity: pick.identity } : null;
    }
    if (!skipped.length) break;
    skipped = []; // everyone was tried: start again with the people who are free now
  }
  return null;
}

/** Offers waiting callers of a queue to free members until no caller or nobody is left. Never throws. */
export async function dispatchQueue(pool: Pool, queueId: string, opts: { max?: number } = {}): Promise<number> {
  let made = 0;
  for (let i = 0; i < (opts.max ?? 10); i++) {
    let offer: Offer | null = null;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      offer = await pickOffer(client, queueId);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch((e) => console.error("[call-queue] rollback failed", e instanceof Error ? e.message : e));
      console.error("[call-queue] dispatch failed", { queueId, message: err instanceof Error ? err.message : String(err) });
      return made;
    } finally {
      client.release();
    }
    if (!offer) return made;
    const ok = await ringAgent(pool, queueId, offer);
    if (ok) made++;
  }
  return made;
}

/**
 * The custom parameters on the offer call. The iPhone dialler (CallerCard.fromInviteParameters) and the portal name
 * an incoming call from callerName / callerCompany, so a queue call shows who is waiting and which queue it came from
 * instead of Boreal's own number (the offer is placed from Boreal's caller ID). No dialler change is needed.
 */
export function offerParameters(a: { callId: string; queueName: string | null; from: string | null; callerName: string | null; contactId: string | null }): Record<string, string> {
  const queue = String(a.queueName ?? "").trim() || "Queue";
  const out: Record<string, string> = { queueCall: a.callId, queueName: queue.slice(0, 60), callerCompany: a.queueName ? `${queue} queue call`.slice(0, 80) : "Queue call" };
  out.callerName = (String(a.callerName ?? "").trim() || String(a.from ?? "").trim() || "Caller waiting").slice(0, 80);
  if (a.from) out.callerNumber = String(a.from).slice(0, 20);
  if (a.contactId && UUID.test(String(a.contactId))) out.contactId = String(a.contactId);
  return out;
}

async function ringAgent(pool: Pool, queueId: string, offer: Offer): Promise<boolean> {
  const call = (await pool.query(
    `SELECT c.from_number, c.caller_name, c.contact_id::text AS contact_id, q.ring_seconds, q.name AS queue_name
       FROM call_queue_calls c JOIN call_queues q ON q.id = c.queue_id WHERE c.id = $1::uuid`, [offer.callId])).rows[0];
  const base = getPublicBaseUrl();
  const params = new URLSearchParams(offerParameters({ callId: offer.callId, queueName: call?.queue_name ?? null, from: call?.from_number ?? null,
    callerName: call?.caller_name ?? null, contactId: call?.contact_id ?? null }));
  try {
    const c = await twilioImpl.createCall({
      to: `client:${offer.identity}?${params.toString()}`,
      from: getCallerId(),
      url: `${base}${WEBHOOK_BASE}/bridge?qc=${offer.callId}`,
      method: "POST",
      timeout: Number(call?.ring_seconds ?? 20),
      statusCallback: `${base}${WEBHOOK_BASE}/agent-status?qc=${offer.callId}&user=${offer.userId}`,
      statusCallbackEvent: ["completed"],
      statusCallbackMethod: "POST",
    });
    await pool.query(`UPDATE call_queue_calls SET offer_call_sid = $2 WHERE id = $1::uuid AND offered_user_id = $3::uuid`, [offer.callId, c.sid, offer.userId]);
    console.log(JSON.stringify({ event: "call_queue_offer", queueId, callId: offer.callId, userId: offer.userId }));
    return true;
  } catch (err) {
    console.error("[call-queue] could not ring the agent; trying the next person", { callId: offer.callId, userId: offer.userId, message: err instanceof Error ? err.message : String(err) });
    await offerMissed(pool, offer.callId, offer.userId, null);
    return false;
  }
}

/** Stops an agent's phone ringing for a caller who hung up. */
export async function cancelOfferCall(offerCallSid: string): Promise<void> {
  await twilioImpl.updateCall(offerCallSid, { status: "canceled" });
}

/** The offer was not answered (or could not be placed): back to waiting, skip this person for this caller. */
export async function offerMissed(db: Q, callId: string, userId: string, offerCallSid: string | null): Promise<boolean> {
  const r = await db.query(
    `UPDATE call_queue_calls SET status = 'waiting', offered_user_id = NULL, offer_call_sid = NULL, offered_at = NULL,
            skipped_user_ids = (SELECT ARRAY(SELECT DISTINCT unnest(skipped_user_ids || ARRAY[$2::uuid])))
      WHERE id = $1::uuid AND status = 'offered' AND offered_user_id = $2::uuid AND ($3::text IS NULL OR offer_call_sid = $3)
      RETURNING queue_id::text AS queue_id`, [callId, userId, offerCallSid]);
  if (r.rows.length) await db.query(`UPDATE call_queue_agents SET last_missed_at = now(), updated_at = now() WHERE user_id = $1::uuid`, [userId]);
  return r.rows.length > 0;
}

/** Connects the dequeued caller with the agent whose offer call dequeued them (swapping offers if Twilio's front
 *  caller was not the one this agent was offered). */
export async function markConnected(db: Q, callerSid: string, agentCallSid: string): Promise<{ callId: string; userId: string | null } | null> {
  const caller = (await db.query(`SELECT id::text AS id, offered_user_id::text AS user_id, offer_call_sid FROM call_queue_calls WHERE call_sid = $1`, [callerSid])).rows[0];
  if (!caller) return null;
  const offer = (await db.query(`SELECT id::text AS id, offered_user_id::text AS user_id FROM call_queue_calls WHERE offer_call_sid = $1`, [agentCallSid])).rows[0];
  if (offer && offer.id !== caller.id) {
    // The other caller takes this caller's offer (or goes back to waiting when there was none).
    await db.query(
      `UPDATE call_queue_calls SET offered_user_id = $2::uuid, offer_call_sid = $3, status = CASE WHEN $2::uuid IS NULL THEN 'waiting' ELSE 'offered' END WHERE id = $1::uuid`,
      [offer.id, caller.user_id ?? null, caller.offer_call_sid ?? null]);
  }
  const userId = offer?.user_id ?? caller.user_id ?? null;
  await db.query(
    `UPDATE call_queue_calls SET status = 'connected', answered_user_id = $2::uuid, offered_user_id = $2::uuid, offer_call_sid = $3, answered_at = now(),
            wait_seconds = GREATEST(0, EXTRACT(EPOCH FROM (now() - enqueued_at))::int) WHERE id = $1::uuid`,
    [caller.id, userId, agentCallSid]);
  return { callId: caller.id, userId };
}

/** The agent's queue call ended: the caller's row is completed and the agent is free (idle from now). */
export async function agentCallEnded(db: Q, callId: string, userId: string): Promise<void> {
  await db.query(`UPDATE call_queue_calls SET status = 'completed', ended_at = COALESCE(ended_at, now()), outcome = COALESCE(outcome, 'answered')
                   WHERE id = $1::uuid AND status = 'connected' AND answered_user_id = $2::uuid`, [callId, userId]);
  await db.query(`UPDATE call_queue_agents SET last_call_ended_at = now(), updated_at = now() WHERE user_id = $1::uuid`, [userId]);
}

/** Callers past the longest wait who are still waiting (the sweep dequeues them to the overflow). */
export async function overdueCallers(db: Q): Promise<Array<{ id: string; call_sid: string; twilio_queue_sid: string | null }>> {
  const r = await db.query(
    `SELECT c.id::text AS id, c.call_sid, c.twilio_queue_sid FROM call_queue_calls c JOIN call_queues q ON q.id = c.queue_id
      WHERE c.status = 'waiting' AND c.enqueued_at < now() - make_interval(secs => q.max_wait_seconds + 15) LIMIT 50`);
  return r.rows as any[];
}

export async function sweepQueues(pool: Pool): Promise<{ offers: number; overflowed: number; expired: number }> {
  const out = { offers: 0, overflowed: 0, expired: 0 };
  // Offers that never got a status callback (lost webhook) go back to waiting after the ring time plus a margin.
  const stale = await pool.query(
    `UPDATE call_queue_calls c SET status = 'waiting', offered_user_id = NULL, offer_call_sid = NULL, offered_at = NULL
       FROM call_queues q WHERE q.id = c.queue_id AND c.status = 'offered' AND c.offered_at < now() - make_interval(secs => q.ring_seconds + 45)
     RETURNING c.id`);
  out.expired = stale.rows.length;
  // Rows Twilio never told us about (a call that ended without any callback) are closed after a day.
  await pool.query(`UPDATE call_queue_calls SET status = 'abandoned', outcome = 'lost', ended_at = now() WHERE status IN ('waiting', 'offered') AND enqueued_at < now() - interval '1 day'`);
  for (const c of await overdueCallers(pool)) {
    if (!c.twilio_queue_sid) continue;
    try {
      await twilioImpl.dequeueMember(c.twilio_queue_sid, c.call_sid, `${getPublicBaseUrl()}${WEBHOOK_BASE}/overflow?qc=${c.id}`);
      out.overflowed++;
    } catch (err) {
      console.warn("[call-queue] overdue caller could not be dequeued (they may have hung up)", { callId: c.id, message: err instanceof Error ? err.message : String(err) });
    }
  }
  const queues = await pool.query(`SELECT DISTINCT queue_id::text AS id FROM call_queue_calls WHERE status = 'waiting'`);
  for (const q of queues.rows) out.offers += await dispatchQueue(pool, String(q.id));
  return out;
}

/** Puts the caller in a queue; false when the queue is not usable (the caller then follows the no-answer route). */
export async function enqueueCaller(pool: Pool | Q, v: any, queue: QueueSettings, args: { callSid: string; from: string | null; callerName: string | null; contactId: string | null }): Promise<boolean> {
  if (!args.callSid || queue.archived_at) return false;
  await pool.query(
    `INSERT INTO call_queue_calls (queue_id, call_sid, from_number, caller_name, contact_id) VALUES ($1::uuid, $2, $3, $4, $5::uuid)
     ON CONFLICT (call_sid) DO UPDATE SET queue_id = EXCLUDED.queue_id, status = 'waiting', enqueued_at = now(), offered_user_id = NULL, offer_call_sid = NULL,
       skipped_user_ids = '{}'::uuid[], wait_visits = 0, outcome = NULL`,
    [queue.id, args.callSid, args.from, args.callerName, args.contactId]);
  const id = (await pool.query(`SELECT id::text AS id FROM call_queue_calls WHERE call_sid = $1`, [args.callSid])).rows[0]?.id;
  v.enqueue({ action: `${WEBHOOK_BASE}/left?qc=${id}`, method: "POST", waitUrl: `${WEBHOOK_BASE}/wait?qc=${id}`, waitUrlMethod: "POST" }, twilioQueueName(queue.id));
  console.log(JSON.stringify({ event: "call_queue_enqueued", queueId: queue.id, callId: id }));
  return true;
}

// ------------------------------------------------------------------ the live panel and today's numbers
export async function livePanel(db: Q, now = new Date()) {
  const queues = await listQueues(db);
  const calls = (await db.query(
    `SELECT c.id::text AS id, c.queue_id::text AS queue_id, c.status, c.from_number, c.caller_name, c.contact_id::text AS contact_id, c.enqueued_at, c.answered_at,
            c.offered_user_id::text AS offered_user_id, c.answered_user_id::text AS answered_user_id, c.position
       FROM call_queue_calls c WHERE c.status IN ('waiting', 'offered', 'connected') ORDER BY c.enqueued_at`)).rows;
  const agents = (await db.query(
    `SELECT u.id::text AS user_id, NULLIF(btrim(concat_ws(' ', u.first_name, u.last_name)), '') AS name, COALESCE(ag.available, false) AS available,
            GREATEST(COALESCE(ag.available_since, 'epoch'::timestamptz), COALESCE(ag.last_call_ended_at, 'epoch'::timestamptz)) AS idle_since,
            COALESCE(sp.on_call, false) AS on_call, COALESCE(sp.manual_busy, false) AS busy,
            COALESCE(${ringableStaffSql("sp", "u")} OR sp.on_call OR sp.manual_busy, false) AS signed_in,
            array_agg(m.queue_id::text) AS queue_ids
       FROM call_queue_members m JOIN users u ON u.id = m.user_id AND COALESCE(u.active, true) = true
       JOIN call_queues q ON q.id = m.queue_id AND q.archived_at IS NULL
       LEFT JOIN call_queue_agents ag ON ag.user_id = u.id LEFT JOIN staff_presence sp ON sp.user_id = u.id
      GROUP BY u.id, u.first_name, u.last_name, ag.available, ag.available_since, ag.last_call_ended_at, sp.user_id
      ORDER BY 2`)).rows;
  const stats = (await db.query(
    `SELECT queue_id::text AS queue_id,
            count(*) FILTER (WHERE answered_at IS NOT NULL)::int AS answered,
            count(*) FILTER (WHERE status = 'abandoned')::int AS abandoned,
            count(*) FILTER (WHERE status = 'voicemail')::int AS voicemail,
            count(*) FILTER (WHERE status = 'callback')::int AS callbacks,
            COALESCE(round(avg(wait_seconds) FILTER (WHERE answered_at IS NOT NULL)), 0)::int AS avg_wait_seconds,
            COALESCE(max(wait_seconds), 0)::int AS longest_wait_seconds
       FROM call_queue_calls WHERE enqueued_at >= date_trunc('day', now()) GROUP BY 1`)).rows;
  const callbacks = (await db.query(
    `SELECT c.id::text AS id, c.queue_id::text AS queue_id, c.from_number, c.caller_name, c.contact_id::text AS contact_id, c.ended_at AS requested_at
       FROM call_queue_calls c WHERE c.status = 'callback' AND c.callback_done_at IS NULL ORDER BY c.ended_at LIMIT 100`)).rows;
  const nameOf = new Map(agents.map((a: any) => [a.user_id, a.name]));
  return {
    queues: queues.map((q) => {
      const live = calls.filter((c: any) => c.queue_id === q.id);
      const waiting = live.filter((c: any) => c.status !== "connected");
      return {
        id: q.id, name: q.name, silo: q.silo, max_wait_seconds: q.max_wait_seconds,
        waiting: waiting.map((c: any, i: number) => ({ id: c.id, position: i + 1, from: c.from_number, caller_name: c.caller_name, contact_id: c.contact_id,
          wait_seconds: Math.max(0, Math.round((now.getTime() - new Date(c.enqueued_at).getTime()) / 1000)), ringing: c.status === "offered" ? nameOf.get(c.offered_user_id) ?? "someone" : null })),
        connected: live.filter((c: any) => c.status === "connected").map((c: any) => ({ id: c.id, from: c.from_number, caller_name: c.caller_name, agent: nameOf.get(c.answered_user_id) ?? null,
          talk_seconds: c.answered_at ? Math.max(0, Math.round((now.getTime() - new Date(c.answered_at).getTime()) / 1000)) : 0 })),
        today: stats.find((s: any) => s.queue_id === q.id) ?? { answered: 0, abandoned: 0, voicemail: 0, callbacks: 0, avg_wait_seconds: 0, longest_wait_seconds: 0 },
      };
    }),
    agents: agents.map((a: any) => ({
      user_id: a.user_id, name: a.name ?? "Team member", available: a.available, signed_in: Boolean(a.signed_in), on_call: a.on_call || calls.some((c: any) => c.status === "connected" && c.answered_user_id === a.user_id),
      busy: a.busy, queue_ids: a.queue_ids, idle_seconds: a.available && new Date(a.idle_since).getTime() > 0 ? Math.max(0, Math.round((now.getTime() - new Date(a.idle_since).getTime()) / 1000)) : null,
    })),
    callbacks,
  };
}
