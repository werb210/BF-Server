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
  voicemailId?: string; // BF_SERVER_v821_DIALER - top-level, UUID only, so the Watch can open the voicemail
}, dependencies: {
  query?: typeof pool.query;
  decrypt?: typeof decryptWatchPushToken;
} = {}): Promise<number> {
  if (!pushProvider) return 0;
  const query = dependencies.query ?? pool.query.bind(pool);
  const decrypt = dependencies.decrypt ?? decryptWatchPushToken;
  const opaqueId = input.resourceId && /^[A-Za-z0-9_-]{1,128}$/.test(input.resourceId) ? input.resourceId : undefined;
  const voicemailId = input.voicemailId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.voicemailId) ? input.voicemailId : undefined;
  // Deliberately allowlist fields: arbitrary event/CRM/application data can never
  // flow into an APNs lock-screen payload.
  const payload = {
    aps: { alert: { title: input.title.slice(0, 60), body: input.body.slice(0, 120) }, sound: "default", category: input.category },
    schema: 1,
    type: input.eventType,
    ...(opaqueId ? { id: opaqueId } : {}),
    ...(voicemailId ? { voicemailId } : {}),
  };
  // BF_SERVER_v819_PUSH - watch_push_registrations has no id column (its primary key is device_id, see
  // migrations/2026_09_02_v154_watch_backend.sql and 000000_baseline.sql). "SELECT p.id" failed with
  // 'column p.id does not exist' on every call, so not one Watch push was ever sent: notifyAllStaff caught the
  // throw and logged a bare watch_push_failed. The registration is identified by its device_id.
  const registrations = await query(
    `SELECT p.device_id AS id,p.device_id,p.token_ciphertext,p.environment FROM watch_push_registrations p JOIN watch_devices d ON d.id=p.device_id
      WHERE d.staff_user_id=$1 AND d.revoked_at IS NULL AND p.push_type='standard'`, [input.staffUserId]);
  let sent = 0;
  // BF_SERVER_v845_PUSH_DEDUPE - every Watch app install registers a new device row, often with the same APNs token,
  // so one event reached the same watch once per stale row. Send once per distinct token.
  const seenTokens = new Set<string>();
  for (const row of registrations.rows) {
    try {
      const token = decrypt(row.token_ciphertext);
      if (seenTokens.has(token)) continue;
      seenTokens.add(token);
      try {
        await pushProvider.send({ token, environment: row.environment }, payload);
      } catch (error) {
        // BF_SERVER_v819_PUSH - Apple answers BadDeviceToken when the token belongs to the other APNs host
        // (Xcode debug build = sandbox, TestFlight/App Store = production). Try the other host once before the
        // registration is treated as dead, and remember the host that worked.
        if ((error as { reason?: unknown })?.reason !== "BadDeviceToken") throw error;
        const other = row.environment === "production" ? "sandbox" : "production";
        await pushProvider.send({ token, environment: other }, payload);
        await query("UPDATE watch_push_registrations SET environment=$2,updated_at=now() WHERE device_id=$1", [row.device_id, other])
          .catch((updateError: unknown) => console.warn(JSON.stringify({
            event: "watch_push_environment_update_failed", registrationId: row.id,
            error: String((updateError as Error)?.message ?? updateError).slice(0, 200),
          })));
      }
      sent += 1;
    } catch (error) {
      const failure = error as { statusCode?: unknown; reason?: unknown; invalidRegistration?: unknown };
      if (failure.invalidRegistration === true) {
        try {
          await query("DELETE FROM watch_push_registrations WHERE device_id=$1", [row.id]);
        } catch {
          console.warn(JSON.stringify({ event: "watch_push_registration_cleanup_failed", registrationId: row.id }));
        }
      }
      console.warn(JSON.stringify({
        event: "watch_push_failed", staffUserId: input.staffUserId, registrationId: row.id,
        environment: row.environment,
        ...(typeof failure.statusCode === "number" ? { statusCode: failure.statusCode } : {}),
        ...(typeof failure.reason === "string" ? { reason: failure.reason } : {}),
        // BF_SERVER_v819_PUSH - timeouts/connection errors/decrypt failures carry no status; say what happened.
        ...(typeof failure.statusCode !== "number" ? { error: String((error as Error)?.message ?? error).slice(0, 200) } : {}),
      }));
    }
  }
  return sent;
}
