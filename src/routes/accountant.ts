import { Router } from "express";
import multer from "multer";
import { pool } from "../db.js";
import requireAccountant from "../middleware/requireAccountant.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { persistAndEnqueue } from "./documents.js";

const router: Router = Router();

// Categories that are useful to an accountant but might not be a product's
// outstanding requirement are deliberately kept narrow.
export const ACCOUNTANT_ALWAYS_AVAILABLE = ["Other"];

// Keep applicant-only forms (in particular personal net worth) out of both the
// accountant read surface and its upload front door.
const ACCOUNTANT_HIDDEN_CATEGORY =
  /personal\s*net\s*worth|net\s*worth\s*statement|government\s*id|driver'?s?\s*licen[cs]e|passport/i;

export function isAccountantVisible(category: unknown): boolean {
  const value = String(category ?? "").trim();
  return Boolean(value) && !ACCOUNTANT_HIDDEN_CATEGORY.test(value);
}

// BF_SERVER_ACCOUNTANT_UPLOAD_v1 - same 25MB ceiling as the applicant upload.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

// Mirrors the list on /api/documents/public-upload. A drift test pins the two
// together, because an accountant sending a Word document and being told 415
// while the applicant can send the same file would be a maddening bug to chase.
export const ACCOUNTANT_ALLOWED_MIME_PREFIXES: string[] = [
  "application/pdf",
  "image/jpeg", "image/png", "image/heic", "image/heif", "image/webp",
  "application/vnd.openxmlformats-officedocument",
  "application/msword",
  "application/vnd.ms-excel",
  "text/csv",
  "text/plain",
];

export function isAllowedAccountantMime(mimetype: unknown): boolean {
  const mime = String(mimetype ?? "").toLowerCase();
  if (!mime) return false;
  return ACCOUNTANT_ALLOWED_MIME_PREFIXES.some(
    (p) => mime === p || mime.startsWith(p + ";") || mime.startsWith(p + "/") || mime.startsWith(p + ".")
  );
}

const TERMINAL_STATES = new Set(["Accepted", "Rejected", "Funded", "Closed"]);

// BF_SERVER_ACCOUNTANT_UPLOAD_v1
router.post(
  "/applications/:id/upload",
  requireAccountant,
  upload.single("file"),
  safeHandler(async (req: any, res: any) => {
    const { contactId } = req.accountant;
    const id = String(req.params.id ?? "").trim();
    const category = String(req.body?.category ?? "").trim();
    const file = req.file;

    if (!id || !category) {
      res.status(400).json({ error: "MISSING_FIELDS" });
      return;
    }
    if (!file) {
      res.status(400).json({ error: "NO_FILE" });
      return;
    }

    // Scope the application exclusively with the contact identity from the
    // verified token. A 404 covers both "no such application" and "not yours"
    // so this endpoint cannot be used to probe for real application ids.
    const owned = await pool.query<{ pipeline_state: string | null }>(
      `SELECT pipeline_state
         FROM applications
        WHERE id::text = ($1)::text AND contact_id::text = ($2)::text
        LIMIT 1`,
      [id, contactId]
    );
    const row = owned.rows[0];
    if (!row) {
      res.status(404).json({ error: "APPLICATION_NOT_FOUND" });
      return;
    }

    if (!isAccountantVisible(category) && !ACCOUNTANT_ALWAYS_AVAILABLE.includes(category)) {
      console.warn("[accountant] upload rejected out-of-scope category", { contactId, category });
      res.status(403).json({ error: "CATEGORY_NOT_PERMITTED" });
      return;
    }

    if (!isAllowedAccountantMime(file.mimetype)) {
      console.warn("[accountant] upload rejected mime", { contactId, mime: file.mimetype });
      res.status(415).json({ error: "UNSUPPORTED_FILE_TYPE" });
      return;
    }

    if (row.pipeline_state && TERMINAL_STATES.has(row.pipeline_state)) {
      res.status(409).json({ error: "APPLICATION_NOT_ACCEPTING_UPLOADS" });
      return;
    }

    try {
      const result = await persistAndEnqueue({
        applicationId: id,
        category,
        file,
        uploadedBy: `accountant:${contactId}`,
      });
      res.json({
        status: "ok",
        data: {
          id: result.id,
          versionId: result.versionId,
          applicationId: id,
          filename: file.originalname,
          size: result.sizeBytes,
        },
      });
    } catch (err: any) {
      console.error("[accountant] upload failed", { id, category, message: err?.message });
      res.status(500).json({ error: "UPLOAD_FAILED" });
    }
  })
);

export default router;
