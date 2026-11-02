// BF_SERVER_v864_ACTIVE_CONTRACTS - equipment assets, insurance certificates, contract files, settings, renewal rules
// on lender products, and the client-safe view (no commissions, no internal notes, no internal lender data).
import { isoDay, num, RULE_TYPES, STATUS_LABELS, toDate, type ContractStatus } from "./model.js";
import { InputError } from "./money.js";
import { contractView, type Q } from "./repo.js";
import { writeContractEvent } from "./timeline.js";

const txt = (v: unknown, max = 200) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

export async function listAssets(db: Q, contractId: string) {
  return (await db.query(`SELECT id::text AS id, description, year, make, model, serial_number, vendor, cost, location, created_at FROM active_contract_assets
                           WHERE contract_id = $1::uuid AND removed_at IS NULL ORDER BY created_at`, [contractId])).rows;
}
export async function addAsset(db: Q, contractId: string, b: any, actor: string | null) {
  const description = txt(b?.description);
  if (!description) throw new InputError("description_required", "description");
  const year = num(b?.year);
  if (year !== null && (year < 1950 || year > 2100)) throw new InputError("invalid_year", "year");
  const r = await db.query(
    `INSERT INTO active_contract_assets (contract_id, description, year, make, model, serial_number, vendor, cost, location, created_by)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10::uuid) RETURNING id::text AS id`,
    [contractId, description, year, txt(b?.make), txt(b?.model), txt(b?.serial_number), txt(b?.vendor), num(b?.cost), txt(b?.location), actor]);
  await writeContractEvent(db, contractId, { title: "Equipment added", detail: description, actor });
  return r.rows[0];
}
export async function removeAsset(db: Q, contractId: string, assetId: string, actor: string | null) {
  const r = await db.query(`UPDATE active_contract_assets SET removed_at = now() WHERE id = $1::uuid AND contract_id = $2::uuid AND removed_at IS NULL RETURNING description`, [assetId, contractId]);
  if (r.rows[0]) await writeContractEvent(db, contractId, { title: "Equipment removed", detail: r.rows[0].description, actor });
  return Boolean(r.rows[0]);
}

export async function listInsurance(db: Q, contractId: string) {
  return (await db.query(`SELECT id::text AS id, insurer, policy_number, coverage, expires_on, document_id::text AS document_id, replaced_at, created_at
                           FROM active_contract_insurance WHERE contract_id = $1::uuid ORDER BY replaced_at NULLS FIRST, expires_on DESC NULLS LAST`, [contractId])).rows;
}
/** A new certificate replaces the current one (kept as history). */
export async function addInsurance(db: Q, contractId: string, b: any, actor: string | null) {
  const insurer = txt(b?.insurer);
  if (!insurer) throw new InputError("insurer_required", "insurer");
  const expires = b?.expires_on ? toDate(b.expires_on) : null;
  if (b?.expires_on && !expires) throw new InputError("invalid_expires_on", "expires_on");
  if (b?.document_id) {
    const ok = await db.query(`SELECT 1 FROM active_contract_documents WHERE id = $1::uuid AND contract_id = $2::uuid`, [b.document_id, contractId]);
    if (!ok.rows[0]) throw new InputError("invalid_document", "document_id");
  }
  await db.query(`UPDATE active_contract_insurance SET replaced_at = now() WHERE contract_id = $1::uuid AND replaced_at IS NULL`, [contractId]);
  const r = await db.query(
    `INSERT INTO active_contract_insurance (contract_id, insurer, policy_number, coverage, expires_on, document_id, created_by)
     VALUES ($1::uuid, $2, $3, $4, $5::date, $6::uuid, $7::uuid) RETURNING id::text AS id`,
    [contractId, insurer, txt(b?.policy_number), txt(b?.coverage, 500), isoDay(expires), b?.document_id || null, actor]);
  await writeContractEvent(db, contractId, { title: "Insurance certificate recorded", detail: `${insurer}${expires ? ` - expires ${isoDay(expires)}` : ""}`, actor });
  return r.rows[0];
}

export const DOC_KINDS = ["lender_statement", "insurance_certificate", "commission_statement", "contract", "payout_letter", "other"] as const;

export async function addDocument(db: Q, contractId: string, file: { buffer: Buffer; originalname: string; mimetype: string; size: number }, kind: string, actor: string | null,
  put: (p: { buffer: Buffer; filename: string; contentType: string; pathPrefix?: string }) => Promise<{ blobName: string }>) {
  if (!(DOC_KINDS as readonly string[]).includes(kind)) throw new InputError("invalid_kind", "kind");
  const stored = await put({ buffer: file.buffer, filename: file.originalname, contentType: file.mimetype || "application/octet-stream", pathPrefix: `active-contracts/${contractId}` });
  const r = await db.query(
    `INSERT INTO active_contract_documents (contract_id, kind, filename, content_type, size_bytes, blob_name, uploaded_by)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::uuid) RETURNING id::text AS id`,
    [contractId, kind, file.originalname.slice(0, 250), file.mimetype, file.size, stored.blobName, actor]);
  await writeContractEvent(db, contractId, { title: "Document added", detail: `${kind.replace(/_/g, " ")}: ${file.originalname}`, actor });
  return r.rows[0] as { id: string };
}
export async function listDocuments(db: Q, contractId: string) {
  const own = (await db.query(`SELECT id::text AS id, kind, filename, content_type, size_bytes, source, created_at FROM active_contract_documents WHERE contract_id = $1::uuid ORDER BY created_at DESC`, [contractId])).rows;
  const funded = (await db.query(
    `SELECT d.id::text AS id, COALESCE(d.display_name, d.filename, d.title) AS filename, COALESCE(d.category, d.document_type) AS category, d.created_at
       FROM documents d JOIN active_contracts c ON c.application_id IS NOT NULL AND d.application_id::text = c.application_id
      WHERE c.id = $1::uuid AND COALESCE(d.status, '') <> 'rejected' ORDER BY d.created_at DESC LIMIT 200`, [contractId])).rows;
  return { contract_documents: own, application_documents: funded };
}

