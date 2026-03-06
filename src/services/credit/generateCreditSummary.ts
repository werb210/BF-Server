export function generateCreditSummary(application: {
  companyName: string;
  requestedAmount: number | string;
  revenue: number;
  industry: string;
}) {
  const {
    companyName,
    requestedAmount,
    revenue,
    industry,
  } = application;

  return {
    overview: `${companyName} is seeking ${requestedAmount} in financing.`,
    industry,
    revenue,
  };
}
