// BF_SERVER_v865_BROKER_TOOLS - /api/broker-tools: the deal tools staff use on an application, and the Admin set-up behind them.
//   Funding conditions (funding_conditions, every plan)
//     GET    /applications/:id/conditions                       list + outstanding count
//     POST   /applications/:id/conditions                       add      { title, description?, owner, assigned_user_id?, due_date?, requires_document?, document_url?, note? }
//     POST   /applications/:id/conditions/from-templates        add the lender / product templates not yet on the file
//     POST   /applications/:id/conditions/from-offer            one condition per line of the offer's notes
//     PATCH  /applications/:id/conditions/:cid                  edit, or { status: open|received|cleared|waived, waived_reason }
//     DELETE /applications/:id/conditions/:cid
//     POST   /applications/:id/conditions/:cid/document         upload the document that satisfies it (multipart "file")
//     GET    /condition-templates                               Admin and staff
//     POST   /condition-templates | PUT /condition-templates/:id | DELETE /condition-templates/:id    Admin
//     GET    /people                                            staff to assign conditions to
//     GET    /lender-options                                    lenders and lender products for the pickers
//   Sales tax (sales_tax, every plan) - BF_SERVER_v865_BROKER_TOOLS_3_SALES_TAX
//     GET    /sales-tax/rates                                   every row + the rate in force today per province
//     PUT    /sales-tax/rates                                   Admin: add or change { province, effective_from, gst, pst, hst, qst, note }
//     DELETE /sales-tax/rates/:province/:effective_from         Admin
//     POST   /sales-tax/calculate                               { amount, province, date? } -> tax lines and total
//     GET    /applications/:id/sales-tax                        the business's province on the file and its rate today
// Every /applications/:id route checks the caller's silo and record visibility first (404 otherwise).
import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { auth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { getSilo } from "../middleware/silo.js";
import { actorId, audit, db, loadApplication, oneOf, str, UUID_RE } from "../brokerTools/common.js";
import { canSeeApplication, gate } from "../brokerTools/platform.js";
import {
  OWNERS, STATUSES, addCondition, applyTemplates, getCondition, importFromOffer, listConditions, outstanding, parseConditionInput,
  type ConditionInput,
} from "../brokerTools/conditions.js";
import {
  PROVINCES, PROVINCE_NAMES, applicationProvince, combinedRate, currentRates, deleteRate, listRates, normaliseProvince, parseRateInput,
  rateOn, salesTax, saveRate,
} from "../brokerTools/salesTax.js"; // BF_SERVER_v865_BROKER_TOOLS_3_SALES_TAX

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
const staff = [auth, requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] })];
const admin = [auth, requireAuthorization({ roles: [ROLES.ADMIN] })];

/** Loads the application into res.locals.app; 404 when it is missing, in another silo, or not visible to the caller. */
async function appGuardImpl(req: Request, res: Response, next: NextFunction) {
  const id = String(req.params.id ?? "").trim();
  const app = await loadApplication(db(), id);
  const silo = getSilo(res);
  if (!app || (app.silo && silo && app.silo !== silo) || !(await canSeeApplication(req, id))) {
    return void res.status(404).json({ ok: false, error: "not_found", message: "Application not found." });
  }
  res.locals.app = app;
  next();
}
function appGuard(req: Request, res: Response, next: NextFunction): void {
  appGuardImpl(req, res, next).catch(next);
}

// ---------------------------------------------------------------------------------------------- funding conditions
const conditions = [...staff, gate("funding_conditions")];

async function conditionsPayload(applicationId: string) {
  const list = await listConditions(db(), applicationId);
  const open = outstanding(list);
  return { ok: true, conditions: list, outstanding_count: open.length, can_fund: open.length === 0, owners: OWNERS, statuses: STATUSES };
}

router.get("/applications/:id/conditions", ...conditions, appGuard, safeHandler(async (req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(await conditionsPayload(String(req.params.id)));
}));

