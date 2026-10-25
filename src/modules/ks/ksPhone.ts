// BF_SERVER_v853_KS_PHONE_SUPPORT - the Keystone (KS) sales / support phone line.
//
// The Keystone number (KS_VOICE_NUMBER, E.164) answers with its own menu: "Thanks for calling Keystone. Press 1 for
// sales, 2 for support." Each choice is a queue (ks_phone_queues): its ring group (named staff, or every staff member
// with Keystone access when none are named), how long it rings and its opening hours. Outside the hours, or when
// nobody picks up, the caller leaves a voicemail (transcribed by the shared voicemail pipeline). Callers are matched
// against Keystone CRM contacts (phone, then second phone) and then Keystone companies (company phone), never against
// BF / BI / SLF records.
//
// With KS_VOICE_NUMBER unset the line is off: the webhooks answer "not in service" and nothing else changes.
import { isValidTimeZone, isWithinCallHours, rowToCallHours, validateCallHoursInput, type WeeklyHours } from "../../voice/callHours.js";
import { ringableStaffSql } from "../presence/presenceService.js";
import { ALBERTA_TZ } from "../../lib/albertaTime.js";

export type Q = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

export const KS_QUEUES = ["sales", "support"] as const;
export type KsQueue = (typeof KS_QUEUES)[number];
export const KS_QUEUE_LABELS: Record<KsQueue, string> = { sales: "Sales", support: "Support" };
export const KS_RING_GROUP_MAX = 10;
export const KS_DEFAULT_RING_SECONDS = 25;

export function isKsQueue(v: unknown): v is KsQueue {
  return typeof v === "string" && (KS_QUEUES as readonly string[]).includes(v);
}

/** North American or E.164 -> E.164, else null. */
export function e164(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (/^\+[1-9]\d{7,14}$/.test(s.replace(/[\s().-]/g, ""))) return s.replace(/[\s().-]/g, "");
  const d = s.replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return null;
}

export function last10(raw: unknown): string {
  const d = String(raw ?? "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : "";
}

/** The Keystone number, or null when the line is off. */
export function ksVoiceNumber(env: NodeJS.ProcessEnv = process.env): string | null {
  return e164(env.KS_VOICE_NUMBER);
}

export function ksVoiceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return ksVoiceNumber(env) !== null;
}

/** True when `to` is the Keystone number (any formatting). */
export function isKsVoiceNumber(to: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  const ks = ksVoiceNumber(env);
  if (!ks) return false;
  const a = last10(ks);
  return a !== "" && a === last10(to) && (e164(to) ?? "") === ks;
}

export type KsQueueSettings = {
  queue: KsQueue;
  label: string;
  ringUserIds: string[];
  ringTimeoutSeconds: number;
  hoursEnabled: boolean;
  timezone: string;
  weekly: WeeklyHours;
  updatedAt: string | null;
};

export function defaultQueueSettings(queue: KsQueue): KsQueueSettings {
  const work: [string, string][] = [["08:00", "17:00"]];
  return {
    queue,
    label: KS_QUEUE_LABELS[queue],
    ringUserIds: [],
    ringTimeoutSeconds: KS_DEFAULT_RING_SECONDS,
    hoursEnabled: true,
    timezone: ALBERTA_TZ,
    weekly: { sun: [], mon: [...work], tue: [...work], wed: [...work], thu: [...work], fri: [...work], sat: [] },
    updatedAt: null,
  };
}

