export interface CreditInput {
  businessName: string;
  requestedAmount: number;
  revenue: number;
  risks: string[];
  mitigants: string[];
}

export function generateCreditSummary(input: CreditInput) {
  return {
    transaction: `Financing request for ${input.businessName}`,
    overview: `${input.businessName} seeking ${input.requestedAmount}`,
    financialSummary: {
      revenue: input.revenue,
    },
    risks: input.risks,
    mitigants: input.mitigants,
    rationale: [
      "Business demonstrates operating revenue",
      "Requested facility aligned with operating profile",
    ],
  };
}
