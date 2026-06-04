// BF_SERVER_BLOCK_v698_DOCS_NEEDED_REAL_v1 — mini-portal DocPicker backing endpoint.
// Returns the docs the client still needs, in two buckets:
//   rejected    = documents staff rejected (client must re-upload)
//   stillNeeded = required categories with no upload yet
// "Required" primarily comes from the application's own document_requirements (the
// same source the orchestrator and staff Documents/Lenders surfaces use). If that
// submit-time table is empty, this falls back to the product's upload-type
// required_documents so the client can still upload required docs.
import { Router, type Request, type Response } from "express";
import { pool } from "../db.js";

const router = Router();

function humanize(category: string): string {
  return category.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

router.get("/needed", async (req: Request, res: Response) => {
  const applicationId = typeof req.query.applicationId === "string" ? req.query.applicationId.trim() : "";
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
    const uploaded = uploadedRes.rows;
    const satisfied = new Set(
      uploaded.filter((r) => r.category && r.status !== "rejected").map((r) => r.category as string)
    );
    const rejectedRows = uploaded.filter((r) => r.status === "rejected" && r.category);

    // Required = the application's own document_requirements (required = true).
    const reqRes = await pool.query<{ category: string }>(
      `SELECT DISTINCT category FROM document_requirements
        WHERE application_id::text = ($1)::text AND required = true AND category IS NOT NULL`,
      [applicationId]
    ).catch(() => ({ rows: [] as Array<{ category: string }> }));

    let stillNeeded = reqRes.rows
      .filter((r) => r.category && !satisfied.has(r.category))
      .map((r) => ({ document_type: r.category, label: humanize(r.category) }));

    // BF_SERVER_BLOCK_v722_DOCS_NEEDED_FALLBACK_v1 — document_requirements is not
    // always populated at submit, which left the mini-portal DocPicker empty and
    // blocked post-submit uploads (e.g. Government ID). When empty, fall back to
    // the application's product required_documents. CMP forms (net worth, Flinks,
    // CRA, debt, real estate, equipment, advisors) are excluded — they have their
    // own buttons. Already-uploaded categories are excluded via `satisfied`.
    if (stillNeeded.length === 0) {
      const CMP_FORM = /net worth|flinks|banking connection|connect bank|\bcra\b|debt|real estate|equipment|professional advisor|\badvisor/i;
      const prodRes = await pool.query<{ required_documents: any }>(
        `SELECT lp.required_documents
           FROM applications a
           JOIN lender_products lp ON lp.id::text = a.lender_product_id::text
          WHERE a.id::text = ($1)::text
          LIMIT 1`,
        [applicationId]
      ).catch(() => ({ rows: [] as Array<{ required_documents: any }> }));
      const arr = prodRes.rows[0]?.required_documents;
      const items = Array.isArray(arr) ? arr : [];
      const seen = new Set<string>();
      for (const it of items) {
        const docType =
          typeof it === "string"
            ? it.trim()
            : typeof it?.document_type === "string" && it.document_type.trim()
            ? it.document_type.trim()
            : typeof it?.category === "string" && it.category.trim()
            ? it.category.trim()
            : "";
        if (!docType) continue;
        if (it && typeof it === "object" && it.required === false) continue;
        if (CMP_FORM.test(docType)) continue;
        if (satisfied.has(docType)) continue;
        if (seen.has(docType)) continue;
        seen.add(docType);
        stillNeeded.push({ document_type: docType, label: docType });
      }
    }

    const rejected = rejectedRows.map((r) => ({
      document_type: r.category as string,
      label: humanize(r.category as string),
    }));

    return res.status(200).json({ stillNeeded, rejected });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? "needed_docs_failed" });
  }
});

export default router;