export function rowToQueueSettings(queue: KsQueue, row: any): KsQueueSettings {
  const base = defaultQueueSettings(queue);
  if (!row) return base;
  const hours = rowToCallHours({ enabled: row.hours_enabled !== false, timezone: row.timezone, weekly: row.weekly });
  const secs = Number(row.ring_timeout_seconds);
  return {
    queue,
    label: String(row.label ?? "").trim() || base.label,
    ringUserIds: Array.isArray(row.ring_user_ids) ? row.ring_user_ids.map(String).filter((id: string) => /^[0-9a-f-]{36}$/i.test(id)) : [],
    ringTimeoutSeconds: Number.isInteger(secs) && secs >= 10 && secs <= 60 ? secs : KS_DEFAULT_RING_SECONDS,
    hoursEnabled: row.hours_enabled !== false,
    timezone: hours.timezone,
    weekly: hours.weekly,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

/** The queue's settings; a missing row or a failed read gives the defaults (logged) so the phone keeps working. */
export async function loadQueueSettings(q: Q, queue: KsQueue): Promise<KsQueueSettings> {
  try {
    const { rows } = await q.query(
      `SELECT queue, label, ring_user_ids::text[] AS ring_user_ids, ring_timeout_seconds, hours_enabled, timezone, weekly, updated_at
         FROM ks_phone_queues WHERE queue = $1`,
      [queue],
    );
    return rowToQueueSettings(queue, rows[0]);
  } catch (err) {
    console.warn("[ks-phone] queue settings read failed; using defaults", { queue, message: err instanceof Error ? err.message : String(err) });
    return defaultQueueSettings(queue);
  }
}

/** Validates PUT /api/ks/support/phone/queues/:queue. */
export function parseQueueSettings(queue: KsQueue, body: unknown):
  | { ok: true; value: Omit<KsQueueSettings, "updatedAt"> }
  | { ok: false; errors: Record<string, string> } {
  const b = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const errors: Record<string, string> = {};
  const base = defaultQueueSettings(queue);
  let label = base.label;
  if (b.label !== undefined) {
    if (typeof b.label !== "string" || !b.label.trim() || b.label.trim().length > 60) errors.label = "must be 1 to 60 characters";
    else label = b.label.trim();
  }
  let ringUserIds: string[] = [];
  if (b.ringUserIds !== undefined) {
    if (!Array.isArray(b.ringUserIds) || b.ringUserIds.some((id) => typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id))) {
      errors.ringUserIds = "must be a list of staff user ids";
    } else if (b.ringUserIds.length > KS_RING_GROUP_MAX) {
      errors.ringUserIds = `at most ${KS_RING_GROUP_MAX} people`;
    } else {
      ringUserIds = Array.from(new Set(b.ringUserIds as string[]));
    }
  }
  let ringTimeoutSeconds = base.ringTimeoutSeconds;
  if (b.ringTimeoutSeconds !== undefined) {
    const n = Number(b.ringTimeoutSeconds);
    if (!Number.isInteger(n) || n < 10 || n > 60) errors.ringTimeoutSeconds = "must be a whole number from 10 to 60";
    else ringTimeoutSeconds = n;
  }
  const hours = validateCallHoursInput({
    enabled: b.hoursEnabled === undefined ? true : b.hoursEnabled,
    timezone: b.timezone === undefined ? base.timezone : b.timezone,
    weekly: b.weekly === undefined ? base.weekly : b.weekly,
  });
  if (!hours.ok) errors.hours = hours.message;
  if (Object.keys(errors).length || !hours.ok) return { ok: false, errors };
  return {
    ok: true,
    value: {
      queue, label, ringUserIds, ringTimeoutSeconds,
      hoursEnabled: hours.value.enabled, timezone: hours.value.timezone, weekly: hours.value.weekly,
    },
  };
}

export async function saveQueueSettings(q: Q, value: Omit<KsQueueSettings, "updatedAt">, userId: string | null): Promise<KsQueueSettings> {
  const { rows } = await q.query(
    `INSERT INTO ks_phone_queues (queue, label, ring_user_ids, ring_timeout_seconds, hours_enabled, timezone, weekly, updated_by_user_id, updated_at)
     VALUES ($1, $2, $3::uuid[], $4, $5, $6, $7::jsonb, $8::uuid, now())
     ON CONFLICT (queue) DO UPDATE SET
       label = EXCLUDED.label, ring_user_ids = EXCLUDED.ring_user_ids, ring_timeout_seconds = EXCLUDED.ring_timeout_seconds,
       hours_enabled = EXCLUDED.hours_enabled, timezone = EXCLUDED.timezone, weekly = EXCLUDED.weekly,
       updated_by_user_id = EXCLUDED.updated_by_user_id, updated_at = now()
     RETURNING queue, label, ring_user_ids::text[] AS ring_user_ids, ring_timeout_seconds, hours_enabled, timezone, weekly, updated_at`,
    [value.queue, value.label, value.ringUserIds, value.ringTimeoutSeconds, value.hoursEnabled, value.timezone, JSON.stringify(value.weekly), userId],
  );
  return rowToQueueSettings(value.queue, rows[0]);
}

/** Open now? Hours switched off = always open. */
export function queueIsOpen(settings: Pick<KsQueueSettings, "hoursEnabled" | "timezone" | "weekly">, now: Date = new Date()): boolean {
  if (!settings.hoursEnabled) return true;
  return isWithinCallHours({ enabled: true, timezone: isValidTimeZone(settings.timezone) ? settings.timezone : ALBERTA_TZ, weekly: settings.weekly }, now);
}

/** SQL for "this user may work Keystone": Admins, and staff whose silo access includes KS (same rule as the CRM). */
export const KS_STAFF_SQL = `(coalesce(u.active, true) = true
    AND lower(coalesce(u.role, '')) IN ('admin', 'staff', 'marketing')
    AND (lower(coalesce(u.role, '')) = 'admin' OR 'KS' = ANY(coalesce(u.silos, ARRAY[]::text[])) OR upper(coalesce(u.silo, '')) = 'KS'))`;

export type RingMember = { userId: string; identity: string };

/**
 * Who rings for this queue right now: the named ring group (or, with nobody named, every staff member with Keystone
 * access) who is ringable (signed in on the dialler / portal, not busy, not on a call). Per-person call hours are
 * applied by the caller (identitiesOutsideHours). Never throws: a failed lookup rings nobody (logged), and the caller
 * goes to voicemail.
 */
export async function ringGroup(q: Q, settings: Pick<KsQueueSettings, "ringUserIds">): Promise<RingMember[]> {
  try {
    const named = settings.ringUserIds.length > 0;
    const { rows } = await q.query(
      `SELECT DISTINCT ON (sp.twilio_identity) u.id::text AS user_id, sp.twilio_identity
         FROM users u JOIN staff_presence sp ON sp.user_id = u.id
        WHERE ${ringableStaffSql("sp", "u")}
          AND ${KS_STAFF_SQL}
          AND ($1::boolean = false OR u.id = ANY($2::uuid[]))
        ORDER BY sp.twilio_identity
        LIMIT ${KS_RING_GROUP_MAX}`,
      [named, settings.ringUserIds],
    );
    return rows.filter((r: any) => r.twilio_identity).map((r: any) => ({ userId: String(r.user_id), identity: String(r.twilio_identity) }));
  } catch (err) {
    console.warn("[ks-phone] ring group lookup failed; nobody rings", { message: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

/** The people to tell about a missed call / voicemail on this queue: the named group, else everyone with KS access. */
export async function queueAlertUserIds(q: Q, settings: Pick<KsQueueSettings, "ringUserIds">): Promise<string[]> {
  if (settings.ringUserIds.length) return [...settings.ringUserIds];
  try {
    const { rows } = await q.query(`SELECT u.id::text AS id FROM users u WHERE ${KS_STAFF_SQL} ORDER BY u.id LIMIT 50`, []);
    return rows.map((r: any) => String(r.id));
  } catch (err) {
    console.warn("[ks-phone] alert recipients lookup failed", { message: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

export type KsCaller = {
  found: boolean;
  contactId: string | null;
  contactName: string | null;
  companyId: string | null;
  companyName: string | null;
  supportLevel: string | null;
  stage: string | null;
};

const NO_CALLER: KsCaller = { found: false, contactId: null, contactName: null, companyId: null, companyName: null, supportLevel: null, stage: null };

/**
 * The Keystone CRM record behind a phone number: a KS contact by phone or second phone (a merged contact resolves to
 * the survivor; archived ones are skipped), else a KS company (licensee or lead) by its phone. Never a BF / BI / SLF
 * record. Throws on a database error; matchKsCallerSafe is the never-throws form for TwiML.
 */
export async function matchKsCaller(q: Q, phone: unknown): Promise<KsCaller> {
  const p10 = last10(phone);
  if (!p10) return NO_CALLER;
  const c = await q.query(
    `WITH hit AS (
       SELECT c.id, c.merged_into_id, c.created_at
         FROM contacts c
        WHERE c.silo = 'KS'
          AND (right(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g'), 10) = $1
               OR right(regexp_replace(coalesce(c.secondary_phone, ''), '[^0-9]', '', 'g'), 10) = $1)
     )
     SELECT x.id::text AS contact_id,
            NULLIF(TRIM(COALESCE(NULLIF(TRIM(x.name), ''), TRIM(COALESCE(x.first_name, '') || ' ' || COALESCE(x.last_name, '')))), '') AS contact_name,
            co.id::text AS company_id, co.name AS company_name, co.ks_support_level, coalesce(co.ks_stage, x.ks_stage) AS ks_stage
       FROM hit h
       JOIN contacts x ON x.id = coalesce(h.merged_into_id, h.id)
       LEFT JOIN companies co ON co.id = x.company_id AND co.silo = 'KS'
      WHERE x.silo = 'KS' AND x.merged_into_id IS NULL AND coalesce(x.status, '') <> 'archived'
      ORDER BY (x.company_id IS NOT NULL) DESC, h.created_at ASC
      LIMIT 1`,
    [p10],
  );
  const row = c.rows[0];
  if (row?.contact_id) {
    return {
      found: true,
      contactId: String(row.contact_id),
      contactName: row.contact_name && String(row.contact_name).toLowerCase() !== "unknown caller" ? String(row.contact_name) : null,
      companyId: row.company_id ? String(row.company_id) : null,
      companyName: row.company_name ? String(row.company_name) : null,
      supportLevel: row.ks_support_level ?? null,
      stage: row.ks_stage ?? null,
    };
  }
  const co = await q.query(
    `SELECT co.id::text AS company_id, co.name AS company_name, co.ks_support_level, co.ks_stage
       FROM companies co
      WHERE co.silo = 'KS' AND right(regexp_replace(coalesce(co.phone, ''), '[^0-9]', '', 'g'), 10) = $1
      ORDER BY co.created_at ASC
      LIMIT 1`,
    [p10],
  );
  const r = co.rows[0];
  if (r?.company_id) {
    return {
      found: true, contactId: null, contactName: null,
      companyId: String(r.company_id), companyName: r.company_name ? String(r.company_name) : null,
      supportLevel: r.ks_support_level ?? null, stage: r.ks_stage ?? null,
    };
  }
  return NO_CALLER;
}

export async function matchKsCallerSafe(q: Q, phone: unknown): Promise<KsCaller> {
  try {
    return await matchKsCaller(q, phone);
  } catch (err) {
    console.warn("[ks-phone] caller lookup failed", { message: err instanceof Error ? err.message : String(err) });
    return NO_CALLER;
  }
}

/** The caller card the dialler / portal shows while the call rings (Twilio <Client> parameters). */
export function ksCallerCard(caller: KsCaller, queue: KsQueue, from: string): { found: true; contactId?: string; name: string; company?: string; stage: string } {
  const line = `Keystone ${queue} line`;
  const name = caller.contactName ?? caller.companyName ?? `Keystone ${queue} call`;
  const company = caller.contactName ? caller.companyName : caller.companyName ? null : e164(from);
  return {
    found: true,
    ...(caller.contactId ? { contactId: caller.contactId } : {}),
    name,
    ...(company ? { company } : {}),
    stage: line,
  };
}
