// BF_SERVER_BLOCK_v698_DOCS_NEEDED_REAL_v1 — mini-portal DocPicker backing endpoint.
// Returns the docs the client still needs, in two buckets:
//   rejected    = documents staff rejected (client must re-upload)
//   stillNeeded = required categories with no upload yet
// "Required" is the application's own document_requirements (the same source the
// orchestrator and staff Documents/Lenders surfaces use). There is intentionally
// NO hardcoded fallback: an application with no requirements returns empty lists,
// so the client is never shown documents that were never actually required.
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

    const stillNeeded = reqRes.rows
      .filter((r) => r.category && !satisfied.has(r.category))
      .map((r) => ({ document_type: r.category, label: humanize(r.category) }));

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
