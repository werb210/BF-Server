// BF_SERVER_SMS_CONSENT_v1 - CASL consent + Canada-only gating for marketing SMS.
//
// CASL puts the burden of proof on the SENDER. Consent is either express (a checkbox,
// no expiry) or implied, and implied consent EXPIRES:
//   - existing business relationship (they transacted): 2 years
//   - inquiry / application:                            6 MONTHS
// The old send filtered on sms_opt_out alone and ignored marketing_opt_out entirely,
// so a contact who opted out of all marketing still got texted.

// Canadian NANP area codes. A +1 number is NOT necessarily Canadian, and nothing in the
// SMS path checked country at all -- US numbers in the list were being sent a
// CASL footer and no TCPA compliance.
const CANADA_NPA = new Set([
  "204","226","236","249","250","263","289","306","343","354","365","367","368","382",
  "387","403","416","418","428","431","437","438","450","468","474","506","514","519",
  "548","579","581","584","587","604","613","639","647","672","683","705","709","742",
  "753","778","780","782","807","819","825","867","873","879","902","905",
]);

export function isCanadianMobile(phone: string | null | undefined): boolean {
  if (!phone) return false;
  const d = String(phone).replace(/[^0-9]/g, "");
  const nat = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  if (nat.length !== 10) return false;
  return CANADA_NPA.has(nat.slice(0, 3));
}

// SQL fragment: a contact we may lawfully send marketing SMS to right now.
// Used identically by the count, the segment list, and the send, so the number the
// portal shows is the number that actually gets messaged.
export const CONSENT_SQL = `(
     COALESCE(c.sms_consent, false) = true
  OR (c.consent_basis = 'implied_transaction' AND c.consent_at > now() - interval '2 years')
  OR (c.consent_basis = 'implied_inquiry'     AND c.consent_at > now() - interval '6 months')
)`;

