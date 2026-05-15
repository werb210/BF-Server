import { Router } from "express";
import rateLimit from "express-rate-limit";
import { AppError } from "../middleware/errors.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { requireAuth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeKeyGenerator } from "../middleware/rateLimit.js";
import { config } from "../config/index.js";

const router = Router();

// BF_SERVER_BLOCK_v335_AUTH_HARDENING_AND_DEAD_CODE_v1 -- Edit 1
// Pre-fix POST /api/banking/analysis was COMPLETELY UNAUTHENTICATED. Any
// internet caller could hit it with an arbitrary transactions[] payload
// and get back computed analysis values keyed by an arbitrary
// applicationId. Two real consumers: BF-portal's BankingTab and
// BankingAnalysisTab (staff drawer/tab UIs at applications/drawer/tab-
// banking and applications/tabs/BankingAnalysisTab). Both call from
// staff sessions which already have a Bearer JWT. Adding requireAuth +
// requireAuthorization for ADMIN/STAFF matches every other staff-side
// analysis endpoint. Also adding a 30 req/min/IP limiter -- the handler
// iterates transactions[] arrays which can be sent oversized to burn
// CPU, even from authenticated callers.
const bankingAnalysisLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  validate: {
    xForwardedForHeader: false,
    trustProxy: false,
  },
  skip: () => config.env === "test",
  keyGenerator: safeKeyGenerator,
});

router.post(
  "/analysis",
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  bankingAnalysisLimiter,
  safeHandler(async (req: any, res: any, next: any) => {
    const applicationId = typeof req.body?.applicationId === "string" ? req.body.applicationId.trim() : "";
    if (!applicationId) {
      throw new AppError("validation_error", "applicationId is required.", 400);
    }

    const transactions = Array.isArray(req.body?.transactions) ? req.body.transactions : [];
    const balances = transactions
      .map((t: any) => Number(t?.balance))
      .filter((n: number) => Number.isFinite(n));
    const deposits = transactions
      .map((t: any) => Number(t?.credit))
      .filter((n: number) => Number.isFinite(n) && n > 0);
    const nsfCount = transactions.filter((t: any) => String(t?.type ?? "").toLowerCase().includes("nsf")).length;

    const avgBalance = balances.length ? balances.reduce((a: number, b: number) => a + b, 0) / balances.length : 0;
    const monthlyRevenue = deposits.reduce((a: number, b: number) => a + b, 0);

    const midpoint = Math.floor(deposits.length / 2) || 1;
    const firstHalf = deposits.slice(0, midpoint).reduce((a: number, b: number) => a + b, 0);
    const secondHalf = deposits.slice(midpoint).reduce((a: number, b: number) => a + b, 0);
    const revenueTrend = secondHalf >= firstHalf ? "up" : "down";

    res.status(200).json({
      applicationId,
      avg_balance: Number(avgBalance.toFixed(2)),
      nsf_count: nsfCount,
      monthly_revenue: Number(monthlyRevenue.toFixed(2)),
      revenue_trend: revenueTrend,
    });
  })
);

export default router;
