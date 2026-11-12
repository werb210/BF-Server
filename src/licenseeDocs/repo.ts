// KS_SERVER_LICENSEE_DOCUMENTS - storage for licensee documents and the extra wizard questions they create.
import type { Q } from "../brokerTools/common.js";
import { questionKey, type MatchedField } from "./match.js";
import type { DocFormat } from "./readFields.js";

export const DOC_KINDS = ["application_form", "client_agreement", "term_sheet", "other"] as const;
export type DocKind = (typeof DOC_KINDS)[number];
export const KIND_LABEL: Record<DocKind, string> = {
  application_form: "Application form", client_agreement: "Client / fee agreement", term_sheet: "Offer / term sheet", other: "Other document to sign",
};

export type DocRow = { id: string; kind: DocKind; name: string; file_name: string | null; format: DocFormat; fields: MatchedField[]; active: boolean; financing_type: string | null; created_at: string; updated_at: string };
export type QuestionRow = { id: string; document_id: string; key: string; label: string; type: string; options: string[]; required: boolean; active: boolean; sort: number };

const COLS = "id::text AS id, kind, name, file_name, format, fields, active, financing_type, created_at, updated_at";

export async function listDocuments(q: Q): Promise<DocRow[]> {
  return (await q.query(`SELECT ${COLS} FROM licensee_documents ORDER BY active DESC, kind, created_at DESC`)).rows;
}
export async function getDocument(q: Q, id: string): Promise<(DocRow & { file: Buffer }) | null> {
  return (await q.query(`SELECT ${COLS}, file FROM licensee_documents WHERE id::text = $1 LIMIT 1`, [id])).rows[0] ?? null;
}
/** The licensee's document in use for a kind, or null (then the built-in document is used). */
// BF_SERVER_v948_TERM_SHEET_BY_TYPE - the template for the file's type of financing wins; the general one (no type) is the fallback.
export async function activeDocument(q: Q, kind: Exclude<DocKind, "other">, financingType: string | null = null): Promise<(DocRow & { file: Buffer }) | null> {
  try {
    return (await q.query(
      `SELECT ${COLS}, file FROM licensee_documents
        WHERE kind = $1 AND active AND (financing_type IS NULL OR financing_type = $2)
        ORDER BY (financing_type IS NULL), updated_at DESC LIMIT 1`, [kind, financingType])).rows[0] ?? null;
  } catch (err) {
    console.warn("[licensee-docs] active document lookup failed; using the built-in document", { kind, message: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

export async function addDocument(q: Q, d: { kind: DocKind; name: string; file_name: string; format: DocFormat; file: Buffer; fields: MatchedField[]; financing_type?: string | null }, actor: string | null): Promise<DocRow> {
  const type = d.kind === "term_sheet" ? d.financing_type ?? null : null;
  if (d.kind !== "other") await q.query(`UPDATE licensee_documents SET active = false, updated_at = now() WHERE kind = $1 AND active AND COALESCE(financing_type, '') = COALESCE($2, '')`, [d.kind, type]);
  const row = (await q.query(
    `INSERT INTO licensee_documents (kind, name, file_name, format, file, fields, created_by, financing_type) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8) RETURNING ${COLS}`,
    [d.kind, d.name, d.file_name, d.format, d.file, JSON.stringify(d.fields), actor, type],
  )).rows[0] as DocRow;
  await syncQuestions(q, row.id, d.fields);
  return row;
}

export async function saveFields(q: Q, id: string, fields: MatchedField[]): Promise<DocRow | null> {
  const row = (await q.query(`UPDATE licensee_documents SET fields = $2::jsonb, updated_at = now() WHERE id::text = $1 RETURNING ${COLS}`, [id, JSON.stringify(fields)])).rows[0] as DocRow | undefined;
  if (!row) return null;
  await syncQuestions(q, row.id, fields);
  return row;
}

export async function setActive(q: Q, id: string, active: boolean): Promise<DocRow | null> {
  const cur = (await q.query(`SELECT kind, financing_type FROM licensee_documents WHERE id::text = $1`, [id])).rows[0];
  if (!cur) return null;
  if (active && cur.kind !== "other") await q.query(`UPDATE licensee_documents SET active = false, updated_at = now() WHERE kind = $1 AND active AND id::text <> $2 AND COALESCE(financing_type, '') = COALESCE($3, '')`, [cur.kind, id, cur.financing_type ?? null]);
  return (await q.query(`UPDATE licensee_documents SET active = $2, updated_at = now() WHERE id::text = $1 RETURNING ${COLS}`, [id, active])).rows[0] ?? null;
}

/** Change which type of financing a term sheet template is for (null = every type without its own). */
export async function setFinancingType(q: Q, id: string, financingType: string | null): Promise<DocRow | null> {
  const cur = (await q.query(`SELECT kind, active FROM licensee_documents WHERE id::text = $1`, [id])).rows[0];
  if (!cur || cur.kind !== "term_sheet") return null;
  if (cur.active) await q.query(`UPDATE licensee_documents SET active = false, updated_at = now() WHERE kind = 'term_sheet' AND active AND id::text <> $1 AND COALESCE(financing_type, '') = COALESCE($2, '')`, [id, financingType]);
  return (await q.query(`UPDATE licensee_documents SET financing_type = $2, updated_at = now() WHERE id::text = $1 RETURNING ${COLS}`, [id, financingType])).rows[0] ?? null;
}

const typeOf = (f: MatchedField): string => (f.type === "checkbox" ? "yesno" : f.type === "choice" ? "choice" : /\bdate\b|\bdob\b/i.test(f.label) ? "date" : "text");

/** One extra question per unmatched field (signatures excluded); questions whose field is now matched are switched off.
 *  A question the licensee edited keeps its wording. */
export async function syncQuestions(q: Q, documentId: string, fields: MatchedField[]): Promise<void> {
  let sort = 0;
  const want = new Set<string>();
  for (const f of fields) {
    if (f.type === "signature" || f.mapped_to) continue;
    const key = questionKey(f.name);
    want.add(key);
    await q.query(
      `INSERT INTO licensee_wizard_questions (document_id, key, label, type, options, sort) VALUES ($1,$2,$3,$4,$5::jsonb,$6)
       ON CONFLICT (document_id, key) DO UPDATE SET active = true, sort = EXCLUDED.sort, updated_at = now()`,
      [documentId, key, f.label, typeOf(f), JSON.stringify(f.options ?? []), sort++],
    );
  }
  const off = (await q.query(`SELECT key FROM licensee_wizard_questions WHERE document_id = $1 AND active`, [documentId])).rows.map((r: any) => String(r.key)).filter((k: string) => !want.has(k));
  if (off.length) await q.query(`UPDATE licensee_wizard_questions SET active = false, updated_at = now() WHERE document_id = $1 AND key = ANY($2::text[])`, [documentId, off]);
}

export async function listQuestions(q: Q, opts: { liveOnly?: boolean } = {}): Promise<QuestionRow[]> {
  const where = opts.liveOnly ? "WHERE q.active AND d.active" : "";
  return (await q.query(
    `SELECT q.id::text AS id, q.document_id::text AS document_id, q.key, q.label, q.type, q.options, q.required, q.active, q.sort
       FROM licensee_wizard_questions q JOIN licensee_documents d ON d.id = q.document_id ${where}
      ORDER BY d.kind, q.sort, q.label`,
  )).rows;
}

export async function updateQuestion(q: Q, id: string, v: { label?: string; type?: string; required?: boolean; active?: boolean; options?: string[] }): Promise<QuestionRow | null> {
  return (await q.query(
    `UPDATE licensee_wizard_questions SET label = COALESCE($2, label), type = COALESCE($3, type), required = COALESCE($4, required),
            active = COALESCE($5, active), options = COALESCE($6::jsonb, options), updated_at = now()
      WHERE id::text = $1
      RETURNING id::text AS id, document_id::text AS document_id, key, label, type, options, required, active, sort`,
    [id, v.label ?? null, v.type ?? null, v.required ?? null, v.active ?? null, v.options ? JSON.stringify(v.options) : null],
  )).rows[0] ?? null;
}
