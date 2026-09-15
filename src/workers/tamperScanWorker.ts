// BF_SERVER_AUTO_TAMPER_SCAN_v269
// Scans newly uploaded documents in the background. Polling the documents
// table (rather than hooking each upload route) covers every way a document
// arrives: wizard, portal, accountant, email attachments, signed PDFs.
import type { Pool } from "pg";
import { recordTamperResult, scanDocumentForTampering } from "../services/documents/tamperScan.js";

const TICK_MS = 60_000;
export const TAMPER_BATCH = 10;

export async function runTamperScanTick(pool: Pool, scan = scanDocumentForTampering): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id::text AS id FROM documents
      WHERE tamper_scanned_at IS NULL AND created_at > now() - interval '30 days'
      ORDER BY created_at DESC
      LIMIT $1`,
    [TAMPER_BATCH],
  );
  for (const row of rows) {
    try {
      const result = await scan(row.id);
      if (result && (result.level === "medium" || result.level === "high")) {
        console.warn(JSON.stringify({ event: "document_tamper_signals", documentId: row.id, level: result.level, signals: result.signals.map((s) => s.code) }));
      }
    } catch (err) {
      // Mark it so one unreadable file can never stall the queue.
      await recordTamperResult(row.id, "error", [], { query: (sql, params) => pool.query(sql, params as any[]) }).catch((markErr) => console.error("[tamper-scan] could not mark failed document", row.id, markErr instanceof Error ? markErr.message : markErr));
      console.error(JSON.stringify({ event: "document_tamper_scan_failed", documentId: row.id, message: err instanceof Error ? err.message : String(err) }));
    }
  }
  return rows.length;
}

export function startTamperScanWorker(pool: Pool): { stop: () => void } {
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try { await runTamperScanTick(pool); }
    catch (err) { console.error("[tamper-scan] tick failed:", err instanceof Error ? err.message : err); }
    finally { running = false; }
  };
  const timer = setInterval(() => { void tick(); }, TICK_MS);
  setTimeout(() => { void tick(); }, 15_000);
  return { stop: () => { stopped = true; clearInterval(timer); } };
}
