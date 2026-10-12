// BF_SERVER_v789_CLIENT_UPLOAD_CATEGORIES
// The client upload front doors (/api/documents/public-upload, and /upload when
// the caller is a client) stored whatever category the request named, and the
// category doubles as documents.document_type. A client could therefore file a
// PDF as "signed_term_sheet" (which termSheetSigned treats as the lender's term
// sheet being signed) or under any staff/system category. This is an allow-list
// on purpose: a category added later is not client-uploadable until listed here.
import { REQUIRED_DOCUMENT_KEYS, normalizeRequiredDocumentKey } from "../../db/schema/requiredDocuments.js";
import { resolveExpectedDocumentKey } from "./classifyDocument.js";

// Same derivation the portal uses for doc keys (label -> snake_case), after
// collapsing unicode dashes so "PnL - Interim financials" matches whatever
// dash the stored label uses.
export function categorySlug(value: unknown): string {
  return String(value ?? "")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// Requirement labels a lender product can ask the client for (lockstep with
// PORTAL_FORM_DOC_LABELS in src/routes/portalLenderProducts.ts), plus the SBA
// stage-2 keys. A drift test pins every portal label to this list.
export const CLIENT_UPLOADABLE_LABELS: readonly string[] = [
  "6 months business banking statements",
  "Purchase Order or Invoice of Equipment to finance",
  "3 years accountant prepared financials",
  "3 years business tax returns",
  "PnL - Interim financials",
  "Balance Sheet - Interim financials",
  "A/R",
  "A/P",
  "2 pieces of Government Issued ID",
  "VOID cheque or PAD",
  "Personal net worth statement",
  "2 years personal tax returns (T1 generals)",
  "Corporate structure / org chart",
  "Business plan / projections",
  "Lease agreement (if applicable)",
  "Lease agreement",
  "Debt stack",
  "Banking connection (Flinks view-only)",
  "CRA view-only access",
  "Real estate collateral",
  "Equipment collateral",
  "Professional advisors (CPA / lawyer / insurance)",
  "Budget",
  "Finance plan",
  "Tax credit status",
  "Production schedule",
  "Minimum guarantees / presales",
  "sba_form_413",
  "sba_form_1919",
  "owner_photo_id",
  "formation_documents",
  "personal_tax_returns",
  "business_plan",
  "sba_1919_attachments",
  "debt_schedule",
  "lease_or_loi",
  // BF_SERVER_BLOCK_v818_OTHER_SKIP_OCR - the client's "Other" bucket.
  "Other",
];

// Written only by the server (SignNow completions, rendered forms, packages)
// or by staff. Never accepted from a client, even when a resolver below would
// otherwise map the name onto an uploadable key.
export const STAFF_ONLY_CATEGORY_SLUGS: ReadonlySet<string> = new Set([
  "signed_term_sheet",
  "term_sheet",
  "signed_application",
  "media_fee_agreement",
  "fee_agreement",
  "sba_forms",
  "lender_package",
  "credit_summary",
  "offer",
  "internal",
]);

const ALLOWED_SLUGS: ReadonlySet<string> = new Set([
  ...CLIENT_UPLOADABLE_LABELS.map(categorySlug),
  ...REQUIRED_DOCUMENT_KEYS,
]);
const CANONICAL_KEYS: ReadonlySet<string> = new Set(REQUIRED_DOCUMENT_KEYS);

export function isClientUploadableCategory(category: unknown): boolean {
  const raw = typeof category === "string" ? category.trim() : "";
  if (!raw || raw.length > 120) return false;
  const slug = categorySlug(raw);
  if (!slug || STAFF_ONLY_CATEGORY_SLUGS.has(slug)) return false;
  if (ALLOWED_SLUGS.has(slug)) return true;
  // Legacy keys (bank_statements, id_document, void_check, ...) and the label
  // variants the document checks already resolve ("Bank Statements", "A/R aging").
  if (normalizeRequiredDocumentKey(slug)) return true;
  return CANONICAL_KEYS.has(resolveExpectedDocumentKey(raw));
}
