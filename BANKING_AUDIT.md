# Banking Analysis Audit (2026-05-19)

## Scope
Read-only code audit of the Banking Analysis pipeline in `BF-Server` on branch `audit/banking-analysis-2026-05-19`.

---

## Step 1 — Banking Analysis code path
Primary Banking Analysis execution path:

1. **Document upload path** inserts/updates `documents` + `document_versions` and OCR jobs.
2. **OCR worker** processes docs and marks `documents.ocr_status='completed'`.
3. **Banking auto-worker** polls for bank-like docs (`LIKE '%bank%'`) with OCR complete.
4. Auto-worker calls `runBankingAnalysis(applicationId)`.
5. Pipeline calls Azure Document Intelligence, extracts transactions, stores in `banking_transactions`, computes `banking_monthly_summaries`, writes final metrics to `banking_analyses`.
6. Portal/app routes read `banking_analyses` + `banking_monthly_summaries` and expose UI metrics.

Key files:
- `src/workers/bankingAutoWorker.ts`
- `src/services/banking/bankingAnalysisPipeline.ts`
- `src/services/banking/bankingFromOcr.ts`
- `src/modules/ocr/azureDocIntelProvider.ts`
- `src/modules/applications/applications.routes.ts`
- `migrations/20260502_banking_analysis_v1.sql`

---

## Step 2 — Worker and internal processing endpoints

### Internal endpoints for complete/fail
Handled in:
- `src/routes/internal/processing.ts`

Routes:
- `POST /banking/:applicationId/complete` → `markBankingAnalysisCompleted(applicationId)`
- `POST /banking/:applicationId/fail` → `markBankingAnalysisFailed(applicationId)`

### Queue/consumer trigger on bank statement uploads
Banking is triggered by **polling**, not direct queue subscription:
- `src/workers/bankingAutoWorker.ts`

Trigger condition:
```sql
LOWER(COALESCE(d.signed_category, d.document_type, '')) LIKE '%bank%'
AND d.ocr_status = 'completed'
```

This means documents are routed by fuzzy category/type matching containing `bank`.

### Full Banking worker code
See full worker implementation in:
- `src/workers/bankingAutoWorker.ts` (entire file)

### Full Banking pipeline code
See full processor implementation in:
- `src/services/banking/bankingAnalysisPipeline.ts` (entire file)

---

## Step 3 — Upstream parser/service and mapping

### Exact parser used
Banking pipeline uses:
- **Azure Document Intelligence REST client** via `@azure-rest/ai-document-intelligence`
- Wrapper function: `analyzeWithDocIntel(buffer, modelId)` in `src/modules/ocr/azureDocIntelProvider.ts`

Models attempted for Banking:
1. `prebuilt-layout`
2. fallback `prebuilt-bankStatement.us` (when `docType=OTHER` or zero extracted tx)

### Request payload format
From `analyzeWithDocIntel`:
- Endpoint path: `/documentModels/{modelId}:analyze`
- Content-Type: `application/octet-stream`
- Body: raw document `Buffer`

No Plaid/Mindee/Ocrolus/custom external API found in Banking path.

### Response mapping to `banking_analysis.*`
Flow:
1. Azure DI response (`analyzeResult`) provides `pages/tables/documents`.
2. `bankingFromOcr.extractTransactionsFromTables(...)` converts table cells to transactions.
3. Transactions inserted into `banking_transactions`.
4. SQL aggregation writes `banking_monthly_summaries`.
5. Aggregate rollup written to `banking_analyses` via `persistAnalysis(...)`.

Mapped columns written in `banking_analyses`:
- `accounts` (JSON note + document statuses)
- `total_avg_monthly_deposits`
- `average_daily_balance`
- `total_deposits`
- `total_withdrawals`
- `average_monthly_nsfs`
- `months_profitable_numerator`
- `months_profitable_denominator`
- `unusual_transactions`
- `top_vendors`
- `period_start`
- `period_end`
- `months_detected`
- `status='analysis_complete'`

