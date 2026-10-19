// BF_SERVER_v825_LENDER_REFERRALS
// Lenders send Boreal the files they declined ("dead files") from the lender portal: one zip per client, several
// at a time. Nothing reaches the client until Boreal staff accept the file:
//   upload    -> lender_referrals row, status 'pending', the zip kept in the row. No application, no CRM contact,
//                no automation, no email or SMS.
//   accept    -> the zip goes through the same import as a partner broker's file (draft application, documents filed,
//                application form read). The referral share is recorded as an agreed split: a complete package earns
//                the lender 50% of Boreal's fee, an incomplete one none. Then the client is texted to sign in. The
//                text never names the lender.
//   decline   -> the zip is deleted; the client is never contacted.
// The lender sees status only: never which lenders the file went to or what they offered.
import { pool } from "../../db.js";

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

export const LENDER_REFERRAL_MAX_FILES = 10;
export const LENDER_REFERRAL_MAX_BYTES = 50 * 1024 * 1024;
export const REFERRAL_SHARE_PCT = 50;

export class LenderReferralError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

export type ReferralDetails = {
  businessName: string;
  clientName: string | null;
  clientPhone: string;
  requestedAmount: number | null;
  declineReason: string | null;
};

function text(value: unknown, max: number): string | null {
  const s = typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
  return s ? s.slice(0, max) : null;
}

export function toE164(value: unknown): string | null {
  const d = String(value ?? "").replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return null;
}

/** One file's details from the upload form. Throws a LenderReferralError naming what is missing. */
export function parseReferralDetails(raw: unknown): ReferralDetails {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const businessName = text(r.business_name ?? r.businessName, 200);
  if (!businessName) throw new LenderReferralError("business_name_required", "Enter the business name.");
  const clientPhone = toE164(r.client_phone ?? r.clientPhone);
  if (!clientPhone) throw new LenderReferralError("client_phone_required", "Enter the client's 10-digit cell number.");
  if (r.consent !== true && r.consent !== "true" && r.consent !== "1") {
    throw new LenderReferralError("consent_required", "Confirm the client agreed to be referred to Boreal Financial.");
  }
  const amountRaw = r.requested_amount ?? r.requestedAmount;
  const amount = amountRaw === null || amountRaw === undefined || amountRaw === "" ? null : Number(String(amountRaw).replace(/[$,\s]/g, ""));
  if (amount !== null && (!Number.isFinite(amount) || amount < 0)) {
    throw new LenderReferralError("bad_amount", "Enter the amount as a number, or leave it blank.");
  }
  return {
    businessName,
    clientName: text(r.client_name ?? r.clientName, 200),
    clientPhone,
    requestedAmount: amount === null ? null : Math.round(amount * 100) / 100,
    declineReason: text(r.decline_reason ?? r.declineReason, 2000),
  };
}

const FINAL_FUNDED = /^(funded|accepted)$/;
const FINAL_CLOSED = /^(declined|rejected|closed|withdrawn|lost|cancelled|canceled)$/;

