// BF_SERVER_v867_BROKER_TOOLS_CONTRACTS - /api/deal-desk: contracts from Word templates (contract_templates, Growth and Pro).
//   GET    /merge-fields                                   the fields a template may use
//   GET    /contract-templates                             templates (staff)
//   POST   /contract-templates                             Admin: multipart "file" (.docx) + name, description
//   GET    /contract-templates/:tid/file                   download the template
//   PATCH  /contract-templates/:tid                        Admin: { name, description, active }
//   GET    /applications/:id/contracts                     contracts on the deal, and the merge values it would use
//   POST   /applications/:id/contracts                     { template_id, values: { field: text }, signers: [{ name, email }] } -> .docx + PDF
//   GET    /applications/:id/contracts/:cid/:kind          download docx | pdf | signed
//   POST   /applications/:id/contracts/:cid/send           { signers? } -> SignNow (one invite, every signer)
//   POST   /applications/:id/contracts/:cid/refresh        check SignNow; files the signed PDF when complete
//   POST   /applications/:id/contracts/:cid/cancel
import { Router, type Request, type Response } from "express";
import { safeHandler } from "../../middleware/safeHandler.js";
import { actorId, audit, db, str, UUID_RE } from "../../brokerTools/common.js";
import { gate } from "../../brokerTools/platform.js";
import { admin, appGuard, bad, staff, upload } from "../../brokerTools/http.js";
import { DocxError } from "../../brokerTools/docx.js";
import {
  ContractSendError, MERGE_FIELDS, addTemplate, checkTemplate, defaultSignNow, generateContract, getContract, listContracts, listTemplates, mergeValues, parseSigners,
  refreshContract, sendContract,
} from "../../brokerTools/contracts.js";

const router = Router();
const ct = [...staff, gate("contract_templates")];
const ctAdmin = [...admin, gate("contract_templates")];
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

router.get("/merge-fields", ...ct, (_req: Request, res: Response) => { res.json({ ok: true, fields: MERGE_FIELDS }); });

router.get("/contract-templates", ...ct, safeHandler(async (_req: Request, res: Response) => {
  res.json({ ok: true, templates: await listTemplates(db()) });
}));

router.post("/contract-templates", ...ctAdmin, upload.single("file"), safeHandler(async (req: Request, res: Response) => {
  if (!req.file) return bad(res, "Upload the Word (.docx) template.");
  const name = str((req.body ?? {}).name, 200) ?? req.file.originalname.replace(/\.docx$/i, "");
  const check = checkTemplate(req.file.buffer);
  if (!check.ok) return bad(res, check.error);
  const t = await addTemplate(db(), { name, description: str((req.body ?? {}).description, 1000), file_name: req.file.originalname, docx: req.file.buffer, fields: check.fields }, actorId(req));
  await audit(req, "contract_template.added", { name, fields: check.fields.length, unknown: check.unknown }, { type: "contract_template", id: t.id });
  res.status(201).json({ ok: true, template: t });
}));

router.get("/contract-templates/:tid/file", ...ct, safeHandler(async (req: Request, res: Response) => {
  const tid = String(req.params.tid);
  const r = UUID_RE.test(tid) ? await db().query(`SELECT name, file_name, docx FROM contract_templates WHERE id = $1::uuid`, [tid]) : { rows: [] as any[] };
  if (!r.rows[0]) return bad(res, "Template not found.", 404, "not_found");
  res.setHeader("Content-Type", DOCX);
  res.setHeader("Content-Disposition", `attachment; filename="${String(r.rows[0].file_name ?? `${r.rows[0].name}.docx`).replace(/[^A-Za-z0-9 ._()-]+/g, "")}"`);
  res.send(r.rows[0].docx);
}));

router.patch("/contract-templates/:tid", ...ctAdmin, safeHandler(async (req: Request, res: Response) => {
  const tid = String(req.params.tid);
  if (!UUID_RE.test(tid)) return bad(res, "Template not found.", 404, "not_found");
  const b = (req.body ?? {}) as Record<string, unknown>;
  const r = await db().query(
    `UPDATE contract_templates SET name = COALESCE($2, name), description = CASE WHEN $3::boolean THEN $4 ELSE description END,
       active = COALESCE($5, active), updated_at = now() WHERE id = $1::uuid RETURNING id`,
    [tid, str(b.name, 200), b.description !== undefined, str(b.description, 1000), typeof b.active === "boolean" ? b.active : null],
  );
  if (!r.rows[0]) return bad(res, "Template not found.", 404, "not_found");
  await audit(req, "contract_template.updated", { name: b.name, active: b.active }, { type: "contract_template", id: tid });
  res.json({ ok: true, templates: await listTemplates(db()) });
}));

