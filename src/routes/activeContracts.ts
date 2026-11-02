// BF_SERVER_v864_ACTIVE_CONTRACTS - /api/active-contracts (no /v1). Staff = Admin + Staff; settings, the portfolio
// report and variance review are Admin only. Every contract is read through the caller's silo (X-Silo / ?silo=).
// The client view (/client/...) answers 404 unless ACTIVE_CONTRACTS_CLIENT_ENABLED=on AND an Admin turned the client
// portal on in the settings; it returns only client-safe fields (extras.ts clientSafe).
import { Router } from "express";
import multer from "multer";
import { auth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { resolveSiloFromRequest } from "../middleware/silo.js";
import { pool } from "../db.js";
import { contractView, expectedFor, getContractRow, ledgerFor, listContracts, createContractFromApplication, type Q } from "../activeContracts/repo.js";
import { revenueSummary } from "../activeContracts/model.js";
import { addBalance, addExpected, addLedgerEntry, correctLedgerEntry, InputError, listLedger, recordLenderReportedBalance, reviewVariance, updateCompensation } from "../activeContracts/money.js";
import { changeStatus, listOpportunities, openOpportunity, patchToSql, startRenewal, updateOpportunity } from "../activeContracts/renewal.js";
import { lastContactFor, portfolioReport, QUEUES, queueCounts, runQueue, summarize, type QueueKey } from "../activeContracts/reports.js";
import { addAsset, addDocument, addInsurance, CLIENT_REQUESTS, clientSafe, getProductRule, getSettings, listAssets, listDocuments, listInsurance, removeAsset, saveProductRule, saveSettings } from "../activeContracts/extras.js";
import { confirmReview, defaultStatementDeps, listReviews, rejectReview, reviewUploadedStatement } from "../activeContracts/statements.js";
import { contractActivity, writeContractEvent } from "../activeContracts/timeline.js";

const router = Router();
const staff = [auth, requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] })];
const adminOnly = [auth, requireAuthorization({ roles: [ROLES.ADMIN] })];
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
const db = pool as unknown as Q;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const actorOf = (req: any): string | null => {
  const id = req.user?.userId ?? req.user?.id ?? null;
  return id && ID.test(String(id)) ? String(id) : null;
};

function fail(res: any, err: unknown) {
  if (err instanceof InputError) {
    const status = err.code === "not_found" ? 404 : 400;
    return res.status(status).json({ ok: false, error: err.code, field: err.field ?? null });
  }
  throw err;
}

/** Loads the contract in the caller's silo, or answers 404. */
async function contractOr404(req: any, res: any): Promise<any | null> {
  const id = String(req.params.id ?? "");
  if (!ID.test(id)) { res.status(404).json({ ok: false, error: "not_found" }); return null; }
  const row = await getContractRow(db, id, resolveSiloFromRequest(req));
  if (!row) { res.status(404).json({ ok: false, error: "not_found" }); return null; }
  return row;
}

// ---- Client view (section 11, behind a flag) ----
async function clientEnabled(silo = "BF"): Promise<boolean> {
  if (String(process.env.ACTIVE_CONTRACTS_CLIENT_ENABLED ?? "").toLowerCase() !== "on") return false;
  return (await getSettings(db, silo)).client_portal === true;
}
async function clientContracts(req: any): Promise<any[] | null> {
  const { principalFromRequest } = await import("../auth/principal.js");
  const p = principalFromRequest(req);
  if (!p || p.kind !== "client") return null;
  const phone10 = String(p.phone ?? "").replace(/\D/g, "").slice(-10);
  if (phone10.length !== 10) return null;
  const ids = await db.query(
    `SELECT c.id::text AS id FROM active_contracts c
      WHERE c.silo = 'BF' AND (c.contact_id IN (SELECT id FROM contacts WHERE right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10) = $1)
         OR c.company_id IN (SELECT company_id FROM contacts WHERE company_id IS NOT NULL AND right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10) = $1))`, [phone10]);
  const out = [];
  for (const r of ids.rows) { const row = await getContractRow(db, r.id, "BF"); if (row) out.push(contractView(row)); }
  return out;
}
router.get("/client/mine", safeHandler(async (req: any, res: any) => {
  if (!(await clientEnabled())) return res.status(404).json({ ok: false, error: "not_found" });
  const list = await clientContracts(req);
  if (!list) return res.status(401).json({ ok: false, error: "unauthorized" });
  res.setHeader("Cache-Control", "no-store");
  return res.json({ ok: true, contracts: list.filter((v) => !v.is_history).map(clientSafe) });
}));
router.post("/client/:id/request", safeHandler(async (req: any, res: any) => {
  if (!(await clientEnabled())) return res.status(404).json({ ok: false, error: "not_found" });
  const list = await clientContracts(req);
  if (!list) return res.status(401).json({ ok: false, error: "unauthorized" });
  const v = list.find((x) => x.id === String(req.params.id));
  const action = String(req.body?.action ?? "") as keyof typeof CLIENT_REQUESTS;
  if (!v) return res.status(404).json({ ok: false, error: "not_found" });
  if (!CLIENT_REQUESTS[action]) return res.status(400).json({ ok: false, error: "invalid_action" });
  await writeContractEvent(db, v.id, { title: CLIENT_REQUESTS[action], detail: typeof req.body?.message === "string" ? req.body.message.slice(0, 1000) : null, channel: "client_portal" });
  if (action !== "contact_boreal") {
    try {
      await openOpportunity(db, v.id, { kind: action === "request_refinancing" ? "refinance" : "additional", reason: CLIENT_REQUESTS[action] });
    } catch (err) {
      console.warn("[active-contracts] client request: opportunity not opened", { contractId: v.id, message: (err as Error)?.message });
    }
  }
  return res.json({ ok: true });
}));

