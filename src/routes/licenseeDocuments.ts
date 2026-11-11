// BF_SERVER_v938_OUR_TERM_SHEET (ported from Keystone) - /api/licensee-documents: a brokerage's own documents (Settings > Your documents).
//   GET    /                       documents, the data fields they can be matched to, and the extra wizard questions
//   POST   /                       Admin: multipart "file" (fillable PDF or Word with {{fields}}) + kind, name
//                                  -> fields read and matched; unmatched fields become extra wizard questions
//   GET    /:id/file               the original upload
//   PUT    /:id/fields             Admin: { fields: [{ name, mapped_to }] } - the licensee's corrections to the matches
//   PATCH  /:id                    Admin: { active }
//   POST   /:id/preview            { applicationId } -> the document filled for that file (PDF)
//   PATCH  /questions/:qid         Admin: { label, type, required, active, options }
//   POST   /offers/:offerId/term-sheet   Staff: the brokerage's term sheet, filled with the offer, becomes the offer's
//                                  term sheet (the lender's is kept) so Send for signature uses it
import { Router, type Request, type Response } from "express";
import { safeHandler } from "../middleware/safeHandler.js";
import { db, UUID_RE } from "../brokerTools/common.js";
import { admin, staff, upload, bad } from "../brokerTools/http.js";
import { DATA_FIELDS, DATA_FIELD_KEYS, valuesFor } from "../licenseeDocs/catalog.js";
import { readDocumentFields } from "../licenseeDocs/readFields.js";
import { matchFields, type MatchedField } from "../licenseeDocs/match.js";
import { fillDocument } from "../licenseeDocs/fill.js";
import { DOC_KINDS, KIND_LABEL, addDocument, getDocument, listDocuments, listQuestions, saveFields, setActive, updateQuestion, type DocKind } from "../licenseeDocs/repo.js";
const brandName = (): string => "Boreal Financial";
const BF_KINDS = new Set<string>(["term_sheet", "other"]);

const router = Router();
const actor = (req: Request): string | null => { const id = (req as any).user?.userId ?? (req as any).user?.id; return typeof id === "string" && UUID_RE.test(id) ? id : null; };

router.get("/", ...staff, safeHandler(async (_req: Request, res: Response) => {
  const q = db();
  res.json({
    ok: true,
    kinds: DOC_KINDS.filter((k) => BF_KINDS.has(k)).map((k) => ({ key: k, label: KIND_LABEL[k] })),
    dataFields: DATA_FIELDS.map(({ key, label }) => ({ key, label })),
    documents: await listDocuments(q),
    questions: await listQuestions(q),
  });
}));

router.post("/", ...admin, upload.single("file"), safeHandler(async (req: Request, res: Response) => {
  const file = (req as any).file as { buffer: Buffer; originalname: string } | undefined;
  const kind = String(req.body?.kind ?? "") as DocKind;
  if (!DOC_KINDS.includes(kind)) return bad(res, "Choose what this document is.");
  // BF_SERVER_v938_OUR_TERM_SHEET - BF uses the brokerage's own term sheet; its own application form and client agreement
  // are not wired into BF's signing, so they are not accepted here (yet).
  if (!BF_KINDS.has(kind)) return bad(res, "Upload a term sheet template here.");
  if (!file?.buffer?.length) return bad(res, "Choose the file to upload.");
  const read = await readDocumentFields(file.buffer, file.originalname);
  if (read.format === "none") {
    return bad(res, "This file has no fill-in fields, so it can't be filled automatically. Upload it as a fillable PDF (in Adobe Acrobat: Prepare a form), or as a Word file with fields written like {{business_name}}.", 422, "no_fields");
  }
  const fields = await matchFields(read.fields);
  const name = String(req.body?.name ?? "").trim().slice(0, 120) || file.originalname.replace(/\.[a-z0-9]+$/i, "");
  const doc = await addDocument(db(), { kind, name, file_name: file.originalname, format: read.format, file: file.buffer, fields }, actor(req));
  res.status(201).json({ ok: true, document: doc, questions: await listQuestions(db()) });
}));

router.get("/:id/file", ...staff, safeHandler(async (req: Request, res: Response) => {
  const doc = UUID_RE.test(String(req.params.id)) ? await getDocument(db(), String(req.params.id)) : null;
  if (!doc) return bad(res, "Document not found.", 404, "not_found");
  res.setHeader("Content-Type", doc.format === "pdf_form" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  res.setHeader("Content-Disposition", `attachment; filename="${String(doc.file_name ?? "document").replace(/[^\w.\-]/g, "_")}"`);
  res.end(doc.file);
}));

router.put("/:id/fields", ...admin, safeHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const doc = UUID_RE.test(id) ? await getDocument(db(), id) : null;
  if (!doc) return bad(res, "Document not found.", 404, "not_found");
  const incoming = Array.isArray(req.body?.fields) ? (req.body.fields as Array<{ name?: unknown; mapped_to?: unknown }>) : [];
  const byName = new Map(incoming.map((f) => [String(f.name ?? ""), f.mapped_to]));
  const next: MatchedField[] = doc.fields.map((f) => {
    if (!byName.has(f.name) || f.type === "signature") return f;
    const m = byName.get(f.name);
    const key = typeof m === "string" && DATA_FIELD_KEYS.has(m) ? m : null;
    return { ...f, mapped_to: key, matched_by: "licensee" };
  });
  const saved = await saveFields(db(), id, next);
  res.json({ ok: true, document: saved, questions: await listQuestions(db()) });
}));

