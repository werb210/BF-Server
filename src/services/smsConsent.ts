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

// Everything the law and the carriers require before a marketing SMS may go out.
export const SMS_ELIGIBLE_SQL = `
      COALESCE(c.phone,'') <> ''
  AND COALESCE(c.sms_opt_out, false) = false
  AND COALESCE(c.marketing_opt_out, false) = false
  AND (c.line_type IS NULL OR c.line_type = 'mobile')
  AND ${CONSENT_SQL}
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