// ---- Portfolio ----
router.get("/", ...staff, safeHandler(async (req: any, res: any) => {
  const silo = resolveSiloFromRequest(req);
  const companyId = typeof req.query.company_id === "string" && ID.test(req.query.company_id) ? req.query.company_id : null;
  const contactId = typeof req.query.contact_id === "string" && ID.test(req.query.contact_id) ? req.query.contact_id : null;
  const now = new Date();
  const views = (await listContracts(db, { silo, companyId, contactId })).map((r) => contractView(r, now));
  const ids = views.map((v) => v.id);
  const [ledger, expected] = [await ledgerFor(db, ids), await expectedFor(db, ids)];
  let last: Date | null = null;
  const companyIds = [...new Set(views.map((v) => v.company_id).filter(Boolean))] as string[];
  if ((companyId || contactId) && companyIds.length) for (const d of (await lastContactFor(db, companyIds)).values()) if (!last || d > last) last = d;
  res.setHeader("Cache-Control", "no-store");
  return res.json({ ok: true, contracts: views, summary: summarize(views, ledger, expected, now, last) });
}));
router.post("/", ...staff, safeHandler(async (req: any, res: any) => {
  const b = req.body ?? {};
  const silo = resolveSiloFromRequest(req);
  try {
    if (typeof b.application_id === "string" && b.application_id) {
      const r = await createContractFromApplication(db, b.application_id, actorOf(req));
      if (!r.contractId) return res.status(400).json({ ok: false, error: "application_not_funded" });
      return res.status(r.created ? 201 : 200).json({ ok: true, id: r.contractId, created: r.created });
    }
    if (!ID.test(String(b.company_id ?? ""))) return res.status(400).json({ ok: false, error: "company_required", field: "company_id" });
    const ins = await db.query(`INSERT INTO active_contracts (silo, company_id, contact_id, source, created_by, owner_user_id) VALUES ($1, $2::uuid, $3::uuid, 'manual', $4::uuid, $4::uuid) RETURNING id::text AS id`,
      [silo, b.company_id, ID.test(String(b.contact_id ?? "")) ? b.contact_id : null, actorOf(req)]);
    const id = ins.rows[0].id;
    const { sets, params } = patchToSql({ ...b, company_id: undefined, contact_id: undefined });
    if (sets.length) await db.query(`UPDATE active_contracts SET ${sets.join(", ")}, updated_at = now() WHERE id = $1::uuid`, [id, ...params]);
    if (b.original_amount) await db.query(`INSERT INTO active_contract_ledger (contract_id, entry_type, amount, is_revenue, effective_on, notes, created_by) VALUES ($1::uuid, 'funding', $2, false, COALESCE($3::date, CURRENT_DATE), 'Entered by staff', $4::uuid)`,
      [id, Number(b.original_amount) || 0, b.funded_at || null, actorOf(req)]);
    await writeContractEvent(db, id, { title: "Contract added", detail: "Entered by staff", actor: actorOf(req) });
    return res.status(201).json({ ok: true, id, created: true });
  } catch (err) { return fail(res, err); }
}));

