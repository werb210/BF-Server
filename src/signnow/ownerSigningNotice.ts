// BF_SERVER_BLOCK_v461_SIGNING_NOTICE
// Owner 1 is the applicant and signs in the client mini-portal (CMP). When staff
// press Send on an unsigned application, Owner 1 is texted to sign in the CMP.
// That text was the whole notice: staff were never told where it went, and
// pressing Send again did nothing. This lets a second Send resend the text and
// reports who was texted so the portal can say. Owner 1 is never emailed; only
// additional owners get an email invite (see embeddedSigningSession).
import { dbQuery } from "../db.js";

export type SigningNotice = {
  name: string | null;
  phone: string | null;
  smsSent: boolean;
  resent: boolean;
  throttled: boolean;
  lastSentAt: string | null;
};

type Contact = { name: string | null; phone: string | null; lastSentAt: string | null };

const RESEND_MIN_SECONDS = 120;
const PORTAL = "client.boreal.financial";

function usablePhone(raw: string | null): string | null {
  const s = (raw ?? "").trim();
  const digits = s.replace(/\D/g, "");
  if (digits.length < 10) return null;
  return s.startsWith("+") ? s : `+1${digits.slice(-10)}`;
}

export async function owner1Contact(applicationId: string): Promise<Contact> {
  const r = await dbQuery<{ first: string | null; last: string | null; phone: string | null; sms_at: string | null }>(
    `SELECT metadata->'applicant'->>'firstName' AS first, metadata->'applicant'->>'lastName' AS last,
            metadata->'applicant'->>'phone' AS phone, metadata->>'owner1_signing_sms_at' AS sms_at
       FROM applications WHERE id::text = ($1)::text LIMIT 1`,
    [applicationId],
  );
  const row = r.rows[0];
  const name = [row?.first, row?.last].map((x) => (x ?? "").trim()).filter(Boolean).join(" ") || null;
  return { name, phone: usablePhone(row?.phone ?? null), lastSentAt: row?.sms_at ?? null };
}

// BF_SERVER_BLOCK_v464_SMS_DELIVERY - the latest signing text and what Twilio says
// happened to it (queued, sent, delivered, undelivered, failed) plus the error code.
export async function latestSigningSms(applicationId: string): Promise<{ to: string | null; status: string | null; errorCode: string | null; sentAt: string | null } | null> {
  const r = await dbQuery<{ to_number: string | null; status: string | null; error_code: string | null; created_at: string | null }>(
    `SELECT to_number, status, error_code, created_at FROM sms_deliveries
      WHERE application_id = $1 AND kind = 'owner1_signing'
      ORDER BY created_at DESC LIMIT 1`,
    [applicationId],
  );
  const row = r.rows[0];
  return row ? { to: row.to_number, status: row.status, errorCode: row.error_code, sentAt: row.created_at ? new Date(row.created_at).toISOString() : null } : null;
}

/** Who was texted to sign, as recorded - sends nothing. */
export async function describeOwner1Notice(applicationId: string): Promise<SigningNotice> {
  const c = await owner1Contact(applicationId);
  return { name: c.name, phone: c.phone, smsSent: Boolean(c.phone && c.lastSentAt), resent: false, throttled: false, lastSentAt: c.lastSentAt };
}

/** Text Owner 1 again to sign in the CMP, at most once every two minutes. */
export async function remindOwner1ToSign(applicationId: string, now: Date = new Date()): Promise<SigningNotice> {
  const c = await owner1Contact(applicationId);
  const last = c.lastSentAt ? Date.parse(c.lastSentAt) : NaN;
  if (Number.isFinite(last) && now.getTime() - last < RESEND_MIN_SECONDS * 1000) {
    return { name: c.name, phone: c.phone, smsSent: false, resent: false, throttled: true, lastSentAt: c.lastSentAt };
  }
  if (!c.phone) {
    console.warn(`[signnow] Owner 1 has no usable phone for app=${applicationId}; signing text not resent`);
    return { name: c.name, phone: null, smsSent: false, resent: false, throttled: false, lastSentAt: c.lastSentAt };
  }
  try {
    const first = c.name ? c.name.split(/\s+/)[0] : null;
    const { sendSms } = await import("../modules/notifications/sms.service.js");
    await sendSms({
      to: c.phone,
      message: `${first ? `Hi ${first},` : "Hi,"} your Boreal Financial application is ready for your signature. Sign in at ${PORTAL} with this phone number to review and sign. Reply STOP to opt out.`,
      track: { kind: "owner1_signing", applicationId }, // BF_SERVER_BLOCK_v464_SMS_DELIVERY
    });
    await dbQuery(
      `UPDATE applications SET metadata = COALESCE(metadata,'{}'::jsonb)
          || jsonb_build_object('owner1_signing_sms_at', to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'))
        WHERE id::text = ($1)::text`,
      [applicationId],
    );
    console.log(`[signnow] Owner 1 signing SMS re-sent for app=${applicationId}`);
    return { name: c.name, phone: c.phone, smsSent: true, resent: true, throttled: false, lastSentAt: now.toISOString() };
  } catch (e) {
    console.warn(`[signnow] Owner 1 signing SMS resend failed for app=${applicationId}: ${e instanceof Error ? e.message : String(e)}`);
    return { name: c.name, phone: c.phone, smsSent: false, resent: false, throttled: false, lastSentAt: c.lastSentAt };
  }
}
