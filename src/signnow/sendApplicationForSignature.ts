// BF_SERVER_BLOCK_v200_SIGNNOW_STUB_MODE_v1
// BF_SERVER_BLOCK_v201_SIGNNOW_REAL_BUILD_v1
// BF_SERVER_BLOCK_v202_SIGNNOW_FILLED_PDF_v1
import crypto from "node:crypto";
import { dbQuery } from "../db.js";
import { logCrmEvent } from "../modules/crm/crmTimeline.service.js";
import { buildApplicationPdf, type ApplicationPdfInputs, type PdfOwner } from "./pdfBuilder.js";
import { uploadSignedApplicationPdf } from "./blobStorage.js";
import * as signnow from "./signnowClient.js";

type OrchestratorContext = { applicationId: string; pool?: unknown };
type SendResult =
  | { ok: true; mode: "real"; documentId: string; blobName: string }
  | { ok: true; mode: "stub"; documentId: string; blobName: string }
  | { ok: false; mode: "skipped"; reason: string };

function isStubMode(): boolean { const v = (process.env.SIGNNOW_STUB_MODE ?? "").trim().toLowerCase(); return ["1", "true", "yes", "on"].includes(v); }
function stubDelayMs(): number { const n = Number(process.env.SIGNNOW_STUB_DELAY_MS); return Number.isFinite(n) && n >= 0 ? n : 2000; }
function fromEmail(): string { return process.env.SIGNNOW_FROM_EMAIL || "no-reply@boreal.financial"; }

function obj(v: unknown): Record<string, any> | null { return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : null; }
function num(v: unknown): number | null { if (v === null || v === undefined || v === "") return null; const n = Number(String(v).replace(/[^0-9.\-]/g, "")); return Number.isFinite(n) ? n : null; }
function str(v: unknown): string | null { return typeof v === "string" && v.trim().length > 0 ? v : (typeof v === "number" ? String(v) : null); }
function normLocation(v: unknown): string | null { const s = String(v ?? ""); if (/^ca$|canada/i.test(s)) return "Canada"; if (/^us$|united states|usa/i.test(s)) return "United States"; return s.trim().length ? s : null; }

function ownerFrom(src: Record<string, any>, label: string, prefix = ""): PdfOwner {
  const g = (k: string) => src[prefix ? prefix + k[0].toUpperCase() + k.slice(1) : k];
  return {
    label,
    firstName: str(g("firstName")), lastName: str(g("lastName")),
    ownership: num(g("ownership")),
    email: str(g("email")), phone: str(g("phone")),
    street: str(g("street")) ?? str(g("address")), city: str(g("city")),
    province: str(g("state")) ?? str(g("province")), postal: str(g("zip")) ?? str(g("postalCode")),
    dob: str(g("dob")), sin: str(g("ssn")) ?? str(g("sin")),
    creditScore: str(g("creditScoreRange")) ?? str(g("creditScore")),
  };
}

export async function loadApplicationForPdf(applicationId: string): Promise<ApplicationPdfInputs> {
  const res = await dbQuery<{ id: string; name: string | null; requested_amount: string | null; product_category: string | null; metadata: any }>(
    `SELECT id, name, requested_amount, product_category, metadata FROM applications WHERE id::text = ($1)::text LIMIT 1`, [applicationId]);
  const row = res.rows[0];
  const md = obj(row?.metadata) ?? {};
  const business = obj(md.business) ?? {};
  const applicant = obj(md.applicant) ?? {};
  const kyc = obj(md.kyc) ?? obj(md.financial) ?? {};

  const owners: PdfOwner[] = [ownerFrom(applicant, "Owner 1") ];
  const nestedPartner = obj(applicant.partner) ?? obj(md.partner);
  const hasPartner = applicant.hasMultipleOwners || applicant.partnerFirstName || nestedPartner?.firstName;
  if (hasPartner) {
    owners.push(nestedPartner ? ownerFrom(nestedPartner, "Owner 2") : ownerFrom(applicant, "Owner 2", "partner"));
  }

  return {
    applicationId,
    product: {
      lookingFor: str(kyc.lookingFor),
      category: str(row?.product_category) ?? str(kyc.productCategory) ?? str(md.product_category),
      amountRequested: num(row?.requested_amount) ?? num(kyc.fundingAmount) ?? num(kyc.requestedAmount) ?? num(kyc.capitalAmount),
      equipmentValue: num(kyc.equipmentAmount),
      location: normLocation(kyc.businessLocation),
    },
    funding: {
      purposeOfFunds: str(kyc.purposeOfFunds) ?? str(kyc.purpose),
      industry: str(kyc.industry) ?? str(business.industry),
      yearsInBusiness: str(kyc.yearsInBusiness) ?? str(kyc.salesHistory),
      annualRevenue: str(kyc.annualRevenue) ?? str(kyc.revenueLast) ?? str(kyc.revenueLast12Months),
      monthlyRevenue: str(kyc.monthlyRevenue),
      accountsReceivable: num(kyc.accountsReceivable) ?? num(kyc.arBalance),
      fixedAssets: num(kyc.fixedAssets),
      availableCollateral: num(kyc.availableCollateral),
    },
    business: {
      legalName: str(business.legalName) ?? str(business.companyName) ?? str(row?.name),
      dba: str(business.businessName) ?? str(business.dba),
      structure: str(business.businessStructure),
      inBusinessSince: str(business.startDate),
      employees: str(business.employees),
      estimatedRevenue: num(business.estimatedRevenue),
      phone: str(business.phone), website: str(business.website),
      address: str(business.address) ?? str(business.street),
      city: str(business.city), province: str(business.state) ?? str(business.province),
      postal: str(business.zip) ?? str(business.postalCode),
    },
    owners,
    applicantEmail: owners[0]?.email ?? null,
    applicantName: [owners[0]?.firstName, owners[0]?.lastName].filter(Boolean).join(" ").trim() || null,
  };
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
  const upload = await signnow.uploadDocument(pdfBytes, `application-${applicationId}.pdf`);
  const documentId = upload.documentId;
  const o1 = inputs.owners[0];
  const signerEmail = o1?.email;
  if (!signerEmail) throw new Error(`SignNow: no applicant email on file for app=${applicationId}`);
  const signerName = [o1?.firstName, o1?.lastName].filter(Boolean).join(" ").trim() || undefined;
  await signnow.sendInvite({ documentId, signerEmail, signerName, fromEmail: fromEmail(), subject: "Please sign your Boreal Financial loan application" });
  await dbQuery(`UPDATE applications SET signnow_document_id = $1, metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('signed_application_blob_name', $2::text,'signed_application_blob_url',  $3::text,'signnow_stub', false,'signnow_envelope_sent_at',to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')), updated_at = now() WHERE id::text = ($4)::text`, [documentId, blobName, blobUrl, applicationId]);
  return { ok: true, mode: "real", documentId, blobName };
}
async function sendStub(applicationId: string, blobName: string, blobUrl: string): Promise<SendResult> {
  const documentId = `stub-${crypto.randomUUID()}`;
  await dbQuery(`UPDATE applications SET signnow_document_id = $1, metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('signed_application_blob_name', $2::text,'signed_application_blob_url',  $3::text,'signnow_stub', true,'signnow_stub_sent_at',to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')), updated_at = now() WHERE id::text = ($4)::text`, [documentId, blobName, blobUrl, applicationId]);
  const timer = setTimeout(() => { void simulateSignedWebhook(applicationId, documentId); }, stubDelayMs());
  const maybeTimer = timer as unknown as { unref?: () => void };
  maybeTimer.unref?.();
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
