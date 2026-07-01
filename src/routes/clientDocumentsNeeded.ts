// BF_SERVER_BLOCK_v698_DOCS_NEEDED_REAL_v1 - mini-portal DocPicker backing endpoint.
// Returns the docs the client still needs, in two buckets:
//   rejected    = documents staff rejected (client must re-upload)
//   stillNeeded = required categories with no upload yet
// "Required" primarily comes from the application's own document_requirements (the
// same source the orchestrator and staff Documents/Lenders surfaces use). If that
// submit-time table is empty, this falls back to the wizard's stored product
// requirements first, then the matched product's upload-type required_documents.
import { Router, type Request, type Response } from "express";
import { pool } from "../db.js";

const router = Router();

function humanize(category: string): string {
  return category.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

const CMP_FORM =
  /net worth|flinks|banking connection|connect bank|\bcra\b|debt stack|real estate collateral|equipment collateral|professional advisor|\badvisor/i; // BF_SERVER_CMP_FORM_FIX_v1

type NeededDoc = { document_type: string; label: string };
type UploadedDocRow = { category: string | null; status: string | null };

function docTypeFromRequirement(raw: any): string {
  return typeof raw === "string"
    ? raw.trim()
    : typeof raw?.document_type === "string" && raw.document_type.trim()
    ? raw.document_type.trim()
    : typeof raw?.category === "string" && raw.category.trim()
    ? raw.category.trim()
    : typeof raw?.key === "string" && raw.key.trim()
    ? raw.key.trim()
    : "";
}

// BF_SERVER_REQUEST_ITEMS_FULL_SET_v1 - keeps a document regardless of whether
// it has been uploaded yet, so the full required set can be built.
function appendRequiredDocAll(
  raw: any,
  seen: Set<string>,
  out: NeededDoc[]
): void {
  const docType = docTypeFromRequirement(raw);
  if (!docType) return;
  if (raw && typeof raw === "object" && raw.required === false) return;
  if (CMP_FORM.test(docType)) return;
  if (seen.has(docType)) return;
  seen.add(docType);
  out.push({ document_type: docType, label: docType });
}

function productRequirementItems(metadata: any): any[] {
  const md = metadata && typeof metadata === "object" ? metadata : {};
  const fd = md.formData && typeof md.formData === "object" ? md.formData : md;
  const pr = fd.productRequirements ?? md.productRequirements;
  const selectedProductId = fd.selectedProductId ?? md.selectedProductId;

  const aggregated = pr?.aggregated;
  if (Array.isArray(aggregated)) return aggregated;

  if (pr && selectedProductId && Array.isArray(pr[selectedProductId])) return pr[selectedProductId];

  if (pr && typeof pr === "object" && !Array.isArray(pr)) {
    return Object.values(pr).flatMap((value) => (Array.isArray(value) ? value : []));
  }

  return [];
}

// BF_SERVER_DOCS_PARITY_v1 - shared outstanding-docs computation, reused by both the
// client mini-portal endpoint below AND the staff task-status endpoint, so the two can
// never disagree about whether the applicant still owes documents.
async function computeOutstandingDocsRaw(
  applicationId: string
): Promise<{ stillNeeded: NeededDoc[]; rejected: NeededDoc[]; required: NeededDoc[] }> {
  // Uploaded documents by category + status. A category counts as satisfied
  // once it has any non-rejected upload. Rejected docs go in their own bucket.
  const uploadedRes = await pool.query<{ category: string | null; status: string | null }>(
    // BF_SERVER_DOCS_FAMILY_SHARE_v1 - a document uploaded anywhere in the
    // parent/child family (e.g. the primary equipment app or its closing-cost
    // add-on) satisfies the matching requirement on EVERY app in the family, so
    // the client is never asked to upload the same doc twice across linked apps.
    `WITH fam AS (
       SELECT COALESCE(a.parent_application_id, a.id) AS root_id
       FROM applications a WHERE a.id::text = ($1)::text
     )
     SELECT d.category, d.status FROM documents d
     JOIN applications da ON da.id = d.application_id
     WHERE da.id::text IN (SELECT root_id::text FROM fam)
        OR da.parent_application_id::text IN (SELECT root_id::text FROM fam)`,
    [applicationId]
  ).catch(() => ({ rows: [] as Array<{ category: string | null; status: string | null }> }));
  const uploaded: UploadedDocRow[] = uploadedRes.rows;
  const satisfied: Set<string> = new Set(
    uploaded
      .filter((r: UploadedDocRow) => r.category && r.status !== "rejected")
      .map((r: UploadedDocRow) => r.category as string)
  );
  const rejectedRows = uploaded.filter(
    (r: UploadedDocRow) => r.status === "rejected" && r.category
  );

  // BF_SERVER_REQUEST_ITEMS_FULL_SET_v1 - build the FULL required set for this deal
  // (every required document, uploaded or not). This is what the staff Request Items
  // checkboxes reflect, so they match the Application tab. stillNeeded (the client
  // mini-portal list) is then this set minus already-satisfied uploads. Fallbacks now
  // fire when the PRIMARY required set is empty (not when the outstanding set is empty).
  const required: NeededDoc[] = [];
  const seen = new Set<string>();

  // Primary: the application's own document_requirements (required = true).
  const reqRes = await pool.query<{ category: string }>(
    `SELECT DISTINCT category FROM document_requirements
      WHERE application_id::text = ($1)::text AND required = true AND category IS NOT NULL`,
    [applicationId]
  ).catch(() => ({ rows: [] as Array<{ category: string }> }));
  for (const r of reqRes.rows) {
    if (r.category && !seen.has(r.category)) {
      seen.add(r.category);
      required.push({ document_type: r.category, label: humanize(r.category) });
    }
  }

  // Fallback 1: wizard-stored product requirements (metadata productRequirements.aggregated).
  if (required.length === 0) {
    const metaRes = await pool.query<{ metadata: any }>(
      `SELECT metadata FROM applications WHERE id::text = ($1)::text LIMIT 1`,
      [applicationId]
    ).catch(() => ({ rows: [] as Array<{ metadata: any }> }));
    const items = productRequirementItems(metaRes.rows[0]?.metadata);
    for (const item of items) appendRequiredDocAll(item, seen, required);
  }

  // BF_SERVER_DOCS_PRODUCT_ALWAYS_MERGE_v1 - product always-required docs
  // (e.g. the equipment PO/Invoice) must ALWAYS be in the required set, not
  // fallback-only, or staff Request Items silently drops mandatory docs.
  {
    const prodRes = await pool.query<{ required_documents: any }>(
      `SELECT lp.required_documents
         FROM applications a
         JOIN lender_products lp ON lp.id::text = a.lender_product_id::text
        WHERE a.id::text = ($1)::text
        LIMIT 1`,
      [applicationId]
    ).catch(() => ({ rows: [] as Array<{ required_documents: any }> }));
    const items = Array.isArray(prodRes.rows[0]?.required_documents)
      ? prodRes.rows[0]?.required_documents
      : [];
    for (const item of items) appendRequiredDocAll(item, seen, required);
  }

  // stillNeeded = full required set minus categories already uploaded (non-rejected).
  const satisfiedNorm = new Set(
    Array.from(satisfied).map((c) => c.trim().toLowerCase())
  );
  const stillNeeded = required.filter(
    (d) => !satisfiedNorm.has(d.document_type.trim().toLowerCase())
  );

  // Rejected docs (client must re-upload), deduped and not already re-satisfied.
  const seenRejected = new Set<string>();
  const rejected = rejectedRows
    .filter((r: UploadedDocRow) => {
      const cat = (r.category as string).trim();
      const key = cat.toLowerCase();
      if (satisfiedNorm.has(key)) return false;
      if (seenRejected.has(key)) return false;
      seenRejected.add(key);
      return true;
    })
    .map((r: UploadedDocRow) => ({
      document_type: r.category as string,
      label: humanize(r.category as string),
    }));

  return { stillNeeded, rejected, required };
}

// BF_SERVER_DOC_WAIVERS_v1 - per-application admin waivers. A waived requirement is removed
// from the outstanding set everywhere (client upload list, staff block, Send/SignNow gate).
export async function getWaivedDocTypes(applicationId: string): Promise<Set<string>> {
  const res = await pool.query<{ document_type: string }>(
    `SELECT document_type FROM application_document_waivers WHERE application_id::text = ($1)::text`,
    [applicationId]
  ).catch(() => ({ rows: [] as Array<{ document_type: string }> }));
  return new Set(res.rows.map((r: { document_type: string }) => String(r.document_type ?? "").trim().toLowerCase()));
}

export async function computeOutstandingDocs(
  applicationId: string
): Promise<{ stillNeeded: NeededDoc[]; rejected: NeededDoc[]; required: NeededDoc[] }> {
  const raw = await computeOutstandingDocsRaw(applicationId);
  const waived = await getWaivedDocTypes(applicationId);
  return {
    stillNeeded: raw.stillNeeded.filter((d) => !waived.has(String(d.document_type ?? "").trim().toLowerCase())),
    rejected: raw.rejected,
    required: raw.required.filter((d) => !waived.has(String(d.document_type ?? "").trim().toLowerCase())),
  };
}

// BF_SERVER_BLOCK_v_FORM_WAIVERS_v1 - form ids that have been requested of the
// client (posted as task prompts). Mirrors the cta_action contract used by
// task-status so the Request Items tab and the Application tab agree on forms.
const FORM_IDS = ["networth", "flinks", "cra", "debt", "realestate", "equipment", "advisors"];
export async function getRequestedFormIds(applicationId: string): Promise<string[]> {
  const res = await pool.query<{ cta_action: string }>(
    `SELECT DISTINCT cta_action FROM communications_messages
      WHERE application_id::text = ($1)::text
        AND (cta_action LIKE 'form:%'
             OR cta_action IN ('networth','flinks','cra','debt','realestate','equipment','advisors'))`,
    [applicationId]
  ).catch(() => ({ rows: [] as Array<{ cta_action: string }> }));
  const ids = new Set<string>();
  for (const r of res.rows) {
    let k = String(r.cta_action ?? "");
    if (k.startsWith("form:")) k = k.slice(5);
    if (FORM_IDS.includes(k)) ids.add(k);
  }
  return Array.from(ids);
}

export async function getRequestItemsForApp(
  applicationId: string
): Promise<{ required: NeededDoc[]; waived: string[]; forms: string[]; formsWaived: string[] }> {
  const raw = await computeOutstandingDocsRaw(applicationId);
  const allWaived = await getWaivedDocTypes(applicationId);
  // Form waivers are stored in the same table with a "form:<id>" document_type,
  // so split them out from real document waivers.
  const waived: string[] = [];
  const formsWaived: string[] = [];
  for (const w of allWaived) {
    if (w.startsWith("form:")) formsWaived.push(w.slice(5));
    else waived.push(w);
  }
  const forms = await getRequestedFormIds(applicationId);
  return { required: raw.required, waived, forms, formsWaived };
}

router.get("/needed", async (req: Request, res: Response) => {
  const applicationId =
    typeof req.query.applicationId === "string" ? req.query.applicationId.trim() : "";
  if (!applicationId) return res.status(400).json({ error: "applicationId is required" });
  try {
    const result = await computeOutstandingDocs(applicationId);
    return res.status(200).json(result);
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? "needed_docs_failed" });
  }
});

export default router;
