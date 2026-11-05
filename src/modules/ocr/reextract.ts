// BF_SERVER_v886_OCR_REEXTRACT - re-read every stored document with the current field parser.
// The parser fixes (v885 label fragments, v886 signs and statement kinds) only applied to documents read after them;
// fields read earlier stayed wrong on the Financials tab. Each document's OCR text and the model's fields are kept in
// ocr_document_results, so a re-read needs no AI call: recompute the fields and replace that document's rows.
import type { Pool, PoolClient } from "pg";
import { extractOcrFields } from "./ocr.service.js";

type Q = Pick<Pool, "query"> & { connect?: () => Promise<PoolClient> };

/** The model's fields from a stored result's JSON ({ fields: { key: value } }), as the OCR worker reads them. */
export function modelFieldsFrom(json: unknown): Record<string, string | number> {
  if (!json || typeof json !== "object" || Array.isArray(json)) return {};
  const f = (json as Record<string, unknown>).fields;
  if (!f || typeof f !== "object" || Array.isArray(f)) return {};
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(f as Record<string, unknown>)) {
    if (typeof v === "string" && v.trim()) out[k] = v;
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/** Replace one document's field rows with a fresh read of its stored text. Returns the number of fields written. */
export async function reextractDocument(db: Q, documentId: string): Promise<number | null> {
  const r = await db.query(
    `SELECT r.extracted_text, r.extracted_json, d.application_id, d.document_type
       FROM ocr_document_results r JOIN documents d ON d.id = r.document_id
      WHERE r.document_id = $1 LIMIT 1`, [documentId]);
  const row = r.rows[0];
  if (!row || !String(row.extracted_text ?? "").trim()) return null;
  const fields = extractOcrFields(String(row.extracted_text), modelFieldsFrom(row.extracted_json));
  const client = db.connect ? await db.connect() : null;
  const q = client ?? db;
  try {
    if (client) await client.query("BEGIN");
    await q.query(`DELETE FROM ocr_results WHERE document_id = $1`, [documentId]);
    for (const f of fields) {
      await q.query(
        `INSERT INTO ocr_results (id, application_id, document_id, field_key, value, confidence, source_document_type, created_at)
         VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, now())`,
        [row.application_id, documentId, f.fieldKey, f.value, f.confidence, row.document_type ?? null]);
    }
    if (client) await client.query("COMMIT");
    return fields.length;
  } catch (err) {
    if (client) await client.query("ROLLBACK").catch((e: unknown) => console.error("[ocr-reextract] rollback failed", e));
    throw err;
  } finally {
    client?.release();
  }
}

/** Re-read every document that has a stored OCR result, one at a time. One failure never stops the rest. */
export async function reextractAll(db: Q): Promise<{ documents: number; fields: number; failed: number }> {
  const ids = await db.query(`SELECT document_id FROM ocr_document_results ORDER BY document_id`);
  let documents = 0, fields = 0, failed = 0;
  for (const { document_id } of ids.rows) {
    try {
      const n = await reextractDocument(db, String(document_id));
      if (n !== null) { documents += 1; fields += n; }
    } catch (err) {
      failed += 1;
      console.error("[ocr-reextract] document failed", { documentId: document_id, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { documents, fields, failed };
}

/** Once per database: re-read everything after this release, then record it in data_repairs. */
export async function runOcrReextractOnce(db: Q): Promise<void> {
  const KEY = "v886_ocr_reextract";
  const lock = await db.query(`SELECT pg_try_advisory_lock(hashtext($1)) AS ok`, [KEY]);
  if (!lock.rows[0]?.ok) return; // another instance is doing it
  try {
    const done = await db.query(`SELECT 1 FROM data_repairs WHERE key = $1`, [KEY]);
    if (done.rows.length) return;
    const out = await reextractAll(db);
    await db.query(`INSERT INTO data_repairs (key, detail) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO NOTHING`, [KEY, JSON.stringify(out)]);
    console.log("[ocr-reextract] done", out);
  } finally {
    await db.query(`SELECT pg_advisory_unlock(hashtext($1))`, [KEY]).catch((e: unknown) => console.error("[ocr-reextract] unlock failed", e));
  }
}
