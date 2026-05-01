// BF_SERVER_BLOCK_1_30_DOC_INTEL_AND_BANKING
import { pool } from "../../db.js";
import { logInfo, logError } from "../../observability/logger.js";
import { analyzeWithDocIntel } from "../../modules/ocr/azureDocIntelProvider.js";
import { extractTransactionsFromTables, type BankTransaction } from "./bankingFromOcr.js";
import OpenAI from "openai";

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

type Country = "US" | "CA" | "OTHER";

function detectCountry(metadata: any): Country {
  const c = String(
    metadata?.country ??
      metadata?.business?.country ??
      metadata?.borrower?.country ??
      "",
  ).toUpperCase();
  if (c === "US" || c === "USA") return "US";
  if (c === "CA" || c === "CAN" || c === "CANADA") return "CA";
  return "OTHER";
}

interface BankStatementDoc {
  documentId: string;
  storageKey: string | null;
  fileName: string | null;
}

async function fetchDocumentBuffer(_storageKey: string): Promise<Buffer> {
  throw new Error("fetchDocumentBuffer not bound — inject in tests");
}

export interface PipelineDeps {
  fetchBuffer: (storageKey: string) => Promise<Buffer>;
}

export async function runBankingAnalysis(
  applicationId: string,
  deps: PipelineDeps = { fetchBuffer: fetchDocumentBuffer },
) {
  const appRes = await pool.query<{ metadata: any }>(
    `SELECT metadata FROM applications WHERE id::text = ($1)::text`,
    [applicationId],
  );
  if (!appRes.rows[0]) throw new Error(`application_not_found:${applicationId}`);
  const country = detectCountry(appRes.rows[0].metadata);
  const model = country === "US" ? "prebuilt-bankStatement.us" : "prebuilt-layout";

  const docsRes = await pool.query<{ id: string; storage_key: string | null; file_name: string | null; }>(
    `SELECT d.id,
            (SELECT (dv.metadata->>'storageKey') FROM document_versions dv
              WHERE dv.document_id = d.id ORDER BY dv.version DESC LIMIT 1) AS storage_key,
            (SELECT (dv.metadata->>'fileName') FROM document_versions dv
              WHERE dv.document_id = d.id ORDER BY dv.version DESC LIMIT 1) AS file_name
       FROM documents d
      WHERE d.application_id::text = ($1)::text
        AND LOWER(COALESCE(d.signed_category, d.document_type, '')) LIKE '%bank%'`,
    [applicationId],
  );

  await pool.query(`INSERT INTO banking_analyses (application_id, status, updated_at)
       VALUES ($1, 'in_progress', now())
       ON CONFLICT (application_id) DO UPDATE
         SET status = 'in_progress', updated_at = now()`, [applicationId]);

  await pool.query(`DELETE FROM banking_transactions WHERE application_id::text = ($1)::text`, [applicationId]);
  await pool.query(`DELETE FROM banking_monthly_summaries WHERE application_id::text = ($1)::text`, [applicationId]);

  const allTransactions: Array<BankTransaction & { document_id: string }> = [];
  const docs: BankStatementDoc[] = docsRes.rows.map((r: { id: string; storage_key: string | null; file_name: string | null }) => ({ documentId: r.id, storageKey: r.storage_key, fileName: r.file_name }));

  for (const doc of docs) {
    if (!doc.storageKey) continue;
    let buffer: Buffer;
    try { buffer = await deps.fetchBuffer(doc.storageKey); } catch (err) { logError("banking_pipeline_buffer_fetch_failed", { applicationId, documentId: doc.documentId, error: err instanceof Error ? err.message : String(err) }); continue; }
    let result: any;
    try { result = await analyzeWithDocIntel(buffer, model); } catch (err) { logError("banking_pipeline_di_failed", { applicationId, documentId: doc.documentId, model, error: err instanceof Error ? err.message : String(err) }); continue; }

    const transactions = extractTransactionsFromTables({
      pages: (result?.pages ?? []).map((p: any) => ({
        page_number: p.pageNumber,
        tables: (result?.tables ?? []).filter((t: any) => (t.boundingRegions ?? []).some((b: any) => b.pageNumber === p.pageNumber)).map((t: any) => ({ rows: rowifyTableCells(t) })),
      })),
    });
    for (const tx of transactions) if (tx.date && Number.isFinite(tx.amount)) allTransactions.push({ ...tx, document_id: doc.documentId });
  }

  if (allTransactions.length > 0) await insertTransactions(applicationId, allTransactions);
  const aggregates = await aggregateMonthlySummaries(applicationId);
  const llmFlags = openai ? await flagWithOpenAI(applicationId, allTransactions.slice(0, 200)) : { unusualTransactions: [], topVendors: [] };
  await persistAnalysis(applicationId, aggregates, llmFlags, allTransactions.length, country, model);
  await pool.query(`UPDATE banking_analyses SET status = 'analysis_complete', completed_at = now(), updated_at = now() WHERE application_id::text = ($1)::text`, [applicationId]);
  await pool.query(`UPDATE applications SET banking_completed_at = now(), updated_at = now() WHERE id::text = ($1)::text`, [applicationId]);
  logInfo("banking_pipeline_complete", { applicationId, transactions: allTransactions.length, months: aggregates.months });
}