### Expected schema/field names
Transaction extraction expects recognizable transaction table rows (date/description/amount/balance patterns) from OCR table output; then pipeline expects each tx to have:
- `date`
- `amount`
- optional `description`
- optional `balance`

If parsed transactions are empty, aggregates become zero/null and UI shows dashes/0.

### Table where extracted transactions go
- `banking_transactions`

### Aggregation for Avg Daily Balance / Avg Monthly NSFs / etc.
In `aggregateMonthlySummaries(...)`:
- Builds monthly buckets from `banking_transactions`.
- Writes per-month records to `banking_monthly_summaries`.
- Computes totals and derived metrics:
  - `avg_balance` from `AVG(balance_after)`
  - `averageMonthlyNsfs = nsf_total / months`
  - `avgMonthlyDeposits = total_deposits / months`
  - profitable month count via `net_cash_flow > 0`

---

## Step 4 — Compare with Financials OCR worker

### Financials OCR worker location
- `src/modules/ocr/ocr.worker.ts`
- `src/modules/ocr/ocr.service.ts`
- provider wrapper in `src/modules/ocr/azureDocIntelProvider.ts`

### Parser used by Financials path
Financials OCR goes through generic OCR provider resolution:
- config-driven provider (`azure-doc-intel` or `openai`)
- Azure mode uses `createAzureDocIntelOcrProvider()` which calls `analyzeWithDocIntel(..., 'prebuilt-read')`

So Financials uses **Azure Document Intelligence prebuilt-read** + text/field extraction logic.

### Why Financials can succeed while Banking fails
Most likely code-level difference:
- Financials path uses text extraction (`prebuilt-read`) and flexible field matching.
- Banking path requires table-structured transaction extraction from DI table output.
- Banking writes `analysis_complete` even when **0 transactions parsed** (no hard failure), producing "complete, 6 analyzed" but all metrics empty/zero.

This matches the observed symptom exactly.

---

## Step 5 — Recent Banking-related commits (last 60 days)
Command run:
```bash
git log --since='60 days ago' --pretty='%h %ad %s' --date=short -- $(git ls-files | xargs grep -l 'banking' 2>/dev/null) | head -30
```

Top relevant commits:
- `4ac7300 2026-05-18 Block 103 - surface banking OCR document status and fallback models`
- `97b24aa 2026-05-17 Fix monthly summary aggregation with month/endings CTEs`
- `e9e2582 2026-05-17 Add banking analysis diagnostics fields and admin retry route`
- `0646def 2026-05-17 Fix lender send gate and add manual banking analysis trigger`
- `2e7b1f1 2026-05-09 Sync documents OCR status with OCR job outcomes`

Recent churn is high in exactly this area.

---

## Step 6 — Top 3 likely root causes (ranked)

### 1) Parser-output mismatch (most likely)
Banking parser expects transaction tables; DI output may be present but not in extractable table shape, so `extractTransactionsFromTables` yields empty arrays. Pipeline still marks analysis complete.

### 2) Model strategy mismatch
Banking tries `prebuilt-layout` first and only falls back to `prebuilt-bankStatement.us` on `docType=OTHER` or empty extraction. Some real statements may still need different model behavior (e.g., global model, different fallback condition, or model-first ordering).

### 3) Document routing/filter mismatch
Banking worker selects docs via `LIKE '%bank%'` on `signed_category/document_type`. If uploads are categorized inconsistently, non-statement docs could be included (or true statements excluded), leading to analysis_complete with no useful tx.

---

## Concrete diagnostic checks to run next (suggested)
1. For one failing app, inspect `banking_analyses.accounts` JSON `documentStatuses` to see `transaction_count`, `model_used`, and `error` per document.
2. Inspect `banking_transactions` row count for that app.
3. Compare one document's DI raw output between Financials prebuilt-read and Banking prebuilt-layout/prebuilt-bankStatement.us.
4. Add a guard: if all docs parse zero transactions, set status `failed` with explicit `last_error` instead of `analysis_complete`.

