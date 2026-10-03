// BF_SERVER_BROKER_PORTAL_v717 - the broker portal API (separate broker link).
// A broker is a partner account (users row, role Referrer, partner_kind 'broker')
// that signed the broker agreement; it logs in with its phone like a referrer.
//   GET  /api/broker/me
//   GET  /api/broker/files                         status only (no lenders or offer terms)
//   POST /api/broker/files            (zip)        upload one client file
//   POST /api/broker/files/:applicationId/split    { action: "accept" } | { action: "counter", broker_pct, note }
import { Router, type NextFunction, type Request, type Response } from "express";
import jwt from "jsonwebtoken";
import multer from "multer";
import { pool } from "../db.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";

type BrokerReq = Request & { broker?: { id: string; company: string; name: string } };
const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024, files: 1 } });

async function requireBroker(req: BrokerReq, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.split(" ")[1];
  const secret = process.env.JWT_SECRET;
  if (!token || !secret) return void res.status(401).json({ error: "unauthorized" });
  let id = "";
  try {
    const d = jwt.verify(token, secret) as Record<string, unknown>;
    if (String(d.role ?? "") !== ROLES.REFERRER) return void res.status(403).json({ error: "broker_required" });
    id = String(d.referrerId ?? d.referrer_id ?? "");
  } catch {
    return void res.status(401).json({ error: "unauthorized" });
  }
  if (!id) return void res.status(403).json({ error: "broker_required" });
  const u = await pool.query<{ company: string | null; name: string | null; partner_kind: string; referrer_status: string | null }>(
    `SELECT company_name AS company, trim(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) AS name, partner_kind, referrer_status FROM users WHERE id::text = $1 LIMIT 1`,
    [id],
  );
  const row = u.rows[0];
  if (!row || row.partner_kind !== "broker") return void res.status(403).json({ error: "broker_required" });
  if (String(row.referrer_status ?? "").toLowerCase() !== "active") return void res.status(403).json({ error: "agreement_not_signed", message: "Sign the broker agreement to use the broker portal." });
  req.broker = { id, company: row.company || row.name || "Partner broker", name: row.name || row.company || "" };
  next();
}

router.get("/me", requireBroker, safeHandler(async (req: BrokerReq, res: Response) => {
  res.json({ broker: req.broker });
}));

router.get("/files", requireBroker, safeHandler(async (req: BrokerReq, res: Response) => {
  const r = await pool.query(
    `SELECT bi.id::text AS import_id, bi.application_id, bi.zip_name, bi.status AS import_status, bi.created_at,
            COALESCE(a.name, bi.summary->>'businessName') AS business_name, a.pipeline_state AS stage, a.requested_amount,
            d.boreal_pct, d.broker_pct, d.terms, d.status AS split_status, d.broker_counter_pct, d.broker_counter_note,
            d.payout_amount, d.payout_paid_on
       FROM broker_imports bi
       LEFT JOIN applications a ON a.id::text = bi.application_id
       LEFT JOIN broker_deal_confirmations d ON d.application_id = bi.application_id
      WHERE bi.broker_user_id = $1
      ORDER BY bi.created_at DESC LIMIT 200`,
    [req.broker!.id],
  );
  res.json({ files: r.rows });
}));

router.post("/files", requireBroker, upload.single("file"), safeHandler(async (req: BrokerReq, res: Response) => {
  const file = (req as any).file as Express.Multer.File | undefined;
  if (!file) return void res.status(400).json({ error: "file_required", message: "Attach the client's zip file." });
  if (!/[.]zip$/i.test(file.originalname)) return void res.status(400).json({ error: "zip_required", message: "Upload a .zip file (one per client)." });
  const { importBrokerZip, BrokerImportError } = await import("../services/brokerImport/importBrokerFile.js");
  try {
    const out = await importBrokerZip({ zip: file.buffer, zipName: file.originalname, brokerName: req.broker!.company, uploadedBy: "broker:" + req.broker!.id, applicantPhone: (req.body as any)?.applicant_phone });
    await pool.query("UPDATE broker_imports SET broker_user_id = $2, updated_at = now() WHERE id::text = $1", [out.importId, req.broker!.id]);
    res.status(201).json({ importId: out.importId, applicationId: out.applicationId, businessName: out.businessName, warnings: out.warnings });
  } catch (e) {
    if (e instanceof BrokerImportError) return void res.status(e.status).json({ error: e.code, message: e.message });
    throw e;
  }
}));

router.post("/files/:applicationId/split", requireBroker, safeHandler(async (req: BrokerReq, res: Response) => {
  const appId = String(req.params.applicationId);
  const own = await pool.query("SELECT 1 FROM broker_imports WHERE application_id = $1 AND broker_user_id = $2 LIMIT 1", [appId, req.broker!.id]);
  if (!own.rows[0]) return void res.status(404).json({ error: "not_found" });
  const deal = await pool.query<{ status: string }>("SELECT status FROM broker_deal_confirmations WHERE application_id = $1 LIMIT 1", [appId]);
  const status = deal.rows[0]?.status;
  if (!status) return void res.status(409).json({ error: "no_proposal", message: "Boreal has not proposed a split for this file yet." });
  if (status === "accepted") return void res.status(409).json({ error: "already_accepted", message: "The split for this file is already agreed." });
  const action = String((req.body as any)?.action ?? "");
  if (action === "accept") {
    if (status !== "proposed") return void res.status(409).json({ error: "waiting_on_boreal", message: "Boreal is reviewing your counter-proposal." });
    const r = await pool.query(
      `UPDATE broker_deal_confirmations SET status = 'accepted', accepted_at = now(), agreed_by_broker = $2, agreed_on = CURRENT_DATE, updated_at = now() WHERE application_id = $1 RETURNING status`,
      [appId, `${req.broker!.name} (${req.broker!.company}) in the broker portal`],
    );
    return void res.json({ ok: true, status: r.rows[0]?.status });
  }
  if (action === "counter") {
    const pct = Number((req.body as any)?.broker_pct);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return void res.status(400).json({ error: "bad_percent" });
    const note = String((req.body as any)?.note ?? "").trim().slice(0, 1000) || null;
    await pool.query(
      `UPDATE broker_deal_confirmations SET status = 'countered', broker_counter_pct = $2, broker_counter_note = $3, updated_at = now() WHERE application_id = $1`,
      [appId, pct, note],
    );
    return void res.json({ ok: true, status: "countered" });
  }
  res.status(400).json({ error: "bad_action" });
}));

export default router;
