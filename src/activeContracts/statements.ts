// BF_SERVER_v864_ACTIVE_CONTRACTS - lender statement intake. A statement uploaded on a contract, or arriving by email
// (filed to the CRM by the inbound-attachment worker / "Save to CRM"), is read with the existing document text
// extraction (PDF text, else Azure Document Intelligence) and an AI read of balance, as-of date, payments made and
// arrears. The result waits as "pending review"; nothing changes the balance until staff confirm it.
import { isoDay, num, toDate } from "./model.js";
import { addBalance, InputError } from "./money.js";
import { writeContractEvent } from "./timeline.js";
import type { Q } from "./repo.js";

export type Extracted = { borrower_name: string | null; lender_name: string | null; account_number: string | null; balance: number | null; as_of: string | null; payments_made: number | null; arrears: number | null };
export type StatementDeps = {
  load: (blobName: string) => Promise<{ buffer: Buffer; contentType: string } | null>;
  text: (buffer: Buffer, mime: string) => Promise<string>;
  read: (text: string) => Promise<unknown>;
};

const PROMPT = `You read a loan, lease or merchant cash advance statement sent by a lender. Return JSON with exactly these keys:
borrower_name, lender_name, account_number, balance (the current outstanding balance as a plain number), as_of (the statement or balance date, YYYY-MM-DD),
payments_made (number of payments made, integer), arrears (amount past due, plain number, 0 if none stated).
Use null for anything not written on the statement. Never guess.\n\n`;

export async function defaultStatementDeps(): Promise<StatementDeps> {
  return {
    async load(blobName) {
      const { getStorage } = await import("../lib/storage/index.js");
      return getStorage().get(blobName);
    },
    async text(buffer, mime) {
      const { documentText } = await import("../services/brokerImport/extract.js");
      return documentText(buffer, mime);
    },
    async read(text) {
      if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
      const { sharedOpenAI } = await import("../lib/sharedClients.js");
      const r = await sharedOpenAI(process.env.OPENAI_API_KEY).chat.completions.create({
        model: process.env.ACTIVE_CONTRACTS_LLM_MODEL || process.env.BROKER_IMPORT_LLM_MODEL || "gpt-5.4-mini",
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: PROMPT + text.slice(0, 40000) }],
      });
      return JSON.parse(r.choices?.[0]?.message?.content ?? "{}");
    },
  };
}

export function normalizeExtracted(raw: any): Extracted {
  const s = (v: unknown) => (v === null || v === undefined || String(v).trim() === "" ? null : String(v).trim().slice(0, 200));
  const n = (v: unknown) => num(v);
  const pm = n(raw?.payments_made);
  return {
    borrower_name: s(raw?.borrower_name), lender_name: s(raw?.lender_name), account_number: s(raw?.account_number),
    balance: n(raw?.balance), as_of: isoDay(toDate(s(raw?.as_of))), payments_made: pm === null ? null : Math.round(pm), arrears: n(raw?.arrears),
  };
}

async function readFile(deps: StatementDeps, blobName: string): Promise<Extracted> {
  const file = await deps.load(blobName);
  if (!file) throw new Error("file_not_found");
  const text = await deps.text(file.buffer, file.contentType || "application/pdf");
  if (!text.trim()) throw new Error("no_readable_text");
  return normalizeExtracted(await deps.read(text));
}

/** A statement uploaded on the contract: read it now and leave it pending review. */
export async function reviewUploadedStatement(db: Q, contractId: string, documentId: string, deps: StatementDeps): Promise<{ id: string; status: string }> {
  const doc = (await db.query(`SELECT d.blob_name, d.filename, c.silo FROM active_contract_documents d JOIN active_contracts c ON c.id = d.contract_id
                                WHERE d.id = $1::uuid AND d.contract_id = $2::uuid`, [documentId, contractId])).rows[0];
  if (!doc) throw new InputError("not_found");
  let extracted: Extracted | null = null;
  let error: string | null = null;
  try { extracted = await readFile(deps, doc.blob_name); } catch (err) { error = String((err as Error)?.message ?? err).slice(0, 300); }
  const r = await db.query(
    `INSERT INTO active_contract_statement_reviews (silo, contract_id, document_id, filename, extracted, status, error)
     VALUES ($1, $2::uuid, $3::uuid, $4, $5::jsonb, $6, $7) RETURNING id::text AS id, status`,
    [doc.silo, contractId, documentId, doc.filename, JSON.stringify(extracted ?? {}), error ? "failed" : "pending", error]);
  if (!error) await writeContractEvent(db, contractId, { title: "Lender statement read - pending review", detail: extracted?.balance !== null ? `Balance $${extracted!.balance} as of ${extracted!.as_of ?? "?"}` : doc.filename });
  return r.rows[0];
}