router.post("/applications/:id/conditions", ...conditions, appGuard, safeHandler(async (req: Request, res: Response) => {
  const p = parseConditionInput((req.body ?? {}) as Record<string, unknown>);
  if (!p.ok) return void res.status(400).json({ ok: false, error: "validation_error", message: p.error });
  const v = p.value;
  const c = await addCondition(db(), String(req.params.id), {
    title: v.title!, description: v.description ?? null, owner: v.owner ?? "staff", assigned_user_id: v.assigned_user_id ?? null,
    due_date: v.due_date ?? null, requires_document: v.requires_document === true, document_url: v.document_url ?? null, note: v.note ?? null,
  }, actorId(req));
  await audit(req, "funding_condition.added", { application_id: req.params.id, title: c.title, owner: c.owner }, { type: "application", id: String(req.params.id) });
  res.status(201).json({ ok: true, condition: c });
}));

router.post("/applications/:id/conditions/from-templates", ...conditions, appGuard, safeHandler(async (req: Request, res: Response) => {
  const app = res.locals.app;
  const added = await applyTemplates(db(), { id: app.id, lender_id: app.lender_id, lender_product_id: app.lender_product_id }, actorId(req));
  if (added) await audit(req, "funding_condition.templates_applied", { application_id: app.id, added }, { type: "application", id: app.id });
  res.json({ ...(await conditionsPayload(app.id)), added });
}));

router.post("/applications/:id/conditions/from-offer", ...conditions, appGuard, safeHandler(async (req: Request, res: Response) => {
  const app = res.locals.app;
  const r = await importFromOffer(db(), app.id, actorId(req));
  if (!r.offer_id) return void res.status(404).json({ ok: false, error: "no_offer", message: "There is no lender offer on this file yet." });
  if (r.added) await audit(req, "funding_condition.offer_imported", { application_id: app.id, offer_id: r.offer_id, added: r.added }, { type: "application", id: app.id });
  res.json({ ...(await conditionsPayload(app.id)), added: r.added });
}));

router.patch("/applications/:id/conditions/:cid", ...conditions, appGuard, safeHandler(async (req: Request, res: Response) => {
  const appId = String(req.params.id);
  const before = await getCondition(db(), appId, String(req.params.cid));
  if (!before) return void res.status(404).json({ ok: false, error: "not_found" });
  const b = (req.body ?? {}) as Record<string, unknown>;
  const p = parseConditionInput(b, true);
  if (!p.ok) return void res.status(400).json({ ok: false, error: "validation_error", message: p.error });
  const sets: string[] = [];
  const params: unknown[] = [appId, before.id];
  const put = (col: string, val: unknown, cast = "") => { params.push(val); sets.push(`${col} = $${params.length}${cast}`); };
  const v = p.value as Partial<ConditionInput>;
  if (v.title !== undefined) put("title", v.title);
  if (v.description !== undefined) put("description", v.description);
  if (v.owner !== undefined) put("owner", v.owner);
  if (v.assigned_user_id !== undefined) put("assigned_user_id", v.assigned_user_id, "::uuid");
  if (v.due_date !== undefined) put("due_date", v.due_date, "::date");
  if (v.requires_document !== undefined) put("requires_document", v.requires_document);
  if (v.document_url !== undefined) put("document_url", v.document_url);
  if (v.note !== undefined) put("note", v.note);
  let status: string | null = null;
  if (b.status !== undefined) {
    status = oneOf(b.status, STATUSES, before.status);
    const reason = str(b.waived_reason, 1000);
    if (status === "waived" && (!reason || reason.length < 3)) {
      return void res.status(400).json({ ok: false, error: "reason_required", message: "Say why this condition is waived." });
    }
    if (status === "cleared" && before.requires_document && !before.document_id && !before.document_url && !v.document_url) {
      return void res.status(400).json({ ok: false, error: "document_required", message: "Attach the document before clearing this condition." });
    }
    put("status", status);
    const actor = actorId(req);
    if (status === "cleared") { put("cleared_at", new Date().toISOString(), "::timestamptz"); put("cleared_by", actor, "::uuid"); }
    if (status === "waived") { put("waived_at", new Date().toISOString(), "::timestamptz"); put("waived_by", actor, "::uuid"); put("waived_reason", reason); }
    if (status === "open" || status === "received") { sets.push("cleared_at = NULL", "cleared_by = NULL", "waived_at = NULL", "waived_by = NULL", "waived_reason = NULL"); }
  }
  if (!sets.length) return void res.json({ ok: true, condition: before });
  await db().query(`UPDATE funding_conditions SET ${sets.join(", ")}, updated_at = now() WHERE application_id = $1 AND id = $2::uuid`, params);
  const after = await getCondition(db(), appId, before.id);
  if (status && status !== before.status) {
    await audit(req, `funding_condition.${status}`, { application_id: appId, condition_id: before.id, title: before.title, from: before.status, reason: after?.waived_reason ?? null }, { type: "application", id: appId });
  } else {
    await audit(req, "funding_condition.updated", { application_id: appId, condition_id: before.id, fields: Object.keys(v) }, { type: "application", id: appId });
  }
  res.json({ ok: true, condition: after });
}));

