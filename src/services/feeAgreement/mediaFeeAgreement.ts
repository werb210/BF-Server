import { ALBERTA_TZ } from "../../lib/albertaTime.js"; // BF_SERVER_ALBERTA_TIME_v743 - Alberta is UTC-6 all year
// BF_SERVER_MEDIA_FEE_AGREEMENT_v709
// MEDIA lender sends create one client services agreement without delaying dispatch.
import { createHash, randomUUID } from "node:crypto";
import { dbQuery, pool as defaultPool } from "../../db.js";
import { logWarnSwallowed } from "../../lib/logWarnSwallowed.js";
import * as signnow from "../../signnow/signnowClient.js";
import { buildMediaFeeAgreementPdf, MEDIA_FEE_AGREEMENT_ROLE, type MediaFeeAgreementData } from "../../signnow/mediaFeeAgreementPdfBuilder.js";

export const FEE_AGREEMENT_DOCUMENT_CATEGORY = "Fee Agreement";
export const FEE_AGREEMENT_DOCUMENT_TYPE = "media_fee_agreement";
export const FEE_AGREEMENT_SMS_KIND = "media_fee_agreement";
type Q = (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
const defaultQuery: Q = (text, params) => dbQuery(text, params as any[]);
const object = (v: unknown): Record<string, any> | null => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : null;
const string = (v: unknown): string | null => { const value = typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : ""; return value || null; };

export function isMediaCategory(raw: unknown): boolean {
  const value = String(raw ?? "").trim().toUpperCase().replace(/[\s\-/]+/g, "_");
  return ["MEDIA", "MEDIA_FUNDING", "MEDIA_FINANCE", "MEDIA_FINANCING", "MEDIA_FILM_FINANCE"].includes(value);
}
export function needsFeeAgreement(category: unknown, lenders: Array<{ has_broker_agreement: boolean | null }>): boolean {
  return isMediaCategory(category) && lenders.some(({ has_broker_agreement }) => has_broker_agreement !== true);
}
export type FeeSigner = { name: string | null; email: string | null; phone: string | null; title: string | null; isApplicant: boolean; reason: "director" | "applicant_fallback" };
function isDirector(person: Record<string, any>, prefix = ""): boolean {
  const get = (key: string) => person[prefix ? prefix + key[0].toUpperCase() + key.slice(1) : key];
  return ["yes", "true"].includes(String(get("director") ?? "").trim().toLowerCase()) || /\bdirector\b/.test(String(get("title") ?? "").toLowerCase());
}
export function pickFeeSigner(metadata: unknown): FeeSigner {
  const md = object(metadata) ?? {}, applicant = object(md.applicant) ?? {};
  const primary: FeeSigner = { name: [string(applicant.firstName) ?? string(applicant.first_name), string(applicant.lastName) ?? string(applicant.last_name)].filter(Boolean).join(" ") || null, email: string(applicant.email), phone: string(applicant.phone), title: string(applicant.title), isApplicant: true, reason: "applicant_fallback" };
  if (isDirector(applicant)) return { ...primary, reason: "director" };
  const partner = object(applicant.partner) ?? object(md.partner);
  if (partner && isDirector(partner)) return { name: [string(partner.firstName), string(partner.lastName)].filter(Boolean).join(" ") || null, email: string(partner.email), phone: string(partner.phone), title: string(partner.title), isApplicant: false, reason: "director" };
  if (!partner && (applicant.hasMultipleOwners || string(applicant.partnerFirstName)) && isDirector(applicant, "partner")) return { name: [string(applicant.partnerFirstName), string(applicant.partnerLastName)].filter(Boolean).join(" ") || null, email: string(applicant.partnerEmail), phone: string(applicant.partnerPhone), title: string(applicant.partnerTitle), isApplicant: false, reason: "director" };
  for (const value of Array.isArray(applicant.additionalShareholders) ? applicant.additionalShareholders : []) { const row = object(value); if (row && isDirector(row)) return { name: string(row.name), email: string(row.email), phone: string(row.mobile) ?? string(row.office), title: "Director", isApplicant: false, reason: "director" }; }
  return primary;
}
function usablePhone(raw: string | null): string | null { const value = (raw ?? "").trim(), digits = value.replace(/\D/g, ""); return digits.length < 10 ? null : value.startsWith("+") ? value : "+1" + digits.slice(-10); }
export function agreementDataFrom(row: { name: string | null; requested_amount: unknown; metadata: unknown }, signer: FeeSigner, now = new Date()): MediaFeeAgreementData {
  const md = object(row.metadata) ?? {}, business = object(md.business) ?? {};
  const legal = string(business.legalName) ?? string(business.companyName) ?? string(business.businessName) ?? string(row.name), bn = string(business.businessNumber) ?? string(business.business_number) ?? string(business.bn);
  const amount = Number(String(row.requested_amount ?? object(md.kyc)?.fundingAmount ?? "").replace(/[^0-9.]/g, ""));
  return { agreementDate: new Intl.DateTimeFormat("en-CA", { timeZone: ALBERTA_TZ, year: "numeric", month: "long", day: "numeric" }).format(now), companyName: legal ? (bn ? legal + " BN " + bn : legal) : null, clientName: signer.name, street: string(business.address) ?? string(business.street), city: string(business.city), provinceState: string(business.state) ?? string(business.province), country: string(business.country) ?? string(md.country), title: signer.title, approxAmount: Number.isFinite(amount) && amount > 0 ? "$" + Math.round(amount).toLocaleString("en-US") : null };
}
export type EnsureResult = { created: boolean; reason: string; agreementId?: string };
export async function ensureMediaFeeAgreement(applicationId: string, sentLenderIds: string[], deps: { query?: Q } = {}): Promise<EnsureResult> {
  const query = deps.query ?? defaultQuery;
  if (!applicationId || !sentLenderIds.length) return { created: false, reason: "nothing_sent" };
  const row = (await query("SELECT id::text AS id, name, requested_amount, product_category, metadata FROM applications WHERE id::text = ($1)::text LIMIT 1", [applicationId])).rows[0];
  if (!row) return { created: false, reason: "application_not_found" };
  if (!isMediaCategory(row.product_category)) return { created: false, reason: "not_media" };
  const lenders = (await query("SELECT id::text AS id, name, has_broker_agreement FROM lenders WHERE id::text = ANY($1::text[])", [sentLenderIds])).rows.filter(l => l.has_broker_agreement !== true);
  if (!lenders.length) return { created: false, reason: "lender_pays" };
  const signer = pickFeeSigner(row.metadata), id = randomUUID();
  const inserted = await query("INSERT INTO media_fee_agreements (id, application_id, trigger_lender_id, trigger_lender_name, signer_name, signer_email, signer_phone, signer_title, signer_is_applicant, status, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',now(),now()) ON CONFLICT (application_id) DO NOTHING RETURNING id::text AS id", [id, applicationId, lenders[0].id, lenders[0].name ?? null, signer.name, signer.email, signer.phone, signer.title, signer.isApplicant]);
  const agreementId = inserted.rows[0]?.id;
  if (!agreementId) return { created: false, reason: "already_exists" };
  await notifySigner(applicationId, signer, row, query).catch(err => console.warn("[fee-agreement] notify failed", { applicationId, message: err instanceof Error ? err.message : String(err) }));
  return { created: true, reason: "created", agreementId };
}
// BF_SERVER_FEE_NOTICE_DELIVERY_v740 - returns what was delivered; throws when nothing went out.
async function notifySigner(applicationId: string, signer: FeeSigner, row: any, query: Q): Promise<import("./deliverFeeNotice.js").FeeDelivery | null> {
  if (signer.isApplicant) { const { deliverFeeNotice } = await import("./deliverFeeNotice.js"); const first = (signer.name ?? "").trim().split(" ")[0] || null; const delivery = await deliverFeeNotice({ applicationId, phone: usablePhone(signer.phone), email: signer.email, firstName: first }); await query("UPDATE media_fee_agreements SET sent_at=now(), updated_at=now() WHERE application_id=$1", [applicationId]); return delivery; }
  if (!signnow.isApiKeyConfigured()) throw new Error("e-signature (SignNow) is not configured on the server"); if (!signer.email) throw new Error("no email for the signer");
  const pdf = await buildMediaFeeAgreementPdf(agreementDataFrom(row, signer)), { documentId } = await signnow.uploadDocumentWithFieldExtract(pdf, `fee-agreement-${applicationId}.pdf`), { groupId } = await signnow.createDocumentGroup([documentId], `Fee Agreement ${applicationId}`);
  const { inviteId } = await signnow.sendGroupEmailInvite(groupId, { email: signer.email, name: signer.name ?? undefined, roleName: MEDIA_FEE_AGREEMENT_ROLE, fromEmail: process.env.SIGNNOW_FROM_EMAIL || "no-reply@boreal.financial", order: 1 });
  await query("UPDATE media_fee_agreements SET signnow_group_id=$2,signnow_doc_id=$3,signnow_invite_id=$4,sent_at=now(),updated_at=now() WHERE application_id=$1", [applicationId, groupId, documentId, inviteId ?? null]);
  return { push: false, sms: false, email: true, phoneLast4: null, emailTo: signer.email, errors: [] };
}
export type FeeAgreementRow = { id: string; application_id: string; status: string; signer_name: string | null; signer_email: string | null; signer_is_applicant: boolean; trigger_lender_name: string | null; signnow_group_id: string | null; signnow_doc_id: string | null; created_at: string; sent_at: string | null; signed_at: string | null; document_id: string | null };
export async function getFeeAgreement(applicationId: string, deps: { query?: Q } = {}): Promise<FeeAgreementRow | null> { const result = await (deps.query ?? defaultQuery)("SELECT id::text AS id,application_id,status,signer_name,signer_email,signer_is_applicant,trigger_lender_name,signnow_group_id,signnow_doc_id,created_at,sent_at,signed_at,document_id FROM media_fee_agreements WHERE application_id=$1 LIMIT 1", [applicationId]); return result.rows[0] ?? null; }
export type SessionResult = { status: "none" | "signed" | "stub" } | { status: "other_signer"; signerName: string | null } | { status: "error"; reason: string } | { status: "ready"; url: string };
export async function createFeeAgreementSigningSession(applicationId: string): Promise<SessionResult> {
  const agreement = await getFeeAgreement(applicationId); if (!agreement) return { status: "none" }; if (agreement.status === "signed") return { status: "signed" }; if (!agreement.signer_is_applicant) return { status: "other_signer", signerName: agreement.signer_name }; if (!signnow.isApiKeyConfigured()) return { status: "stub" };
  const row = (await dbQuery<{ name: string | null; requested_amount: unknown; metadata: unknown }>("SELECT name,requested_amount,metadata FROM applications WHERE id::text=($1)::text LIMIT 1", [applicationId])).rows[0]; if (!row) return { status: "error", reason: "application_not_found" };
  const signer = pickFeeSigner(row.metadata), email = agreement.signer_email ?? signer.email; if (!email) return { status: "error", reason: "signer_email_missing" };
  // BF_SERVER_FEE_SESSION_REUSE_v744 - reuse the agreement already prepared instead of uploading a new SignNow
  // document every time the client taps Review (each tap left another unsigned copy behind).
  if (agreement.signnow_group_id) {
    try {
      const inv = (await dbQuery<{ signnow_invite_id: string | null }>("SELECT signnow_invite_id FROM media_fee_agreements WHERE application_id=$1 LIMIT 1", [applicationId])).rows[0]?.signnow_invite_id ?? null;
      if ((await signnow.getDocumentGroupStatus(agreement.signnow_group_id)).signed) { await confirmFeeAgreementSigned(applicationId); return { status: "signed" }; }
      if (inv) { const { url } = await signnow.createEmbeddedGroupLink(agreement.signnow_group_id, inv, email); return { status: "ready", url }; }
    } catch (err) {
      console.warn("[fee-agreement] reuse_failed_preparing_new_copy", { applicationId, message: err instanceof Error ? err.message : String(err) });
    }
  }
  const pdf = await buildMediaFeeAgreementPdf(agreementDataFrom(row, { ...signer, name: agreement.signer_name ?? signer.name })), { documentId } = await signnow.uploadDocumentWithFieldExtract(pdf, `fee-agreement-${applicationId}.pdf`), { groupId } = await signnow.createDocumentGroup([documentId], `Fee Agreement ${applicationId}`), { inviteId } = await signnow.createEmbeddedGroupInvite(groupId, [documentId], [{ email, name: agreement.signer_name ?? undefined, roleName: MEDIA_FEE_AGREEMENT_ROLE }]), { url } = await signnow.createEmbeddedGroupLink(groupId, inviteId, email);
  await dbQuery("UPDATE media_fee_agreements SET signnow_group_id=$2,signnow_doc_id=$3,signnow_invite_id=$4,updated_at=now() WHERE application_id=$1", [applicationId, groupId, documentId, inviteId]); return { status: "ready", url };
}
export async function confirmFeeAgreementSigned(applicationId: string): Promise<{ signed: boolean; reason?: string }> { const agreement = await getFeeAgreement(applicationId); if (!agreement) return { signed: false, reason: "none" }; if (agreement.status === "signed") return { signed: true }; if (!agreement.signnow_group_id) return { signed: false, reason: "no_signing_group" }; if (!signnow.isApiKeyConfigured()) return { signed: false, reason: "signnow_not_configured" }; if (!(await signnow.getDocumentGroupStatus(agreement.signnow_group_id)).signed) return { signed: false, reason: "not_signed" }; await dbQuery("UPDATE media_fee_agreements SET status='signed',signed_at=COALESCE(signed_at,now()),updated_at=now() WHERE application_id=$1", [applicationId]); await attachSignedFeeAgreement(applicationId); return { signed: true }; }
export async function confirmFeeAgreementBySignNowIds(ids: string[]): Promise<{ matched: boolean; signed?: boolean; applicationId?: string }> { if (!ids.filter(Boolean).length) return { matched: false }; const applicationId = (await dbQuery<{ application_id: string }>("SELECT application_id FROM media_fee_agreements WHERE signnow_group_id=ANY($1::text[]) OR signnow_doc_id=ANY($1::text[]) LIMIT 1", [ids.filter(Boolean)])).rows[0]?.application_id; if (!applicationId) return { matched: false }; return { matched: true, signed: (await confirmFeeAgreementSigned(applicationId)).signed, applicationId }; }
// swallow-ok: attachment failures are logged and returned explicitly.
export async function attachSignedFeeAgreement(applicationId: string): Promise<{ attached: boolean; reason?: string }> {
  try { const existing = (await dbQuery<{ id: string }>("SELECT id::text AS id FROM documents WHERE application_id::text=($1)::text AND document_type=$2 AND uploaded_by='system' LIMIT 1", [applicationId, FEE_AGREEMENT_DOCUMENT_TYPE])).rows[0]; if (existing) { await dbQuery("UPDATE media_fee_agreements SET document_id=$2,updated_at=now() WHERE application_id=$1 AND document_id IS NULL", [applicationId, existing.id]); return { attached: true, reason: "already_attached" }; } const agreement = await getFeeAgreement(applicationId); if (!agreement?.signnow_doc_id) return { attached: false, reason: "no_document" }; const pdf = await signnow.downloadDocument(agreement.signnow_doc_id); if (!pdf || !pdf.length) return { attached: false, reason: "download_failed" }; const hash = createHash("sha256").update(pdf).digest("hex"), filename = `Fee-Agreement-Signed-${applicationId}.pdf`; const { getStorage } = await import("../../lib/storage/index.js"); const put = await getStorage().put({ buffer: pdf, filename, contentType: "application/pdf", pathPrefix: `applications/${applicationId}` }); const documentId = randomUUID(), client = await defaultPool.connect(); try { await client.query("BEGIN"); await client.query("INSERT INTO documents (id,application_id,filename,hash,category,storage_path,blob_name,blob_url,size_bytes,status,ocr_status,uploaded_by,document_type,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'accepted','skipped','system',$10,now(),now())", [documentId, applicationId, filename, hash, FEE_AGREEMENT_DOCUMENT_CATEGORY, put.blobName, put.blobName, put.url, put.sizeBytes, FEE_AGREEMENT_DOCUMENT_TYPE]); await client.query("INSERT INTO document_versions (id,document_id,version,blob_name,hash,metadata,content,created_at) VALUES ($1,$2,1,$3,$4,$5::jsonb,$6,now())", [randomUUID(), documentId, put.blobName, hash, JSON.stringify({ source: "signnow_fee_agreement", groupId: agreement.signnow_group_id, docId: agreement.signnow_doc_id, signedAt: new Date().toISOString() }), put.url]); await client.query("UPDATE media_fee_agreements SET document_id=$2,updated_at=now() WHERE application_id=$1", [applicationId, documentId]); await client.query("COMMIT"); } catch (error) { await client.query("ROLLBACK").catch(e => logWarnSwallowed(e, "services/feeAgreement/mediaFeeAgreement.ts:rollback", undefined)); return { attached: false, reason: "insert_failed" }; } finally { client.release(); } return { attached: true }; } catch (error) { console.warn("[fee-agreement] attach failed", { applicationId, message: error instanceof Error ? error.message : String(error) }); return { attached: false, reason: "error" }; }
}
export async function backfillFeeAgreementsForLender(lenderId: string, deps: { query?: Q } = {}): Promise<{ checked: number; created: number }> { const query = deps.query ?? defaultQuery, rows = (await query("SELECT DISTINCT p.application_id::text AS application_id FROM application_packages p JOIN applications a ON a.id::text=p.application_id::text WHERE p.lender_id::text=($1)::text AND p.status='sent'", [lenderId])).rows; let created = 0; for (const row of rows) { const result = await ensureMediaFeeAgreement(String(row.application_id), [lenderId], { query }).catch((error: unknown) => { console.warn("[fee-agreement] backfill item failed", { applicationId: row.application_id, message: error instanceof Error ? error.message : String(error) }); return { created: false, reason: "error" }; }); if (result.created) created++; } return { checked: rows.length, created }; }


// BF_SERVER_FEE_AGREEMENT_SEND_NOW_v731 - staff send the client fee agreement on a Media
// file themselves. The automatic trigger only fires when the file is sent to a lender
// through the portal and that lender's broker-agreement box is unticked; files sent by
// hand outside the portal (as the two Bondit files were) never triggered it. Creates the
// agreement if there is none and texts or emails the signer; if one is already waiting,
// it sends the reminder again. A signed agreement is left alone.
export async function sendMediaFeeAgreementNow(applicationId: string, lenderName: string | null, deps: { query?: Q } = {}): Promise<{ ok: boolean; reason: string; delivery?: import("./deliverFeeNotice.js").FeeDelivery | null }> {
  const query = deps.query ?? defaultQuery;
  const row = (await query("SELECT id::text AS id, name, requested_amount, product_category, metadata FROM applications WHERE id::text = ($1)::text LIMIT 1", [applicationId])).rows[0];
  if (!row) return { ok: false, reason: "application_not_found" };
  if (!isMediaCategory(row.product_category)) return { ok: false, reason: "not_media" };
  const existing = (await query("SELECT status FROM media_fee_agreements WHERE application_id = $1 LIMIT 1", [applicationId])).rows[0];
  if (existing?.status === "signed") return { ok: false, reason: "already_signed" };
  const signer = pickFeeSigner(row.metadata);
  if (!existing) {
    await query("INSERT INTO media_fee_agreements (id, application_id, trigger_lender_id, trigger_lender_name, signer_name, signer_email, signer_phone, signer_title, signer_is_applicant, status, created_at, updated_at) VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8,'pending',now(),now()) ON CONFLICT (application_id) DO NOTHING", [randomUUID(), applicationId, lenderName, signer.name, signer.email, signer.phone, signer.title, signer.isApplicant]);
  }
  const delivery = await notifySigner(applicationId, signer, row, query);
  return { ok: true, reason: existing ? "reminder_sent" : "sent", delivery };
}
