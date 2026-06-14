// BF_SERVER_PRESENCE_AUTO_BUSY_v1
// Presence is computed, not set directly. 'available' only when: signed in
// (recent heartbeat), inside 08:00–18:00 MST (fixed offset, no DST), and no
// busy reason active (manual / on a call / in a meeting). Else 'busy'; stale
// heartbeat -> 'offline'. Postgres 'MST' is a fixed UTC-7 abbreviation.
import { pool } from "../../db.js";

const RECOMPUTE_SQL = `
  UPDATE staff_presence SET
    status = CASE
      WHEN last_heartbeat < now() - interval '5 minutes' THEN 'offline'
      WHEN manual_busy OR on_call OR in_meeting THEN 'busy'
      WHEN extract(hour from (now() AT TIME ZONE 'MST')) < 8
        OR extract(hour from (now() AT TIME ZONE 'MST')) >= 18 THEN 'busy'
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
