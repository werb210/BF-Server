// BF_SERVER_v872_QUOTES - quotes (offer summaries) for the client, staff side (ported from KS-server #50, no plan gate).
// Record visibility (batch 3) applies: /applications/:id routes are record-guarded in routeRegistry, and a quote id is
// checked against the application it belongs to.
//   GET  /api/quotes/applications/:id            quotes on the file, the lender offers a quote can start from, the tax province
//   POST /api/quotes/applications/:id            { title?, message?, expires_on?, tax_province?, offer_ids?: [] | options?: [] } a draft
//   GET  /api/quotes/:qid                        one quote with its timeline
//   PUT  /api/quotes/:qid                        draft only: { title?, message?, expires_on?, currency?, tax_province?, options? }
//   GET  /api/quotes/:qid/pdf                    the branded PDF (preview for drafts)
//   POST /api/quotes/:qid/send                   draft -> sent: stores the PDF on Documents, tells the client
//   POST /api/quotes/:qid/withdraw               draft / sent / viewed -> withdrawn
//   POST /api/quotes/:qid/duplicate              a new draft with the same options (to change a sent quote)
import { Router } from "express";
import { pool } from "../db.js";
import { auth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { actorId, auditFor } from "../settingsPack/common.js";
import { canSeeRecord, scopeForRequest } from "../visibility/scope.js";
import { PROVINCES, PROVINCE_NAMES, applicationProvince } from "../brokerTools/salesTax.js";
import {
  createQuote, duplicateQuote, listQuotes, loadQuote, offersOnFile, quoteEvents, quotePdf, sendQuote, updateQuote, withdrawQuote, type Db, type QuoteView,
} from "../quotes/service.js";

const router = Router();
const db = () => pool as unknown as Db;
router.use(auth, requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF, ROLES.OPS] }));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MESSAGES: Record<string, string> = {
  not_found: "That quote or application was not found.",
  only_drafts_can_change: "A sent quote cannot be changed. Duplicate it to make a new one.",
  already_sent: "This quote has already been sent.",
  add_an_option: "Add at least one option before sending.",
  every_option_needs_a_payment: "Every option needs a payment: add the term and the rate or factor, or type the lender's payment.",
  expiry_in_the_past: "The expiry date has passed. Pick a later date.",
  not_open: "Only a draft, sent or viewed quote can be withdrawn.",
};
const fail = (res: any, status: number, error: string) => res.status(status).json({ ok: false, error, message: MESSAGES[error] ?? error });

/** A quote the caller may see (its application is visible to them), or null after answering 404. */
async function visibleQuote(req: any, res: any): Promise<QuoteView | null> {
  const q = await loadQuote(db(), String(req.params.qid ?? ""));
  if (!q || !(await canSeeRecord(db(), await scopeForRequest(req, db()), "application", q.application_id))) {
    fail(res, 404, "not_found");
    return null;
  }
  return q;
}

router.get("/applications/:id", safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id ?? "");
  if (!UUID.test(id)) return fail(res, 400, "invalid_id");
  res.setHeader("Cache-Control", "no-store");
  return res.json({
    ok: true, quotes: await listQuotes(db(), id), offers: await offersOnFile(db(), id),
    default_tax_province: await applicationProvince(db(), id),
    provinces: PROVINCES.map((p) => ({ code: p, name: PROVINCE_NAMES[p] })),
  });
}));

router.post("/applications/:id", safeHandler(async (req: any, res: any) => {
  const id = String(req.params.id ?? "");
  if (!UUID.test(id)) return fail(res, 400, "invalid_id");
  const b = req.body ?? {};
  const r = await createQuote({
    applicationId: id, title: b.title, message: b.message, expiresOn: b.expires_on ?? null,
    offerIds: Array.isArray(b.offer_ids) ? b.offer_ids.map(String) : undefined, options: b.options,
    taxProvince: "tax_province" in b ? b.tax_province : undefined, userId: actorId(req),
  }, db());
  if (!r.ok) return fail(res, r.status, r.error);
  await auditFor(req, "quote.created", { quote_id: r.quote.id, options: r.quote.options.length }, { type: "application", id });
  return res.status(201).json({ ok: true, quote: r.quote });
}));

router.get("/:qid", safeHandler(async (req: any, res: any) => {
  const q = await visibleQuote(req, res);
  if (!q) return;
  res.setHeader("Cache-Control", "no-store");
  return res.json({ ok: true, quote: q, events: await quoteEvents(db(), q.id) });
}));

router.put("/:qid", safeHandler(async (req: any, res: any) => {
  const q = await visibleQuote(req, res);
  if (!q) return;
  const r = await updateQuote(q.id, req.body ?? {}, actorId(req), db());
  if (!r.ok) return fail(res, r.status, r.error);
  return res.json({ ok: true, quote: r.quote });
}));

router.get("/:qid/pdf", safeHandler(async (req: any, res: any) => {
  const q = await visibleQuote(req, res);
  if (!q) return;
  const pdf = await quotePdf(q, db());
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="Quote-${q.quote_number}.pdf"`);
  res.setHeader("Cache-Control", "no-store");
  return res.send(Buffer.from(pdf));
}));

router.post("/:qid/send", safeHandler(async (req: any, res: any) => {
  const q = await visibleQuote(req, res);
  if (!q) return;
  const r = await sendQuote(q.id, actorId(req));
  if (!r.ok) return fail(res, r.status, r.error);
  await auditFor(req, "quote.sent", { quote_id: r.quote.id, options: r.quote.options.length }, { type: "application", id: r.quote.application_id });
  return res.json({ ok: true, quote: r.quote });
}));

router.post("/:qid/withdraw", safeHandler(async (req: any, res: any) => {
  const q = await visibleQuote(req, res);
  if (!q) return;
  if (!(await withdrawQuote(q.id, actorId(req), db()))) return fail(res, 409, "not_open");
  await auditFor(req, "quote.withdrawn", { quote_id: q.id }, { type: "application", id: q.application_id });
  return res.json({ ok: true, quote: await loadQuote(db(), q.id) });
}));

router.post("/:qid/duplicate", safeHandler(async (req: any, res: any) => {
  const q = await visibleQuote(req, res);
  if (!q) return;
  const r = await duplicateQuote(q.id, actorId(req), db());
  if (!r.ok) return fail(res, r.status, r.error);
  return res.status(201).json({ ok: true, quote: r.quote });
}));

export default router;
