// BF_SERVER_BLOCK_53_v1 -- mini-portal DocPicker backing endpoint.
// Returns the list of docs the client still needs to upload, broken
// into two buckets: rejected re-uploads and still-needed required
// docs. The mini-portal DocPicker iterates both lists.
//
// "Required" = lender_products_required_docs for the application's
// matched lender product. If the app has no matched product yet, we
// fall back to a sensible default required-doc list (3yr financials,
// 3yr tax returns, 6mo banking, photo ID).
import { Router, type Request, type Response } from "express";
import { pool } from "../db.js";

const router = Router();

const FALLBACK_REQUIRED = [
  { document_type: "government_id", label: "Government-issued ID" },
  { document_type: "financials_3yr", label: "3 years accountant-prepared financials" },
  { document_type: "tax_returns_3yr", label: "3 years business tax returns" },
  { document_type: "bank_statements_6mo", label: "6 months business banking statements" },
];

router.get("/needed", async (req: Request, res: Response) => {
  const applicationId = typeof req.query.applicationId === "string" ? req.query.applicationId.trim() : "";
  if (!applicationId) return res.status(400).json({ error: "applicationId is required" });

  try {
    // What's been uploaded and its status.
    const uploadedRes = await pool.query<{ document_type: string | null; status: string | null }>(
      `SELECT document_type, status FROM documents WHERE application_id = $1`,
      [applicationId]
    ).catch(() => ({ rows: [] as any[] }));
    const uploaded = uploadedRes.rows;
    const approvedTypes = new Set(uploaded.filter((r) => r.status === "approved").map((r) => r.document_type ?? ""));
    const rejected = uploaded.filter((r) => r.status === "rejected" && r.document_type);

    // Required for matched lender product, fallback to defaults.
    let required: { document_type: string; label: string }[] = [];
    try {
      const appRow = await pool.query<{
        lender_product_id: string | null;
        product_category: string | null;
        requested_amount: string | number | null;
        metadata: Record<string, unknown> | null;
      }>(
        `SELECT lender_product_id, product_category, requested_amount, metadata FROM applications WHERE id = $1 LIMIT 1`,
        [applicationId]
      );
      const productId = appRow.rows[0]?.lender_product_id ?? null;
      if (productId) {
        const reqRes = await pool.query<{ document_type: string; label: string | null }>(
          `SELECT document_type, label FROM lender_products_required_docs WHERE lender_product_id = $1`,
          [productId]
        ).catch(() => ({ rows: [] as any[] }));
        required = reqRes.rows.map((r) => ({ document_type: r.document_type, label: r.label || r.document_type }));
      } else if (appRow.rows[0]) {
        const row = appRow.rows[0];
        const category = String(row.product_category ?? "").toLowerCase();
        const amount = Number(row.requested_amount ?? 0) || null;
        const country = (() => {
          try {
            const md = row.metadata as any;
            return String(md?.kyc?.country ?? md?.business?.country ?? md?.businessLocation ?? "").toLowerCase();
          } catch { return ""; }
        })();
        if (category && amount) {
          const unionRes = await pool.query<{ document_type: string; label: string | null }>(
            `SELECT DISTINCT d.document_type, d.label
               FROM lender_products p
               JOIN lender_products_required_docs d ON d.lender_product_id = p.id
              WHERE LOWER(p.category) = $1
                AND (p.amount_min IS NULL OR p.amount_min <= $2)
                AND (p.amount_max IS NULL OR p.amount_max >= $2)
                AND ($3 = '' OR LOWER(COALESCE(p.country, '')) = $3 OR LOWER(COALESCE(p.country, '')) = '')
                AND COALESCE(p.active, true) = true`,
            [category, amount, country]
          ).catch(() => ({ rows: [] as any[] }));
          required = unionRes.rows.map((r) => ({ document_type: r.document_type, label: r.label || r.document_type }));
        }
      }
    } catch {
      /* fall through to defaults */
    }
    if (required.length === 0) required = FALLBACK_REQUIRED;

    const stillNeeded = required.filter((r) => !approvedTypes.has(r.document_type));

    return res.status(200).json({
      stillNeeded,
      rejected: rejected.map((r) => ({ document_type: r.document_type, label: r.document_type })),
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? "needed_docs_failed" });
  }
});

export default router;
