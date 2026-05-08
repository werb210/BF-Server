// BF_SERVER_BLOCK_v200_SIGNNOW_STUB_MODE_v1
// BF_SERVER_BLOCK_v201_SIGNNOW_REAL_BUILD_v1
import crypto from "node:crypto";
import { dbQuery } from "../db.js";
import { logCrmEvent } from "../modules/crm/crmTimeline.service.js";
import { buildApplicationPdf, type ApplicationPdfInputs } from "./pdfBuilder.js";
import { uploadSignedApplicationPdf } from "./blobStorage.js";
import * as signnow from "./signnowClient.js";

type OrchestratorContext = { applicationId: string; pool?: unknown; };
type SendResult =
  | { ok: true; mode: "real"; documentId: string; blobName: string }
  | { ok: true; mode: "stub"; documentId: string; blobName: string }
  | { ok: false; mode: "skipped"; reason: string };

function isStubMode(): boolean { const v = (process.env.SIGNNOW_STUB_MODE ?? "").trim().toLowerCase(); return ["1", "true", "yes", "on"].includes(v); }
function stubDelayMs(): number { const n = Number(process.env.SIGNNOW_STUB_DELAY_MS); return Number.isFinite(n) && n >= 0 ? n : 2000; }
function fromEmail(): string { return process.env.SIGNNOW_FROM_EMAIL || "no-reply@boreal.financial"; }

async function loadApplicationForPdf(applicationId: string): Promise<ApplicationPdfInputs> {
  const res = await dbQuery<{ id: string; name: string | null; requested_amount: string | null; product_category: string | null; metadata: any; created_at: Date | null; }>(`SELECT id, name, requested_amount, product_category, metadata, created_at FROM applications WHERE id::text = ($1)::text LIMIT 1`, [applicationId]);
  const row = res.rows[0];
  const md = row?.metadata && typeof row.metadata === "object" ? (row.metadata as Record<string, any>) : {};
  const business: Record<string, any> = md.business && typeof md.business === "object" ? md.business : {};
  const applicant: Record<string, any> = md.applicant && typeof md.applicant === "object" ? md.applicant : {};
  const fp: Record<string, any> = md.kyc && typeof md.kyc === "object" ? md.kyc : md.financial && typeof md.financial === "object" ? md.financial : {};
  const addrParts = [business.address ?? business.street ?? null, business.city ?? null, business.state ?? business.province ?? null, business.postalCode ?? business.zip ?? null].filter((p): p is string => typeof p === "string" && p.trim().length > 0);
  const fullName = [applicant.firstName, applicant.lastName].filter((s): s is string => typeof s === "string" && s.trim().length > 0).join(" ").trim();
  const applicantName = fullName.length > 0 ? fullName : (typeof applicant.fullName === "string" ? applicant.fullName : null);
  let amount: number | null = null; if (row?.requested_amount) { const n = Number(String(row.requested_amount).replace(/[^0-9.\-]/g, "")); amount = Number.isFinite(n) ? n : null; }
  return { applicationId, businessName: business.legalName ?? business.name ?? row?.name ?? null, businessAddress: addrParts.length > 0 ? addrParts.join(", ") : null, applicantName, applicantEmail: typeof applicant.email === "string" ? applicant.email : null, applicantPhone: typeof applicant.phone === "string" ? applicant.phone : null, requestedAmount: amount, productCategory: row?.product_category ?? null, purposeOfFunds: (typeof fp.purposeOfFunds === "string" ? fp.purposeOfFunds : null) ?? (typeof fp.purpose === "string" ? fp.purpose : null), submittedAt: row?.created_at ?? null };
}

