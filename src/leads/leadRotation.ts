// BF_SERVER_v869_SETTINGS_PACK_LEAD_ROTATION - round-robin owner for new leads (Settings > Lead rotation, Admins).
//
// When on, a new contact from the chosen sources gets an owner in turn among the chosen people:
//   website   the website contact form and the credit readiness check
//   booking   a booking made on the team page (a booking on someone's own page is theirs)
//   form      an application started from the public form
// Whoever was assigned a lead least recently goes next; someone never assigned goes first. People marked away
// (by an Admin, or themselves under My Profile) and people no longer active are skipped. If everyone is away the lead
// is left without an owner and staff are not guessed at. Each assignment is logged and shows on the timeline.
// BF_SERVER_v869_SETTINGS_PACK - per silo: BF and BI each have their own rotation (people, sources, away list) and
// their own turn order. Boreal's public lead sources (website form, team booking page, public application) are BF.
import { readSetting, writeSetting, type Q } from "../settingsPack/common.js";

export const LEAD_SOURCES = ["website", "booking", "form"] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

export type LeadRotationSettings = {
  enabled: boolean;
  user_ids: string[];
  sources: Record<LeadSource, boolean>;
  away_user_ids: string[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ids = (v: unknown): string[] => (Array.isArray(v) ? Array.from(new Set(v.map(String).filter((x) => UUID.test(x)))).slice(0, 100) : []);

export function normalizeRotation(raw: unknown): LeadRotationSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const src = (r.sources && typeof r.sources === "object" ? r.sources : {}) as Record<string, unknown>;
  return {
    enabled: r.enabled === true,
    user_ids: ids(r.user_ids),
    sources: { website: src.website !== false, booking: src.booking !== false, form: src.form !== false },
    away_user_ids: ids(r.away_user_ids),
  };
}

export type RotationSilo = "BF" | "BI" | "SLF";
export const rotationSilo = (raw: unknown): RotationSilo => (raw === "BI" || raw === "SLF" ? raw : "BF");
const settingKey = (silo: RotationSilo) => `lead_rotation:${silo}`;

export async function rotationSettings(db: Q, silo: RotationSilo = "BF"): Promise<LeadRotationSettings> {
  return readSetting(db, settingKey(silo), normalizeRotation);
}
export async function saveRotationSettings(db: Q, v: LeadRotationSettings, actor: string | null, silo: RotationSilo = "BF"): Promise<void> {
  await writeSetting(db, settingKey(silo), v, actor);
}

/** Of the eligible people, who is next: least recently assigned first, never-assigned before anyone; ties keep the
 *  Admin's order. */
export function nextInTurn(eligible: string[], lastAssigned: Map<string, number>): string | null {
  if (!eligible.length) return null;
  return [...eligible].map((id, i) => ({ id, i, t: lastAssigned.get(id) ?? -1 }))
    .sort((a, b) => a.t - b.t || a.i - b.i)[0]!.id;
}

export async function eligibleUsers(db: Q, s: LeadRotationSettings): Promise<string[]> {
  if (!s.user_ids.length) return [];
  const r = await db.query(
    `SELECT id::text AS id FROM users
      WHERE id::text = ANY($1::text[]) AND COALESCE(active, true) AND COALESCE(disabled, false) = false AND deleted_at IS NULL`,
    [s.user_ids]);
  const active = new Set(r.rows.map((x) => String(x.id)));
  const away = new Set(s.away_user_ids);
  return s.user_ids.filter((id) => active.has(id) && !away.has(id));
}

/**
 * Gives a new lead an owner in turn. Only a contact with no owner is changed (or, for a team booking, one whose owner
 * is the person the booking landed on: replaceOwnerId). Returns the new owner, or null when rotation is off, does not
 * cover this source, nobody is available, or the contact already had an owner.
 */
export async function assignRotatingOwner(db: Q, contactId: string | null | undefined, source: LeadSource, opts: { replaceOwnerId?: string | null; silo?: RotationSilo } = {}): Promise<string | null> {
  if (!contactId) return null;
  const silo = rotationSilo(opts.silo);
  try {
    const s = await rotationSettings(db, silo);
    if (!s.enabled || !s.sources[source]) return null;
    const eligible = await eligibleUsers(db, s);
    if (!eligible.length) {
      console.warn("[lead-rotation] nobody available; lead left without an owner", { contactId, source });
      return null;
    }
    const last = await db.query(
      `SELECT user_id::text AS user_id, max(assigned_at) AS last_at FROM lead_rotation_assignments WHERE user_id::text = ANY($1::text[]) AND silo = $2 GROUP BY 1`,
      [eligible, silo]);
    const pick = nextInTurn(eligible, new Map(last.rows.map((x) => [String(x.user_id), new Date(x.last_at).getTime()] as [string, number])));
    if (!pick) return null;
    const upd = await db.query(
      `UPDATE contacts SET owner_id = $2::uuid, updated_at = now()
        WHERE id::text = $1 AND (owner_id IS NULL OR ($3::text IS NOT NULL AND owner_id::text = $3)) RETURNING id`,
      [contactId, pick, opts.replaceOwnerId ?? null]);
    if (!upd.rows.length) return null;
    await db.query(`INSERT INTO lead_rotation_assignments (contact_id, user_id, source, silo) VALUES ($1::uuid, $2::uuid, $3, $4)`, [contactId, pick, source, silo]);
    await db.query(`INSERT INTO crm_timeline_events (contact_id, event_type, payload) VALUES ($1::uuid, 'owner_assigned', $2::jsonb)`,
      [contactId, JSON.stringify({ owner_id: pick, by: "lead_rotation", source, silo })]);
    return pick;
  } catch (err) {
    // A rotation failure must not lose the lead itself (it is already saved): logged, and the lead keeps no owner.
    console.error("[lead-rotation] assignment failed", { contactId, source, message: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

export async function recentAssignments(db: Q, limit = 20, silo: RotationSilo = "BF"): Promise<Array<{ contact_id: string; user_id: string; source: string; assigned_at: string; contact_name: string | null }>> {
  const r = await db.query(
    `SELECT a.contact_id::text AS contact_id, a.user_id::text AS user_id, a.source, a.assigned_at, c.name AS contact_name
       FROM lead_rotation_assignments a LEFT JOIN contacts c ON c.id = a.contact_id
      WHERE a.silo = $2
      ORDER BY a.assigned_at DESC LIMIT $1`, [limit, silo]);
  return r.rows as any;
}