router.get("/queues", ...staff, safeHandler(async (req: any, res: any) => {
  res.setHeader("Cache-Control", "no-store");
  return res.json({ ok: true, titles: QUEUES, counts: await queueCounts(db, resolveSiloFromRequest(req), new Date()) });
}));
router.get("/queues/:key", ...staff, safeHandler(async (req: any, res: any) => {
  const key = String(req.params.key) as QueueKey;
  if (!(key in QUEUES)) return res.status(404).json({ ok: false, error: "not_found" });
  const silo = resolveSiloFromRequest(req);
  const months = Number(req.query.months) || (await getSettings(db, silo)).no_contact_months;
  res.setHeader("Cache-Control", "no-store");
  return res.json({ ok: true, key, title: QUEUES[key], contracts: await runQueue(db, silo, key, new Date(), { months }) });
}));
router.get("/reports/portfolio", ...adminOnly, safeHandler(async (req: any, res: any) => {
  res.setHeader("Cache-Control", "no-store");
  return res.json({ ok: true, report: await portfolioReport(db, resolveSiloFromRequest(req), new Date()) });
}));
router.get("/settings", ...staff, safeHandler(async (req: any, res: any) => res.json({ ok: true, settings: await getSettings(db, resolveSiloFromRequest(req)) })));
router.put("/settings", ...adminOnly, safeHandler(async (req: any, res: any) => res.json({ ok: true, settings: await saveSettings(db, resolveSiloFromRequest(req), req.body ?? {}, actorOf(req)) })));
router.get("/renewal-rules/:productId", ...staff, safeHandler(async (req: any, res: any) => res.json({ ok: true, rule: await getProductRule(db, String(req.params.productId).slice(0, 80)) })));
router.put("/renewal-rules/:productId", ...staff, safeHandler(async (req: any, res: any) => {
  try { return res.json({ ok: true, rule: await saveProductRule(db, String(req.params.productId).slice(0, 80), req.body ?? {}, actorOf(req)) }); } catch (err) { return fail(res, err); }
}));
router.get("/reviews", ...staff, safeHandler(async (req: any, res: any) => res.json({ ok: true, reviews: await listReviews(db, resolveSiloFromRequest(req)) })));
router.post("/reviews/:reviewId/confirm", ...staff, safeHandler(async (req: any, res: any) => {
  if (!ID.test(String(req.params.reviewId))) return res.status(404).json({ ok: false, error: "not_found" });
  if (req.body?.contract_id && !(await getContractRow(db, String(req.body.contract_id), resolveSiloFromRequest(req)))) return res.status(400).json({ ok: false, error: "invalid_contract", field: "contract_id" });
  try { return res.json({ ok: true, ...(await confirmReview(db, String(req.params.reviewId), req.body ?? {}, actorOf(req))) }); } catch (err) { return fail(res, err); }
}));
router.post("/reviews/:reviewId/reject", ...staff, safeHandler(async (req: any, res: any) => {
  if (!ID.test(String(req.params.reviewId))) return res.status(404).json({ ok: false, error: "not_found" });
  return (await rejectReview(db, String(req.params.reviewId), actorOf(req))) ? res.json({ ok: true }) : res.status(404).json({ ok: false, error: "not_found" });
}));

