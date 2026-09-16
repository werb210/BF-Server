// BF_SERVER_CHANGE_PRODUCT_CATEGORY_v286
// Staff can correct the product category an applicant picked (for example
// Merchant Cash Advance when they wanted a Term Loan) and re-match lenders.
// Values are the canonical buckets the lender match engine uses.
export const PRODUCT_CATEGORIES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "TERM_LOAN", label: "Term Loan" },
  { value: "LINE_OF_CREDIT", label: "Line of Credit" },
  { value: "MERCHANT_CASH_ADVANCE", label: "Merchant Cash Advance" },
  { value: "EQUIPMENT_FINANCE", label: "Equipment Finance" },
  { value: "FACTORING", label: "Factoring" },
  { value: "PURCHASE_ORDER_FINANCE", label: "Purchase Order Finance" },
  { value: "ASSET_BASED_LENDING", label: "Asset-Based Lending" },
  { value: "SBA_GOVERNMENT", label: "SBA / Government" },
  { value: "STARTUP_CAPITAL", label: "Startup Capital" },
  { value: "MEDIA", label: "Media Funding" },
];

export function normalizeProductCategory(raw: unknown): string | null {
  const v = String(raw ?? "").trim().toUpperCase().replace(/[\s\-/]+/g, "_");
  return PRODUCT_CATEGORIES.some((c) => c.value === v) ? v : null;
}

type Query = (sql: string, params: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;

/**
 * Sets the category, drops any multi-category match override (closing-cost
 * companions) so the staff choice wins, and keeps a history in metadata.
 */
export async function changeProductCategory(query: Query, applicationId: string, category: string, changedBy: string | null) {
  const current = await query(`SELECT product_category FROM applications WHERE id::text = ($1)::text LIMIT 1`, [applicationId]);
  const from = current.rows[0]?.product_category ?? null;
  const entry = { from, to: category, by: changedBy, at: new Date().toISOString() };
  await query(
    `UPDATE applications
        SET product_category = $2,
            metadata = (COALESCE(metadata, '{}'::jsonb) - 'match_categories' - 'matchCategories')
                       || jsonb_build_object(
                            'product_category', $2::text,
                            'product_category_history',
                            COALESCE(metadata->'product_category_history', '[]'::jsonb) || jsonb_build_array($3::jsonb)
                          ),
            lender_matches_stale = true,
            updated_at = now()
      WHERE id::text = ($1)::text`,
    [applicationId, category, JSON.stringify(entry)],
  );
  return { from, to: category };
}
