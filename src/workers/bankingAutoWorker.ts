// BF_AZURE_OCR_TERMSHEET_v44 — polls for documents whose OCR completed and
// banking has not run yet. Runs banking analysis and marks banking_status.
// Pure DB-poll design — no eventBus changes needed in the OCR pipeline.
import type { Pool } from "pg";
import { eventBus } from "../events/eventBus.js";
import { analyzeBankStatements } from "../services/bankingAnalysis.service.js";
import { buildBankingFromOcr } from "../services/banking/bankingFromOcr.js";

interface DocRow {
  id: string;
  application_id: string;
  ocr_text: string | null;
}

const POLL_MS = Number(process.env.BANKING_AUTO_POLL_MS || 5000);

export function startBankingAutoWorker(pool: Pool): { stop: () => void } {
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const { rows } = await pool.query<DocRow>(
        `SELECT d.id, d.application_id, r.extracted_json::text AS ocr_text
           FROM documents d
           LEFT JOIN ocr_document_results r ON r.document_id = d.id
          WHERE d.ocr_status = 'completed'
            AND (d.banking_status IS NULL OR d.banking_status = 'pending')
          LIMIT 5`
      );
      for (const row of rows) {
        try {
          const ocrResult = row.ocr_text ? JSON.parse(row.ocr_text) : {};
          const normalized = buildBankingFromOcr(ocrResult as never);
          const result = analyzeBankStatements({
            applicationId: row.application_id,
            transactions: normalized.transactions,
          });
          await pool.query(
            `UPDATE documents SET banking_status='completed', updated_at=now() WHERE id=$1`,
            [row.id]
          );
          eventBus.emit("banking_completed", { documentId: row.id, applicationId: row.application_id, result });
        } catch (err) {
          await pool.query(
            `UPDATE documents SET banking_status='failed', updated_at=now() WHERE id=$1`,
            [row.id]
          ).catch(() => {});
          console.error("[banking_auto_worker] failed", { documentId: row.id, error: String(err) });
        }
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => { tick().catch(() => {}); }, POLL_MS);
  tick().catch(() => {});

  const stop = () => {
    stopped = true;
    clearInterval(timer);
    process.removeListener("SIGTERM", stop);
  };
  process.on("SIGTERM", stop);
  return { stop };
}