// ---- One contract ----
router.get("/:id", ...staff, safeHandler(async (req: any, res: any) => {
  const row = await contractOr404(req, res);
  if (!row) return;
  const now = new Date();
  const view = contractView(row, now);
  const [ledger, expected] = [await listLedger(db, row.id), await expectedFor(db, [row.id])];
  const chain = (await db.query(`SELECT id::text AS id, status, lender_name, product_name, funded_at, original_amount FROM active_contracts
                                  WHERE id::text = $1 OR previous_contract_id::text = $2 ORDER BY funded_at`, [row.previous_contract_id ?? "", row.id])).rows;
  res.setHeader("Cache-Control", "no-store");
  return res.json({
    ok: true, contract: view, ledger, revenue: revenueSummary(ledger, expected, now), opportunities: await listOpportunities(db, row.id),
    activity: await contractActivity(db, row.id), assets: await listAssets(db, row.id), insurance: await listInsurance(db, row.id),
    documents: await listDocuments(db, row.id), reviews: await listReviews(db, row.silo, row.id), chain,
    balances: (await db.query(`SELECT id::text AS id, balance, as_of, source, payments_made, arrears, note, created_at FROM active_contract_balances WHERE contract_id = $1::uuid ORDER BY as_of DESC, created_at DESC LIMIT 50`, [row.id])).rows,
  });
}));
router.patch("/:id", ...staff, safeHandler(async (req: any, res: any) => {
  const row = await contractOr404(req, res);
  if (!row) return;
  try {
    const { sets, params } = patchToSql(req.body ?? {});
    if (!sets.length) return res.status(400).json({ ok: false, error: "nothing_to_change" });
    await db.query(`UPDATE active_contracts SET ${sets.join(", ")}, updated_at = now() WHERE id = $1::uuid`, [row.id, ...params]);
    await writeContractEvent(db, row.id, { title: "Contract details updated", detail: Object.keys(req.body ?? {}).join(", ").slice(0, 300), actor: actorOf(req) });
    return res.json({ ok: true });
  } catch (err) { return fail(res, err); }
}));
const act = (fn: (req: any, row: any) => Promise<unknown>, status = 200) => safeHandler(async (req: any, res: any) => {
  const row = await contractOr404(req, res);
  if (!row) return;
  try { const out = await fn(req, row); return res.status(status).json({ ok: true, ...(out && typeof out === "object" ? out : {}) }); } catch (err) { return fail(res, err); }
});
router.post("/:id/status", ...staff, act((req, row) => changeStatus(db, row.id, String(req.body?.status ?? ""), typeof req.body?.note === "string" ? req.body.note : null, actorOf(req), req.body?.payoff_amount == null ? null : Number(req.body.payoff_amount))));
router.post("/:id/opportunities", ...staff, act((req, row) => openOpportunity(db, row.id, { kind: req.body?.kind, reason: req.body?.reason, actor: actorOf(req) }), 201));
router.patch("/:id/opportunities/:oppId", ...staff, act((req, row) => updateOpportunity(db, row.id, String(req.params.oppId), String(req.body?.status ?? ""), typeof req.body?.note === "string" ? req.body.note : null, actorOf(req))));
router.post("/:id/renewal/start", ...staff, act((req, row) => startRenewal(db, row.id, { kind: req.body?.kind, actor: actorOf(req) }), 201));
router.put("/:id/compensation", ...staff, act((req, row) => updateCompensation(db, row.id, req.body ?? {}, actorOf(req))));
router.post("/:id/expected", ...staff, act(async (req, row) => ({ added: await addExpected(db, row.id, req.body ?? {}, actorOf(req)) }), 201));
router.post("/:id/expected/:eid/review", ...adminOnly, act(async (req, row) => {
  if (!(await reviewVariance(db, row.id, String(req.params.eid), actorOf(req), req.body?.waive === true))) throw new InputError("not_found");
}));
router.post("/:id/ledger", ...staff, act((req, row) => addLedgerEntry(db, row.id, req.body ?? {}, actorOf(req)), 201));
router.post("/:id/ledger/:entryId/correct", ...staff, act((req, row) => correctLedgerEntry(db, row.id, String(req.params.entryId), String(req.body?.reason ?? ""), actorOf(req)), 201));
router.post("/:id/balances", ...staff, act((req, row) => addBalance(db, row.id, { ...(req.body ?? {}), source: req.body?.source === "lender_statement" ? "lender_statement" : "manual" }, actorOf(req)), 201));
// Hook for lender broker-portal connectors (staff or service token): POST { balance, as_of, payments_made?, arrears? }.
router.post("/:id/reported-balance", ...staff, act((req, row) => recordLenderReportedBalance(db, row.id, Number(req.body?.balance), String(req.body?.as_of ?? ""), "lender_portal",
  { payments_made: req.body?.payments_made ?? null, arrears: req.body?.arrears ?? null, note: typeof req.body?.note === "string" ? req.body.note : null }), 201));
router.post("/:id/assets", ...staff, act((req, row) => addAsset(db, row.id, req.body ?? {}, actorOf(req)), 201));
router.delete("/:id/assets/:assetId", ...staff, act(async (req, row) => { if (!(await removeAsset(db, row.id, String(req.params.assetId), actorOf(req)))) throw new InputError("not_found"); }));
router.post("/:id/insurance", ...staff, act((req, row) => addInsurance(db, row.id, req.body ?? {}, actorOf(req)), 201));
router.post("/:id/documents", ...staff, upload.single("file"), act(async (req, row) => {
  if (!req.file) throw new InputError("file_required", "file");
  const kind = String(req.body?.kind ?? "other");
  const { getStorage } = await import("../lib/storage/index.js");
  const doc = await addDocument(db, row.id, req.file, kind, actorOf(req), (p) => getStorage().put(p));
  const review = kind === "lender_statement" ? await reviewUploadedStatement(db, row.id, doc.id, await defaultStatementDeps()) : null;
  return { document: doc, review };
}, 201));
router.get("/:id/documents/:docId/file", ...staff, safeHandler(async (req: any, res: any) => {
  const row = await contractOr404(req, res);
  if (!row) return;
  if (!ID.test(String(req.params.docId))) return res.status(404).json({ ok: false, error: "not_found" });
  const d = (await db.query(`SELECT filename, content_type, blob_name FROM active_contract_documents WHERE id = $1::uuid AND contract_id = $2::uuid`, [req.params.docId, row.id])).rows[0];
  if (!d) return res.status(404).json({ ok: false, error: "not_found" });
  const { getStorage } = await import("../lib/storage/index.js");
  const f = await getStorage().get(d.blob_name);
  if (!f) return res.status(404).json({ ok: false, error: "file_missing" });
  res.setHeader("Content-Type", d.content_type || f.contentType || "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename="${String(d.filename).replace(/[^A-Za-z0-9._ -]/g, "_")}"`);
  return res.send(f.buffer);
}));

export default router;