router.delete("/applications/:id/conditions/:cid", ...conditions, appGuard, safeHandler(async (req: Request, res: Response) => {
  const appId = String(req.params.id);
  const before = await getCondition(db(), appId, String(req.params.cid));
  if (!before) return void res.status(404).json({ ok: false, error: "not_found" });
  await db().query(`DELETE FROM funding_conditions WHERE application_id = $1 AND id = $2::uuid`, [appId, before.id]);
  await audit(req, "funding_condition.removed", { application_id: appId, condition_id: before.id, title: before.title, status: before.status }, { type: "application", id: appId });
  res.json({ ok: true });
}));

router.post("/applications/:id/conditions/:cid/document", ...conditions, appGuard, upload.single("file"), safeHandler(async (req: Request, res: Response) => {
  const appId = String(req.params.id);
  const before = await getCondition(db(), appId, String(req.params.cid));
  if (!before) return void res.status(404).json({ ok: false, error: "not_found" });
  const file = (req as any).file as Express.Multer.File | undefined;
  if (!file) return void res.status(400).json({ ok: false, error: "file_required", message: "Choose a file." });
  const doc = await storeConditionDocument(appId, file, "staff");
  if (!doc.ok) return void res.status(doc.status).json({ ok: false, error: doc.error, message: doc.message });
  await db().query(
    `UPDATE funding_conditions SET document_id = $3, status = CASE WHEN status = 'open' THEN 'received' ELSE status END, updated_at = now()
      WHERE application_id = $1 AND id = $2::uuid`,
    [appId, before.id, doc.id],
  );
  await audit(req, "funding_condition.document", { application_id: appId, condition_id: before.id, document_id: doc.id }, { type: "application", id: appId });
  res.status(201).json({ ok: true, condition: await getCondition(db(), appId, before.id) });
}));

