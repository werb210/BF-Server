// BF_SERVER_v872_KYC - the applicant's side of ID verification (client app), ported from KS-server #50 without the plan gate.
//   GET  /api/client/kyc/applications/:id[?wizard=1]  the caller's own verifications on the file. wizard=1 (right after
//                                                     submitting) opens one when the Admin turned the wizard step on.
//   POST /api/client/kyc/verifications/:vid/start     { mode: hosted, url } (vendor link) | { mode: upload } | { mode: done }
//   POST /api/client/kyc/verifications/:vid/upload    manual review: multipart id_front (required), id_back, selfie (required)
// The caller must own the application (OTP phone on the file) and the verification must be theirs (same phone).
import { Router } from "express";
import multer from "multer";
import jwt from "jsonwebtoken";
import { pool } from "../db.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { callerOwnsApplication } from "../auth/clientApplicationOwnership.js";
import {
  clientView, getKycSettings, getVerification, startSession, submitManualUpload, wizardRequests, type Db,
} from "../kyc/service.js";
import { kycProviders } from "../kyc/providers/index.js";
import type { KycMedia } from "../kyc/types.js";

const router = Router();
const db = () => pool as unknown as Db;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 3 } });

function callerPhone10(req: any): string | null {
  const h = String(req.headers?.authorization ?? "");
  const secret = process.env.JWT_SECRET;
  if (!h.startsWith("Bearer ") || !secret) return null;
  try {
    const d = jwt.verify(h.slice(7), secret, { algorithms: ["HS256"] }) as Record<string, unknown>;
    const p = String(d.phone ?? "").replace(/[^0-9]/g, "").slice(-10);
    return p.length === 10 ? p : null;
  } catch {
    return null;
  }
}

/** The verifications on the file that belong to the caller's phone. */
async function mine(applicationId: string, phone10: string) {
  const r = await db().query(
    `SELECT v.id::text AS id, v.application_id, v.status, v.provider, v.requested_at, v.completed_at
       FROM kyc_verifications v JOIN contacts c ON c.id::text = v.contact_id
      WHERE v.application_id = $1 AND right(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g'), 10) = $2
        AND v.status <> 'cancelled'
      ORDER BY v.requested_at DESC LIMIT 10`,
    [applicationId, phone10],
  );
  return r.rows;
}

async function guard(req: any, res: any, applicationId: string): Promise<string | null> {
  if (!UUID.test(applicationId)) { res.status(400).json({ ok: false, error: "invalid_id" }); return null; }
  const phone = callerPhone10(req);
  if (!phone || !(await callerOwnsApplication(req, applicationId))) { res.status(403).json({ ok: false, error: "forbidden" }); return null; }
  return phone;
}

router.get("/applications/:id", safeHandler(async (req: any, res: any) => {
  res.setHeader("Cache-Control", "no-store");
  const id = String(req.params.id ?? "");
  const phone = await guard(req, res, id);
  if (!phone) return;
  const settings = await getKycSettings(db());
  if (req.query?.wizard === "1" && settings.wizard_step) await wizardRequests(id);
  const providers = kycProviders();
  const rows = await mine(id, phone);
  return res.json({ ok: true, enabled: true, wizard_step: settings.wizard_step, verifications: rows.map((r: any) => clientView(r, providers[r.provider as "onfido" | "manual"])) });
}));

async function ownVerification(req: any, res: any) {
  const v = await getVerification(db(), String(req.params.vid ?? ""));
  if (!v) {
    // Fail closed: an unknown verification id is refused like someone else's (403) unless the caller owns the file it names.
    if (!(await callerOwnsApplication(req, String(req.query?.applicationId ?? req.body?.applicationId ?? "")))) { res.status(403).json({ ok: false, error: "forbidden" }); return null; }
    res.status(404).json({ ok: false, error: "not_found" }); return null;
  }
  const phone = await guard(req, res, String(v.application_id));
  if (!phone) return null;
  if (!(await mine(String(v.application_id), phone)).some((r: any) => r.id === v.id)) { res.status(403).json({ ok: false, error: "not_your_verification" }); return null; }
  return v;
}

router.post("/verifications/:vid/start", safeHandler(async (req: any, res: any) => {
  const v = await ownVerification(req, res);
  if (!v) return;
  const r = await startSession(v.id);
  if (!r.ok) return res.status(r.status).json({ ok: false, error: r.error, message: r.error === "vendor_unavailable" ? "The verification service did not answer. Please try again in a minute." : "Verification is not available right now." });
  res.setHeader("Cache-Control", "no-store");
  return res.json(r);
}));

const FIELDS: Record<string, KycMedia["kind"]> = { id_front: "document_front", id_back: "document_back", selfie: "selfie" };

router.post("/verifications/:vid/upload", upload.any(), safeHandler(async (req: any, res: any) => {
  const v = await ownVerification(req, res);
  if (!v) return;
  const files = (Array.isArray(req.files) ? req.files : [])
    .filter((f: any) => FIELDS[f.fieldname])
    .map((f: any) => ({ kind: FIELDS[f.fieldname]!, buffer: f.buffer as Buffer, contentType: String(f.mimetype ?? ""), filename: String(f.originalname ?? "upload.jpg") }));
  const r = await submitManualUpload(v.id, files);
  if (!r.ok) {
    const message = r.error === "id_and_selfie_required" ? "Please add a photo of the front of your ID and a selfie." : r.error === "unsupported_file_type" ? "Please use a JPEG, PNG or HEIC photo." : "This verification has already been sent.";
    return res.status(r.status).json({ ok: false, error: r.error, message });
  }
  return res.json({ ok: true, status: r.status });
}));

export default router;
