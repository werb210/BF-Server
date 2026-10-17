// BF_SERVER_v820_WATCH_CALLS - lock-screen alerts for the staff iPhone dialler (com.borealfinancial.dialer).
// The dialler only had VoIP pushes (incoming calls). A missed call, a voicemail, a client-portal message, an
// inbound SMS or a Maya "talk to a person" handoff reached the portal bell and nowhere a phone in a pocket shows.
// Reuses the Watch APNs provider (v819 hardened transport). A .p8 key signs for its own team, so the dialler may
// use its own STAFF_APNS_* key; each value falls back to WATCH_APNS_*.
// Best-effort by design: a failed alert never fails the request that triggered it, and no token is ever logged.
import { pool } from "../../db.js";
import { AppleWatchApnsProvider } from "../../watch/apnsProvider.js";
import type { WatchPushProvider } from "../../watch/notifications.js";

export const STAFF_ALERT_CATEGORIES = ["MISSED_CALL", "VOICEMAIL", "CLIENT_MESSAGE", "SMS", "HANDOFF"] as const;
export type StaffAlertCategory = typeof STAFF_ALERT_CATEGORIES[number];
export const STAFF_ALERT_TYPES = ["missed_call", "voicemail", "client_message", "sms", "maya_handoff"] as const;
export type StaffAlertType = typeof STAFF_ALERT_TYPES[number];

export const STAFF_PUSH_APPS = ["dialer-ios"] as const;
export const DEFAULT_STAFF_APNS_BUNDLE_ID = "com.borealfinancial.dialer";

export const STAFF_ALERT_TITLE_MAX = 80;
export const STAFF_ALERT_BODY_MAX = 120;

// BF_SERVER_v821_DIALER - every staff alert is a client reaching out (a call, a voicemail, a message, a text, a
// "talk to a person"), so it may break through a Work focus: interruption-level time-sensitive (the dialler has the
// Time Sensitive Notifications entitlement). relevance-score (0-1) orders them in the notification summary.
export const STAFF_ALERT_INTERRUPTION_LEVEL = "time-sensitive";
export const STAFF_ALERT_RELEVANCE: Record<StaffAlertCategory, number> = {
  HANDOFF: 1,
  MISSED_CALL: 0.9,
  VOICEMAIL: 0.8,
  CLIENT_MESSAGE: 0.7,
  SMS: 0.6,
};

/** Only these ids may reach the device; everything else the lock screen should not carry is dropped. */
export type StaffAlertData = {
  contactId?: string | null;
  applicationId?: string | null;
  phone?: string | null;
  threadKind?: "sms" | "messages" | null;
  voicemailId?: string | null; // BF_SERVER_v821_DIALER - lets the app open the voicemail
};

export type StaffAlertInput = {
  userId: string;
  title: string;
  body: string;
  category: StaffAlertCategory;
  type: StaffAlertType;
  data?: StaffAlertData;
};

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

let provider: WatchPushProvider | null = null;

export function staffApnsCredentials(env: NodeJS.ProcessEnv = process.env): {
  teamId?: string; keyId?: string; privateKey?: string; bundleId: string;
} {
  const pick = (own: string, shared: string) => (env[own]?.trim() || env[shared]?.trim() || undefined);
  return {
    teamId: pick("STAFF_APNS_TEAM_ID", "WATCH_APNS_TEAM_ID"),
    keyId: pick("STAFF_APNS_KEY_ID", "WATCH_APNS_KEY_ID"),
    privateKey: pick("STAFF_APNS_PRIVATE_KEY", "WATCH_APNS_PRIVATE_KEY")?.replace(/\\n/g, "\n"),
    bundleId: env.STAFF_APNS_BUNDLE_ID?.trim() || DEFAULT_STAFF_APNS_BUNDLE_ID,
  };
}

export function initializeStaffPushProvider(env: NodeJS.ProcessEnv = process.env): boolean {
  // Unit/integration processes must never construct a production network transport.
  if (env.NODE_ENV === "test") return false;
  const { teamId, keyId, privateKey, bundleId } = staffApnsCredentials(env);
  if (!teamId || !keyId || !privateKey) {
    console.warn(JSON.stringify({ event: "staff_apns_not_configured" }));
    return false;
  }
  try {
    provider = new AppleWatchApnsProvider({ teamId, keyId, privateKey, bundleId });
  } catch (error) {
    // Push is optional: a malformed key disables staff alerts loudly, it never stops the server.
    console.error(JSON.stringify({ event: "staff_apns_misconfigured", error: String((error as Error)?.message ?? error) }));
    provider = null;
    return false;
  }
  console.log(JSON.stringify({ event: "staff_apns_initialized", bundleId, teamId, keyId }));
  return true;
}

export function isStaffPushConfigured(): boolean { return provider !== null; }

/** Test seam. */
export function __setStaffPushProvider(p: WatchPushProvider | null): void { provider = p; }