/** What the lender sees for a file. Status only. */
export function referralProgress(r: { status: string; pipeline_state?: string | null }): string {
  if (r.status === "pending" || r.status === "accepting") return "Under review";
  if (r.status === "declined") return "Not accepted";
  const s = String(r.pipeline_state ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (s === "draft") return "Accepted - waiting for the client";
  if (FINAL_FUNDED.test(s)) return "Funded";
  if (FINAL_CLOSED.test(s)) return "Closed";
  if (s === "offer") return "Approved";
  if (s === "off_to_lender") return "Submitted to lenders";
  return "Client signed in - in progress";
}

/** The lender's share, as the lender portal shows it. */
export function referralShare(r: { status: string; complete_package?: boolean | null }): string {
  if (r.status !== "accepted") return "-";
  return r.complete_package ? `${REFERRAL_SHARE_PCT}% of Boreal's fee` : "None (incomplete package)";
}

export function clientInviteText(firstName: string | null, appUrl: string): string {
  const hi = firstName && firstName.trim() ? `Hi ${firstName.trim()}, ` : "Hi, ";
  return `${hi}Boreal Financial has your business financing application ready. To check it and finish, sign in with this mobile number at ${appUrl}`;
}

export async function lenderName(lenderId: string, db: Q = pool): Promise<string> {
  const r = await db.query(`SELECT name FROM lenders WHERE id::text = $1 LIMIT 1`, [lenderId]);
  return String(r.rows[0]?.name ?? "").trim() || "Lender";
}

/** Saves one uploaded zip as a pending referral. */
export async function saveReferral(
  input: { lenderId: string; lenderName: string; uploadedBy: string; zipName: string; zip: Buffer; details: ReferralDetails },
  db: Q = pool,
): Promise<{ id: string; fileNames: string[] }> {
  const { readZip, ZipError } = await import("../brokerImport/zip.js");
  let names: string[];
  try {
    names = readZip(input.zip).map((e) => e.name);
  } catch (e) {
    if (e instanceof ZipError) throw new LenderReferralError("bad_zip", e.message);
    throw e;
  }
  if (names.length === 0) throw new LenderReferralError("empty_zip", "The zip has no files in it.");
  const dup = await db.query(
    `SELECT id FROM lender_referrals
      WHERE lender_id = $1 AND status IN ('pending', 'accepting') AND client_phone = $2
      LIMIT 1`,
    [input.lenderId, input.details.clientPhone],
  );
  if (dup.rows[0]) throw new LenderReferralError("already_sent", "You already sent a file for this client. Boreal is reviewing it.", 409);
  const d = input.details;
  const r = await db.query(
    `INSERT INTO lender_referrals
       (lender_id, lender_name, uploaded_by, business_name, client_name, client_phone, requested_amount, decline_reason,
        zip_name, zip_data, zip_size, file_names, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, 'pending')
     RETURNING id::text AS id`,
    [input.lenderId, input.lenderName, input.uploadedBy, d.businessName, d.clientName, d.clientPhone, d.requestedAmount,
      d.declineReason, input.zipName.slice(0, 300), input.zip, input.zip.length, JSON.stringify(names)],
  );
  return { id: String(r.rows[0].id), fileNames: names };
}

export async function listForLender(lenderId: string, db: Q = pool): Promise<any[]> {
  const r = await db.query(
    `SELECT r.id::text AS id, r.business_name, r.client_name, r.requested_amount, r.zip_name, r.status, r.complete_package,
            r.created_at, r.decided_at, a.pipeline_state, d.payout_amount, d.payout_paid_on
       FROM lender_referrals r
       LEFT JOIN applications a ON a.id::text = r.application_id
       LEFT JOIN broker_deal_confirmations d ON d.application_id = r.application_id
      WHERE r.lender_id = $1
      ORDER BY r.created_at DESC
      LIMIT 300`,
    [lenderId],
  );
  return r.rows.map((row) => ({
    id: row.id,
    business_name: row.business_name,
    client_name: row.client_name,
    requested_amount: row.requested_amount,
    zip_name: row.zip_name,
    sent_at: row.created_at,
    progress: referralProgress(row),
    share: referralShare(row),
    payout_amount: row.complete_package ? row.payout_amount ?? null : null,
    payout_paid_on: row.complete_package ? row.payout_paid_on ?? null : null,
  }));
}

export async function listForStaff(db: Q = pool): Promise<any[]> {
  const r = await db.query(
    `SELECT r.id::text AS id, r.lender_id, r.lender_name, r.business_name, r.client_name, r.client_phone, r.requested_amount,
            r.decline_reason, r.zip_name, r.zip_size, r.file_names, r.status, r.complete_package, r.decision_note,
            r.decided_by, r.decided_at, r.application_id, r.client_texted_at, r.created_at, a.pipeline_state,
            (r.zip_data IS NOT NULL) AS has_zip
       FROM lender_referrals r
       LEFT JOIN applications a ON a.id::text = r.application_id
      ORDER BY (r.status = 'pending') DESC, r.created_at DESC
      LIMIT 300`,
  );
  return r.rows.map((row) => ({ ...row, progress: referralProgress(row) }));
}

export async function referralZip(id: string, db: Q = pool): Promise<{ name: string; data: Buffer } | null> {
  const r = await db.query(`SELECT zip_name, zip_data FROM lender_referrals WHERE id::text = $1 LIMIT 1`, [id]);
  const row = r.rows[0];
  if (!row?.zip_data) return null;
  return { name: String(row.zip_name || "file.zip"), data: Buffer.from(row.zip_data) };
}

export async function declineReferral(id: string, staffId: string | null, note: string | null, db: Q = pool): Promise<void> {
  const r = await db.query(
    `UPDATE lender_referrals
        SET status = 'declined', decision_note = $3, decided_by = $2, decided_at = now(), zip_data = NULL, updated_at = now()
      WHERE id::text = $1 AND status = 'pending'
      RETURNING id`,
    [id, staffId, note],
  );
  if (!r.rows[0]) throw new LenderReferralError("not_pending", "This file was already accepted or declined.", 409);
}

type ImportFn = (opts: { zip: Buffer; zipName: string; brokerName: string; uploadedBy: string | null; applicantPhone?: string | null }) =>
  Promise<{ importId: string; applicationId: string; businessName: string | null; warnings: string[]; prefill: any }>;
type SmsFn = (args: { to: string; message: string; track?: any }) => Promise<unknown>;

export type AcceptResult = { applicationId: string; texted: boolean; warnings: string[] };

/** Accept: import the file, record the referral share, then text the client. */
export async function acceptReferral(
  id: string,
  opts: { staffId: string | null; completePackage: boolean; note: string | null },
  deps: { db?: Q; importZip?: ImportFn; sendSms?: SmsFn; appUrl?: string } = {},
): Promise<AcceptResult> {
  const db = deps.db ?? pool;
  // Claim the row first so two clicks never import the file twice.
  const claimed = await db.query(
    `UPDATE lender_referrals SET status = 'accepting', updated_at = now()
      WHERE id::text = $1 AND status = 'pending' AND zip_data IS NOT NULL
      RETURNING id::text AS id, lender_id, lender_name, business_name, client_name, client_phone, requested_amount, zip_name, zip_data`,
    [id],
  );
  const row = claimed.rows[0];
  if (!row) throw new LenderReferralError("not_pending", "This file was already accepted or declined.", 409);

  let imported: Awaited<ReturnType<ImportFn>>;
  try {
    const importZip = deps.importZip ?? (await import("../brokerImport/importBrokerFile.js")).importBrokerZip;
    imported = await importZip({
      zip: Buffer.from(row.zip_data),
      zipName: String(row.zip_name),
      brokerName: String(row.lender_name || "Lender"),
      uploadedBy: "lender:" + String(row.lender_id),
      applicantPhone: row.client_phone,
    });
  } catch (error) {
    await db.query(`UPDATE lender_referrals SET status = 'pending', updated_at = now() WHERE id::text = $1`, [id]);
    const { BrokerImportError } = await import("../brokerImport/importBrokerFile.js");
    if (error instanceof BrokerImportError) throw new LenderReferralError(error.code, error.message, error.status);
    throw error;
  }

  const share = opts.completePackage ? REFERRAL_SHARE_PCT : 0;
  // The lender's name stays for staff (pipeline label); the client app shows "the documents you provided".
  await db.query(
    `UPDATE applications
        SET name = CASE WHEN $3::boolean THEN $4 ELSE name END,
            requested_amount = COALESCE(requested_amount, $5::numeric),
            metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('lender_referral', jsonb_build_object(
              'referral_id', $2::text, 'lender_id', $6::text, 'lender_name', $7::text, 'complete_package', $8::boolean)),
            updated_at = now()
      WHERE id::text = $1`,
    [imported.applicationId, id, !imported.businessName, row.business_name, row.requested_amount, String(row.lender_id),
      String(row.lender_name || "Lender"), opts.completePackage],
  );
  await db.query(
    `INSERT INTO broker_deal_confirmations
       (application_id, broker_name, boreal_pct, broker_pct, terms, notes, agreed_by_broker, agreed_on, recorded_by, status, accepted_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'Lender referral terms', CURRENT_DATE, $7, 'accepted', now())
     ON CONFLICT (application_id) DO NOTHING`,
    [imported.applicationId, String(row.lender_name || "Lender"), 100 - share, share,
      opts.completePackage ? `Lender referral, complete package: ${REFERRAL_SHARE_PCT}% of Boreal's fee` : "Lender referral, incomplete package: no referral share",
      opts.note, opts.staffId],
  );
  await db.query(
    `UPDATE lender_referrals
        SET status = 'accepted', complete_package = $2, decision_note = $3, decided_by = $4, decided_at = now(),
            application_id = $5, import_id = $6, zip_data = NULL, updated_at = now()
      WHERE id::text = $1`,
    [id, opts.completePackage, opts.note, opts.staffId, imported.applicationId, imported.importId],
  );

  let texted = false;
  try {
    const sendSms = deps.sendSms ?? (await import("../../modules/notifications/sms.service.js")).sendSms;
    const appUrl = deps.appUrl ?? (process.env.CLIENT_APP_URL || "https://client.boreal.financial").replace(/\/+$/, "");
    const first = String(imported.prefill?.applicant?.firstName ?? "").trim() || String(row.client_name ?? "").trim().split(/\s+/)[0] || null;
    await sendSms({ to: String(row.client_phone), message: clientInviteText(first, appUrl), track: { kind: "lender_referral_invite", applicationId: imported.applicationId } });
    await db.query(`UPDATE lender_referrals SET client_texted_at = now(), updated_at = now() WHERE id::text = $1`, [id]);
    await db.query(
      `UPDATE broker_imports SET summary = COALESCE(summary, '{}'::jsonb) || jsonb_build_object('client_texted_at', now()::text), updated_at = now() WHERE id::text = $1`,
      [imported.importId],
    );
    texted = true;
  } catch (error) {
    console.warn("[lender-referrals] client text failed", { id, error: error instanceof Error ? error.message : String(error) });
  }
  return { applicationId: imported.applicationId, texted, warnings: imported.warnings ?? [] };
}
