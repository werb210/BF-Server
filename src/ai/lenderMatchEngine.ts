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
import { productCategoryLabel, toBucketId } from "../modules/applications/productCategoryChange.js"; // BF_SERVER_v887_PRODUCT_LABELS

// BF_SERVER_v887_LENDER_MATCH_FIX - bumped when the match row shape or scoring changes, so lists cached in an older
// shape are recalculated when the Lenders tab opens instead of showing old numbers.
export const MATCH_VERSION = 887;

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
  productCategoryLabel: string; // BF_SERVER_v887_PRODUCT_LABELS - plain words for productCategory
  matchPercent: number;
  reasoning: string;
  submissionMethod: string | null;
  // BF_LENDERS_TAB_FIX_v55_SERVER — surface funding range so the portal
  // can render dedicated columns. Sourced from lender_product_requirements
  // (already aggregated via min/max in the SQL query above).
  amountMin: number | null;
  amountMax: number | null;
  matchVersion: number; // BF_SERVER_v887_LENDER_MATCH_FIX
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
            -- BF_SERVER_v887_LENDER_MATCH_FIX - amount_min/amount_max are what the Lender product editor saves;
            -- min_amount/max_amount are the older columns and only fill a gap.
            coalesce(lp.amount_min, lp.min_amount)  as min_amount,
            coalesce(lp.amount_max, lp.max_amount)  as max_amount,
            l.submission_method         as submission_method
       from lender_products lp
       join lenders          l   on l.id = lp.lender_id
  left join lender_product_requirements lpr on lpr.lender_product_id = lp.id
      where lp.active = true
        and coalesce(l.active, true) = true
   group by lp.id, lp.lender_id, l.name, lp.name, lp.category, lp.country, lp.active, l.submission_method
   order by lp.updated_at desc`
  );

  // BF_SERVER_BLOCK_v210_LENDER_CATEGORY_ALIAS_AND_OCR_AUDIT_v1 - toBucketId (product category aliases) now
  // lives with the category labels in productCategoryChange.ts (v887) so the labels can use it too.
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
      // A maximum of 0 is how an empty box was sometimes saved: treat it as "no maximum on file".
      const maxN = row.max_amount === null || row.max_amount === undefined || Number(row.max_amount) <= 0 ? null : Number(row.max_amount);
      const amountScore   = scoreAmountFit(requestedAmount, minN, maxN);
      const maturityScore = input.timeInBusiness && input.timeInBusiness >= 24 ? 0.9 : 0.65;
      const revenueScore  = input.revenue && input.revenue >= 120000 ? 0.9 : 0.6;
      const aggregate     = amountScore * 0.5 + maturityScore * 0.25 + revenueScore * 0.25;
      const minText       = minN ? `$${minN.toLocaleString("en-CA")}` : "no minimum";
      const maxText       = maxN ? `$${maxN.toLocaleString("en-CA")}` : "no maximum";
      // BF_SERVER_v887_LENDER_MATCH_FIX - say what the score is built from, in plain words.
      const reasoning = [
        minN === null && maxN === null ? "No amount range on file for this product" : `Amount range ${minText} to ${maxText}`,
        input.timeInBusiness == null ? "time in business not given" : `${Math.round(input.timeInBusiness)} months in business`,
        input.revenue == null ? "annual revenue not given" : `annual revenue about $${Math.round(input.revenue).toLocaleString("en-CA")}`,
      ].join("; ") + ".";
      return {
        id:               row.product_id,
        lenderId:         row.lender_id,
        lenderName:       row.lender_name,
        productName:      row.product_name,
        productCategory:  row.product_category,
        productCategoryLabel: productCategoryLabel(row.product_category),
        matchPercent:     normalizeToPercent(aggregate),
        reasoning,
        submissionMethod: row.submission_method,
        // BF_LENDERS_TAB_FIX_v55_SERVER
        amountMin:        minN,
        amountMax:        maxN,
        matchVersion:     MATCH_VERSION,
      };
    })
    .sort((a: LenderMatch, b: LenderMatch) => b.matchPercent - a.matchPercent);
}
