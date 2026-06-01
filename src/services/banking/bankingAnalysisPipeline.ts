// BF_SERVER_BLOCK_1_30_DOC_INTEL_AND_BANKING
import { pool } from "../../db.js";
import { logInfo, logError } from "../../observability/logger.js";
import { analyzeWithDocIntel } from "../../modules/ocr/azureDocIntelProvider.js";
import {
  extractTransactionsFromTables,
  extractTransactionsFromBankStatementModel,
  type BankTransaction,
} from "./bankingFromOcr.js";
import OpenAI from "openai";

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

// BF_SERVER_BLOCK_v690_BANKING_LLM_FALLBACK_v1 — when Doc-Intel's table /
// bankStatement extractors return nothing (common on real statements that are
// not laid out as clean ruled tables), extract transactions from the OCR TEXT
// with the LLM. Layout OCR already produced the text; only table parsing failed.
// Model is env-configurable; default is a current GPT-5.x mini. NOTE: GPT-5.x
// reasoning models reject the `temperature` param, so it is intentionally omitted.
const BANKING_LLM_MODEL = process.env.BANKING_LLM_MODEL || "gpt-5.4-mini";

function ocrTextFromResult(result: any): string {
  if (typeof result?.content === "string" && result.content.trim()) return result.content;
  const lines: string[] = (result?.pages ?? []).flatMap((p: any) =>
    (p?.lines ?? []).map((l: any) => String(l?.content ?? "")),
  );
  return lines.join("\n");
}

export function parseLlmTransactions(raw: string): BankTransaction[] {
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { return []; }
  const arr = Array.isArray(parsed?.transactions) ? parsed.transactions : [];
  const out: BankTransaction[] = [];
  for (const t of arr) {
    const dateRaw = typeof t?.date === "string" ? t.date : "";
    const date = /^\d{4}-\d{2}-\d{2}/.test(dateRaw) ? dateRaw.slice(0, 10) : null;
    const description = typeof t?.description === "string" ? t.description : null;
    let amount: number | undefined;
    if (typeof t?.amount === "number" && Number.isFinite(t.amount)) amount = t.amount;
    else if (typeof t?.amount === "string") {
      const n = Number(t.amount.replace(/[,$\s]/g, ""));
      if (Number.isFinite(n)) amount = n;
    }
    let balance: number | null = null;
    if (typeof t?.balance === "number" && Number.isFinite(t.balance)) balance = t.balance;
    else if (typeof t?.balance === "string") {
      const n = Number(t.balance.replace(/[,$\s]/g, ""));
      if (Number.isFinite(n)) balance = n;
    }
    if (!date || amount === undefined) continue; // pipeline requires date + finite amount
    const tx: BankTransaction = { date, description };
    tx.amount = amount;
    if (balance !== null) tx.balance = balance;
    out.push(tx);
  }
  return out;
}

async function extractTransactionsWithLLM(text: string): Promise<BankTransaction[]> {
  if (!openai) return [];
  const MAX = 60000;
  const body = text.length > MAX ? text.slice(0, MAX) : text;
  const prompt = [
    "Extract every dated transaction from this business bank statement text.",
    'Return ONLY JSON: {"transactions":[{"date":"YYYY-MM-DD","description":"...","amount":<signed number; deposits/credits positive, withdrawals/debits negative>,"balance":<number or null>}]}.',
    'Rules: amount is a plain number (no currency symbols or thousands separators). Exclude non-transaction rows such as opening/closing balance summaries, totals, and column headers. If there are no transactions, return {"transactions":[]}.',
    "Statement text:",
    body,
  ].join("\n");
  const resp = await openai.chat.completions.create({
    model: BANKING_LLM_MODEL,
    response_format: { type: "json_object" },
    messages: [{ role: "user", content: prompt }],
  });
  return parseLlmTransactions(resp.choices?.[0]?.message?.content ?? "");
}

type Country = "US" | "CA" | "OTHER";

// BF_SERVER_BLOCK_v101_BANKING_CLASSIFIER_MSG_v1
const NON_BANK_STATEMENT_MESSAGE = "Document classified as financial statement, not bank statement. Try uploading actual bank statements (monthly account activity exports).";

