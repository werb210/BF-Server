// BF_LENDER_MATCH_v42 — Block 42-A — geography fix + portal-compatible LenderMatch shape.
//
// The previous version of this file always excluded any applicant who had a
// province set whenever the product was US-only, which was the inverse of the
// intended rule. The real rule is: if the product's country gate is "BOTH",
// always pass; otherwise the applicant's country must equal the product's
// country. (Province is informational, not a gate.)
//
// We also enrich the return shape so the staff portal LendersTab can render
// without further joins: id (= lender_product_id), lenderId, lenderName,
// productName, productCategory, matchPercent, reasoning, plus the upstream
// submission status if there is one.
import { runQuery } from "../db.js";
import { normalizeToPercent, scoreAmountFit, type PrequalInput } from "./scoringEngine.js";

type ProductRow = {
  product_id: string;
  lender_id: string;
  lender_name: string;
  product_name: string;
  product_category: string | null;
  country: string | null;
  active: boolean;
  min_amount: number | null;
  max_amount: number | null;
  submission_method: string | null;
};

export type LenderMatch = {
  id: string;
  lenderId: string;
  lenderName: string;
  productName: string;
  productCategory: string | null;
  matchPercent: number;
  reasoning: string;
  submissionMethod: string | null;
  // BF_LENDERS_TAB_FIX_v55_SERVER — surface funding range so the portal
  // can render dedicated columns. Sourced from lender_product_requirements
  // (already aggregated via min/max in the SQL query above).
  amountMin: number | null;
  amountMax: number | null;
};

function geographyAllows(productCountry: string | null, applicantCountry: PrequalInput["country"]): boolean {
  if (!productCountry || productCountry === "BOTH") return true;
  if (!applicantCountry) return true; // applicant country unknown — be permissive
  return productCountry === applicantCountry;
}

export async function matchLenders(input: PrequalInput): Promise<LenderMatch[]> {
  const requestedAmount = input.requestedAmount ?? null;
  const { rows: productRows } = await runQuery<ProductRow>(
    `select lp.id                       as product_id,
            lp.lender_id                as lender_id,
            l.name                      as lender_name,
            lp.name                     as product_name,
            lp.category::text           as product_category,
            lp.country                  as country,
            lp.active                   as active,
            coalesce(lp.min_amount, lp.amount_min)  as min_amount,
            coalesce(lp.max_amount, lp.amount_max)  as max_amount,
            l.submission_method         as submission_method
       from lender_products lp
       join lenders          l   on l.id = lp.lender_id
  left join lender_product_requirements lpr on lpr.lender_product_id = lp.id
      where lp.active = true
        and coalesce(l.active, true) = true
   group by lp.id, lp.lender_id, l.name, lp.name, lp.category, lp.country, lp.active, l.submission_method
   order by lp.updated_at desc`
  );

  // BF_SERVER_BLOCK_v210_LENDER_CATEGORY_ALIAS_AND_OCR_AUDIT_v1
  // Map both the application's wanted category and the lender row's category
  // to a canonical bucket ID. lender_products.category is a short-code enum
  // (LOC, TERM, EQUIPMENT, ...) but the wizard stores the long bucket form
  // (LINE_OF_CREDIT, TERM_LOAN, ...). Without this mapping, no rows match.
  function toBucketId(raw: string | null | undefined): string | null {
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
  // BF_SERVER_LENDER_MATCH_DUAL_v1 — match against the full set of wanted
  // categories (closing-cost companions carry TERM+LOC); fall back to the single
  // productCategory when no multi-category set is present.
  const wantedSource = (input.productCategories && input.productCategories.length)
    ? input.productCategories
    : (input.productCategory ? [input.productCategory] : []);
  const wantedBuckets = new Set(wantedSource.map((c) => toBucketId(c)).filter(Boolean));

  const rows = productRows as ProductRow[];

  const filtered = rows.filter((row: ProductRow) => {
    if (!geographyAllows(row.country, input.country ?? null)) return false;
    if (requestedAmount && row.min_amount && requestedAmount < Number(row.min_amount)) return false;
    if (requestedAmount && row.max_amount && requestedAmount > Number(row.max_amount)) return false;
    if (wantedBuckets.size) {
      const rowBucket = toBucketId(row.product_category);
      if (!wantedBuckets.has(rowBucket)) return false;
    }
    return true;
  });

  return filtered
    .map((row): LenderMatch => {
      const minN = row.min_amount === null || row.min_amount === undefined ? null : Number(row.min_amount);
      const maxN = row.max_amount === null || row.max_amount === undefined ? null : Number(row.max_amount);
      const amountScore   = scoreAmountFit(requestedAmount, minN, maxN);
      const maturityScore = input.timeInBusiness && input.timeInBusiness >= 24 ? 0.9 : 0.65;
      const revenueScore  = input.revenue && input.revenue >= 120000 ? 0.9 : 0.6;
      const aggregate     = amountScore * 0.5 + maturityScore * 0.25 + revenueScore * 0.25;
      const minText       = minN ? `$${minN.toLocaleString()}` : "no minimum";
      const maxText       = maxN ? `$${maxN.toLocaleString()}` : "no maximum";
      return {
        id:               row.product_id,
        lenderId:         row.lender_id,
        lenderName:       row.lender_name,
        productName:      row.product_name,
        productCategory:  row.product_category,
        matchPercent:     normalizeToPercent(aggregate),
        reasoning:        `Amount fit ${minText}-${maxText}; weighted by time-in-business and annual revenue signals.`,
        submissionMethod: row.submission_method,
        // BF_LENDERS_TAB_FIX_v55_SERVER
        amountMin:        minN,
        amountMax:        maxN,
      };
    })
    .sort((a: LenderMatch, b: LenderMatch) => b.matchPercent - a.matchPercent);
}
