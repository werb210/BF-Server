// BF_SERVER_v821_DIALER - the caller card: who is calling, from the CRM, for the iPhone dialler's incoming-call UI.
//   GET /api/voice/caller-card?phone=<E.164>  (staff, silo from X-Silo)
//   -> { found, contactId?, name?, company?, stage?, applicationId?, lastNote? (<=140), lastContactAt?, tags? }
// and the same facts as Twilio <Client> custom parameters (callerName, callerCompany, callerStage, contactId) on
// inbound calls that ring the app, so CallKit can show them before the app has fetched anything.
// Read-only: a lookup never creates a contact.
type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

export type CallerCard = {
  found: boolean;
  contactId?: string;
  name?: string;
  company?: string;
  stage?: string;
  applicationId?: string;
  lastNote?: string;
  lastContactAt?: string;
  tags?: string[];
};

export const LAST_NOTE_MAX = 140;
/** Twilio custom parameters travel in the call invite; keep each value short. */
export const CLIENT_PARAM_MAX = 80;

export function toE164(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (/^\+[1-9]\d{7,14}$/.test(s)) return s;
  const d = s.replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return null;
}

function clip(value: unknown, max: number): string {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** The portal shows pipeline_state as-is ("In Review", "Off to Lender"); legacy lower-case values are title-cased. */
export function stageLabel(raw: unknown): string | undefined {
  const s = String(raw ?? "").trim();
  if (!s) return undefined;
  if (/[A-Z]/.test(s)) return s;
  return s.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export const CALLER_CARD_SQL = `
  SELECT c.id::text AS contact_id,
         NULLIF(TRIM(COALESCE(NULLIF(TRIM(c.name), ''), TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')))), '') AS name,
         COALESCE(NULLIF(TRIM(co.name), ''), NULLIF(TRIM(c.company_name), '')) AS company,
         COALESCE(c.tags, '{}'::text[]) AS tags,
         app.id::text AS application_id, app.pipeline_state, app.business_name,
         note.body AS last_note,
         GREATEST(msg.at, calls.at, conf.at) AS last_contact_at
    FROM contacts c
    LEFT JOIN companies co ON co.id = c.company_id
    LEFT JOIN LATERAL (
      SELECT a.id, a.pipeline_state,
             COALESCE(NULLIF(TRIM(a.business_legal_name), ''), NULLIF(TRIM(a.name), '')) AS business_name
        FROM applications a
       WHERE a.contact_id = c.id
       ORDER BY a.updated_at DESC NULLS LAST
       LIMIT 1
    ) app ON true
    LEFT JOIN LATERAL (
      SELECT n.body FROM crm_notes n
       WHERE n.contact_id = c.id AND COALESCE(n.is_deleted, false) = false
       ORDER BY n.created_at DESC LIMIT 1
    ) note ON true
    LEFT JOIN LATERAL (
      SELECT max(m.created_at)::timestamptz AS at FROM communications_messages m WHERE m.contact_id = c.id
    ) msg ON true
    LEFT JOIN LATERAL (
      SELECT max(cl.created_at) AS at FROM call_logs cl WHERE cl.contact_id = c.id OR cl.crm_contact_id = c.id
    ) calls ON true
    LEFT JOIN LATERAL (
      SELECT max(cf.created_at) AS at FROM conferences cf WHERE cf.contact_id = c.id::text
    ) conf ON true
   WHERE c.phone IS NOT NULL
     AND right(regexp_replace(c.phone, '[^0-9]', '', 'g'), 10) = $1
     AND c.merged_into_id IS NULL
     AND ($2::text IS NULL OR c.silo = $2)
   ORDER BY c.updated_at DESC NULLS LAST, c.created_at DESC NULLS LAST
   LIMIT 1`;

/** The CRM card for a phone number in a silo (null silo = any). Throws on a database error; callers decide. */
export async function callerCardFor(q: Q, phone: unknown, silo: string | null): Promise<CallerCard> {
  const e164 = toE164(phone);
  if (!e164) return { found: false };
  const last10 = e164.replace(/\D/g, "").slice(-10);
  if (last10.length !== 10) return { found: false };
  const { rows } = await q.query(CALLER_CARD_SQL, [last10, silo]);
  const r = rows[0];
  if (!r?.contact_id) return { found: false };
  const card: CallerCard = { found: true, contactId: String(r.contact_id) };
  const name = r.name && String(r.name).trim().toLowerCase() !== "unknown caller" ? String(r.name).trim() : "";
  if (name) card.name = name;
  const company = String(r.company ?? "").trim() || String(r.business_name ?? "").trim();
  if (company) card.company = company;
  const stage = r.application_id ? stageLabel(r.pipeline_state) : undefined;
  if (stage) card.stage = stage;
  if (r.application_id) card.applicationId = String(r.application_id);
  if (r.last_note && String(r.last_note).trim()) card.lastNote = clip(r.last_note, LAST_NOTE_MAX);
  if (r.last_contact_at) card.lastContactAt = new Date(r.last_contact_at).toISOString();
  card.tags = Array.isArray(r.tags) ? r.tags.map(String).filter(Boolean) : [];
  return card;
}

/** Card lookup for TwiML: never throws (logged), never delays the call beyond one query. */
export async function callerCardForCall(q: Q, from: unknown, silo: string | null = null): Promise<CallerCard | null> {
  if (!toE164(from)) return null;
  try {
    const card = await callerCardFor(q, from, silo);
    return card.found ? card : null;
  } catch (err: any) {
    console.warn("[caller_card] lookup for TwiML failed", { message: err?.message });
    return null;
  }
}

/** The <Client> <Parameter>s for a matched caller (only the fields that have a value). */
export function clientParameters(card: CallerCard | null): Array<{ name: string; value: string }> {
  if (!card?.found) return [];
  const out: Array<{ name: string; value: string }> = [];
  const add = (name: string, value: unknown) => {
    const v = clip(value, CLIENT_PARAM_MAX);
    if (v) out.push({ name, value: v });
  };
  add("callerName", card.name);
  add("callerCompany", card.company);
  add("callerStage", card.stage);
  add("contactId", card.contactId);
  return out;
}

/**
 * Adds a <Client> to a <Dial>. With a matched caller (or noun attributes) it uses the <Identity> + <Parameter> form;
 * otherwise the plain <Client>identity</Client> it always was.
 */
export function dialClient(dial: any, identity: string, card: CallerCard | null, attrs: Record<string, unknown> = {}): void {
  const params = clientParameters(card);
  if (!params.length) {
    if (Object.keys(attrs).length) dial.client(attrs, identity);
    else dial.client(identity);
    return;
  }
  const client = dial.client(attrs);
  client.identity(identity);
  for (const p of params) client.parameter(p);
}
