// BF_SERVER_v825_LENDER_REFERRALS - lenders send their declined files; staff accept or decline them.
//   Lender (lender portal token):
//     GET  /api/lender-referrals/mine                       the lender's files, status only
//     POST /api/lender-referrals/mine   (multipart)         files[] (one zip per client) + details (JSON array, same order)
//   Staff (Admin / Staff):
//     GET  /api/lender-referrals                            the review queue
//     GET  /api/lender-referrals/:id/zip                    download the zip to review it
//     POST /api/lender-referrals/:id/accept                 { complete_package: boolean, note? }
//     POST /api/lender-referrals/:id/decline                { note? }
import { Router, type Request, type Response } from "express";
import multer from "multer";
import { pool } from "../db.js";
import { ROLES } from "../auth/roles.js";
import { requireAuth, requireAuthorization } from "../middleware/auth.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { requireLender } from "./lenderSelf.js";
import { logWarnSwallowed } from "../lib/logWarnSwallowed.js";
import {
  LENDER_REFERRAL_MAX_BYTES,
  LENDER_REFERRAL_MAX_FILES,
  LenderReferralError,
  acceptReferral,
  declineReferral,
  lenderName,
  listForLender,
  listForStaff,
  parseReferralDetails,
  referralZip,
  saveReferral,
} from "../services/lenderReferrals/lenderReferrals.js";

const router = Router();
const staff = [requireAuth, requireAuthorization({ roles: [ROLES.ADMIN, ROLES.STAFF] })];
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: LENDER_REFERRAL_MAX_BYTES, files: LENDER_REFERRAL_MAX_FILES } });

type LenderReq = Request & { lenderId?: string };

function uploadFiles(req: Request, res: Response, next: (err?: unknown) => void): void {
  upload.array("files", LENDER_REFERRAL_MAX_FILES)(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      const message = err.code === "LIMIT_FILE_SIZE" ? "Each zip must be 50 MB or smaller."
        : err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE" ? `Send up to ${LENDER_REFERRAL_MAX_FILES} zips at a time.`
        : "The upload could not be read.";
      res.status(400).json({ error: "bad_upload", message });
      return;
    }
    next(err);
  });
}

function parseDetailsList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

router.get("/mine", requireLender, safeHandler(async (req: LenderReq, res: Response) => {
  res.json({ files: await listForLender(String(req.lenderId)) });
}));

router.post("/mine", requireLender, uploadFiles, safeHandler(async (req: LenderReq, res: Response) => {
  const files = ((req as any).files as Express.Multer.File[] | undefined) ?? [];
  if (files.length === 0) return void res.status(400).json({ error: "file_required", message: "Attach at least one zip (one per client)." });
  const details = parseDetailsList((req.body as any)?.details);
  const lenderId = String(req.lenderId);
  const name = await lenderName(lenderId);
  const results: Array<{ file: string; ok: boolean; id?: string; error?: string; message?: string }> = [];
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i]!;
    try {
      if (!/[.]zip$/i.test(file.originalname)) throw new LenderReferralError("zip_required", "Upload a .zip file (one per client).");
      const parsed = parseReferralDetails(details[i]);
      const saved = await saveReferral({ lenderId, lenderName: name, uploadedBy: "lender:" + lenderId, zipName: file.originalname, zip: file.buffer, details: parsed });
      results.push({ file: file.originalname, ok: true, id: saved.id });
    } catch (error) {
      if (!(error instanceof LenderReferralError)) throw error;
      results.push({ file: file.originalname, ok: false, error: error.code, message: error.message });
    }
  }
  const sent = results.filter((r) => r.ok).length;
  if (sent > 0) {
    try {
      const { notifyAllStaff } = await import("../services/notifications/notifyAllStaff.js");
      await notifyAllStaff({
        pool,
        notificationType: "lender_referral_received",
        title: "Lender referral",
        body: `${name} sent ${sent} declined file${sent === 1 ? "" : "s"} for review.`,
        refTable: "lender_referrals",
        refId: results.find((r) => r.ok)!.id! + ":" + Date.now(),
        contextUrl: "/marketing?tab=referrers&sub=lender-referrals",
        silo: "BF",
      });
    } catch (error) {
      logWarnSwallowed(error, "routes/lenderReferrals.ts:notify");
    }
  }
  res.status(sent > 0 ? 201 : 400).json({ sent, results });
}));

router.get("/", ...staff, safeHandler(async (_req: Request, res: Response) => {
  res.json({ referrals: await listForStaff() });
}));

router.get("/:id/zip", ...staff, safeHandler(async (req: Request, res: Response) => {
  const zip = await referralZip(String(req.params.id));
  if (!zip) return void res.status(404).json({ error: "not_found", message: "The zip is no longer stored (the file was accepted or declined)." });
  const safeName = zip.name.replace(/[^A-Za-z0-9._ -]/g, "_");
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.status(200).end(zip.data);
}));

router.post("/:id/accept", ...staff, safeHandler(async (req: any, res: Response) => {
  const complete = req.body?.complete_package;
  if (typeof complete !== "boolean") return void res.status(400).json({ error: "complete_package_required", message: "Choose whether this is a complete package." });
  const note = typeof req.body?.note === "string" && req.body.note.trim() ? req.body.note.trim().slice(0, 2000) : null;
  try {
    const out = await acceptReferral(String(req.params.id), { staffId: req.user?.id ? String(req.user.id) : null, completePackage: complete, note });
    res.json({ ok: true, ...out });
  } catch (error) {
    if (error instanceof LenderReferralError) return void res.status(error.status).json({ error: error.code, message: error.message });
    throw error;
  }
}));

router.post("/:id/decline", ...staff, safeHandler(async (req: any, res: Response) => {
  const note = typeof req.body?.note === "string" && req.body.note.trim() ? req.body.note.trim().slice(0, 2000) : null;
  try {
    await declineReferral(String(req.params.id), req.user?.id ? String(req.user.id) : null, note);
    res.json({ ok: true });
  } catch (error) {
    if (error instanceof LenderReferralError) return void res.status(error.status).json({ error: error.code, message: error.message });
    throw error;
  }
}));

export default router;
