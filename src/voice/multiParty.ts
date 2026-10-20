// BF_SERVER_v830_DIALER_CONTROLS - transfers and 3-way calls no longer drop everyone.
//
// Every leg joins with endConferenceOnExit=true, which is right for a 2-party call (either side hanging up ends it)
// but wrong once a third party is added: a warm transfer ended the call for the customer as soon as staff hung up,
// a cold transfer removed staff and so ended it at once, and in a 3-way call anyone hanging up ended it for all.
//
// Now, when someone is added (add participant / transfer):
//   - the legs already in the call are switched to endConferenceOnExit=false (Twilio participant update), and
//   - the new leg joins with it off too (join URL multi=1).
// The call then ends when only one person is left in it and nobody else is still being rung (endIfAlone, run on
// every participant leaving and on an added party who never answered).
import { pool } from "../db.js";

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };
type Tw = {
  conferences: (sid: string) => {
    update: (args: Record<string, unknown>) => Promise<unknown>;
    participants: (callSid: string) => { update: (args: Record<string, unknown>) => Promise<unknown> };
  };
};

async function defaultTwilio(): Promise<Tw> {
  const { getTwilioClient } = await import("./twilioClient.js");
  return getTwilioClient() as unknown as Tw;
}

/** Legs added within this window that are still ringing count as "on the way" (a stale row must not keep a call open). */
export const RINGING_GRACE_SECONDS = 90;

/** Switches every leg already in the call to stay when another leaves. Returns how many were updated. Never throws. */
export async function prepareMultiParty(conferenceId: string, deps: { db?: Q; twilio?: () => Promise<Tw> } = {}): Promise<number> {
  const db = deps.db ?? pool;
  let updated = 0;
  try {
    const conf = await db.query(
      `UPDATE conferences SET multi_party = true, updated_at = now() WHERE id = $1 RETURNING twilio_conference_sid`,
      [conferenceId],
    );
    const confSid = conf.rows[0]?.twilio_conference_sid as string | undefined;
    if (!confSid) return 0;
    const legs = await db.query(
      `SELECT twilio_call_sid FROM conference_participants
        WHERE conference_id = $1 AND status = 'joined' AND twilio_call_sid IS NOT NULL`,
      [conferenceId],
    );
    const tw = await (deps.twilio ?? defaultTwilio)();
    for (const leg of legs.rows) {
      try {
        await tw.conferences(confSid).participants(String(leg.twilio_call_sid)).update({ endConferenceOnExit: false });
        updated += 1;
      } catch (err: any) {
        console.warn("[multi-party] could not keep a leg in the call", { conferenceId, callSid: leg.twilio_call_sid, message: err?.message });
      }
    }
  } catch (err: any) {
    console.warn("[multi-party] prepare failed", { conferenceId, message: err?.message });
  }
  return updated;
}

/**
 * Ends a started call that has one person left in it and nobody on the way. Returns true when it ended the call.
 * Never throws.
 */
export async function endIfAlone(conferenceId: string, deps: { db?: Q; twilio?: () => Promise<Tw> } = {}): Promise<boolean> {
  const db = deps.db ?? pool;
  try {
    const r = await db.query(
      `SELECT c.twilio_conference_sid, c.status, c.multi_party,
              (SELECT COUNT(*)::int FROM conference_participants p WHERE p.conference_id = c.id AND p.status = 'joined') AS joined,
              (SELECT COUNT(*)::int FROM conference_participants p
                WHERE p.conference_id = c.id AND p.status IN ('invited', 'ringing', 'pending_dial')
                  AND p.created_at > now() - make_interval(secs => $2)) AS coming
         FROM conferences c WHERE c.id = $1`,
      [conferenceId, RINGING_GRACE_SECONDS],
    );
    const row = r.rows[0];
    // Only calls someone was added to: a 2-party call already ends itself (endConferenceOnExit).
    if (!row?.twilio_conference_sid || row.status !== "active" || row.multi_party !== true) return false;
    if (Number(row.joined) > 1 || Number(row.coming) > 0) return false;
    const tw = await (deps.twilio ?? defaultTwilio)();
    await tw.conferences(String(row.twilio_conference_sid)).update({ status: "completed" });
    return true;
  } catch (err: any) {
    console.warn("[multi-party] end-if-alone failed", { conferenceId, message: err?.message });
    return false;
  }
}
