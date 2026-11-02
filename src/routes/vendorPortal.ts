// BF_SERVER_v867_BROKER_TOOLS_VENDORS - /api/vendor-portal: the equipment vendor / dealer portal (vendor_portal, Pro).
// Public (no login): POST /signup, POST /signup/complete. Everything else needs the vendor's partner token (the broker
// portal's phone-code login: role Referrer, partner_kind 'vendor', agreement signed, vendor not paused).
//   GET  /me                                  company, referral code, fee terms, apply link
//   POST /quote                               { customer_name, customer_email, customer_phone, equipment_description, amount, province, terms, tax_mode, down_payment }
//                                             -> payment options from the rate cards (with sales tax) + the customer's apply link
//   GET  /quotes                              the vendor's quotes
//   GET  /deals                               deals that came in through the vendor's link: status only (no lender terms)
//   POST /deals/:applicationId/invoice        upload the invoice for a deal (multipart "file")
//   GET  /fees                                fees owed to the vendor
import { Router, type NextFunction, type Request, type Response } from "express";
import jwt from "jsonwebtoken";
import { safeHandler } from "../middleware/safeHandler.js";
import { ROLES } from "../auth/roles.js";
import { db, str, UUID_RE } from "../brokerTools/common.js";
import { featureOn, gate } from "../brokerTools/platform.js";
import { bad, upload } from "../brokerTools/http.js";
import { parseStructureInput, structure } from "../brokerTools/rateCards.js";
import {
  VendorError, applyLink, createVendor, getVendor, listFees, ownsDeal, parseVendorInput, startAgreement, syncAgreement, vendorByCode, vendorDeals, type Vendor,
} from "../brokerTools/vendors.js";
import { storeConditionDocument } from "./brokerTools.js";

type VendorReq = Request & { vendor?: Vendor };
const router = Router();
const vp = gate("vendor_portal");

async function requireVendorImpl(req: VendorReq, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.split(" ")[1];
  const secret = process.env.JWT_SECRET;
  if (!token || !secret) return bad(res, "Log in to the vendor portal.", 401, "unauthorized");
  let id = "";
  try {
    const d = jwt.verify(token, secret, { algorithms: ["HS256"] }) as Record<string, unknown>;
    if (String(d.role ?? "") !== ROLES.REFERRER) return bad(res, "This is the vendor portal.", 403, "vendor_required");
    id = String(d.referrerId ?? d.referrer_id ?? "");
  } catch {
    return bad(res, "Log in to the vendor portal.", 401, "unauthorized");
  }
  const u = await db().query(`SELECT partner_kind, referrer_status FROM users WHERE id::text = $1 LIMIT 1`, [id]);
  if (!u.rows[0] || u.rows[0].partner_kind !== "vendor") return bad(res, "This is the vendor portal.", 403, "vendor_required");
  const v = await syncAgreement(db(), id);
  if (!v || u.rows[0].referrer_status !== "active") return bad(res, "Sign the vendor agreement to use the portal.", 403, "agreement_not_signed");
  if (v.status === "paused") return bad(res, "Your vendor account is paused. Contact us.", 403, "vendor_paused");
  req.vendor = v;
  next();
}
function requireVendor(req: VendorReq, res: Response, next: NextFunction): void {
  requireVendorImpl(req, res, next).catch(next);
}

// ------------------------------------------------------------------------------------------------ sign-up (public)
router.post("/signup", vp, safeHandler(async (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const p = parseVendorInput(b);
  if (!p.ok) return bad(res, p.error);
  let v: Vendor | null = null;
  const code = str(b.code, 40);
  if (code) {
    const invited = await vendorByCode(db(), code);
    if (invited && invited.status !== "active" && (invited.email === p.value.email || String(invited.phone ?? "").slice(-10) === String(p.value.phone).slice(-10))) v = invited;
  }
  try {
    if (!v) v = await createVendor(db(), { ...p.value, fee_pct: null, fee_flat: null, fee_terms: null, notes: null, status: undefined }, "BF", null, "pending_agreement");
  } catch (err) {
    if (err instanceof VendorError) return bad(res, "That email or mobile number already has a login. Log in instead, or contact us.", 409, "already_registered");
    throw err;
  }
  const session = await startAgreement(db(), v);
  res.status(201).json({ ok: true, vendorId: v.user_id, agreementConfigured: Boolean(session), signingUrl: session?.url ?? null });
}));

router.post("/signup/complete", vp, safeHandler(async (req: Request, res: Response) => {
  const id = str((req.body ?? {}).vendorId, 80);
  if (!id || !UUID_RE.test(id)) return bad(res, "Missing the sign-up.");
  const u = await db().query(`SELECT referrer_status, agreement_document_group_id FROM users WHERE id::text = $1 AND partner_kind = 'vendor' LIMIT 1`, [id]);
  if (!u.rows[0]) return bad(res, "Sign-up not found.", 404, "not_found");
  if (u.rows[0].referrer_status !== "active" && u.rows[0].agreement_document_group_id) {
    const sn = await import("../signnow/signnowClient.js");
    const st = await sn.getDocumentGroupStatus(String(u.rows[0].agreement_document_group_id));
    if (st.signed) await db().query(`UPDATE users SET referrer_status = 'active', agreement_signed_at = COALESCE(agreement_signed_at, now()), updated_at = now() WHERE id::text = $1`, [id]);
  }
  const v = await syncAgreement(db(), id);
  res.json({ ok: true, active: v?.status === "active" });
}));