function hasStatementNoTransactionShape(result: any): boolean {
  const lines: string[] = (result?.pages ?? []).flatMap((p: any) => (p?.lines ?? []).map((l: any) => String(l?.content ?? "")));
  const hasStatementWord = lines.some((line) => /statement/i.test(line));
  const hasTxnHeaders = lines.some((line) => /date\s+description|description\s+amount|debit|credit|balance/i.test(line));
  const hasTables = Array.isArray(result?.tables) && result.tables.length > 0;
  return hasStatementWord && (!hasTxnHeaders || !hasTables);
}

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
interface BankingDocumentStatus {
  document_id: string;
  filename: string | null;
  model_used: "prebuilt-layout" | "prebuilt-bankStatement.us";
  detected_type: string | null;
  transaction_count: number;
  fallback_used: boolean;
  pages: number;
  error?: string;
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
  const modelChain = ["prebuilt-layout", "prebuilt-bankStatement.us"] as const;

  const docsRes = await pool.query<{ id: string; storage_key: string | null; file_name: string | null; }>(
    `SELECT d.id,
            (SELECT COALESCE(dv.content, dv.blob_name, dv.metadata->>'storageKey') /* BF_SERVER_BLOCK_v687_BANKING_STORAGE_KEY_v1 */ FROM document_versions dv
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
  const documentStatuses: BankingDocumentStatus[] = [];
  const docs: BankStatementDoc[] = docsRes.rows.map((r: { id: string; storage_key: string | null; file_name: string | null }) => ({ documentId: r.id, storageKey: r.storage_key, fileName: r.file_name }));

  for (const doc of docs) {
    if (!doc.storageKey) continue;
    let buffer: Buffer;
    try { buffer = await deps.fetchBuffer(doc.storageKey); } catch (err) { logError("banking_pipeline_buffer_fetch_failed", { applicationId, documentId: doc.documentId, error: err instanceof Error ? err.message : String(err) }); continue; }
    let finalResult: any = null;
    let finalModel: (typeof modelChain)[number] = "prebuilt-layout";
    let detectedType: string | null = null;
    let transactions: BankTransaction[] = [];
    let docError: string | null = null;
    let fallbackUsed = false;

    for (const model of modelChain) {
      let result: any;
      try {
        result = await analyzeWithDocIntel(buffer, model);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        // Distinguish env-var misconfiguration from a true OCR failure
        const isEnvMissing = /AZURE_DOC_INTEL_(ENDPOINT|KEY)\s+not set/.test(errMsg) || /not configured/i.test(errMsg);
        logError("banking_pipeline_di_failed", { applicationId, documentId: doc.documentId, model, error: errMsg, envMissing: isEnvMissing });
        docError = isEnvMissing
          ? "Azure Document Intelligence not configured. Set AZURE_DOC_INTEL_ENDPOINT and AZURE_DOC_INTEL_KEY on the BF-Server App Service."
          : `OCR model ${model} failed: ${errMsg}`;
        continue;
      }

      // Determine statement year from prebuilt-bankStatement.us structured fields, if present
      let statementYear: number | null = null;
      try {
        const startStr =
          result?.documents?.[0]?.fields?.StatementStartDate?.valueDate ??
          result?.documents?.[0]?.fields?.StatementStartDate?.valueString ??
          null;
        if (typeof startStr === "string" && /^\d{4}/.test(startStr)) {
          statementYear = Number(startStr.slice(0, 4));
        }
      } catch { /* ignore */ }

      let extracted: BankTransaction[] = [];

      // Strategy A: structured extractor (only meaningful for bank-statement model)
      if (model === "prebuilt-bankStatement.us") {
        extracted = extractTransactionsFromBankStatementModel(result);
      }

      // Strategy B: table extractor — runs for layout model OR as a safety net for bank-statement
      if (extracted.length === 0) {
        extracted = extractTransactionsFromTables(
          {
            pages: (result?.pages ?? []).map((p: any) => ({
              page_number: p.pageNumber,
              tables: ((result?.tables ?? []).filter((tbl: any) =>
                (tbl?.boundingRegions ?? []).some((br: any) => br?.pageNumber === p.pageNumber),
              )).map((tbl: any) => ({ rows: rowifyTableCells(tbl) })),
              lines: p.lines,
            })),
          },
          { statementYear },
        );
      }

      const normalizedType = String(result?.documents?.[0]?.docType ?? result?.documents?.[0]?.documentType ?? "").toUpperCase() || null;

      finalResult = result;
      finalModel = model;
      detectedType = normalizedType;
      transactions = extracted;
      docError = null;

      const shouldShortCircuitNonBank = model === "prebuilt-layout" && normalizedType === "OTHER" && extracted.length === 0 && hasStatementNoTransactionShape(result);
      if (shouldShortCircuitNonBank) {
        docError = NON_BANK_STATEMENT_MESSAGE;
        break;
      }

      const shouldFallbackToBankStatement = model === "prebuilt-layout" && (normalizedType === "OTHER" || extracted.length === 0);
      if (shouldFallbackToBankStatement) {
        fallbackUsed = true;
        continue;
      }
      break;
    }

    if (!finalResult) {
      documentStatuses.push({ document_id: doc.documentId, filename: doc.fileName, model_used: finalModel, detected_type: detectedType, transaction_count: 0, fallback_used: fallbackUsed, pages: 0, error: docError ?? "OCR parsing failed for all models" });
      continue;
    }
    // BF_SERVER_BLOCK_v690_BANKING_LLM_FALLBACK_v1 — Doc-Intel parsers found no
    // transactions; try the LLM over the OCR text before giving up on this doc.
    if (transactions.length === 0 && openai) {
      const ocrText = ocrTextFromResult(finalResult);
      if (ocrText.trim().length > 0) {
        const llmTx = await extractTransactionsWithLLM(ocrText).catch((e) => {
          logError("banking_llm_fallback_failed", { applicationId, documentId: doc.documentId, error: e instanceof Error ? e.message : String(e) });
          return [] as BankTransaction[];
        });
        if (llmTx.length > 0) {
          transactions = llmTx;
          docError = null;
          logInfo("banking_llm_fallback_used", { applicationId, documentId: doc.documentId, count: llmTx.length });
        }
      }
    }
    if (fallbackUsed && transactions.length === 0) {
      docError = NON_BANK_STATEMENT_MESSAGE;
    }
    documentStatuses.push({ document_id: doc.documentId, filename: doc.fileName, model_used: finalModel, detected_type: detectedType, transaction_count: transactions.length, fallback_used: fallbackUsed, pages: Number(finalResult?.pages?.length ?? 0), ...(docError ? { error: docError } : {}) });
    for (const tx of transactions) if (tx.date && Number.isFinite(tx.amount)) allTransactions.push({ ...tx, document_id: doc.documentId });
  }

  // BF_SERVER_BLOCK_v307_BANKING_ZERO_TX_GUARD_v1 — when zero transactions
  // were extracted from every analyzed document, persist a 'failed' row
  // with an explicit last_error instead of silently writing
  // 'analysis_complete' with empty metrics. Surface the failure in the
  // portal so staff can see WHY the analysis didn't produce useful data
  // (statement is a summary letter / screenshot / photo, parser couldn't
  // identify tables, etc.).
  if (allTransactions.length > 0) await insertTransactions(applicationId, allTransactions);
  const aggregates = await aggregateMonthlySummaries(applicationId);
  const llmFlags = openai ? await flagWithOpenAI(applicationId, allTransactions.slice(0, 200)) : { unusualTransactions: [], topVendors: [] };
  await persistAnalysis(applicationId, aggregates, llmFlags, allTransactions.length, country, documentStatuses.find((status) => status.transaction_count > 0)?.model_used ?? modelChain[0], documentStatuses);

  if (allTransactions.length === 0) {
    // No usable transactions extracted from any document. Mark failed
    // with a friendly message; do NOT touch applications.banking_completed_at
    // (analysis isn't truly complete).
    const docCount = documentStatuses.length;
    const errorSummary = documentStatuses
      .map((d) => d.error)
      .filter((e): e is string => typeof e === "string" && e.length > 0)
      .slice(0, 3)
      .join(" | ");
    const lastError = errorSummary ||
      `Banking analysis extracted zero transactions from ${docCount} document(s). ` +
      `Verify the uploads are true bank statements (not summary letters, screenshots, or photos).`;
    await pool.query(
      `UPDATE banking_analyses
          SET status = 'failed',
              last_error = $2,
              updated_at = now()
        WHERE application_id::text = ($1)::text`,
      [applicationId, lastError]
    );
    // v629: cap consecutive zero-tx failures. After 5 attempts with 0 docs,
    // mark application as banking_auto_skip=true so the worker stops retrying.
    // Cleared automatically on the next document upload (see documents route).
    try {
      await pool.query(
        `UPDATE applications
            SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                  'banking_auto_zero_attempts', COALESCE((metadata->>'banking_auto_zero_attempts')::int, 0) + 1,
                  'banking_auto_last_attempt', NOW()::text,
                  'banking_auto_skip',
                    CASE WHEN COALESCE((metadata->>'banking_auto_zero_attempts')::int, 0) + 1 >= 5
                         THEN true ELSE COALESCE((metadata->>'banking_auto_skip')::boolean, false) END
                )
          WHERE id::text = ($1)::text`,
        [applicationId],
      );
    } catch (e) {
      logInfo("banking_pipeline_skip_marker_failed", {
        applicationId,
        err: e instanceof Error ? e.message : String(e),
      });
    }
    logInfo("banking_pipeline_failed_zero_tx", {
      applicationId,
      documents: docCount,
      last_error: lastError,
    });
    return {
      application_id: applicationId,
      transaction_count: 0,
      documents: documentStatuses,
    };
  }

  await pool.query(`UPDATE banking_analyses SET status = 'analysis_complete', completed_at = now(), updated_at = now() WHERE application_id::text = ($1)::text`, [applicationId]);
  await pool.query(`UPDATE applications SET banking_completed_at = now(), updated_at = now() WHERE id::text = ($1)::text`, [applicationId]);
  logInfo("banking_pipeline_complete", { applicationId, transactions: allTransactions.length, months: aggregates.months });
  return {
    application_id: applicationId,
    transaction_count: allTransactions.length,
    documents: documentStatuses,
  };
}

function rowifyTableCells(table: any): Array<Array<{ text: string }>> { if (!table || !Array.isArray(table.cells)) return []; const rows: Array<Array<{ text: string }>> = []; for (const cell of table.cells) { const r = cell.rowIndex ?? 0; const c = cell.columnIndex ?? 0; rows[r] = rows[r] ?? []; rows[r][c] = { text: String(cell.content ?? "") }; } return rows.map((r) => r ?? []); }
async function insertTransactions(applicationId: string, transactions: Array<BankTransaction & { document_id: string }>) { const rows: string[] = []; const params: any[] = []; let i = 0; for (const tx of transactions) { rows.push(`($${++i}, $${++i}, $${++i}::date, $${++i}, $${++i}::numeric, $${++i}::numeric, $${++i})`); params.push(applicationId, tx.document_id, tx.date, tx.description ?? null, tx.amount ?? 0, tx.balance ?? null, (tx.description ?? "").toLowerCase().includes("nsf") || (tx.description ?? "").toLowerCase().includes("returned") || (tx.description ?? "").toLowerCase().includes("insufficient")); } await pool.query(`INSERT INTO banking_transactions (application_id, document_id, transaction_date, description, amount, balance_after, is_nsf) VALUES ` + rows.join(","), params); }
async function aggregateMonthlySummaries(applicationId: string) { await pool.query(`WITH month_buckets AS (SELECT date_trunc('month', transaction_date)::date AS month_start, COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) AS total_deposits, COALESCE(SUM(CASE WHEN amount < 0 THEN -amount ELSE 0 END), 0) AS total_withdrawals, COALESCE(SUM(amount), 0) AS net_cash_flow, COUNT(*) FILTER (WHERE is_nsf) AS nsf_count FROM banking_transactions WHERE application_id::text = ($1)::text GROUP BY date_trunc('month', transaction_date)), endings AS (SELECT DISTINCT ON (date_trunc('month', transaction_date)::date) date_trunc('month', transaction_date)::date AS month_start, balance_after AS ending_balance FROM banking_transactions WHERE application_id::text = ($1)::text AND balance_after IS NOT NULL ORDER BY date_trunc('month', transaction_date)::date, transaction_date DESC, created_at DESC) INSERT INTO banking_monthly_summaries (application_id, month_start, total_deposits, total_withdrawals, net_cash_flow, ending_balance, nsf_count) SELECT $1::uuid, m.month_start, m.total_deposits, m.total_withdrawals, m.net_cash_flow, e.ending_balance, m.nsf_count FROM month_buckets m LEFT JOIN endings e ON e.month_start = m.month_start ON CONFLICT (application_id, month_start) DO UPDATE SET total_deposits = EXCLUDED.total_deposits, total_withdrawals = EXCLUDED.total_withdrawals, net_cash_flow = EXCLUDED.net_cash_flow, ending_balance = EXCLUDED.ending_balance, nsf_count = EXCLUDED.nsf_count`, [applicationId]); const sumRes = await pool.query<any>(`SELECT COUNT(*)::text AS months, COALESCE(SUM(total_deposits), 0)::text AS total_deposits, COALESCE(SUM(total_withdrawals), 0)::text AS total_withdrawals, (SELECT AVG(bt2.balance_after)::text FROM banking_transactions bt2 WHERE bt2.application_id::text = ($1)::text AND bt2.balance_after IS NOT NULL) AS avg_balance, MIN(month_start)::text AS period_start, MAX(month_start)::text AS period_end, COALESCE(SUM(nsf_count), 0)::text AS nsf_total, COALESCE(SUM(CASE WHEN net_cash_flow > 0 THEN 1 ELSE 0 END), 0)::text AS months_profitable FROM banking_monthly_summaries WHERE application_id::text = ($1)::text`, [applicationId]); const r=sumRes.rows[0]; const months=Number(r?.months??0); return {months,totalDeposits:Number(r?.total_deposits??0),totalWithdrawals:Number(r?.total_withdrawals??0),averageDailyBalance:r?.avg_balance?Number(r.avg_balance):null,avgMonthlyDeposits:months>0?Number(r?.total_deposits??0)/months:0,periodStart:r?.period_start??null,periodEnd:r?.period_end??null,nsfTotal:Number(r?.nsf_total??0),monthsProfitable:Number(r?.months_profitable??0),averageMonthlyNsfs:months>0?Number(r?.nsf_total??0)/months:0}; }
async function flagWithOpenAI(_applicationId: string, transactions: Array<BankTransaction & { document_id: string }>) { if (!openai || transactions.length===0) return { unusualTransactions: [], topVendors: [] }; return { unusualTransactions: [], topVendors: [] }; }
async function persistAnalysis(applicationId: string, agg: Awaited<ReturnType<typeof aggregateMonthlySummaries>>, llm: { unusualTransactions: any[]; topVendors: any[] }, txCount: number, country: Country, model: string, documentStatuses: BankingDocumentStatus[]) { await pool.query(`INSERT INTO banking_analyses (application_id, accounts, total_avg_monthly_deposits, average_daily_balance,total_deposits, total_withdrawals, average_monthly_nsfs,months_profitable_numerator, months_profitable_denominator,unusual_transactions, top_vendors, period_start, period_end,months_detected, status, updated_at) VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb,$12::date, $13::date, $14, 'analysis_complete', now()) ON CONFLICT (application_id) DO UPDATE SET accounts = EXCLUDED.accounts,total_avg_monthly_deposits = EXCLUDED.total_avg_monthly_deposits,average_daily_balance = EXCLUDED.average_daily_balance,total_deposits = EXCLUDED.total_deposits,total_withdrawals = EXCLUDED.total_withdrawals,average_monthly_nsfs = EXCLUDED.average_monthly_nsfs,months_profitable_numerator = EXCLUDED.months_profitable_numerator,months_profitable_denominator = EXCLUDED.months_profitable_denominator,unusual_transactions = EXCLUDED.unusual_transactions,top_vendors = EXCLUDED.top_vendors,period_start = EXCLUDED.period_start,period_end = EXCLUDED.period_end,months_detected = EXCLUDED.months_detected,status = 'analysis_complete',updated_at = now()`, [applicationId, JSON.stringify([{ note: `${txCount} transactions parsed via ${model} (${country})` }, { documentStatuses }]), agg.avgMonthlyDeposits || null, agg.averageDailyBalance, agg.totalDeposits, agg.totalWithdrawals, agg.averageMonthlyNsfs, agg.monthsProfitable, agg.months, JSON.stringify(llm.unusualTransactions), JSON.stringify(llm.topVendors), agg.periodStart, agg.periodEnd, agg.months]); }
