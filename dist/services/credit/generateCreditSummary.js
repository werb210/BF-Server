export function generateCreditSummary(application) {
    const { companyName, requestedAmount, revenue, industry, } = application;
    return {
        overview: `${companyName} is seeking ${requestedAmount} in financing.`,
        industry,
        revenue,
    };
}