/** Files a condition's document with the application's documents ("other": not read by OCR). */
export async function storeConditionDocument(applicationId: string, file: Express.Multer.File, uploadedBy: string):
  Promise<{ ok: true; id: string } | { ok: false; status: number; error: string; message: string }> {
  const { persistAndEnqueue } = await import("./documents.js");
  const { DuplicateDocumentError } = await import("../services/documents/duplicateDocuments.js");
  try {
    const out = await persistAndEnqueue({ applicationId, category: "other", file, uploadedBy });
    return { ok: true, id: String(out.id) };
  } catch (err) {
    if (err instanceof DuplicateDocumentError) return { ok: false, status: 409, error: "duplicate_document", message: "That file is already on this application." };
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------- condition templates
function parseTemplate(b: Record<string, unknown>): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const title = str(b.title, 300);
  if (!title) return { ok: false, error: "Give the condition a title." };
  const lender = str(b.lender_id, 80);
  const product = str(b.lender_product_id, 80);
  if ((lender && !UUID_RE.test(lender)) || (product && !/^[A-Za-z0-9_-]{1,80}$/.test(product))) return { ok: false, error: "Pick the lender from the list." };
  const days = b.due_days === undefined || b.due_days === null || b.due_days === "" ? null : Math.floor(Number(b.due_days));
  if (days !== null && (!Number.isFinite(days) || days < 0 || days > 365)) return { ok: false, error: "Due in days must be 0 to 365." };
  return { ok: true, value: {
    title, description: str(b.description, 4000), owner: oneOf(b.owner, OWNERS, "staff"), due_days: days,
    requires_document: b.requires_document === true, lender_id: lender, lender_product_id: product, active: b.active !== false,
  } };
}

router.get("/condition-templates", ...conditions, safeHandler(async (_req: Request, res: Response) => {
  const r = await db().query(
    `SELECT t.*, l.name AS lender_name, lp.name AS product_name
       FROM funding_condition_templates t
       LEFT JOIN lenders l ON l.id = t.lender_id
       LEFT JOIN lender_products lp ON lp.id = t.lender_product_id
      ORDER BY t.active DESC, l.name NULLS FIRST, lp.name NULLS FIRST, t.position, t.created_at`,
  );
  res.json({ ok: true, templates: r.rows });
}));

router.post("/condition-templates", ...admin, gate("funding_conditions"), safeHandler(async (req: Request, res: Response) => {
  const p = parseTemplate((req.body ?? {}) as Record<string, unknown>);
  if (!p.ok) return void res.status(400).json({ ok: false, error: "validation_error", message: p.error });
  const v = p.value as any;
  const r = await db().query(
    `INSERT INTO funding_condition_templates (title, description, owner, due_days, requires_document, lender_id, lender_product_id, active, position, created_by)
     VALUES ($1, $2, $3, $4, $5, $6::uuid, $7, $8, (SELECT COALESCE(max(position), 0) + 1 FROM funding_condition_templates), $9::uuid) RETURNING *`,
    [v.title, v.description, v.owner, v.due_days, v.requires_document, v.lender_id, v.lender_product_id, v.active, actorId(req)],
  );
  await audit(req, "funding_condition_template.created", { title: v.title }, { type: "funding_condition_template", id: String(r.rows[0].id) });
  res.status(201).json({ ok: true, template: r.rows[0] });
}));

router.put("/condition-templates/:tid", ...admin, gate("funding_conditions"), safeHandler(async (req: Request, res: Response) => {
  const tid = String(req.params.tid);
  if (!UUID_RE.test(tid)) return void res.status(404).json({ ok: false, error: "not_found" });
  const p = parseTemplate((req.body ?? {}) as Record<string, unknown>);
  if (!p.ok) return void res.status(400).json({ ok: false, error: "validation_error", message: p.error });
  const v = p.value as any;
  const r = await db().query(
    `UPDATE funding_condition_templates SET title = $2, description = $3, owner = $4, due_days = $5, requires_document = $6,
        lender_id = $7::uuid, lender_product_id = $8, active = $9, updated_at = now() WHERE id = $1::uuid RETURNING *`,
    [tid, v.title, v.description, v.owner, v.due_days, v.requires_document, v.lender_id, v.lender_product_id, v.active],
  );
  if (!r.rows[0]) return void res.status(404).json({ ok: false, error: "not_found" });
  await audit(req, "funding_condition_template.updated", { title: v.title }, { type: "funding_condition_template", id: tid });
  res.json({ ok: true, template: r.rows[0] });
}));

router.delete("/condition-templates/:tid", ...admin, gate("funding_conditions"), safeHandler(async (req: Request, res: Response) => {
  const tid = String(req.params.tid);
  if (!UUID_RE.test(tid)) return void res.status(404).json({ ok: false, error: "not_found" });
  const r = await db().query(`DELETE FROM funding_condition_templates WHERE id = $1::uuid RETURNING title`, [tid]);
  if (!r.rows[0]) return void res.status(404).json({ ok: false, error: "not_found" });
  await audit(req, "funding_condition_template.deleted", { title: r.rows[0].title }, { type: "funding_condition_template", id: tid });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------------------------- sales tax
// BF_SERVER_v865_BROKER_TOOLS_3_SALES_TAX
const taxStaff = [...staff, gate("sales_tax")];

router.get("/sales-tax/rates", ...taxStaff, safeHandler(async (_req: Request, res: Response) => {
  const rows = await listRates(db());
  const current = currentRates(rows).map((r) => ({ ...r, name: PROVINCE_NAMES[r.province], combined: combinedRate(r) }));
  res.json({ ok: true, rates: rows, current, provinces: PROVINCES.map((code) => ({ code, name: PROVINCE_NAMES[code] })) });
}));

router.put("/sales-tax/rates", ...admin, gate("sales_tax"), safeHandler(async (req: Request, res: Response) => {
  const p = parseRateInput((req.body ?? {}) as Record<string, unknown>);
  if (!p.ok) return void res.status(400).json({ ok: false, error: "invalid", message: p.error });
  await saveRate(db(), p.rate, actorId(req));
  await audit(req, "sales_tax.rate_saved", { ...p.rate }, { type: "sales_tax_rate", id: `${p.rate.province}:${p.rate.effective_from}` });
  res.json({ ok: true, rate: p.rate });
}));

router.delete("/sales-tax/rates/:province/:day", ...admin, gate("sales_tax"), safeHandler(async (req: Request, res: Response) => {
  const province = normaliseProvince(req.params.province);
  const day = String(req.params.day ?? "");
  if (!province || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return void res.status(400).json({ ok: false, error: "invalid" });
  const removed = await deleteRate(db(), province, day);
  if (!removed) return void res.status(404).json({ ok: false, error: "not_found" });
  await audit(req, "sales_tax.rate_deleted", { province, effective_from: day }, { type: "sales_tax_rate", id: `${province}:${day}` });
  res.json({ ok: true });
}));

router.post("/sales-tax/calculate", ...taxStaff, safeHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const province = normaliseProvince(b.province);
  const amount = Number(b.amount);
  if (!province) return void res.status(400).json({ ok: false, error: "invalid", message: "Pick a province or territory." });
  if (!(amount >= 0) || amount > 1e11) return void res.status(400).json({ ok: false, error: "invalid", message: "Enter an amount." });
  const rate = await rateOn(db(), province, typeof b.date === "string" ? b.date : undefined);
  const t = salesTax(amount, rate);
  res.json({ ok: true, province, rate, combined: combinedRate(rate), lines: t.lines, total_tax: t.total, total_with_tax: Math.round((amount + t.total) * 100) / 100 });
}));

router.get("/applications/:id/sales-tax", ...taxStaff, appGuard, safeHandler(async (req: Request, res: Response) => {
  const province = await applicationProvince(db(), String(req.params.id));
  const rate = province ? await rateOn(db(), province) : null;
  res.json({ ok: true, province, rate, combined: rate ? combinedRate(rate) : null });
}));

router.get("/lender-options", ...staff, safeHandler(async (_req: Request, res: Response) => {
  const lenders = await db().query(`SELECT id::text AS id, name FROM lenders WHERE COALESCE(active, true) = true ORDER BY lower(name) LIMIT 1000`);
  const products = await db().query(
    `SELECT id::text AS id, name, lender_id::text AS lender_id, category FROM lender_products WHERE COALESCE(active, true) = true ORDER BY lower(name) LIMIT 5000`,
  );
  res.json({ ok: true, lenders: lenders.rows, products: products.rows });
}));

router.get("/people", ...staff, safeHandler(async (_req: Request, res: Response) => {
  const r = await db().query(
    `SELECT id::text AS id, NULLIF(trim(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')), '') AS name, email, role
       FROM users WHERE role IN ('Admin','Staff','Ops') AND COALESCE(active, true) = true ORDER BY first_name NULLS LAST, last_name NULLS LAST LIMIT 500`,
  );
  res.json({ ok: true, people: r.rows });
}));

export default router;
