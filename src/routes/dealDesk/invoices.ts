// BF_SERVER_v867_BROKER_TOOLS_INVOICES - /api/deal-desk: vendor invoice reading (invoice_reading, every plan).
//   GET    /applications/:id/invoice-documents          the file's documents to read from (invoices first)
//   GET    /applications/:id/invoices                   drafts and confirmed invoices
//   POST   /applications/:id/invoices/read              { document_id } or multipart "file" -> a new draft
//   PATCH  /applications/:id/invoices/:iid              save staff corrections to a draft
//   POST   /applications/:id/invoices/:iid/confirm      fill the deal's equipment fields (and contract assets)
//   DELETE /applications/:id/invoices/:iid              discard
import { Router, type Request, type Response } from "express";
import { safeHandler } from "../../middleware/safeHandler.js";
import { actorId, audit, db, str, UUID_RE } from "../../brokerTools/common.js";
import { gate } from "../../brokerTools/platform.js";
import { appGuard, bad, staff, upload } from "../../brokerTools/http.js";
import {
  InvoiceConfirmError, InvoiceReadError, confirmInvoice, getInvoice, listInvoices, loadDocumentFile, readInvoice, saveDraft,
} from "../../brokerTools/invoices.js";
import { storeConditionDocument } from "../brokerTools.js";

const router = Router();
const inv = [...staff, gate("invoice_reading")];
const INVOICE_HINT = /invoice|bill.?of.?sale|purchase.?order|equipment|quote/i;

router.get("/applications/:id/invoice-documents", ...inv, appGuard, safeHandler(async (req: Request, res: Response) => {
  const r = await db().query(
    `SELECT id::text AS id, filename, category, created_at FROM documents WHERE application_id::text = $1 ORDER BY created_at DESC LIMIT 300`,
    [String(req.params.id)],
  );
  const docs = r.rows.map((d: any) => ({ ...d, likely_invoice: INVOICE_HINT.test(`${d.category ?? ""} ${d.filename ?? ""}`) }));
  docs.sort((a: any, b: any) => Number(b.likely_invoice) - Number(a.likely_invoice));
  res.json({ ok: true, documents: docs });
}));

router.get("/applications/:id/invoices", ...inv, appGuard, safeHandler(async (req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true, invoices: await listInvoices(db(), String(req.params.id)) });
}));

router.post("/applications/:id/invoices/read", ...inv, appGuard, upload.single("file"), safeHandler(async (req: Request, res: Response) => {
  const appId = String(req.params.id);
  let input: { text?: string | null; buffer?: Buffer | null; mimeType?: string | null; fileName?: string | null; documentId?: string | null };
  if (req.file) {
    const doc = await storeConditionDocument(appId, req.file, "staff");
    const documentId = doc.ok ? doc.id : null; // a duplicate file is still read; it is just not filed twice
    input = { buffer: req.file.buffer, mimeType: req.file.mimetype, fileName: req.file.originalname, documentId };
  } else {
    const documentId = str((req.body ?? {}).document_id, 80);
    if (!documentId) return bad(res, "Pick the invoice from the file's documents, or upload it.");
    const file = await loadDocumentFile(db(), appId, documentId);
    if (!file) return bad(res, "That document is not on this file.", 404, "not_found");
    input = { ...file, documentId };
  }
  try {
    const out = await readInvoice(db(), appId, input, actorId(req));
    await audit(req, "vendor_invoice.read", { application_id: appId, invoice_id: out.id, document_id: input.documentId ?? null, error: out.read_error }, { type: "application", id: appId });
    res.status(201).json({ ok: true, invoice: out });
  } catch (err) {
    if (err instanceof InvoiceReadError) return bad(res, err.message, 503, err.code);
    throw err;
  }
}));

router.patch("/applications/:id/invoices/:iid", ...inv, appGuard, safeHandler(async (req: Request, res: Response) => {
  const iid = String(req.params.iid);
  if (!UUID_RE.test(iid)) return bad(res, "Invoice not found.", 404, "not_found");
  const out = await saveDraft(db(), String(req.params.id), iid, req.body ?? {});
  if (!out) return bad(res, "Only a draft can be changed.", 409, "not_draft");
  res.json({ ok: true, invoice: out });
}));

router.post("/applications/:id/invoices/:iid/confirm", ...inv, appGuard, safeHandler(async (req: Request, res: Response) => {
  const iid = String(req.params.iid), appId = String(req.params.id);
  if (!UUID_RE.test(iid)) return bad(res, "Invoice not found.", 404, "not_found");
  try {
    const out = await confirmInvoice(db(), appId, iid, actorId(req));
    await audit(req, "vendor_invoice.confirmed", { application_id: appId, invoice_id: iid, total: out.data.total, contract_id: out.assets_contract_id }, { type: "application", id: appId });
    res.json({ ok: true, invoice: out });
  } catch (err) {
    if (err instanceof InvoiceConfirmError) return bad(res, err.message, 409, "cannot_confirm");
    throw err;
  }
}));

router.delete("/applications/:id/invoices/:iid", ...inv, appGuard, safeHandler(async (req: Request, res: Response) => {
  const iid = String(req.params.iid), appId = String(req.params.id);
  if (!UUID_RE.test(iid) || !(await getInvoice(db(), appId, iid))) return bad(res, "Invoice not found.", 404, "not_found");
  await db().query(`UPDATE vendor_invoices SET status = 'discarded', updated_at = now() WHERE application_id = $1 AND id = $2::uuid AND status = 'draft'`, [appId, iid]);
  await audit(req, "vendor_invoice.discarded", { application_id: appId, invoice_id: iid }, { type: "application", id: appId });
  res.json({ ok: true });
}));

export default router;