// ------------------------------------------------------------------------------------------------ the portal
router.get("/me", vp, requireVendor, (req: VendorReq, res: Response) => {
  const v = req.vendor!;
  res.json({ ok: true, vendor: { company_name: v.company_name, contact_name: v.contact_name, code: v.code, province: v.province, fee_pct: v.fee_pct, fee_flat: v.fee_flat, fee_terms: v.fee_terms }, apply_link: applyLink(v.code) });
});

router.post("/quote", vp, requireVendor, safeHandler(async (req: VendorReq, res: Response) => {
  if (!(await featureOn("rate_cards"))) return bad(res, "Quotes need the lender rate cards, which are not on this plan.", 402, "feature_not_in_plan");
  const b = (req.body ?? {}) as Record<string, unknown>;
  const p = parseStructureInput(b, { province: req.vendor!.province as any, terms: [36, 48, 60], tax_mode: "lease" });
  if (!p.ok) return bad(res, p.error);
  const out = await structure(db(), { ...p.value, tier: null });
  const r = await db().query(
    `INSERT INTO vendor_quotes (vendor_id, customer_name, customer_email, customer_phone, equipment_description, amount, province, inputs, options)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb) RETURNING id::text AS id, created_at`,
    [req.vendor!.user_id, str(b.customer_name, 200), str(b.customer_email, 200), str(b.customer_phone, 40), str(b.equipment_description, 500), p.value.amount, p.value.province,
      JSON.stringify(p.value), JSON.stringify(out.options)],
  );
  const options = out.options.map((o) => ({ lender_name: o.lender_name, product_name: o.product_name, card_name: o.card_name, card_id: o.card_id, rate_kind: o.rate_kind, rate: o.rate, tier: o.tier,
    term_months: o.term_months, financed: o.financed, residual: o.residual, payment: o.payment, payment_tax: o.payment_tax, payment_with_tax: o.payment_with_tax,
    upfront: o.upfront, upfront_total: o.upfront_total, total_of_payments: o.total_of_payments, cost_of_borrowing: o.cost_of_borrowing }));
  res.status(201).json({ ok: true, quote: { id: r.rows[0].id, created_at: r.rows[0].created_at, input: p.value, options }, apply_link: applyLink(req.vendor!.code, r.rows[0].id),
    disclaimer: "Estimates from lender rate cards, before credit approval. Not an offer of credit." });
}));

router.get("/quotes", vp, requireVendor, safeHandler(async (req: VendorReq, res: Response) => {
  const r = await db().query(
    `SELECT id::text AS id, customer_name, customer_email, equipment_description, amount, province, created_at, jsonb_array_length(options) AS options
       FROM vendor_quotes WHERE vendor_id = $1::uuid ORDER BY created_at DESC LIMIT 200`,
    [req.vendor!.user_id],
  );
  res.json({ ok: true, quotes: r.rows.map((q: any) => ({ ...q, apply_link: applyLink(req.vendor!.code, q.id) })) });
}));

router.get("/deals", vp, requireVendor, safeHandler(async (req: VendorReq, res: Response) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true, deals: await vendorDeals(db(), req.vendor!) });
}));

router.post("/deals/:applicationId/invoice", vp, requireVendor, upload.single("file"), safeHandler(async (req: VendorReq, res: Response) => {
  const appId = String(req.params.applicationId);
  if (!UUID_RE.test(appId) || !(await ownsDeal(db(), req.vendor!, appId))) return bad(res, "Deal not found.", 404, "not_found");
  if (!req.file) return bad(res, "Choose the invoice (PDF or photo).");
  if (!/^(application\/pdf|image\/)/.test(req.file.mimetype)) return bad(res, "Send the invoice as a PDF or a photo.");
  const doc = await storeConditionDocument(appId, req.file, "vendor");
  if (!doc.ok) return bad(res, doc.message, doc.status, doc.error);
  // Staff see it on the Deal desk; with invoice reading on, it is read into a draft for them to confirm.
  if (await featureOn("invoice_reading")) {
    try {
      const { readInvoice } = await import("../brokerTools/invoices.js");
      await readInvoice(db(), appId, { buffer: req.file.buffer, mimeType: req.file.mimetype, fileName: req.file.originalname, documentId: doc.id }, null);
    } catch (err) {
      console.warn("[broker-tools] vendor invoice not read", { applicationId: appId, message: err instanceof Error ? err.message : String(err) });
    }
  }
  res.status(201).json({ ok: true, document_id: doc.id });
}));

router.get("/fees", vp, requireVendor, safeHandler(async (req: VendorReq, res: Response) => {
  res.json({ ok: true, fees: await listFees(db(), { vendorId: req.vendor!.user_id }) });
}));

export default router;