router.get("/applications/:id/contracts", ...ct, appGuard, safeHandler(async (req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true, contracts: await listContracts(db(), String(req.params.id)), values: await mergeValues(db(), res.locals.app) });
}));

router.post("/applications/:id/contracts", ...ct, appGuard, safeHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, any>;
  const tid = str(b.template_id, 80);
  if (!tid || !UUID_RE.test(tid)) return bad(res, "Pick a template.");
  const signers = b.signers === undefined || (Array.isArray(b.signers) && b.signers.length === 0) ? [] : parseSigners(b.signers);
  if (typeof signers === "string") return bad(res, signers);
  try {
    const c = await generateContract(db(), res.locals.app, tid, b.values && typeof b.values === "object" ? b.values : {}, signers, actorId(req));
    await audit(req, "contract.generated", { application_id: req.params.id, contract_id: c.id, template_id: tid, missing: c.missing }, { type: "application", id: String(req.params.id) });
    res.status(201).json({ ok: true, contract: c });
  } catch (err) {
    if (err instanceof DocxError) return bad(res, err.message);
    throw err;
  }
}));

router.get("/applications/:id/contracts/:cid/:kind", ...ct, appGuard, safeHandler(async (req: Request, res: Response) => {
  const cid = String(req.params.cid), kind = String(req.params.kind);
  if (!UUID_RE.test(cid) || !["docx", "pdf", "signed"].includes(kind)) return bad(res, "Not found.", 404, "not_found");
  const c = await getContract(db(), String(req.params.id), cid);
  const bytes = c ? (kind === "docx" ? c.docx : kind === "pdf" ? c.pdf : c.signed_pdf) : null;
  if (!c || !bytes) return bad(res, "Not found.", 404, "not_found");
  res.setHeader("Content-Type", kind === "docx" ? DOCX : "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${c.name.replace(/[^A-Za-z0-9 ._()-]+/g, "")}${kind === "signed" ? " - signed" : ""}.${kind === "docx" ? "docx" : "pdf"}"`);
  res.send(bytes);
}));

router.post("/applications/:id/contracts/:cid/send", ...ct, appGuard, safeHandler(async (req: Request, res: Response) => {
  const cid = String(req.params.cid), appId = String(req.params.id);
  if (!UUID_RE.test(cid)) return bad(res, "Contract not found.", 404, "not_found");
  const b = (req.body ?? {}) as Record<string, unknown>;
  const signers = b.signers === undefined ? null : parseSigners(b.signers);
  if (typeof signers === "string") return bad(res, signers);
  try {
    const c = await sendContract(db(), appId, cid, signers, await defaultSignNow());
    await audit(req, "contract.sent", { application_id: appId, contract_id: cid, signers: c.signers.map((x) => x.email) }, { type: "application", id: appId });
    res.json({ ok: true, contract: c });
  } catch (err) {
    if (err instanceof ContractSendError) return bad(res, err.message, 409, "cannot_send");
    const message = err instanceof Error ? err.message : String(err);
    console.error("[broker-tools] contract send failed", { contractId: cid, message });
    await db().query(`UPDATE contract_documents SET error = $2, updated_at = now() WHERE id = $1::uuid`, [cid, message.slice(0, 500)]);
    return bad(res, "SignNow did not take the contract. Try again, or check the e-signing set-up.", 502, "signnow_failed");
  }
}));

router.post("/applications/:id/contracts/:cid/refresh", ...ct, appGuard, safeHandler(async (req: Request, res: Response) => {
  const cid = String(req.params.cid);
  if (!UUID_RE.test(cid)) return bad(res, "Contract not found.", 404, "not_found");
  try {
    res.json({ ok: true, contract: await refreshContract(db(), String(req.params.id), cid, await defaultSignNow()) });
  } catch (err) {
    if (err instanceof ContractSendError) return bad(res, err.message, 404, "not_found");
    throw err;
  }
}));

router.post("/applications/:id/contracts/:cid/cancel", ...ct, appGuard, safeHandler(async (req: Request, res: Response) => {
  const cid = String(req.params.cid), appId = String(req.params.id);
  if (!UUID_RE.test(cid)) return bad(res, "Contract not found.", 404, "not_found");
  const r = await db().query(`UPDATE contract_documents SET status = 'cancelled', updated_at = now() WHERE application_id = $1 AND id = $2::uuid AND status IN ('generated','sent') RETURNING id`, [appId, cid]);
  if (!r.rows[0]) return bad(res, "Only a contract not yet signed can be cancelled.", 409, "cannot_cancel");
  await audit(req, "contract.cancelled", { application_id: appId, contract_id: cid }, { type: "application", id: appId });
  res.json({ ok: true });
}));

export default router;