const STATEMENT_NAME = `(d.filename ~* '(statement|balance|payout|pay-out|account summary|releve|solde)')`;

/** Worker step: statements filed from email (from a lender's address, or forwarded by a client with a contract). */
export async function scanInboundStatements(db: Q, deps: StatementDeps, limit = 10): Promise<number> {
  if (!process.env.OPENAI_API_KEY) return 0;
  const r = await db.query(
    `SELECT d.id::text AS id, d.silo, d.filename, d.blob_name, d.content_type, d.contact_id::text AS contact_id, lower(split_part(ct.email, '@', 2)) AS domain
       FROM contact_documents d JOIN contacts ct ON ct.id = d.contact_id
      WHERE d.created_at > now() - interval '30 days' AND ${STATEMENT_NAME}
        AND (d.content_type IS NULL OR d.content_type ~* '(pdf|image)')
        AND NOT EXISTS (SELECT 1 FROM active_contract_statement_reviews s WHERE s.contact_document_id = d.id)
        AND (EXISTS (SELECT 1 FROM lenders l WHERE lower(split_part(coalesce(l.email, l.contact_email, l.submission_email, l.primary_contact_email, ''), '@', 2)) = lower(split_part(ct.email, '@', 2))
                     AND coalesce(ct.email, '') <> '')
             OR EXISTS (SELECT 1 FROM active_contracts c WHERE c.contact_id = d.contact_id OR (c.company_id IS NOT NULL AND c.company_id = ct.company_id)))
      ORDER BY d.created_at ASC LIMIT $1`, [limit]);
  let made = 0;
  for (const d of r.rows) {
    let extracted: Extracted | null = null;
    let error: string | null = null;
    try { extracted = await readFile(deps, d.blob_name); } catch (err) { error = String((err as Error)?.message ?? err).slice(0, 300); }
    const contractId = extracted ? await matchContract(db, d, extracted) : null;
    const ins = await db.query(
      `INSERT INTO active_contract_statement_reviews (silo, contract_id, contact_document_id, filename, extracted, status, error)
       VALUES ($1, $2::uuid, $3::uuid, $4, $5::jsonb, $6, $7) ON CONFLICT (contact_document_id) WHERE contact_document_id IS NOT NULL DO NOTHING RETURNING id`,
      [d.silo, contractId, d.id, d.filename, JSON.stringify(extracted ?? {}), error ? "failed" : "pending", error]);
    if (ins.rows[0]) made++;
    if (ins.rows[0] && contractId && !error) await writeContractEvent(db, contractId, { title: "Lender statement received by email - pending review", detail: d.filename });
  }
  return made;
}

