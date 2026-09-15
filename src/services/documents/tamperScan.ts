// BF_SERVER_AUTO_TAMPER_SCAN_v269
// Runs the existing tamper checks (PDF producer, edit history, re-saves, same
// file on another application) for a document and stores the result, so the
// portal can show it without staff clicking "scan". Advisory only.
import { pool } from "../../db.js";
import { getStorage } from "../../lib/storage/index.js";
import { findActiveDocumentVersion } from "../../modules/applications/applications.repo.js";
import { hashBuffer } from "./hashService.js";
import { classifyDocKind, extractPdfMeta, scoreFraudSignals, type FraudResult, type PdfMeta } from "./fraudSignals.js";

export type TamperScan = FraudResult & { documentId: string; kind: string; duplicateCount: number; meta: PdfMeta };

type Query = (sql: string, params: unknown[]) => Promise<{ rows: any[] }>;
export type TamperDeps = {
  query: Query;
  loadFile: (doc: { id: string; storage_key: string | null; blob_name: string | null; storage_path: string | null }) => Promise<Buffer | null>;
};

const defaultDeps: TamperDeps = {
  query: (sql, params) => pool.query(sql, params as any[]),
  loadFile: async (doc) => {
    const version = await findActiveDocumentVersion({ documentId: doc.id });
    const vmeta = version && version.metadata && typeof version.metadata === "object" ? (version.metadata as { storageKey?: string }) : {};
    const key = vmeta.storageKey ?? doc.storage_key ?? doc.blob_name ?? doc.storage_path;
    if (!key) return null;
    const file = await getStorage().get(key);
    return file?.buffer ? Buffer.from(file.buffer) : null;
  },
};

export async function recordTamperResult(documentId: string, level: string, signals: unknown, deps: Pick<TamperDeps, "query"> = defaultDeps): Promise<void> {
  await deps.query(
    `UPDATE documents SET tamper_level = $2, tamper_signals = $3::jsonb, tamper_scanned_at = now() WHERE id::text = ($1)::text`,
    [documentId, level, JSON.stringify(signals ?? [])],
  );
}

/** Scans one document and stores the result. Returns null when the document or its file is gone. */
export async function scanDocumentForTampering(documentId: string, deps: TamperDeps = defaultDeps): Promise<TamperScan | null> {
  const { rows } = await deps.query(
    `SELECT id::text AS id, application_id::text AS application_id, COALESCE(category, document_type, signed_category) AS category,
            hash, storage_key, blob_name, storage_path
       FROM documents WHERE id::text = ($1)::text LIMIT 1`,
    [documentId],
  );
  const doc = rows[0];
  if (!doc) return null;
  const buffer = await deps.loadFile(doc);
  if (!buffer) {
    await recordTamperResult(documentId, "unavailable", [], deps);
    return null;
  }
  const hash = doc.hash ?? hashBuffer(buffer);
  const dup = await deps.query(
    `SELECT COUNT(DISTINCT application_id)::text AS n FROM documents
      WHERE hash = $1 AND hash IS NOT NULL AND application_id::text <> ($2)::text`,
    [hash, doc.application_id],
  ).catch((err) => { console.warn(JSON.stringify({ event: "tamper_duplicate_lookup_failed", documentId, message: err instanceof Error ? err.message : String(err) })); return { rows: [{ n: "0" }] }; });
  const duplicateCount = Number(dup.rows[0]?.n ?? 0);
  const meta = await extractPdfMeta(buffer);
  const kind = classifyDocKind(doc.category);
  const result = scoreFraudSignals(meta, { kind, duplicateCount });
  await recordTamperResult(documentId, result.level, result.signals, deps);
  return { documentId, kind, duplicateCount, meta, ...result };
}
