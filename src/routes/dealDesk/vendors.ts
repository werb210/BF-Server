// BF_SERVER_v867_BROKER_TOOLS_VENDORS - /api/deal-desk: staff side of the vendor portal (vendor_portal, Pro).
//   GET    /vendors                      vendors with quote, deal and fee totals
//   POST   /vendors                      Admin: add a vendor { company_name, contact_name, email, phone, province, fee_pct, fee_flat, fee_terms }
//   PATCH  /vendors/:vid                 Admin: fees, contact, status (active | paused; active also marks the agreement as signed on paper)
//   POST   /vendors/:vid/agreement       Admin: start the SignNow vendor agreement -> signing link (the vendor's sign-up page does this too)
//   GET    /vendor-fees?status=          fees owed to vendors
//   PATCH  /vendor-fees/:fid             Admin: { status: expected | paid | void, paid_on, note }
import { Router, type Request, type Response } from "express";
import { safeHandler } from "../../middleware/safeHandler.js";
import { getSilo } from "../../middleware/silo.js";
import { actorId, audit, db, isoDate, str, UUID_RE } from "../../brokerTools/common.js";
import { gate } from "../../brokerTools/platform.js";
import { admin, bad, staff } from "../../brokerTools/http.js";
import { VendorError, applyLink, createVendor, getVendor, listFees, parseVendorInput, startAgreement, syncAgreement, updateVendor } from "../../brokerTools/vendors.js";

const router = Router();
const vs = [...staff, gate("vendor_portal")];
const vsAdmin = [...admin, gate("vendor_portal")];

router.get("/vendors", ...vs, safeHandler(async (_req: Request, res: Response) => {
  const silo = getSilo(res) ?? "BF";
  const r = await db().query(
    `SELECT vp.user_id::text AS user_id, vp.company_name, vp.contact_name, vp.email, vp.phone, vp.province, vp.code, vp.status, vp.fee_pct, vp.fee_flat, vp.fee_terms,
            (SELECT count(*)::int FROM vendor_quotes q WHERE q.vendor_id = vp.user_id) AS quotes,
            (SELECT count(*)::int FROM applications a WHERE lower(a.metadata->'attribution'->>'ref') = lower(vp.code)) AS deals,
            (SELECT COALESCE(sum(fee_amount), 0) FROM vendor_fees f WHERE f.vendor_id = vp.user_id AND f.status = 'expected') AS fees_expected,
            (SELECT COALESCE(sum(fee_amount), 0) FROM vendor_fees f WHERE f.vendor_id = vp.user_id AND f.status = 'paid') AS fees_paid
       FROM vendor_profiles vp WHERE vp.silo = $1 ORDER BY lower(vp.company_name) LIMIT 500`,
    [silo],
  );
  res.json({ ok: true, vendors: r.rows.map((v: any) => ({ ...v, apply_link: applyLink(v.code) })) });
}));

router.post("/vendors", ...vsAdmin, safeHandler(async (req: Request, res: Response) => {
  const p = parseVendorInput((req.body ?? {}) as Record<string, unknown>);
  if (!p.ok) return bad(res, p.error);
  try {
    const v = await createVendor(db(), { ...p.value, status: undefined }, getSilo(res) ?? "BF", actorId(req));
    await audit(req, "vendor.added", { company: v.company_name, code: v.code, fee_pct: v.fee_pct, fee_flat: v.fee_flat }, { type: "vendor", id: v.user_id });
    res.status(201).json({ ok: true, vendor: v, signup_link: `/vendor/signup?code=${encodeURIComponent(v.code)}` });
  } catch (err) {
    if (err instanceof VendorError) return bad(res, err.message, 409, "already_registered");
    throw err;
  }
}));

router.patch("/vendors/:vid", ...vsAdmin, safeHandler(async (req: Request, res: Response) => {
  const vid = String(req.params.vid);
  if (!UUID_RE.test(vid) || !(await getVendor(db(), vid))) return bad(res, "Vendor not found.", 404, "not_found");
  const p = parseVendorInput((req.body ?? {}) as Record<string, unknown>, true);
  if (!p.ok) return bad(res, p.error);
  const v = await updateVendor(db(), vid, p.value);
  await audit(req, "vendor.updated", { changes: p.value }, { type: "vendor", id: vid });
  res.json({ ok: true, vendor: v });
}));

router.post("/vendors/:vid/agreement", ...vsAdmin, safeHandler(async (req: Request, res: Response) => {
  const vid = String(req.params.vid);
  const v = UUID_RE.test(vid) ? await syncAgreement(db(), vid) : null;
  if (!v) return bad(res, "Vendor not found.", 404, "not_found");
  if (v.status === "active") return bad(res, "This vendor has already signed.", 409, "already_signed");
  const s = await startAgreement(db(), v);
  if (!s) return bad(res, "E-signing is not set up (SignNow key missing). Mark the vendor active if the agreement was signed on paper.", 409, "signnow_not_configured");
  await audit(req, "vendor.agreement_sent", { company: v.company_name }, { type: "vendor", id: vid });
  res.json({ ok: true, signing_url: s.url });
}));

router.get("/vendor-fees", ...vs, safeHandler(async (req: Request, res: Response) => {
  const status = ["expected", "paid", "void"].includes(String(req.query.status)) ? String(req.query.status) : null;
  res.json({ ok: true, fees: await listFees(db(), { status, silo: getSilo(res) ?? "BF" }) });
}));

router.patch("/vendor-fees/:fid", ...vsAdmin, safeHandler(async (req: Request, res: Response) => {
  const fid = String(req.params.fid);
  const b = (req.body ?? {}) as Record<string, unknown>;
  const status = String(b.status ?? "");
  if (!UUID_RE.test(fid)) return bad(res, "Fee not found.", 404, "not_found");
  if (!["expected", "paid", "void"].includes(status)) return bad(res, "A fee is expected, paid or void.");
  const paidOn = status === "paid" ? isoDate(b.paid_on) ?? new Date().toISOString().slice(0, 10) : null;
  const r = await db().query(
    `UPDATE vendor_fees SET status = $2, paid_on = $3::date, note = COALESCE($4, note), updated_at = now() WHERE id = $1::uuid RETURNING id`,
    [fid, status, paidOn, str(b.note, 1000)],
  );
  if (!r.rows[0]) return bad(res, "Fee not found.", 404, "not_found");
  await audit(req, "vendor_fee.updated", { status, paid_on: paidOn }, { type: "vendor_fee", id: fid });
  res.json({ ok: true });
}));

export default router;
