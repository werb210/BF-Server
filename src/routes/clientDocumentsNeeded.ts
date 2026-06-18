// BF_SERVER_BLOCK_v698_DOCS_NEEDED_REAL_v1 — mini-portal DocPicker backing endpoint.
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
  /net worth|flinks|banking connection|connect bank|\bcra\b|debt|real estate|equipment|professional advisor|\badvisor/i;

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

function appendRequiredDoc(
  raw: any,
  seen: Set<string>,
  satisfied: Set<string>,
  stillNeeded: NeededDoc[]
): void {
  const docType = docTypeFromRequirement(raw);
  if (!docType) return;
  if (raw && typeof raw === "object" && raw.required === false) return;
  if (CMP_FORM.test(docType)) return;
  if (satisfied.has(docType)) return;
  if (seen.has(docType)) return;
  seen.add(docType);
  stillNeeded.push({ document_type: docType, label: docType });
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

router.get("/needed", async (req: Request, res: Response) => {
  const applicationId =
    typeof req.query.applicationId === "string" ? req.query.applicationId.trim() : "";
  if (!applicationId) return res.status(400).json({ error: "applicationId is required" });

  try {
    // Uploaded documents by category + status. documents uses `category`
    // (not document_type). A category counts as satisfied once it has any
    // non-rejected upload (uploaded / pending / accepted) — the client has
    // done their part and shouldn't be asked again. Rejected docs go in their
    // own bucket so the client knows to re-upload.
    const uploadedRes = await pool.query<{ category: string | null; status: string | null }>(
      `SELECT category, status FROM documents WHERE application_id::text = ($1)::text`,
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

    // Required = the application's own document_requirements (required = true).
    const reqRes = await pool.query<{ category: string }>(
      `SELECT DISTINCT category FROM document_requirements
        WHERE application_id::text = ($1)::text AND required = true AND category IS NOT NULL`,
      [applicationId]
    ).catch(() => ({ rows: [] as Array<{ category: string }> }));

    const stillNeeded: NeededDoc[] = reqRes.rows
      .filter((r: { category: string }) => r.category && !satisfied.has(r.category))
      .map((r: { category: string }) => ({
        document_type: r.category,
        label: humanize(r.category),
      }));

    // BF_SERVER_BLOCK_v722b_PRODUCTREQS_FALLBACK_v1 — document_requirements is not
    // always populated at submit, which left the mini-portal DocPicker empty and
    // blocked post-submit uploads. Primary fallback:
    // metadata.formData.productRequirements.aggregated,
    // the same source the CMP messenger seeds upload steps from. This surfaces
    // Government ID / void cheque / Stage-2 uploads even on received-but-unmatched
    // apps (no lender_product_id). CMP forms and already-uploaded categories are excluded.
    if (stillNeeded.length === 0) {
      const metaRes = await pool.query<{ metadata: any }>(
        `SELECT metadata FROM applications WHERE id::text = ($1)::text LIMIT 1`,
        [applicationId]
      ).catch(() => ({ rows: [] as Array<{ metadata: any }> }));
      const items = productRequirementItems(metaRes.rows[0]?.metadata);
      const seen = new Set<string>();
      for (const item of items) appendRequiredDoc(item, seen, satisfied, stillNeeded);
    }

    // BF_SERVER_BLOCK_v722_DOCS_NEEDED_FALLBACK_v1b — secondary fallback: the matched
    // product's required_documents (covers apps with a lender_product_id but no
    // productRequirements snapshot). CMP forms and already-uploaded categories are excluded.
    if (stillNeeded.length === 0) {
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
      const seen = new Set<string>();
      for (const item of items) appendRequiredDoc(item, seen, satisfied, stillNeeded);
    }

    // Dedupe by normalized category and drop any category the client has since
    // re-uploaded (now satisfied). Fixes the "same doc listed ~10x" spam and the
    // casing mismatch that listed one doc in both rejected and still-needed.
    const satisfiedNorm = new Set(
      Array.from(satisfied).map((c) => c.trim().toLowerCase())
    );
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

    return res.status(200).json({ stillNeeded, rejected });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? "needed_docs_failed" });
  }
});

export default router;
