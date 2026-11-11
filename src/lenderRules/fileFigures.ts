// BF_SERVER_v940_LENDER_PRODUCT_RULES - the file's figures the lender rules are checked against.
// Monthly revenue: the bank statements' average monthly deposits when the banking analysis has run (what lenders use),
// otherwise the monthly revenue the client gave in step 1 of the application, otherwise annual revenue / 12.
// NSFs, average daily balance and other lenders being paid ("positions") come from the banking analysis only.
import { pool } from "../db.js";
import { amountFromBand } from "../services/biHandoff.js";
import { buildBankingInsights } from "../services/banking/bankingInsights.js";
import type { FileFigures } from "./rules.js";

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

const pos = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
};
const band = (v: unknown): number | null => (typeof v === "number" ? pos(v) : v ? pos(amountFromBand(String(v))) : null);

export async function loadFileFigures(
  applicationId: string,
  base: { requestedAmount: number | null; revenue: number | null; timeInBusiness: number | null; metadata?: Record<string, any> | null },
  q: Q = pool as unknown as Q,
): Promise<FileFigures> {
  let bank: Record<string, any> | null = null;
  let positions: number | null = null;
  try {
    bank = (await q.query(
      `SELECT total_avg_monthly_deposits, average_daily_balance, average_monthly_nsfs, status
         FROM banking_analyses WHERE application_id::text = ($1)::text LIMIT 1`, [applicationId])).rows[0] ?? null;
  } catch (err) {
    console.warn("[lender-rules] banking analysis not read", { applicationId, message: err instanceof Error ? err.message : String(err) });
  }
  try {
    const tx = await q.query(
      `SELECT document_id, transaction_date::text AS transaction_date, description, amount::float8 AS amount,
              balance_after::float8 AS balance_after, is_nsf
         FROM banking_transactions WHERE application_id::text = ($1)::text
        ORDER BY transaction_date ASC LIMIT 20000`, [applicationId]);
    if (tx.rows.length) {
      // A lender paid in two or more months is an open position; a one-off payment is not.
      positions = buildBankingInsights(tx.rows).lenderPayments.filter((p) => p.months >= 2).length;
    }
  } catch (err) {
    console.warn("[lender-rules] transactions not read", { applicationId, message: err instanceof Error ? err.message : String(err) });
  }
  const md = base.metadata ?? {};
  const deposits = bank ? pos(bank.total_avg_monthly_deposits) : null;
  const stated = band(md.kyc?.monthlyRevenue ?? md.financialProfile?.monthlyRevenue ?? md.monthlyRevenue ?? md.business?.monthlyRevenue);
  const monthlyRevenue = deposits ?? stated ?? (base.revenue ? Math.round(base.revenue / 12) : null);
  return {
    monthlyRevenue,
    monthlyRevenueBasis: deposits ? "bank deposits" : stated ? "application" : base.revenue ? "annual revenue / 12" : null,
    nsfPerMonth: bank && bank.average_monthly_nsfs !== null && bank.average_monthly_nsfs !== undefined ? Number(bank.average_monthly_nsfs) : null,
    avgDailyBalance: bank && bank.average_daily_balance !== null && bank.average_daily_balance !== undefined ? Number(bank.average_daily_balance) : null,
    positions,
    monthsInBusiness: base.timeInBusiness,
    requestedAmount: base.requestedAmount,
  };
}
