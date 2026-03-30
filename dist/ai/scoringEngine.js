"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.scoreAmountFit = scoreAmountFit;
exports.normalizeToPercent = normalizeToPercent;
function scoreAmountFit(requestedAmount, minAmount, maxAmount) {
    if (!requestedAmount || requestedAmount <= 0)
        return 0.4;
    if (minAmount && requestedAmount < minAmount)
        return 0;
    if (maxAmount && requestedAmount > maxAmount)
        return 0;
    if (minAmount && maxAmount && maxAmount > minAmount) {
        const midpoint = (minAmount + maxAmount) / 2;
        const distance = Math.abs(requestedAmount - midpoint) / (maxAmount - minAmount);
        return Math.max(0.2, 1 - distance);
    }
    return 0.8;
}
function normalizeToPercent(value) {
    const clamped = Math.max(0, Math.min(1, value));
    return Math.round(clamped * 100);
}
