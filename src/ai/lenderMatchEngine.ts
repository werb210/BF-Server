import { pool, runQuery } from "../db";
import { normalizeToPercent, scoreAmountFit, type PrequalInput } from "./scoringEngine";

type ProductRow = {
  id: string;
  lender_id: string;
  product_name: string;
  country: string | null;
  active: boolean;
  min_amount: number | null;
  max_amount: number | null;
};

export type LenderMatch = {
  lenderId: string;
  productName: string;
  likelihoodPercent: number;
  reasoning: string;
};

export async function matchLenders(input: PrequalInput): Promise<LenderMatch[]> {
  const requestedAmount = input.requestedAmount ?? null;
  const { rows } = await runQuery<ProductRow>(
    `select lp.id,
            lp.lender_id,
            lp.name as product_name,
            lp.country,
            lp.active,
            min(lpr.min_amount) as min_amount,
            max(lpr.max_amount) as max_amount
     from lender_products lp
     left join lender_product_requirements lpr on lpr.lender_product_id = lp.id
     where lp.active = true
     group by lp.id, lp.lender_id, lp.name, lp.country, lp.active
     order by lp.updated_at desc`
  );

  const filtered = rows.filter((row: ProductRow) => {
    if (requestedAmount && row.min_amount && requestedAmount < row.min_amount) return false;
    if (requestedAmount && row.max_amount && requestedAmount > row.max_amount) return false;
    if (input.province && row.country && row.country === "US" && input.province) return false;
    return true;
  });

  return filtered
    .map((row: ProductRow) => {
      const amountScore = scoreAmountFit(requestedAmount, row.min_amount, row.max_amount);
      const maturityScore = input.timeInBusiness && input.timeInBusiness >= 24 ? 0.9 : 0.65;
      const revenueScore = input.revenue && input.revenue >= 120000 ? 0.9 : 0.6;
      const aggregate = amountScore * 0.5 + maturityScore * 0.25 + revenueScore * 0.25;
      const minText = row.min_amount ? `$${row.min_amount}` : "no minimum";
      const maxText = row.max_amount ? `$${row.max_amount}` : "no maximum";
      return {
        lenderId: row.lender_id,
        productName: row.product_name,
        likelihoodPercent: normalizeToPercent(aggregate),
        reasoning: `Amount fit checked against ${minText}-${maxText}; weighted by time in business and annual revenue signals.`,
      };
    })
    .sort((a: LenderMatch, b: LenderMatch) => b.likelihoodPercent - a.likelihoodPercent)
    .slice(0, 3);
}