router.patch("/:id", ...admin, safeHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id);
  if (!UUID_RE.test(id) || typeof req.body?.active !== "boolean") return bad(res, "Say whether the document is in use.");
  const doc = await setActive(db(), id, req.body.active);
  if (!doc) return bad(res, "Document not found.", 404, "not_found");
  res.json({ ok: true, document: doc });
}));

router.post("/:id/preview", ...staff, safeHandler(async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const applicationId = String(req.body?.applicationId ?? "").trim();
  const doc = UUID_RE.test(id) ? await getDocument(db(), id) : null;
  if (!doc) return bad(res, "Document not found.", 404, "not_found");
  if (!UUID_RE.test(applicationId)) return bad(res, "Choose a file to preview with.");
  // Review fix: a preview shows the file's data, so the caller must be able to see that file.
  const { canSeeApplication } = await import("../brokerTools/platform.js");
  if (!(await canSeeApplication(req, applicationId))) return bad(res, "Application not found.", 404, "not_found");
  const { loadApplicationForPdf } = await import("../signnow/sendApplicationForSignature.js");
  const inputs = await loadApplicationForPdf(applicationId);
  const x = (await db().query(`SELECT metadata->'extra_answers' AS x FROM applications WHERE id::text = $1`, [applicationId])).rows[0]?.x ?? {};
  const pdf = await fillDocument({ name: doc.name, format: doc.format, file: doc.file, fields: doc.fields }, valuesFor({ app: inputs, brokerName: brandName(), extras: x }), [], `${brandName()} - ${doc.name} (preview)`);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="preview.pdf"`);
  res.end(Buffer.from(pdf));
}));

const Q_TYPES = new Set(["text", "yesno", "choice", "date", "number"]);
router.patch("/questions/:qid", ...admin, safeHandler(async (req: Request, res: Response) => {
  const qid = String(req.params.qid);
  if (!UUID_RE.test(qid)) return bad(res, "Question not found.", 404, "not_found");
  const b = req.body ?? {};
  const label = typeof b.label === "string" ? b.label.trim().slice(0, 300) : undefined;
  if (label !== undefined && !label) return bad(res, "Write the question.");
  const type = typeof b.type === "string" && Q_TYPES.has(b.type) ? b.type : undefined;
  const options = Array.isArray(b.options) ? b.options.map((o: unknown) => String(o).trim()).filter(Boolean).slice(0, 30) : undefined;
  const row = await updateQuestion(db(), qid, { label, type, options, required: typeof b.required === "boolean" ? b.required : undefined, active: typeof b.active === "boolean" ? b.active : undefined });
  if (!row) return bad(res, "Question not found.", 404, "not_found");
  res.json({ ok: true, question: row });
}));

router.post("/offers/:offerId/term-sheet", ...staff, safeHandler(async (req: Request, res: Response) => {
  const offerId = String(req.params.offerId);
  if (!UUID_RE.test(offerId)) return bad(res, "Offer not found.", 404, "not_found");
  try {
    const { licenseeTermSheetPdf } = await import("../licenseeDocs/service.js");
    const { pdf, applicationId, name } = await licenseeTermSheetPdf(offerId);
    const { getStorage } = await import("../lib/storage/index.js");
    const put = await getStorage().put({ buffer: Buffer.from(pdf), filename: `${name.replace(/[^\w.\- ]/g, "")}.pdf`, contentType: "application/pdf", pathPrefix: `applications/${applicationId}/term-sheets` });
    await db().query(
      `UPDATE offers SET
          lender_term_sheet_blob_name = COALESCE(lender_term_sheet_blob_name, term_sheet_blob_name),
          term_sheet_blob_name = $2, term_sheet_filename = $3, term_sheet_size_bytes = $4, document_url = $5,
          term_sheet_mode = CASE WHEN term_sheet_mode = 'template' THEN 'template' ELSE 'ours' END, our_term_sheet_at = now(), updated_at = now()
        WHERE id::text = $1`,
      [offerId, put.blobName, `${name}.pdf`, put.sizeBytes, put.url],
    );
    res.json({ ok: true, message: `Your ${name} is now this offer's term sheet. Send it to the client for signature when ready.` });
  } catch (err: any) {
    const status = Number(err?.status) || 500;
    if (status >= 500) console.warn("[licensee-docs] term sheet from template failed", { offerId, message: String(err?.message ?? err) });
    return bad(res, status >= 500 ? "The term sheet could not be made. Try again." : String(err.message), status, status === 404 ? "not_found" : "not_ready");
  }
}));

export default router;