// BF_SERVER_v808_TOLLFREE_MARKETING - when marketing texts go out from the toll-free number (TWILIO_SMS_FROM is an
// 8XX number and TWILIO_TOLLFREE_MARKETING=on), only people who ticked the optional "Text me offers" box may be
// texted, so the counts and lists on the SMS screens show exactly those people. Settings are read at start-up
// (changing them in Azure restarts the server).
function tollFreeMarketingSender(): boolean {
  const d = String(process.env.TWILIO_SMS_FROM ?? "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  return /^8(00|33|44|55|66|77|88)\d{7}$/.test(d) && String(process.env.TWILIO_TOLLFREE_MARKETING ?? "").trim().toLowerCase() === "on";
}
export const MARKETING_OPTIN_SQL = `(COALESCE(c.sms_consent, false) = true AND c.consent_source = 'marketing_sms_optin')`;

// Everything the law and the carriers require before a marketing SMS may go out.
export const SMS_ELIGIBLE_SQL = `
      COALESCE(c.phone,'') <> ''
  AND COALESCE(c.sms_opt_out, false) = false
  AND COALESCE(c.marketing_opt_out, false) = false
  AND (c.line_type IS NULL OR c.line_type = 'mobile')
  AND ${CONSENT_SQL}${tollFreeMarketingSender() ? `
  AND ${MARKETING_OPTIN_SQL}` : ""}
`;

// BF_SERVER_SMS_CASCADE_COMPLETE_v12
// A contact we can reach by marketing EMAIL. Deliberately narrower than SMS:
// email needs no CASL express/implied timer here because the fallback email is
// only ever sent as part of a campaign the contact is already in scope for, and
// marketing_opt_out is honoured. Mirrors the predicate the cascade worker and
// the inline fallback both already use.
export const EMAIL_FALLBACK_ELIGIBLE_SQL = `(
      COALESCE(c.email,'') <> ''
  AND COALESCE(c.marketing_opt_out, false) = false
)`;

// Who a campaign WITH a fallback email can actually reach, by either channel.
//
// The blast previously selected on SMS_ELIGIBLE_SQL alone, so a contact with no
// phone at all - or one who opted out of SMS but not email - was excluded from
// the query entirely and received nothing. The email fallback in runSmsSend
// could only ever fire for contacts already inside the SMS-eligible set who
// then failed the Canadian-mobile or line-type test at send time.
export const CAMPAIGN_ELIGIBLE_SQL = `(
     (${SMS_ELIGIBLE_SQL})
  OR ${EMAIL_FALLBACK_ELIGIBLE_SQL}
)`;

// BF_SERVER_v808_MARKETING_OPTIN - the exact wording of the optional "Text me offers" box on the client app's
// Step 6 (BF-client MARKETING_SMS_OPTIN_TEXT). Stored as consent_text with consent_source 'marketing_sms_optin';
// only these contacts may get marketing texts from the toll-free number.
export const MARKETING_SMS_OPTIN_TEXT =
  "Optional: Text me news, tips and offers from Boreal Financial. Up to 4 messages per month. Message and data rates may apply. Reply STOP to opt out at any time. Not required to apply.";
export const MARKETING_SMS_OPTIN_SOURCE = "marketing_sms_optin";

// BF_SERVER_APPLICANT_CONSENT_v728 - starting an application is an inquiry, which gives
// implied consent for 6 months (CASL). Applicant contacts were created with no consent
// recorded at all unless they finished Step 6 with the box ticked, so everyone who
// started but didn't finish was invisible to the SMS screen. This records the inquiry
// without ever downgrading express consent or a client's 2-year transaction consent.
export const RECORD_INQUIRY_CONSENT_SQL = `
  UPDATE contacts
     SET consent_basis  = CASE WHEN COALESCE(sms_consent,false) OR consent_basis IN ('express','implied_transaction') THEN consent_basis ELSE 'implied_inquiry' END,
         consent_at     = CASE WHEN COALESCE(sms_consent,false) OR consent_basis IN ('express','implied_transaction') THEN consent_at ELSE now() END,
         consent_source = CASE WHEN COALESCE(sms_consent,false) OR consent_basis IN ('express','implied_transaction') THEN consent_source ELSE 'application_started' END,
         updated_at     = now()
   WHERE id = $1`;

// BF_SERVER_v789_CASL_EXPRESS_CONSENT - the public website forms (contact / lead,
// credit readiness, booking, Maya talk-to-a-human) show a CASL consent checkbox.
// Express consent is recorded on the contact, in the same columns the applicant
// consent work uses (sms_consent / consent_basis / consent_at / consent_source),
// plus the exact wording the visitor agreed to (consent_text). Only an explicit
// boolean true counts: absent, false, "true" or 1 record nothing.
export type ExpressCaslConsent = { text: string | null; at: Date };

const CASL_TEXT_MAX = 2000;
const CASL_CLOCK_SKEW_MS = 5 * 60 * 1000;
const CASL_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function parseExpressCaslConsent(body: unknown, now: Date = new Date()): ExpressCaslConsent | null {
  const b = (body ?? {}) as Record<string, unknown>;
  if (b.casl_consent !== true) return null;
  const rawText = typeof b.casl_consent_text === "string" ? b.casl_consent_text.trim() : "";
  const text = rawText ? rawText.slice(0, CASL_TEXT_MAX) : null;
  // The browser's timestamp is kept when it is plausible (not in the future, not
  // older than a day); otherwise the server's clock is the record.
  let at = now;
  if (typeof b.casl_consent_at === "string" || typeof b.casl_consent_at === "number") {
    const d = new Date(b.casl_consent_at as string | number);
    const t = d.getTime();
    if (Number.isFinite(t) && t <= now.getTime() + CASL_CLOCK_SKEW_MS && t >= now.getTime() - CASL_MAX_AGE_MS) at = d;
  }
  return { text, at };
}

export const RECORD_EXPRESS_CASL_CONSENT_BY_ID_SQL = `
  UPDATE contacts
     SET sms_consent    = true,
         consent_basis  = 'express',
         consent_at     = $2::timestamptz,
         consent_source = $3,
         consent_text   = $4,
         updated_at     = now()
   WHERE id::text = ($1)::text`;

export const RECORD_EXPRESS_CASL_CONSENT_BY_EMAIL_SQL = `
  UPDATE contacts
     SET sms_consent    = true,
         consent_basis  = 'express',
         consent_at     = $2::timestamptz,
         consent_source = $3,
         consent_text   = $4,
         updated_at     = now()
   WHERE silo = $5 AND lower(email) = lower($1)`;

type ConsentQuery = (sql: string, params: unknown[]) => Promise<{ rowCount?: number | null }>;

// Records express consent on one contact (by id) or on the silo's contacts with
// that email. Never throws: a consent write failure is logged and must not fail
// the visitor's submission. Returns whether a contact row was updated.
export async function recordExpressCaslConsent(
  query: ConsentQuery,
  target: { contactId?: string | null; email?: string | null; silo?: string | null },
  consent: ExpressCaslConsent | null,
  source: string,
): Promise<boolean> {
  if (!consent) return false;
  const at = consent.at.toISOString();
  const silo = String(target.silo ?? "BF").toUpperCase();
  try {
    if (target.contactId) {
      const r = await query(RECORD_EXPRESS_CASL_CONSENT_BY_ID_SQL, [target.contactId, at, source, consent.text]);
      return Number(r.rowCount ?? 0) > 0;
    }
    const email = String(target.email ?? "").trim();
    if (email) {
      const r = await query(RECORD_EXPRESS_CASL_CONSENT_BY_EMAIL_SQL, [email, at, source, consent.text, silo]);
      return Number(r.rowCount ?? 0) > 0;
    }
    console.warn("[casl-consent] no contact to record express consent on", { source });
    return false;
  } catch (err) {
    console.warn("[casl-consent] record failed", { source, message: err instanceof Error ? err.message : String(err) });
    return false;
  }
}
