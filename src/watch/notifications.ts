import { pool } from "../db.js";
import { decryptWatchPushToken } from "./pushTokenCrypto.js";

export const WATCH_NOTIFICATION_CATEGORIES = ["MESSAGE", "TASK", "MEETING", "MISSED_CALL"] as const;
export const WATCH_EVENT_TYPES = ["client_message", "staff_message", "task", "meeting", "missed_call", "voicemail", "stage_change", "call_status"] as const;
export type WatchNotificationCategory = typeof WATCH_NOTIFICATION_CATEGORIES[number];
export type WatchEventType = typeof WATCH_EVENT_TYPES[number];

export interface WatchPushProvider {
  send(registration: { token: string; environment: "sandbox" | "production" }, payload: Record<string, unknown>): Promise<void>;
}

// APNs transport is injected by production bootstrap/CI. Keeping it behind this
// boundary guarantees tests cannot accidentally emit provider traffic.
let pushProvider: WatchPushProvider | null = null;
export const configureWatchPushProvider = (provider: WatchPushProvider | null) => { pushProvider = provider; };

export async function sendWatchNotification(input: {
  staffUserId: string; category: WatchNotificationCategory; eventType: WatchEventType; title: string; body: string; resourceId?: string;
}, dependencies: {
  query?: typeof pool.query;
  decrypt?: typeof decryptWatchPushToken;
} = {}): Promise<number> {
  if (!pushProvider) return 0;
  const query = dependencies.query ?? pool.query.bind(pool);
  const decrypt = dependencies.decrypt ?? decryptWatchPushToken;
  const opaqueId = input.resourceId && /^[A-Za-z0-9_-]{1,128}$/.test(input.resourceId) ? input.resourceId : undefined;
  // Deliberately allowlist fields: arbitrary event/CRM/application data can never
  // flow into an APNs lock-screen payload.
  const payload = {
    aps: { alert: { title: input.title.slice(0, 60), body: input.body.slice(0, 120) }, sound: "default", category: input.category },
    schema: 1,
    type: input.eventType,
    ...(opaqueId ? { id: opaqueId } : {}),
  };
  const registrations = await query(
    `SELECT p.id,p.device_id,p.token_ciphertext,p.environment FROM watch_push_registrations p JOIN watch_devices d ON d.id=p.device_id
      WHERE d.staff_user_id=$1 AND d.revoked_at IS NULL AND p.push_type='standard'`, [input.staffUserId]);
  let sent = 0;
  for (const row of registrations.rows) {
    try {
      await pushProvider.send({ token: decrypt(row.token_ciphertext), environment: row.environment }, payload);
      sent += 1;
    } catch (error) {
      const failure = error as { statusCode?: unknown; reason?: unknown; invalidRegistration?: unknown };
      if (failure.invalidRegistration === true) {
        try {
          await query("DELETE FROM watch_push_registrations WHERE id=$1", [row.id]);
        } catch {
          console.warn(JSON.stringify({ event: "watch_push_registration_cleanup_failed", registrationId: row.id }));
        }
      }
      console.warn(JSON.stringify({
        event: "watch_push_failed", staffUserId: input.staffUserId, registrationId: row.id,
        environment: row.environment,
        ...(typeof failure.statusCode === "number" ? { statusCode: failure.statusCode } : {}),
        ...(typeof failure.reason === "string" ? { reason: failure.reason } : {}),
      }));
    }
  }
  return sent;
}