function clip(value: unknown, max: number): string {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The exact APNs payload: aps alert + category + thread-id, the type, and allowlisted ids only. */
export function buildStaffAlertPayload(input: Omit<StaffAlertInput, "userId">): Record<string, unknown> {
  const data = input.data ?? {};
  const contactId = typeof data.contactId === "string" && UUID.test(data.contactId) ? data.contactId : undefined;
  const applicationId = typeof data.applicationId === "string" && UUID.test(data.applicationId) ? data.applicationId : undefined;
  const phone = typeof data.phone === "string" && /^\+[1-9]\d{7,14}$/.test(data.phone) ? data.phone : undefined;
  const threadKind = data.threadKind === "sms" || data.threadKind === "messages" ? data.threadKind : undefined;
  const voicemailId = typeof data.voicemailId === "string" && UUID.test(data.voicemailId) ? data.voicemailId : undefined;
  // Group a contact's alerts together (iOS stacks by thread-id), else by kind of event.
  const threadId = `${input.type}:${contactId ?? phone ?? "general"}`;
  return {
    aps: {
      alert: { title: clip(input.title, STAFF_ALERT_TITLE_MAX), body: clip(input.body, STAFF_ALERT_BODY_MAX) },
      sound: "default",
      category: input.category,
      "thread-id": threadId,
      // BF_SERVER_v821_DIALER - breaks through a Work focus; ranked in the summary.
      "interruption-level": STAFF_ALERT_INTERRUPTION_LEVEL,
      "relevance-score": STAFF_ALERT_RELEVANCE[input.category] ?? 0.5,
    },
    schema: 1,
    type: input.type,
    ...(contactId ? { contactId } : {}),
    ...(applicationId ? { applicationId } : {}),
    ...(phone ? { phone } : {}),
    ...(threadKind ? { threadKind } : {}),
    ...(voicemailId ? { voicemailId } : {}),
  };
}

/** Sends one alert to every registered dialler of the staff member. Returns how many devices accepted it. */
export async function sendStaffAlert(input: StaffAlertInput, dependencies: { query?: Q["query"] } = {}): Promise<number> {
  if (!provider) return 0;
  if (!STAFF_ALERT_CATEGORIES.includes(input.category)) return 0;
  const query = dependencies.query ?? pool.query.bind(pool);
  const payload = buildStaffAlertPayload(input);
  let rows: Array<{ id: string; token: string; environment: string }> = [];
  try {
    rows = (await query(
      `SELECT id::text AS id, token, environment FROM staff_push_tokens
        WHERE user_id::text = $1 AND app = 'dialer-ios'
        ORDER BY updated_at DESC LIMIT 10`,
      [input.userId],
    )).rows as typeof rows;
  } catch (err) {
    console.warn(JSON.stringify({ event: "staff_push_lookup_failed", userId: input.userId, error: String((err as Error)?.message ?? err).slice(0, 200) }));
    return 0;
  }
  let sent = 0;
  for (const row of rows) {
    const environment = row.environment === "sandbox" ? "sandbox" : "production";
    try {
      try {
        await provider.send({ token: row.token, environment }, payload);
      } catch (error) {
        // Xcode debug builds hold sandbox tokens, TestFlight/App Store production ones; Apple answers
        // BadDeviceToken from the wrong host. Try the other host once and remember the one that worked.
        if ((error as { reason?: unknown })?.reason !== "BadDeviceToken") throw error;
        const other = environment === "production" ? "sandbox" : "production";
        await provider.send({ token: row.token, environment: other }, payload);
        await query(`UPDATE staff_push_tokens SET environment=$2, last_error=NULL, updated_at=now() WHERE id::text=$1`, [row.id, other])
          .catch((e: unknown) => console.warn(JSON.stringify({ event: "staff_push_environment_update_failed", tokenId: row.id, error: String((e as Error)?.message ?? e).slice(0, 200) })));
      }
      sent += 1;
    } catch (error) {
      const failure = error as { statusCode?: unknown; reason?: unknown; invalidRegistration?: unknown };
      const reason = typeof failure.reason === "string" ? failure.reason : String((error as Error)?.message ?? error).slice(0, 200);
      if (failure.invalidRegistration === true) {
        await query(`DELETE FROM staff_push_tokens WHERE id::text=$1`, [row.id])
          .catch((e: unknown) => console.warn(JSON.stringify({ event: "staff_push_token_cleanup_failed", tokenId: row.id, error: String((e as Error)?.message ?? e).slice(0, 200) })));
      } else {
        await query(`UPDATE staff_push_tokens SET last_error=$2, updated_at=now() WHERE id::text=$1`, [row.id, reason.slice(0, 200)])
          .catch((e: unknown) => console.warn(JSON.stringify({ event: "staff_push_error_record_failed", tokenId: row.id, error: String((e as Error)?.message ?? e).slice(0, 200) })));
      }
      console.warn(JSON.stringify({
        event: "staff_push_failed", userId: input.userId, tokenId: row.id, environment,
        ...(typeof failure.statusCode === "number" ? { statusCode: failure.statusCode } : {}),
        reason, dropped: failure.invalidRegistration === true,
      }));
    }
  }
  return sent;
}
