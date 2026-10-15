// BF_SERVER_v809_SMS_UPDATES_CONSENT - the client's own choice to receive texts about their application.
// It is made with an unticked checkbox on the client app's sign-in screen (or later in the client portal's
// Details), kept per mobile number (last 10 digits) in sms_updates_consents. Automatic application texts -
// status updates, document requests, signing reminders - go only to numbers that said yes; everyone else is
// told by the Boreal app or by email. Staff can still text a client by hand from the portal.

// The exact wording of the checkbox (BF-client SMS_UPDATES_CONSENT_TEXT). Stored with the choice.
export const SMS_UPDATES_CONSENT_TEXT =
  "Text me updates about my application: status updates, document requests and signing reminders. Message frequency varies. Message and data rates may apply. Reply STOP to opt out, HELP for help. Not required to apply.";

export type SmsUpdatesSource = "sign_in" | "client_portal";

type Query = (sql: string, params: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;

export function phone10(raw: unknown): string {
  const d = String(raw ?? "").replace(/[^0-9]/g, "");
  return d.length >= 10 ? d.slice(-10) : "";
}

export const UPSERT_SMS_UPDATES_CONSENT_SQL = `
  INSERT INTO sms_updates_consents (phone10, consent, consent_text, source, updated_at)
  VALUES ($1, $2, $3, $4, now())
  ON CONFLICT (phone10) DO UPDATE
     SET consent = EXCLUDED.consent,
         consent_text = EXCLUDED.consent_text,
         source = EXCLUDED.source,
         updated_at = now()`;

export const SELECT_SMS_UPDATES_CONSENT_SQL = `SELECT consent FROM sms_updates_consents WHERE phone10 = $1 LIMIT 1`;

// SQL fragment for queries over contacts aliased "c": the contact's number said yes.
export const SMS_UPDATES_CONSENT_SQL = `EXISTS (
  SELECT 1 FROM sms_updates_consents suc
   WHERE suc.consent = true
     AND suc.phone10 = right(regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g'), 10)
)`;

async function defaultQuery(): Promise<Query> {
  const { pool } = await import("../db.js");
  return (sql, params) => pool.query(sql, params as any[]) as any;
}

// Records the client's choice. Never throws: a failed write is logged and must not block sign-in.
export async function recordSmsUpdatesConsent(
  phone: unknown,
  consent: boolean,
  source: SmsUpdatesSource,
  query?: Query,
): Promise<boolean> {
  const p10 = phone10(phone);
  if (!p10) return false;
  try {
    const q = query ?? (await defaultQuery());
    await q(UPSERT_SMS_UPDATES_CONSENT_SQL, [p10, consent, consent ? SMS_UPDATES_CONSENT_TEXT : null, source]);
    console.info("[sms-updates-consent] recorded", { phone10: p10.slice(0, 3) + "*******", consent, source });
    return true;
  } catch (err) {
    console.warn("[sms-updates-consent] record failed", { source, message: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

// null = the number never made a choice.
export async function getSmsUpdatesConsent(phone: unknown, query?: Query): Promise<boolean | null> {
  const p10 = phone10(phone);
  if (!p10) return null;
  const q = query ?? (await defaultQuery());
  const { rows } = await q(SELECT_SMS_UPDATES_CONSENT_SQL, [p10]);
  return rows[0] ? rows[0].consent === true : null;
}

// May an automatic application text go to this number? Only an explicit yes counts. A failed lookup is
// logged and treated as no: the client is then told by the app or email instead.
export async function smsUpdatesAllowed(phone: unknown, query?: Query): Promise<boolean> {
  try {
    return (await getSmsUpdatesConsent(phone, query)) === true;
  } catch (err) {
    console.warn("[sms-updates-consent] lookup failed; not texting", { message: err instanceof Error ? err.message : String(err) });
    return false;
  }
}
