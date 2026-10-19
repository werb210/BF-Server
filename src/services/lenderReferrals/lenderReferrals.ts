// BF_SERVER_v825_LENDER_REFERRALS
// BF_SERVER_v827_REFERRAL_PIPELINE_CARD - each uploaded file is imported straight away (in the background) into a
// draft application, so it shows as a card in the Received column of the Sales Pipeline marked "Lender referral -
// needs review"; staff open it, see the documents and Accept / Decline on the application. The draft has no
// sign-in phone until it is accepted, so the client still cannot see or claim it, and nobody is texted.
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
            r.decided_by, r.decided_at, r.application_id, r.client_texted_at, r.created_at, r.import_error, a.pipeline_state,
            (r.zip_data IS NOT NULL) AS has_zip
       FROM lender_referrals r
       LEFT JOIN applications a ON a.id::text = r.application_id
      ORDER BY (r.status = 'pending') DESC, r.created_at DESC
      LIMIT 300`,
  );
  return r.rows.map((row) => ({ ...row, progress: referralProgress(row) }));
}

/** BF_SERVER_v827_REFERRAL_PIPELINE_CARD - the referral behind an application (the review panel on the application). */
export async function referralForApplication(applicationId: string, db: Q = pool): Promise<any | null> {
  const r = await db.query(
    `SELECT r.id::text AS id, r.lender_id, r.lender_name, r.business_name, r.client_name, r.client_phone, r.requested_amount,
            r.decline_reason, r.zip_name, r.status, r.complete_package, r.decision_note, r.decided_at, r.application_id,
            r.client_texted_at, r.created_at, (r.zip_data IS NOT NULL) AS has_zip
       FROM lender_referrals r
      WHERE r.application_id = $1
      ORDER BY r.created_at DESC
      LIMIT 1`,
    [applicationId],
  );
  return r.rows[0] ?? null;
}

export async function referralZip(id: string, db: Q = pool): Promise<{ name: string; data: Buffer } | null> {
  const r = await db.query(`SELECT zip_name, zip_data FROM lender_referrals WHERE id::text = $1 LIMIT 1`, [id]);
  const row = r.rows[0];
  if (!row?.zip_data) return null;
  return { name: String(row.zip_name || "file.zip"), data: Buffer.from(row.zip_data) };
}

type ImportFn = (opts: { zip: Buffer; zipName: string; brokerName: string; uploadedBy: string | null; applicantPhone?: string | null }) =>
  Promise<{ importId: string; applicationId: string; businessName: string | null; warnings: string[]; prefill: any }>;
type SmsFn = (args: { to: string; message: string; track?: any }) => Promise<unknown>;

async function defaultImport(): Promise<ImportFn> {
  return (await import("../brokerImport/importBrokerFile.js")).importBrokerZip;
}

/**
 * BF_SERVER_v827_REFERRAL_PIPELINE_CARD - import a pending referral's zip into a draft application (documents filed,
 * application form read) so it shows on the pipeline. The draft gets no sign-in phone, so the client cannot claim it
 * and nobody is texted; the phone is added when staff accept. Returns the application id, or null when the import
 * did not work (the zip is kept and the reason saved for staff).
 */
export async function importReferral(id: string, deps: { db?: Q; importZip?: ImportFn } = {}): Promise<string | null> {
  const db = deps.db ?? pool;
  const r = await db.query(
    `SELECT id::text AS id, lender_id, lender_name, business_name, requested_amount, zip_name, zip_data, application_id
       FROM lender_referrals WHERE id::text = $1 AND status IN ('pending', 'accepting') LIMIT 1`,
    [id],
  );
  const row = r.rows[0];
  if (!row) return null;
  if (row.application_id) return String(row.application_id);
  if (!row.zip_data) return null;
  const lender = String(row.lender_name || "Lender");
  try {
    const importZip = deps.importZip ?? (await defaultImport());
    const imported = await importZip({
      zip: Buffer.from(row.zip_data),
      zipName: String(row.zip_name),
      brokerName: lender,
      uploadedBy: "lender:" + String(row.lender_id),
      applicantPhone: null,
    });
    // No sign-in phone until accepted (the import may have read one off the application form).
    await db.query(
      `UPDATE applications
          SET name = CASE WHEN $3::boolean THEN $4 ELSE name END,
              requested_amount = COALESCE(requested_amount, $5::numeric),
              metadata = (COALESCE(metadata, '{}'::jsonb) - 'readiness_phone') || jsonb_build_object('lender_referral', jsonb_build_object(
                'referral_id', $2::text, 'lender_id', $6::text, 'lender_name', $7::text, 'status', 'pending')),
              updated_at = now()
        WHERE id::text = $1`,
      [imported.applicationId, id, !imported.businessName, row.business_name, row.requested_amount, String(row.lender_id), lender],
    );
    await db.query(`UPDATE broker_imports SET applicant_phone = NULL, updated_at = now() WHERE id::text = $1`, [imported.importId]);
    await db.query(
      `UPDATE lender_referrals SET application_id = $2, import_id = $3, import_error = NULL, zip_data = NULL, updated_at = now()
        WHERE id::text = $1`,
      [id, imported.applicationId, imported.importId],
    );
    return imported.applicationId;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[lender-referrals] import failed", { id, error: message });
    await db.query(`UPDATE lender_referrals SET import_error = $2, updated_at = now() WHERE id::text = $1`, [id, message.slice(0, 500)]);
    return null;
  }
}

export async function declineReferral(id: string, staffId: string | null, note: string | null, db: Q = pool): Promise<void> {
  const r = await db.query(
    `UPDATE lender_referrals
        SET status = 'declined', decision_note = $3, decided_by = $2, decided_at = now(), zip_data = NULL, updated_at = now()
      WHERE id::text = $1 AND status = 'pending'
      RETURNING id, application_id, import_id`,
    [id, staffId, note],
  );
  const row = r.rows[0];
  if (!row) throw new LenderReferralError("not_pending", "This file was already accepted or declined.", 409);
  // BF_SERVER_v827_REFERRAL_PIPELINE_CARD - the draft leaves the pipeline and can never be claimed.
  if (row.application_id) {
    await db.query(
      `UPDATE applications
          SET source = 'lender_referral_declined',
              metadata = (COALESCE(metadata, '{}'::jsonb) - 'readiness_phone')
                || jsonb_build_object('lender_referral', COALESCE(metadata->'lender_referral', '{}'::jsonb) || jsonb_build_object('status', 'declined')),
              updated_at = now()
        WHERE id::text = $1 AND pipeline_state = 'draft'`,
      [String(row.application_id)],
    );
  }
  if (row.import_id) {
    await db.query(`UPDATE broker_imports SET status = 'discarded', updated_at = now() WHERE id::text = $1`, [String(row.import_id)]);
  }
}

export type AcceptResult = { applicationId: string; texted: boolean; warnings: string[] };

/** Accept: (import if not done yet), give the draft the client's sign-in phone, record the referral share, text the client. */
export async function acceptReferral(
  id: string,
  opts: { staffId: string | null; completePackage: boolean; note: string | null },
  deps: { db?: Q; importZip?: ImportFn; sendSms?: SmsFn; appUrl?: string } = {},
): Promise<AcceptResult> {
  const db = deps.db ?? pool;
  // Claim the row first so two clicks never accept the file twice.
  const claimed = await db.query(
    `UPDATE lender_referrals SET status = 'accepting', updated_at = now()
      WHERE id::text = $1 AND status = 'pending' AND (application_id IS NOT NULL OR zip_data IS NOT NULL)
      RETURNING id::text AS id, lender_id, lender_name, client_name, client_phone`,
    [id],
  );
  const row = claimed.rows[0];
  if (!row) throw new LenderReferralError("not_pending", "This file was already accepted or declined.", 409);
  const back = async () => { await db.query(`UPDATE lender_referrals SET status = 'pending', updated_at = now() WHERE id::text = $1`, [id]); };

  const applicationId = await importReferral(id, { db, ...(deps.importZip ? { importZip: deps.importZip } : {}) });
  if (!applicationId) {
    await back();
    throw new LenderReferralError("import_failed", "The file could not be read. Download the zip and check it.", 422);
  }
  const phone = String(row.client_phone);
  const dup = await db.query(
    `SELECT id FROM applications
      WHERE source = 'broker_import' AND pipeline_state = 'draft' AND id::text <> $2
        AND right(regexp_replace(coalesce(metadata->>'readiness_phone', ''), '[^0-9]', '', 'g'), 10) = right($1, 10)
      LIMIT 1`,
    [phone.replace(/[^0-9]/g, ""), applicationId],
  );
  if (dup.rows[0]) {
    await back();
    throw new LenderReferralError("phone_in_use", "Another imported file is already waiting for this client's cell number.", 409);
  }

  const share = opts.completePackage ? REFERRAL_SHARE_PCT : 0;
  const lender = String(row.lender_name || "Lender");
  const app = await db.query(
    `UPDATE applications
        SET metadata = COALESCE(metadata, '{}'::jsonb)
              || jsonb_build_object('readiness_phone', $2::text)
              || jsonb_build_object('lender_referral', COALESCE(metadata->'lender_referral', '{}'::jsonb)
                   || jsonb_build_object('status', 'accepted', 'complete_package', $3::boolean)),
            updated_at = now()
      WHERE id::text = $1
      RETURNING metadata->'broker_prefill'->'applicant'->>'firstName' AS first_name, metadata->'broker_import'->>'import_id' AS import_id`,
    [applicationId, phone, opts.completePackage],
  );
  const importId = app.rows[0]?.import_id ?? null;
  if (importId) await db.query(`UPDATE broker_imports SET applicant_phone = $2, updated_at = now() WHERE id::text = $1`, [importId, phone]);
  await db.query(
    `INSERT INTO broker_deal_confirmations
       (application_id, broker_name, boreal_pct, broker_pct, terms, notes, agreed_by_broker, agreed_on, recorded_by, status, accepted_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'Lender referral terms', CURRENT_DATE, $7, 'accepted', now())
     ON CONFLICT (application_id) DO NOTHING`,
    [applicationId, lender, 100 - share, share,
      opts.completePackage ? `Lender referral, complete package: ${REFERRAL_SHARE_PCT}% of Boreal's fee` : "Lender referral, incomplete package: no referral share",
      opts.note, opts.staffId],
  );
  await db.query(
    `UPDATE lender_referrals
        SET status = 'accepted', complete_package = $2, decision_note = $3, decided_by = $4, decided_at = now(),
            zip_data = NULL, updated_at = now()
      WHERE id::text = $1`,
    [id, opts.completePackage, opts.note, opts.staffId],
  );

  let texted = false;
  try {
    const sendSms = deps.sendSms ?? (await import("../../modules/notifications/sms.service.js")).sendSms;
    const appUrl = deps.appUrl ?? (process.env.CLIENT_APP_URL || "https://client.boreal.financial").replace(/\/+$/, "");
    const first = String(app.rows[0]?.first_name ?? "").trim() || String(row.client_name ?? "").trim().split(/\s+/)[0] || null;
    await sendSms({ to: phone, message: clientInviteText(first, appUrl), track: { kind: "lender_referral_invite", applicationId } });
    await db.query(`UPDATE lender_referrals SET client_texted_at = now(), updated_at = now() WHERE id::text = $1`, [id]);
    if (importId) {
      await db.query(
        `UPDATE broker_imports SET summary = COALESCE(summary, '{}'::jsonb) || jsonb_build_object('client_texted_at', now()::text), updated_at = now() WHERE id::text = $1`,
        [importId],
      );
    }
    texted = true;
  } catch (error) {
    console.warn("[lender-referrals] client text failed", { id, error: error instanceof Error ? error.message : String(error) });
  }
  return { applicationId, texted, warnings: [] };
}
