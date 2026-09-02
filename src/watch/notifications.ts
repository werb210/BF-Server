import { pool } from "../db.js";
import { decryptWatchPushToken } from "./pushTokenCrypto.js";

export const WATCH_NOTIFICATION_CATEGORIES = ["MESSAGE", "TASK", "MEETING", "MISSED_CALL"] as const;
export const WATCH_EVENT_TYPES = ["client_message", "staff_message", "task", "meeting", "missed_call", "voicemail", "stage_change", "call_status"] as const;
type Category = typeof WATCH_NOTIFICATION_CATEGORIES[number];
type EventType = typeof WATCH_EVENT_TYPES[number];

export interface WatchPushProvider {
  send(registration: { token: string; environment: "sandbox" | "production" }, payload: Record<string, unknown>): Promise<void>;
}

// APNs transport is injected by production bootstrap/CI. Keeping it behind this
// boundary guarantees tests cannot accidentally emit provider traffic.
let pushProvider: WatchPushProvider | null = null;
export const configureWatchPushProvider = (provider: WatchPushProvider) => { pushProvider = provider; };

export async function sendWatchNotification(input: {
  staffUserId: string; category: Category; eventType: EventType; title: string; body: string; resourceId?: string;
}): Promise<number> {
  if (!pushProvider) return 0;
  // Deliberately allowlist fields: arbitrary event/CRM/application data can never
  // flow into an APNs lock-screen payload.
  const payload = {
    aps: { alert: { title: input.title.slice(0, 60), body: input.body.slice(0, 120) }, sound: "default", category: input.category },
    eventType: input.eventType,
    ...(input.resourceId ? { resourceId: input.resourceId } : {}),
  };
  const registrations = await pool.query(
    `SELECT p.token_ciphertext,p.environment FROM watch_push_registrations p JOIN watch_devices d ON d.id=p.device_id
      WHERE d.staff_user_id=$1 AND d.revoked_at IS NULL AND p.push_type='standard'`, [input.staffUserId]);
  let sent = 0;
  for (const row of registrations.rows) {
    await pushProvider.send({ token: decryptWatchPushToken(row.token_ciphertext), environment: row.environment }, payload);
    sent += 1;
  }
  return sent;
}
