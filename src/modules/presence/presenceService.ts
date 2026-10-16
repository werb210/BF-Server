// BF_SERVER_PRESENCE_AUTO_BUSY_v1
// Presence is computed, not set directly. 'available' only when: signed in
// (recent heartbeat), inside 08:00-18:00 Alberta time, and no
// busy reason active (manual / on a call / in a meeting). Else 'busy'; stale
// heartbeat -> 'offline'.
//
// BF_SERVER_PRESENCE_EXPLAIN_v142 - this used to read AT TIME ZONE 'MST',
// which Postgres treats as a fixed UTC-7 abbreviation with no DST. Alberta
// observes DST, so for most of the year the window silently ran 09:00-19:00
// local: staff with the app open were computed 'busy' before 9am and after
// 7pm, and inbound calls answered "no agents are available". The named zone
// tracks DST.
import { pool } from "../../db.js";
// BF_SERVER_v817_DIALER_MESSAGING - business hours deliberately stay on ALBERTA_TZ (America/Regina):
// Alberta is on UTC-6 all year from 2026 and older tzdata still moves the Edmonton zone to UTC-7 in
// November (see src/lib/albertaTime.ts, enforced by albertaTime.v743.test.ts).

// BF_SERVER_v817_DIALER_MESSAGING - who an inbound call may ring. The iOS dialler stops
// heartbeating ~5 minutes after it is closed (the recompute then marks it 'offline'), yet it
// still receives Twilio VoIP pushes, so 'available'-only meant a closed app never rang. A staff
// member is ringable when they have a Twilio client identity, did not mark themselves busy and
// are not on a call / in a meeting, and either:
//   - presence is 'available' (fresh heartbeat, business hours), or
//   - presence went 'offline' only because the heartbeat is stale, it is business hours, and the
//     device is still registered (an unrevoked dialler credential or a voice token in the last 7 days).
// 'busy' (manual / on call / meeting / after hours with the app open) is never rung.
export const BUSINESS_HOURS_SQL = `(extract(hour from (now() AT TIME ZONE 'America/Regina')) >= 8
      AND extract(hour from (now() AT TIME ZONE 'America/Regina')) < 18)`;
export function ringableStaffSql(sp = "sp", u = "u"): string {
  return `(${sp}.twilio_identity IS NOT NULL
    AND coalesce(${sp}.manual_busy, false) = false
    AND coalesce(${sp}.on_call, false) = false
    AND coalesce(${sp}.in_meeting, false) = false
    AND (
      (${sp}.status = 'available' AND ${sp}.last_heartbeat > now() - interval '5 minutes')
      OR (${sp}.status = 'offline' AND ${BUSINESS_HOURS_SQL}
          AND (${sp}.voice_token_at > now() - interval '7 days'
               OR EXISTS (SELECT 1 FROM staff_device_credentials dc
                           WHERE dc.user_id = ${u}.id AND dc.revoked_at IS NULL AND dc.expires_at > now())))
    ))`;
}

/** BF_SERVER_v817_DIALER_MESSAGING - record that this user just fetched a voice token, so the
 *  IVR knows their client identity is registered even after the app stops heartbeating. */
export async function recordVoiceTokenIssued(userId: string, identity: string): Promise<void> {
  if (!userId || !identity) return;
  try {
    await pool.query(
      `INSERT INTO staff_presence (user_id, status, twilio_identity, voice_token_at, last_heartbeat, updated_at)
       VALUES ($1::uuid, 'available', $2, now(), now(), now())
       ON CONFLICT (user_id) DO UPDATE SET twilio_identity = EXCLUDED.twilio_identity,
                                         voice_token_at = now(), last_heartbeat = now(), updated_at = now()`,
      [userId, identity],
    );
    // A token fetch means the app is alive (same as GET /api/telephony/token); status is derived.
    await recomputePresence(userId);
  } catch (err: unknown) {
    console.warn("[presence] voice token registration failed", { userId, message: err instanceof Error ? err.message : String(err) });
  }
}

const RECOMPUTE_SQL = `
  UPDATE staff_presence SET
    status = CASE
      WHEN last_heartbeat < now() - interval '5 minutes' THEN 'offline'
      WHEN manual_busy OR on_call OR in_meeting THEN 'busy'
      WHEN extract(hour from (now() AT TIME ZONE 'America/Regina')) < 8
        OR extract(hour from (now() AT TIME ZONE 'America/Regina')) >= 18 THEN 'busy'
      ELSE 'available'
    END,
    updated_at = now()
`;

export async function recomputePresence(userId?: string): Promise<void> {
  try {
    if (userId) await pool.query(`${RECOMPUTE_SQL} WHERE user_id = $1`, [userId]);
    else await pool.query(RECOMPUTE_SQL);
  } catch {
    /* non-fatal */
  }
}

async function setFlag(userId: string, column: "manual_busy" | "on_call" | "in_meeting", value: boolean): Promise<void> {
  if (!userId) return;
  try {
    await pool.query(
      `INSERT INTO staff_presence (user_id, status, ${column}, last_heartbeat, updated_at)
       VALUES ($1, 'available', $2, now(), now())
       ON CONFLICT (user_id) DO UPDATE SET ${column} = $2, updated_at = now()`,
      [userId, value],
    );
    await recomputePresence(userId);
  } catch {
    /* non-fatal */
  }
}

export const setOnCall = (userId: string, v: boolean) => setFlag(userId, "on_call", v);
export const setManualBusy = (userId: string, v: boolean) => setFlag(userId, "manual_busy", v);
export const setInMeeting = (userId: string, v: boolean) => setFlag(userId, "in_meeting", v);

let started = false;
export function startPresenceCron(): void {
  if (started) return;
  started = true;
  setInterval(() => {
    void recomputePresence();
  }, 60_000).unref();
}

startPresenceCron();


// BF_SERVER_PRESENCE_ONCALL_WIRE_v1 - reconcile every staff member's on_call flag
// from live conference membership: on_call = has a joined staff leg in a
// non-ended conference. Idempotent; call after each conference webhook event.
export async function syncStaffOnCallFromConferences(): Promise<void> {
  try {
    await pool.query(`
      UPDATE staff_presence sp
         SET on_call = EXISTS (
               SELECT 1 FROM conference_participants cp
                 JOIN conferences c ON c.id = cp.conference_id
                WHERE cp.kind = 'staff' AND cp.status = 'joined'
                  AND cp.identity = sp.twilio_identity
                  AND c.status <> 'ended'
             ),
             updated_at = now()
       WHERE sp.twilio_identity IS NOT NULL`);
    await recomputePresence();
  } catch {
    /* non-fatal */
  }
}