function rowifyTableCells(table: any): Array<Array<{ text: string }>> { if (!table || !Array.isArray(table.cells)) return []; const rows: Array<Array<{ text: string }>> = []; for (const cell of table.cells) { const r = cell.rowIndex ?? 0; const c = cell.columnIndex ?? 0; rows[r] = rows[r] ?? []; rows[r][c] = { text: String(cell.content ?? "") }; } return rows.map((r) => r ?? []); }
async function insertTransactions(applicationId: string, transactions: Array<BankTransaction & { document_id: string }>) { const rows: string[] = []; const params: any[] = []; let i = 0; for (const tx of transactions) { rows.push(`($${++i}, $${++i}, $${++i}::date, $${++i}, $${++i}::numeric, $${++i}::numeric, $${++i})`); params.push(applicationId, tx.document_id, tx.date, tx.description ?? null, tx.amount ?? 0, tx.balance ?? null, (tx.description ?? "").toLowerCase().includes("nsf") || (tx.description ?? "").toLowerCase().includes("returned") || (tx.description ?? "").toLowerCase().includes("insufficient")); } await pool.query(`INSERT INTO banking_transactions (application_id, document_id, transaction_date, description, amount, balance_after, is_nsf) VALUES ` + rows.join(","), params); }
async function aggregateMonthlySummaries(applicationId: string) { await pool.query(`INSERT INTO banking_monthly_summaries (application_id, month_start, total_deposits, total_withdrawals, net_cash_flow, ending_balance, nsf_count) SELECT $1::uuid, date_trunc('month', transaction_date)::date AS month_start, COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0), COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END), 0), COALESCE(SUM(amount), 0), (SELECT bt2.balance_after FROM banking_transactions bt2 WHERE bt2.application_id::text = ($1)::text AND date_trunc('month', bt2.transaction_date) = date_trunc('month', bt.transaction_date) ORDER BY bt2.transaction_date DESC, bt2.created_at DESC LIMIT 1), COUNT(*) FILTER (WHERE bt.is_nsf) FROM banking_transactions bt WHERE application_id::text = ($1)::text GROUP BY date_trunc('month', transaction_date), date_trunc('month', bt.transaction_date) ON CONFLICT (application_id, month_start) DO UPDATE SET total_deposits = EXCLUDED.total_deposits,total_withdrawals = EXCLUDED.total_withdrawals,net_cash_flow = EXCLUDED.net_cash_flow,ending_balance = EXCLUDED.ending_balance,nsf_count = EXCLUDED.nsf_count`, [applicationId]); const sumRes = await pool.query<any>(`SELECT COUNT(*)::text AS months, COALESCE(SUM(total_deposits), 0)::text AS total_deposits, COALESCE(SUM(total_withdrawals), 0)::text AS total_withdrawals, (SELECT AVG(balance_after)::text FROM banking_transactions WHERE application_id::text = ($1)::text AND balance_after IS NOT NULL) AS avg_balance, MIN(month_start)::text AS period_start, MAX(month_start)::text AS period_end, COALESCE(SUM(nsf_count), 0)::text AS nsf_total, COALESCE(SUM(CASE WHEN net_cash_flow > 0 THEN 1 ELSE 0 END), 0)::text AS months_profitable FROM banking_monthly_summaries WHERE application_id::text = ($1)::text`, [applicationId]); const r=sumRes.rows[0]; const months=Number(r?.months??0); return {months,totalDeposits:Number(r?.total_deposits??0),totalWithdrawals:Number(r?.total_withdrawals??0),averageDailyBalance:r?.avg_balance?Number(r.avg_balance):null,avgMonthlyDeposits:months>0?Number(r?.total_deposits??0)/months:0,periodStart:r?.period_start??null,periodEnd:r?.period_end??null,nsfTotal:Number(r?.nsf_total??0),monthsProfitable:Number(r?.months_profitable??0),averageMonthlyNsfs:months>0?Number(r?.nsf_total??0)/months:0}; }
async function flagWithOpenAI(_applicationId: string, transactions: Array<BankTransaction & { document_id: string }>) { if (!openai || transactions.length===0) return { unusualTransactions: [], topVendors: [] }; return { unusualTransactions: [], topVendors: [] }; }
async function persistAnalysis(applicationId: string, agg: Awaited<ReturnType<typeof aggregateMonthlySummaries>>, llm: { unusualTransactions: any[]; topVendors: any[] }, txCount: number, country: Country, model: string) { await pool.query(`INSERT INTO banking_analyses (application_id, accounts, total_avg_monthly_deposits, average_daily_balance,total_deposits, total_withdrawals, average_monthly_nsfs,months_profitable_numerator, months_profitable_denominator,unusual_transactions, top_vendors, period_start, period_end,months_detected, status, updated_at) VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb,$12::date, $13::date, $14, 'analysis_complete', now()) ON CONFLICT (application_id) DO UPDATE SET accounts = EXCLUDED.accounts,total_avg_monthly_deposits = EXCLUDED.total_avg_monthly_deposits,average_daily_balance = EXCLUDED.average_daily_balance,total_deposits = EXCLUDED.total_deposits,total_withdrawals = EXCLUDED.total_withdrawals,average_monthly_nsfs = EXCLUDED.average_monthly_nsfs,months_profitable_numerator = EXCLUDED.months_profitable_numerator,months_profitable_denominator = EXCLUDED.months_profitable_denominator,unusual_transactions = EXCLUDED.unusual_transactions,top_vendors = EXCLUDED.top_vendors,period_start = EXCLUDED.period_start,period_end = EXCLUDED.period_end,months_detected = EXCLUDED.months_detected,status = 'analysis_complete',updated_at = now()`, [applicationId, JSON.stringify([{ note: `${txCount} transactions parsed via ${model} (${country})` }]), agg.avgMonthlyDeposits || null, agg.averageDailyBalance, agg.totalDeposits, agg.totalWithdrawals, agg.averageMonthlyNsfs, agg.monthsProfitable, agg.months, JSON.stringify(llm.unusualTransactions), JSON.stringify(llm.topVendors), agg.periodStart, agg.periodEnd, agg.months]); }
