"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const errors_1 = require("../middleware/errors");
const safeHandler_1 = require("../middleware/safeHandler");
const router = (0, express_1.Router)();
router.post("/analysis", (0, safeHandler_1.safeHandler)(async (req, res, next) => {
    const applicationId = typeof req.body?.applicationId === "string" ? req.body.applicationId.trim() : "";
    if (!applicationId) {
        throw new errors_1.AppError("validation_error", "applicationId is required.", 400);
    }
    const transactions = Array.isArray(req.body?.transactions) ? req.body.transactions : [];
    const balances = transactions
        .map((t) => Number(t?.balance))
        .filter((n) => Number.isFinite(n));
    const deposits = transactions
        .map((t) => Number(t?.credit))
        .filter((n) => Number.isFinite(n) && n > 0);
    const nsfCount = transactions.filter((t) => String(t?.type ?? "").toLowerCase().includes("nsf")).length;
    const avgBalance = balances.length ? balances.reduce((a, b) => a + b, 0) / balances.length : 0;
    const monthlyRevenue = deposits.reduce((a, b) => a + b, 0);
    const midpoint = Math.floor(deposits.length / 2) || 1;
    const firstHalf = deposits.slice(0, midpoint).reduce((a, b) => a + b, 0);
    const secondHalf = deposits.slice(midpoint).reduce((a, b) => a + b, 0);
    const revenueTrend = secondHalf >= firstHalf ? "up" : "down";
    res.status(200).json({
        applicationId,
        avg_balance: Number(avgBalance.toFixed(2)),
        nsf_count: nsfCount,
        monthly_revenue: Number(monthlyRevenue.toFixed(2)),
        revenue_trend: revenueTrend,
    });
}));
exports.default = router;
