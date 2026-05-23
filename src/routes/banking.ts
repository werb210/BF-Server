import { Router } from "express";
import rateLimit from "express-rate-limit";
import { AppError } from "../middleware/errors.js";
import { safeHandler } from "../middleware/safeHandler.js";
// BF_SERVER_BLOCK_55_GATE_AND_BANKING_TRIGGER_v1 — manual banking-analysis trigger.
import { runBankingAnalysis } from "../services/banking/bankingAnalysisPipeline.js";
import { getStorage } from "../lib/storage/index.js";
import { pool as bankingPool } from "../db.js";
import { requireAuth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeKeyGenerator } from "../middleware/rateLimit.js";
import { config } from "../config/index.js";

const router = Router();

// BF_SERVER_BLOCK_55_GATE_AND_BANKING_TRIGGER_v1
// Manual banking-analysis trigger. bankingAutoWorker polls for documents
// where signed_category/document_type LIKE '%bank%'. If staff uploaded
// statements under a non-bank category (or the documents have nulls in
// those fields), auto-trigger never fires and the Banking Analysis tab
// stays empty even though OCR completed for all 20 docs. This endpoint
// runs the pipeline directly against ALL OCR-complete docs on the
// application, regardless of category tag.
router.post(
  "/applications/:id/banking-analysis/run",
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  async (req, res) => {
    const id = String(req.params.id ?? "").trim();
    if (!id) return res.status(400).json({ error: "missing_application_id" });

    const ocrCount = await bankingPool
      .query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM documents
          WHERE application_id::text = $1 AND ocr_status = 'completed' AND deleted_at IS NULL`,
        [id]
      )
      .catch(() => ({ rows: [{ n: "0" }] as Array<{ n: string }> }));
    const n = Number(ocrCount.rows[0]?.n ?? "0");
    if (n === 0) return res.status(409).json({ error: "no_ocr_complete_documents" });

    async function fetchBuffer(storageKey: string): Promise<Buffer> {
      const got = await getStorage().get(storageKey);
      if (!got) throw new Error(`storage_object_missing:${storageKey}`);
      return got.buffer;
    }

    try {
      const result = await runBankingAnalysis(id, { fetchBuffer });
      await bankingPool
        .query(
          `UPDATE documents SET banking_status = 'completed', updated_at = NOW()
             WHERE application_id::text = ($1)::text AND ocr_status = 'completed'`,
          [id]
        )
        .catch(() => {});
      return res.json({ ok: true, triggered: "manual", documents_considered: n, result });
    } catch (e) {
      return res.status(500).json({ error: "banking_analysis_failed", message: e instanceof Error ? e.message : String(e) });
    }
  }
);

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


// BF_SERVER_BLOCK_v223_BANKING_ANALYSIS_GET_v1
// Read endpoint for the portal Banking Analysis tab. Sources from
// banking_analyses (populated by bankingAnalysisPipeline.run) joined with
// applications.banking_completed_at. Returns null for fields not yet
// computed by the pipeline; the portal handles null gracefully (renders
// "—" via resolveValue()).
router.get(
  "/applications/:id/banking-analysis",
  requireAuth,
  requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] }),
  safeHandler(async (req: any, res: any) => {
    const applicationId = String(req.params.id ?? "").trim();
    if (!applicationId) {
      throw new AppError("validation_error", "applicationId is required.", 400);
    }

    // Application gate (existence + banking_completed_at).
    // BF_SERVER_BLOCK_v638_MULTIFIX_v1 — surface banking_auto_skip so the UI
    // can render a clear "Skipped — no bank statements found" banner instead of
    // "Analysis complete" with all zeros (which confused everyone).
    const appRow = await bankingPool.query<{
      banking_completed_at: Date | null;
      banking_auto_skip: boolean | null;
    }>(
      `SELECT banking_completed_at,
              COALESCE((metadata->>'banking_auto_skip')::boolean, false) AS banking_auto_skip
         FROM applications
        WHERE id::text = $1::text LIMIT 1`,
      [applicationId],
    );
    if (appRow.rowCount === 0) {
      return res.status(404).json({ error: "application_not_found" });
    }

    // Latest persisted banking_analyses row for this application.
    const r = await bankingPool.query<{
      accounts: unknown;
      total_avg_monthly_deposits: string | null;
      average_daily_balance: string | null;
      total_deposits: string | null;
      total_withdrawals: string | null;
      average_monthly_nsfs: string | null;
      months_profitable_numerator: number | null;
      months_profitable_denominator: number | null;
      unusual_transactions: unknown;
      top_vendors: unknown;
      period_start: Date | null;
      period_end: Date | null;
      months_detected: number | null;
      status: string | null;
      updated_at: Date | null;
    }>(
      `SELECT
         accounts, total_avg_monthly_deposits, average_daily_balance,
         total_deposits, total_withdrawals, average_monthly_nsfs,
         months_profitable_numerator, months_profitable_denominator,
         unusual_transactions, top_vendors,
         period_start, period_end, months_detected, status, updated_at
       FROM banking_analyses
      WHERE application_id::text = $1::text
      ORDER BY updated_at DESC
      LIMIT 1`,
      [applicationId],
    );

    const bankingCompletedAt = appRow.rows[0]?.banking_completed_at
      ? appRow.rows[0].banking_completed_at.toISOString()
      : null;
    const bankingAutoSkip = Boolean(appRow.rows[0]?.banking_auto_skip);

    // No pipeline output yet — return a "waiting" shape. Portal renders
    // "Waiting for statements" / "Processing…" based on banking_completed_at
    // + bankStatementCount.
    if (r.rowCount === 0) {
      return res.status(200).json({
        // BF_SERVER_BLOCK_v638_MULTIFIX_v1
        banking_auto_skip: bankingAutoSkip,
        bankingAutoSkip: bankingAutoSkip,
        banking_completed_at: bankingCompletedAt,
        bankingCompletedAt,
        monthsDetected: null,
        monthGroups: [],
        dateRange: null,
        bankCount: 0,
        inflows: {
          totalDeposits: null,
          averageMonthlyDeposits: null,
          topDepositSources: [],
        },
        outflows: {
          totalWithdrawals: null,
          averageMonthlyWithdrawals: null,
          topExpenseCategories: [],
        },
        cashFlow: {
          netCashFlowMonthlyAverage: null,
          volatility: null,
        },
        balances: {
          averageDailyBalance: null,
          lowestBalance: null,
          nsfOverdraftCount: null,
        },
        riskFlags: {
          irregularDeposits: null,
          revenueConcentration: null,
          decliningBalances: null,
          nsfOverdraftEvents: null,
        },
      });
    }

    const row = r.rows[0]!;

    const num = (s: string | null | undefined): number | null => {
      if (s === null || s === undefined) return null;
      const n = Number(s);
      return Number.isFinite(n) ? n : null;
    };

    const monthsDetected = row.months_detected ?? null;
    const totalDeposits = num(row.total_deposits);
    const totalWithdrawals = num(row.total_withdrawals);
    const avgMonthlyDeposits = num(row.total_avg_monthly_deposits);
    const avgMonthlyWithdrawals =
      totalWithdrawals !== null && monthsDetected && monthsDetected > 0
        ? Number((totalWithdrawals / monthsDetected).toFixed(2))
        : null;
    const netCashFlowMonthlyAvg =
      totalDeposits !== null && totalWithdrawals !== null && monthsDetected && monthsDetected > 0
        ? Number(((totalDeposits - totalWithdrawals) / monthsDetected).toFixed(2))
        : null;
    const avgDailyBalance = num(row.average_daily_balance);
    const avgMonthlyNsfs = num(row.average_monthly_nsfs);
    const totalNsfCount =
      avgMonthlyNsfs !== null && monthsDetected && monthsDetected > 0
        ? Math.round(avgMonthlyNsfs * monthsDetected)
        : null;

    const dateRange =
      row.period_start && row.period_end
        ? `${row.period_start.toISOString().slice(0, 7)} – ${row.period_end.toISOString().slice(0, 7)}`
        : null;

    // accounts is jsonb; count distinct accounts if it's an array, else 0.
    let bankCount = 0;
    if (Array.isArray(row.accounts)) {
      bankCount = row.accounts.length;
    }

    // top_vendors is jsonb shaped roughly as Array<{ name, total, direction? }>.
    // Split by direction when present; fall back to mixed for the inflow side.
    type Vendor = { name?: string; total?: number; direction?: string; percentage?: number };
    const topVendors: Vendor[] = Array.isArray(row.top_vendors) ? (row.top_vendors as Vendor[]) : [];
    const topDepositSources = topVendors
      .filter((v) => !v.direction || v.direction === "inflow" || v.direction === "credit")
      .slice(0, 5)
      .map((v) => ({ name: v.name ?? "(unknown)", percentage: v.percentage ?? null }));
    const topExpenseCategories = topVendors
      .filter((v) => v.direction === "outflow" || v.direction === "debit")
      .slice(0, 5)
      .map((v) => ({ name: v.name ?? "(unknown)", percentage: v.percentage ?? null }));

    // Risk flags — light heuristics from what the pipeline already computes.
    // null when we don't have signal to make a call.
    const nsfFlag = avgMonthlyNsfs !== null ? avgMonthlyNsfs >= 1 : null;
    const revenueConcentrationFlag = topDepositSources[0]?.percentage != null
      ? Number(topDepositSources[0].percentage) >= 0.3
      : null;
    const unusualTxCount = Array.isArray(row.unusual_transactions)
      ? row.unusual_transactions.length
      : 0;
    const irregularDepositsFlag = unusualTxCount > 5 ? true : unusualTxCount > 0 ? false : null;

    return res.status(200).json({
      // BF_SERVER_BLOCK_v638_MULTIFIX_v1
      banking_auto_skip: bankingAutoSkip,
      bankingAutoSkip: bankingAutoSkip,
      banking_completed_at: bankingCompletedAt,
      bankingCompletedAt,
      monthsDetected,
      monthsDetectedSummary: monthsDetected ? `${monthsDetected} month${monthsDetected === 1 ? "" : "s"}` : null,
      monthGroups: [],
      dateRange,
      bankCount,
      inflows: {
        totalDeposits,
        averageMonthlyDeposits: avgMonthlyDeposits,
        topDepositSources,
      },
      outflows: {
        totalWithdrawals,
        averageMonthlyWithdrawals: avgMonthlyWithdrawals,
        topExpenseCategories,
      },
      cashFlow: {
        netCashFlowMonthlyAverage: netCashFlowMonthlyAvg,
        volatility: null, // v224+: derive from monthly summaries variance
      },
      balances: {
        averageDailyBalance: avgDailyBalance,
        lowestBalance: null, // v224+: SELECT MIN(balance_after) FROM banking_transactions
        nsfOverdraftCount: totalNsfCount,
      },
      riskFlags: {
        irregularDeposits: irregularDepositsFlag,
        revenueConcentration: revenueConcentrationFlag,
        decliningBalances: null, // v224+: trend on banking_monthly_summaries.ending_balance
        nsfOverdraftEvents: nsfFlag,
      },
      status: row.status ?? null,
      updated_at: row.updated_at ? row.updated_at.toISOString() : null,
    });
  }),
);

export default router;
