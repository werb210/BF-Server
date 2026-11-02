// BF_SERVER_v871_CALL_QUEUES - the phone menu's way into a call queue (used by routes/reception.ts). Ported from
// KS-server #47 without the plan gate. With no queue set up (day 1) nothing here changes what a caller hears.
import { pool } from "../db.js";
import { readSetting } from "../settingsPack/common.js";
import { callerCardForCall } from "../voice/callerCard.js";
import { RECORDING_NOTICE } from "../voice/recordedDial.js";
import { openInboundRecord } from "../voice/staffRing.js";
import { enqueueCaller, getQueue } from "./queues.js";

const VOICE = "Polly.Joanna";
export const MAIN_LINE_SETTING = "call_queue_main_line";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const mainLineQueue = (raw: unknown): { queue_id: string | null } => {
  const id = String((raw as any)?.queue_id ?? "");
  return { queue_id: UUID.test(id) ? id : null };
};

/** The queue the main line goes straight into (after the greeting), or null: the phone menu as today. */
export async function mainLineQueueId(): Promise<string | null> {
  try {
    return (await readSetting(pool as any, MAIN_LINE_SETTING, mainLineQueue)).queue_id;
  } catch (err) {
    console.error("[call-queue] main-line queue lookup failed; using the phone menu", err instanceof Error ? err.message : err);
    return null;
  }
}

/** Whether a queue can take calls right now (exists and is not archived). */
export async function queueUsable(queueId: string): Promise<boolean> {
  try {
    const q = await getQueue(pool as any, queueId);
    return Boolean(q && !q.archived_at);
  } catch (err) {
    console.error("[call-queue] queue check failed", err instanceof Error ? err.message : err);
    return false;
  }
}

/** Puts the caller in the queue (with the recording notice unless the greeting already said it). False, with nothing
 *  added to the TwiML, when the queue is archived or missing or the call cannot be tracked; the caller then takes the
 *  menu's no-answer route. */
export async function routeToQueue(v: any, call: { callSid: string; from: string; noticeSaid?: boolean }, queueId: string): Promise<boolean> {
  try {
    if (!call.callSid) return false;
    const queue = await getQueue(pool as any, queueId);
    if (!queue || queue.archived_at) return false;
    const card = await callerCardForCall(pool as any, call.from, queue.silo);
    const rec = await openInboundRecord(pool as any, { callSid: call.callSid, from: call.from, card, silo: queue.silo });
    if (rec && !call.noticeSaid) v.say({ voice: VOICE }, RECORDING_NOTICE);
    return await enqueueCaller(pool, v, queue, { callSid: call.callSid, from: call.from || null, callerName: card?.name ?? null, contactId: card?.contactId ?? null });
  } catch (err) {
    console.error("[call-queue] could not put the caller in the queue; using the no-answer route", { queueId, message: err instanceof Error ? err.message : String(err) });
    return false;
  }
}