export async function sendApplicationForSignature(ctx: OrchestratorContext): Promise<SendResult> {
  if (!ctx?.applicationId) return { ok: false, mode: "skipped", reason: "missing_application_id" };
  const inputs = await loadApplicationForPdf(ctx.applicationId);
  const pdfBytes = await buildApplicationPdf(inputs);
  const buffer = Buffer.from(pdfBytes);
  let blobName: string, blobUrl: string;
  try { const upload = await uploadSignedApplicationPdf(ctx.applicationId, buffer); blobName = upload.blobName; blobUrl = upload.url; }
  catch { return { ok: false, mode: "skipped", reason: "blob_upload_failed" }; }
  if (signnow.isApiKeyConfigured()) return sendReal(ctx.applicationId, inputs, pdfBytes, blobName, blobUrl);
  if (isStubMode()) return sendStub(ctx.applicationId, blobName, blobUrl);
  return { ok: false, mode: "skipped", reason: "not_configured" };
}

async function sendReal(applicationId: string, inputs: ApplicationPdfInputs, pdfBytes: Uint8Array, blobName: string, blobUrl: string): Promise<SendResult> {
  const upload = await signnow.uploadDocument(pdfBytes, `application-${applicationId}.pdf`); const documentId = upload.documentId; const signerEmail = inputs.applicantEmail; if (!signerEmail) throw new Error(`SignNow: no applicant email on file for app=${applicationId}`);
  await signnow.sendInvite({ documentId, signerEmail, signerName: inputs.applicantName ?? undefined, fromEmail: fromEmail(), subject: "Please sign your Boreal Financial loan application" });
  await dbQuery(`UPDATE applications SET signnow_document_id = $1, metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('signed_application_blob_name', $2::text,'signed_application_blob_url',  $3::text,'signnow_stub', false,'signnow_envelope_sent_at',to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')), updated_at = now() WHERE id::text = ($4)::text`, [documentId, blobName, blobUrl, applicationId]);
  return { ok: true, mode: "real", documentId, blobName };
}
async function sendStub(applicationId: string, blobName: string, blobUrl: string): Promise<SendResult> {
  const documentId = `stub-${crypto.randomUUID()}`;
  await dbQuery(`UPDATE applications SET signnow_document_id = $1, metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('signed_application_blob_name', $2::text,'signed_application_blob_url',  $3::text,'signnow_stub', true,'signnow_stub_sent_at',to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')), updated_at = now() WHERE id::text = ($4)::text`, [documentId, blobName, blobUrl, applicationId]);
  setTimeout(() => { void simulateSignedWebhook(applicationId, documentId); }, stubDelayMs()).unref?.();
  return { ok: true, mode: "stub", documentId, blobName };
}
async function simulateSignedWebhook(applicationId: string, documentId: string): Promise<void> {
  const stamped = await dbQuery<{ id: string }>(`UPDATE applications SET signnow_app_signed_at = now(), updated_at = now() WHERE id::text = ($1)::text AND signnow_app_signed_at IS NULL RETURNING id`, [applicationId]); if (stamped.rows.length === 0) return;
  await dbQuery(`UPDATE applicants SET ssn = null, sin = null, updated_at = now() WHERE application_id = $1`, [applicationId]).catch(() => {});
  await dbQuery(`UPDATE application_partners SET ssn = null, sin = null, updated_at = now() WHERE application_id = $1`, [applicationId]).catch(() => {});
  const c = await dbQuery<{ crm_contact_id: string | null }>(`SELECT crm_contact_id FROM applications WHERE id::text = ($1)::text LIMIT 1`, [applicationId]).catch(() => ({ rows: [] as Array<{ crm_contact_id: string | null }> }));
  const contactId = c.rows[0]?.crm_contact_id; if (contactId) await logCrmEvent({ contactId, applicationId, eventType: "signnow_signed", payload: { documentId, stub: true } }).catch(() => {});
  await dbQuery(`INSERT INTO job_queue (id, type, payload, status, created_at) VALUES (gen_random_uuid(), 'send_lender_package', $1::jsonb, 'pending', now()) ON CONFLICT ((payload->>'applicationId')) WHERE type = 'send_lender_package' AND status IN ('pending','running') DO NOTHING`, [JSON.stringify({ applicationId })]).catch(() => {});
}
