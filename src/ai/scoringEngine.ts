// BF_LENDER_MATCH_GEO_FIX_v42 — Block 42-A — country added to PrequalInput
// BF_SERVER_BLOCK_v206_LENDER_CATEGORY_FILTER_AND_PREVIEW_FALLBACK_v1 — productCategory added so matchLenders can filter by category.
export type PrequalInput = {
  revenue?: number | null;
  industry?: string | null;
  timeInBusiness?: number | null;
  province?: string | null;
  country?: "CA" | "US" | null;
  requestedAmount?: number | null;
  productCategory?: string | null;
};

export function scoreAmountFit(
  requestedAmount: number | null | undefined,
  minAmount: number | null | undefined,
  maxAmount: number | null | undefined
): number {
  if (!requestedAmount || requestedAmount <= 0) return 0.4;
  if (minAmount && requestedAmount < minAmount) return 0;
  if (maxAmount && requestedAmount > maxAmount) return 0;
  if (minAmount && maxAmount && maxAmount > minAmount) {
    const midpoint = (minAmount + maxAmount) / 2;
    const distance = Math.abs(requestedAmount - midpoint) / (maxAmount - minAmount);
    return Math.max(0.2, 1 - distance);
  }
  return 0.8;
}

export function normalizeToPercent(value: number): number {
  const clamped = Math.max(0, Math.min(1, value));
  return Math.round(clamped * 100);
}
