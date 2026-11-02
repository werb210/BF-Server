// BF_SERVER_v869_SETTINGS_PACK_BLOCKED_NUMBERS - phone numbers an Admin has blocked (Settings > Blocked numbers).
//   calls  a polite message and hang up, or straight to the shared voicemail (the Admin's choice); never rings staff
//   texts  ignored: no inbox message, no alert, no automation, no reply (a STOP is still honoured)
// Every blocked call and text is logged in blocked_number_events, so an Admin can see what was stopped.
import { readSetting, writeSetting, type Q } from "../settingsPack/common.js";

export type CallAction = "reject" | "voicemail";
export type BlockedSettings = { call_action: CallAction };
export const REJECT_MESSAGE = "Sorry, we're unable to take your call. Goodbye.";

/** "(403) 555-0100", "403.555.0100", "+1 403 555 0100" -> "+14035550100"; anything that is not a number -> null. */
export function normalizeNumber(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!s || /[a-z]/i.test(s.replace(/^tel:/i, ""))) return null;
  const digits = s.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (s.trim().startsWith("+") && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return null;
}

let cache: { at: number; numbers: Set<string> } | null = null;
const CACHE_MS = 30_000;
export function clearBlockedCache(): void { cache = null; }

/** Is this caller blocked? A lookup failure is logged and lets the call through (a blocked list must never take the
 *  phones down). */
export async function isBlocked(db: Q, raw: unknown, now = Date.now()): Promise<boolean> {
  const n = normalizeNumber(raw);
  if (!n) return false;
  if (!cache || now - cache.at > CACHE_MS) {
    try {
      const r = await db.query(`SELECT number FROM blocked_numbers`);
      cache = { at: now, numbers: new Set(r.rows.map((x) => String(x.number))) };
    } catch (err) {
      console.error("[blocked-numbers] list could not be read; letting the call or text through", { message: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }
  return cache.numbers.has(n);
}

export async function blockedSettings(db: Q): Promise<BlockedSettings> {
  return readSetting(db, "blocked_numbers", (raw) => ({ call_action: (raw as any)?.call_action === "voicemail" ? "voicemail" : "reject" }));
}
export async function saveBlockedSettings(db: Q, v: BlockedSettings, actor: string | null): Promise<void> {
  await writeSetting(db, "blocked_numbers", v, actor);
}

export async function logBlocked(db: Q, e: { number: string; kind: "call" | "text"; action: string; body?: string | null; callSid?: string | null }): Promise<void> {
  try {
    await db.query(
      `INSERT INTO blocked_number_events (number, kind, action, body, twilio_sid) VALUES ($1, $2, $3, $4, $5)`,
      [normalizeNumber(e.number) ?? e.number, e.kind, e.action, e.body ? String(e.body).slice(0, 320) : null, e.callSid ?? null]);
  } catch (err) {
    console.error("[blocked-numbers] event log failed", { kind: e.kind, message: err instanceof Error ? err.message : String(err) });
  }
}

/** The TwiML for a blocked caller (VoiceResponse instance). */
export function blockedCallTwiml(v: any, action: CallAction): void {
  if (action === "voicemail") {
    v.say({ voice: "Polly.Joanna" }, "Please leave your message after the tone.");
    v.record({ maxLength: 120, playBeep: true, action: "/api/webhooks/twilio/voicemail?blocked=1" });
    return;
  }
  v.say({ voice: "Polly.Joanna" }, REJECT_MESSAGE);
  v.hangup();
}

/** For the voice webhooks: when the caller is blocked, writes the TwiML, logs the call and returns true. */
export async function handleBlockedCall(db: Q, v: any, from: string, callSid: string | null): Promise<boolean> {
  if (!(await isBlocked(db, from))) return false;
  const { call_action } = await blockedSettings(db);
  blockedCallTwiml(v, call_action);
  await logBlocked(db, { number: from, kind: "call", action: call_action, callSid });
  console.log(JSON.stringify({ event: "blocked_call", callSid, action: call_action }));
  return true;
}

/** For the SMS webhooks: true (and logged) when the text must be ignored. */
export async function ignoreBlockedText(db: Q, from: string, body: string, sid: string | null): Promise<boolean> {
  if (!(await isBlocked(db, from))) return false;
  await logBlocked(db, { number: from, kind: "text", action: "ignored", body, callSid: sid });
  console.log(JSON.stringify({ event: "blocked_text", sid }));
  return true;
}

export type BlockedRow = { id: string; number: string; reason: string | null; created_at: string };

export async function listBlocked(db: Q): Promise<BlockedRow[]> {
  const r = await db.query(`SELECT id::text AS id, number, reason, created_at FROM blocked_numbers ORDER BY created_at DESC LIMIT 2000`);
  return r.rows as BlockedRow[];
}
export async function recentBlockedEvents(db: Q, limit = 50): Promise<Array<{ number: string; kind: string; action: string; body: string | null; created_at: string }>> {
  const r = await db.query(`SELECT number, kind, action, body, created_at FROM blocked_number_events ORDER BY created_at DESC LIMIT $1`, [limit]);
  return r.rows as any;
}
export async function addBlocked(db: Q, number: string, reason: string | null, actor: string | null): Promise<BlockedRow | null> {
  const r = await db.query(
    `INSERT INTO blocked_numbers (number, reason, created_by) VALUES ($1, $2, $3::uuid) ON CONFLICT (number) DO NOTHING
     RETURNING id::text AS id, number, reason, created_at`, [number, reason, actor]);
  clearBlockedCache();
  return (r.rows[0] as BlockedRow) ?? null;
}
export async function removeBlocked(db: Q, id: string): Promise<BlockedRow | null> {
  const r = await db.query(`DELETE FROM blocked_numbers WHERE id::text = $1 RETURNING id::text AS id, number, reason, created_at`, [id]);
  clearBlockedCache();
  return (r.rows[0] as BlockedRow) ?? null;
}
