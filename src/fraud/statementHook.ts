// BF_SERVER_v846_FRAUD - check 2 runs inside the banking pipeline, right after a statement's transactions are read and
// BEFORE the opening-balance rows are removed: that is the only point where the statement's own order and its
// opening / closing lines are still known. The result is stored per document and the fraud worker is asked to
// re-score the application. Best effort: a failure is logged and never stops the banking analysis.
import type { Q } from "./types.js";
import { checkStatementArithmetic, type StatementRow } from "./checks/statementMath.js";
import { enqueueFraudRun, upsertResult } from "./store.js";

export async function recordStatementMath(db: Q, applicationId: string, documentId: string, rows: StatementRow[]): Promise<void> {
  try {
    const r = checkStatementArithmetic(rows);
    await upsertResult(db, applicationId, "fraud_2", documentId, r);
    await enqueueFraudRun(db, applicationId, "statement_math");
  } catch (err) {
    console.warn("[fraud] statement math could not be stored", { applicationId, documentId, message: (err as Error)?.message ?? String(err) });
  }
}