export async function getSettings(db: Q, silo: string) {
  const r = await db.query(`SELECT silo, auto_email, auto_sms, email_subject, email_body, sms_body, no_contact_months, client_portal, updated_at FROM active_contract_settings WHERE silo = $1`, [silo]);
  return r.rows[0] ?? { silo, auto_email: false, auto_sms: false, email_subject: null, email_body: null, sms_body: null, no_contact_months: 6, client_portal: false, updated_at: null };
}
export async function saveSettings(db: Q, silo: string, b: any, actor: string | null) {
  const months = Math.max(1, Math.min(60, Math.floor(num(b?.no_contact_months) ?? 6)));
  await db.query(
    `INSERT INTO active_contract_settings (silo, auto_email, auto_sms, email_subject, email_body, sms_body, no_contact_months, client_portal, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::uuid, now())
     ON CONFLICT (silo) DO UPDATE SET auto_email = EXCLUDED.auto_email, auto_sms = EXCLUDED.auto_sms, email_subject = EXCLUDED.email_subject,
       email_body = EXCLUDED.email_body, sms_body = EXCLUDED.sms_body, no_contact_months = EXCLUDED.no_contact_months,
       client_portal = EXCLUDED.client_portal, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [silo, b?.auto_email === true, b?.auto_sms === true, txt(b?.email_subject), txt(b?.email_body, 4000), txt(b?.sms_body, 480), months, b?.client_portal === true, actor]);
  return getSettings(db, silo);
}

export async function getProductRule(db: Q, productId: string) {
  return (await db.query(`SELECT lender_product_id, rule_type, percent_threshold, approach_points, months_before_maturity, eligible_after_months, notes, updated_at
                           FROM lender_product_renewal_rules WHERE lender_product_id = $1`, [productId])).rows[0] ?? null;
}
export async function saveProductRule(db: Q, productId: string, b: any, actor: string | null) {
  const type = String(b?.rule_type ?? "");
  if (!(RULE_TYPES as readonly string[]).includes(type)) throw new InputError("invalid_rule_type", "rule_type");
  const pct = num(b?.percent_threshold);
  if (type === "percent_paid" && (pct === null || pct <= 0 || pct > 100)) throw new InputError("invalid_percent_threshold", "percent_threshold");
  const months = num(b?.months_before_maturity);
  if (type === "months_before_maturity" && (months === null || months < 0 || months > 120)) throw new InputError("invalid_months_before_maturity", "months_before_maturity");
  const exists = await db.query(`SELECT 1 FROM lender_products WHERE id::text = $1`, [productId]);
  if (!exists.rows[0]) throw new InputError("not_found");
  await db.query(
    `INSERT INTO lender_product_renewal_rules (lender_product_id, rule_type, percent_threshold, approach_points, months_before_maturity, eligible_after_months, notes, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::uuid, now())
     ON CONFLICT (lender_product_id) DO UPDATE SET rule_type = EXCLUDED.rule_type, percent_threshold = EXCLUDED.percent_threshold,
       approach_points = EXCLUDED.approach_points, months_before_maturity = EXCLUDED.months_before_maturity,
       eligible_after_months = EXCLUDED.eligible_after_months, notes = EXCLUDED.notes, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [productId, type, pct, num(b?.approach_points) ?? 10, months === null ? null : Math.round(months), num(b?.eligible_after_months), txt(b?.notes, 1000), actor]);
  return getProductRule(db, productId);
}

/** Section 11 (later): what a client may see. Strictly the listed fields - never commissions, profit shares,
 *  internal notes, the ledger, internal lender data or the owner. */
export function clientSafe(v: ReturnType<typeof contractView>) {
  return {
    id: v.id, lender: v.lender_name ?? null, product: v.product_name ?? v.product_category ?? null, original_amount: v.original_amount,
    currency: v.currency ?? "CAD", funding_date: v.funded_at, approximate_maturity: v.maturity_date ? v.maturity_date.slice(0, 7) : null,
    status: STATUS_LABELS[v.status as ContractStatus] ?? v.status,
    renewal: v.renewal.eligibility === "eligible" ? "eligible" : v.renewal.eligibility === "upcoming" ? "upcoming" : "not_yet",
    actions: ["contact_boreal", "request_additional_financing", "request_refinancing"],
  };
}

export const CLIENT_REQUESTS = { contact_boreal: "Client asked Boreal to contact them", request_additional_financing: "Client requested additional financing", request_refinancing: "Client requested refinancing" } as const;
