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

// BF_SERVER_BLOCK_v210_LENDER_CATEGORY_ALIAS_AND_OCR_AUDIT_v1
// Map both the application's wanted category and the lender row's category
// to a canonical bucket ID. lender_products.category is a short-code enum
// (LOC, TERM, EQUIPMENT, ...) but the wizard stores the long bucket form
// (LINE_OF_CREDIT, TERM_LOAN, ...). Without this mapping, no rows match.
export function toBucketId(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const upper = String(raw).trim().toUpperCase().replace(/[\s\-/]+/g, "_").replace(/__+/g, "_");
  if (!upper) return null;
  // Aliases mirror BF-client/src/wizard/categoryAliases.ts
  const map: Record<string, string> = {
    LOC: "LINE_OF_CREDIT",
    LINE_OF_CREDIT: "LINE_OF_CREDIT",
    TERM: "TERM_LOAN",
    TERM_LOAN: "TERM_LOAN",
    WORKING_CAPITAL: "TERM_LOAN",
    EQUIPMENT: "EQUIPMENT_FINANCE",
    EQUIPMENT_FINANCE: "EQUIPMENT_FINANCE",
    EQUIPMENT_FINANCING: "EQUIPMENT_FINANCE",
    FACTORING: "FACTORING",
    INVOICE_FACTORING: "FACTORING",
    PO: "PURCHASE_ORDER_FINANCE",
    PURCHASE_ORDER: "PURCHASE_ORDER_FINANCE",
    PURCHASE_ORDER_FINANCE: "PURCHASE_ORDER_FINANCE",
    PURCHASE_ORDER_FINANCING: "PURCHASE_ORDER_FINANCE",
    MCA: "MERCHANT_CASH_ADVANCE",
    MERCHANT_CASH_ADVANCE: "MERCHANT_CASH_ADVANCE",
    MEDIA: "MEDIA",
    MEDIA_FUNDING: "MEDIA",
    ABL: "ASSET_BASED_LENDING",
    ASSET_BASED_LENDING: "ASSET_BASED_LENDING",
    SBA: "SBA_GOVERNMENT",
    SBA_GOVERNMENT: "SBA_GOVERNMENT",
    STARTUP: "STARTUP_CAPITAL",
    STARTUP_CAPITAL: "STARTUP_CAPITAL",
  };
  return map[upper] ?? upper;
}

// BF_SERVER_v887_PRODUCT_LABELS - plain words for any stored product code (TERM, TERM_LOAN, LOC, MCA ...), from the
// label list above. Staff screens and match reasons use this instead of the raw code. Unknown codes are split into words.
export function productCategoryLabel(raw: unknown): string {
  if (raw === null || raw === undefined || String(raw).trim() === "") return "";
  const bucket = toBucketId(String(raw));
  const hit = PRODUCT_CATEGORIES.find((c) => c.value === bucket);
  if (hit) return hit.label;
  const words = String(raw).trim().replace(/[_\-]+/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

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