/** The contract a statement is about: the sender's contracts, else the lender + borrower name. One match or none. */
async function matchContract(db: Q, d: { contact_id: string; domain: string | null }, x: Extracted): Promise<string | null> {
  const own = await db.query(`SELECT c.id::text AS id, c.lender_name FROM active_contracts c JOIN contacts ct ON ct.id::text = $1
                               WHERE (c.contact_id = ct.id OR c.company_id = ct.company_id) AND c.status NOT IN ('refinanced','paid_out','matured','closed')`, [d.contact_id]);
  const byLender = (rows: any[]) => x.lender_name ? rows.filter((r) => String(r.lender_name ?? "").toLowerCase().includes(String(x.lender_name).toLowerCase().split(" ")[0] ?? "")) : rows;
  if (own.rows.length === 1) return own.rows[0].id;
  if (own.rows.length > 1) { const f = byLender(own.rows); return f.length === 1 ? f[0].id : null; }
  if (!x.borrower_name) return null;
  const words = x.borrower_name.replace(/[^A-Za-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !/^(inc|ltd|llc|corp|the)$/i.test(w)).slice(0, 3);
  if (!words.length) return null;
  const params: unknown[] = [d.domain ?? ""];
  const conds = words.map((w) => { params.push(`%${w}%`); return `co.name ILIKE $${params.length}`; });
  const r = await db.query(
    `SELECT c.id::text AS id FROM active_contracts c JOIN companies co ON co.id = c.company_id LEFT JOIN lenders l ON l.id = c.lender_id
      WHERE c.status NOT IN ('refinanced','paid_out','matured','closed') AND ${conds.join(" AND ")}
        AND ($1 = '' OR lower(split_part(coalesce(l.email, l.contact_email, l.submission_email, l.primary_contact_email, ''), '@', 2)) = $1)
      LIMIT 2`, params);
  return r.rows.length === 1 ? r.rows[0].id : null;
}

export async function listReviews(db: Q, silo: string, contractId?: string | null): Promise<any[]> {
  const params: unknown[] = [silo];
  let where = `s.silo = $1 AND s.status IN ('pending','failed')`;
  if (contractId) { params.push(contractId); where += ` AND s.contract_id::text = $2`; }
  return (await db.query(
    `SELECT s.id::text AS id, s.contract_id::text AS contract_id, s.filename, s.extracted, s.status, s.error, s.created_at,
            s.document_id::text AS document_id, s.contact_document_id::text AS contact_document_id, c.lender_name, co.name AS company_name
       FROM active_contract_statement_reviews s LEFT JOIN active_contracts c ON c.id = s.contract_id LEFT JOIN companies co ON co.id = c.company_id
      WHERE ${where} ORDER BY s.created_at DESC LIMIT 200`, params)).rows;
}

/** One click: the (optionally corrected) figures become the contract's balance, source "lender statement". */
export async function confirmReview(db: Q, reviewId: string, body: { contract_id?: unknown; balance?: unknown; as_of?: unknown }, actor: string | null): Promise<{ balanceId: string }> {
  const rv = (await db.query(`SELECT id::text AS id, contract_id::text AS contract_id, document_id::text AS document_id, contact_document_id::text AS contact_document_id,
                                      filename, extracted, status FROM active_contract_statement_reviews WHERE id = $1::uuid`, [reviewId])).rows[0];
  if (!rv) throw new InputError("not_found");
  if (rv.status !== "pending" && rv.status !== "failed") throw new InputError("already_reviewed");
  const contractId = typeof body.contract_id === "string" && body.contract_id ? body.contract_id : rv.contract_id;
  if (!contractId) throw new InputError("choose_a_contract", "contract_id");
  const x = normalizeExtracted(rv.extracted ?? {});
  let documentId: string | null = rv.document_id;
  if (!documentId && rv.contact_document_id) {
    const cd = (await db.query(`SELECT filename, content_type, size_bytes, blob_name FROM contact_documents WHERE id = $1::uuid`, [rv.contact_document_id])).rows[0];
    if (cd) documentId = (await db.query(
      `INSERT INTO active_contract_documents (contract_id, kind, filename, content_type, size_bytes, blob_name, source, contact_document_id, uploaded_by)
       VALUES ($1::uuid, 'lender_statement', $2, $3, $4, $5, 'email', $6::uuid, $7::uuid) RETURNING id::text AS id`,
      [contractId, cd.filename, cd.content_type, cd.size_bytes, cd.blob_name, rv.contact_document_id, actor])).rows[0]?.id ?? null;
  }
  const b = await addBalance(db, contractId, {
    balance: body.balance ?? x.balance, as_of: body.as_of ?? x.as_of, source: "lender_statement", payments_made: x.payments_made, arrears: x.arrears,
    note: `Confirmed from ${rv.filename ?? "statement"}`, document_id: documentId,
  }, actor);
  await db.query(`UPDATE active_contract_statement_reviews SET status = 'confirmed', contract_id = $2::uuid, reviewed_by = $3::uuid, reviewed_at = now(), balance_id = $4::uuid WHERE id = $1::uuid`,
    [reviewId, contractId, actor, b.id]);
  return { balanceId: b.id };
}

export async function rejectReview(db: Q, reviewId: string, actor: string | null): Promise<boolean> {
  const r = await db.query(`UPDATE active_contract_statement_reviews SET status = 'rejected', reviewed_by = $2::uuid, reviewed_at = now() WHERE id = $1::uuid AND status IN ('pending','failed') RETURNING id`, [reviewId, actor]);
  return Boolean(r.rows[0]);
}
