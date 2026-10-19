// BF_SERVER_v828_APPLICATION_ORIGIN
// Where an application came from, for the "Where this came from" panel at the top of the application. Files from a
// partner are ordinary applications on the pipeline; this panel is the only difference:
//   lender   - a file a lender declined and sent us (lender_referrals), with Accept / Decline until decided
//   broker   - a partner broker's file (applications.metadata.broker_import), with the commission split
//   referrer - a client a referral partner sent us (the application's contact has a referrer_id)
// null for everything else (website, Maya, staff-entered).
import { pool } from "../db.js";
import { referralForApplication } from "./lenderReferrals/lenderReferrals.js";

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

export type ApplicationOrigin =
  | { kind: "lender"; partner: string; sentAt: string | null; referral: Record<string, unknown> }
  | { kind: "broker"; partner: string; sentAt: string | null; zipName: string | null; uploadedBy: string | null;
      split: { borealPct: number | null; partnerPct: number | null; terms: string | null; status: string | null; payoutAmount: number | null; payoutPaidOn: string | null } | null }
  | { kind: "referrer"; partner: string; company: string | null; email: string | null; phone: string | null; sentAt: string | null };

const num = (v: unknown): number | null => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const text = (v: unknown): string | null => (v === null || v === undefined || String(v).trim() === "" ? null : String(v));
const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);

export async function applicationOrigin(applicationId: string, db: Q = pool): Promise<ApplicationOrigin | null> {
  const referral = await referralForApplication(applicationId, db);
  if (referral) return { kind: "lender", partner: text(referral.lender_name) ?? "Lender", sentAt: iso(referral.created_at), referral };

  const app = await db.query(
    `SELECT a.metadata->'broker_import'->>'broker_name' AS broker_name,
            a.metadata->'broker_import'->>'zip_name' AS zip_name,
            a.metadata->'broker_import'->>'uploaded_by' AS uploaded_by,
            bi.created_at AS imported_at,
            d.boreal_pct, d.broker_pct, d.terms, d.status AS split_status, d.payout_amount, d.payout_paid_on,
            ref.first_name AS ref_first, ref.last_name AS ref_last, ref.company_name AS ref_company, ref.email AS ref_email,
            COALESCE(ref.phone_number, ref.phone) AS ref_phone, c.created_at AS contact_created_at
       FROM applications a
       LEFT JOIN broker_imports bi ON bi.id::text = a.metadata->'broker_import'->>'import_id'
       LEFT JOIN broker_deal_confirmations d ON d.application_id = a.id::text
       LEFT JOIN contacts c ON c.id = a.contact_id
       LEFT JOIN users ref ON ref.id = c.referrer_id
      WHERE a.id::text = $1
      LIMIT 1`,
    [applicationId],
  );
  const row = app.rows[0];
  if (!row) return null;
  if (text(row.broker_name)) {
    const hasSplit = row.split_status != null || row.boreal_pct != null || row.broker_pct != null || row.terms != null;
    return {
      kind: "broker",
      partner: String(row.broker_name),
      sentAt: iso(row.imported_at),
      zipName: text(row.zip_name),
      uploadedBy: text(row.uploaded_by),
      split: hasSplit ? {
        borealPct: num(row.boreal_pct), partnerPct: num(row.broker_pct), terms: text(row.terms), status: text(row.split_status),
        payoutAmount: num(row.payout_amount), payoutPaidOn: text(row.payout_paid_on),
      } : null,
    };
  }
  const refName = [text(row.ref_first), text(row.ref_last)].filter(Boolean).join(" ") || text(row.ref_company);
  if (refName) {
    return { kind: "referrer", partner: refName, company: text(row.ref_company), email: text(row.ref_email), phone: text(row.ref_phone), sentAt: iso(row.contact_created_at) };
  }
  return null;
}
