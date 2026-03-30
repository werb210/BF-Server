"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateCreditSummary = generateCreditSummary;
function generateCreditSummary(application) {
    const { companyName, requestedAmount, revenue, industry, } = application;
    return {
        overview: `${companyName} is seeking ${requestedAmount} in financing.`,
        industry,
        revenue,
    };
}
