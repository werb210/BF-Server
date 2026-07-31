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

// BF_SERVER_ACCOUNTANT_FORMS_v2 - allow-list entries that are CMP forms rather
// than uploads. These keys must match the client's FORM_RENDERERS map exactly;
// a near-miss renders nothing and reports no error.
export const ACCOUNTANT_FORM_DOC_TYPES: string[] = [
  "debt_stack",
  "equipment_collateral",
  "real_estate_collateral_disclosure",
  "professional_advisors",
  "cra_view_only_authorization",
  "flinks_banking",
];

const FORM_ALLOWED = new Set(ACCOUNTANT_FORM_DOC_TYPES);

export function isAccountantForm(docType: unknown): boolean {
  return FORM_ALLOWED.has(String(docType ?? "").trim());
}

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

// BF_SERVER_ACCOUNTANT_FORMS_v2 - form-response access for a signed-in
// accountant, mirroring the client handlers but scoped to the token's contact.
async function ownsApplication(contactId: string, applicationId: string): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM applications
      WHERE id::text = ($1)::text AND contact_id::text = ($2)::text
      LIMIT 1`,
    [applicationId, contactId]
  );
  return (r.rowCount ?? 0) > 0;
}

// Ownership and the form allow-list, in that order. A doc_type outside the list
// is refused on read as well as write: letting an accountant read the personal
// net worth statement would defeat the point of leaving it off.
async function guardForm(req: any, res: any): Promise<{ appId: string; docType: string } | null> {
  const { contactId } = req.accountant;
  const appId = String(req.params.id ?? "").trim();
  const docType = String(req.params.doc_type ?? "").trim();
  if (!appId) {
    res.status(400).json({ error: "applicationId_required" });
    return null;
  }
  if (!(await ownsApplication(contactId, appId))) {
    res.status(404).json({ error: "not_found" });
    return null;
  }
  if (docType && !isAccountantForm(docType)) {
    res.status(403).json({ error: "FORM_NOT_PERMITTED" });
    return null;
  }
  return { appId, docType };
}

router.get(
  "/applications/:id/form-responses",
  requireAccountant,
  safeHandler(async (req: any, res: any) => {
    const guard = await guardForm(req, res);
    if (!guard) return;
    const result = await pool.query(
      `SELECT id, doc_type, data, submitted_at, created_at, updated_at
         FROM application_form_responses
        WHERE application_id::text = ($1)::text
          AND doc_type = ANY($2::text[])
        ORDER BY updated_at DESC`,
      [guard.appId, ACCOUNTANT_FORM_DOC_TYPES]
    );
    res.json({ items: result.rows });
  })
);

router.get(
  "/applications/:id/form-responses/:doc_type",
  requireAccountant,
  safeHandler(async (req: any, res: any) => {
    const guard = await guardForm(req, res);
    if (!guard) return;
    const result = await pool.query(
      `SELECT id, doc_type, data, submitted_at, created_at, updated_at
         FROM application_form_responses
        WHERE application_id::text = ($1)::text AND doc_type = $2
        LIMIT 1`,
      [guard.appId, guard.docType]
    );
    if (result.rowCount === 0) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ item: result.rows[0] });
  })
);

router.put(
  "/applications/:id/form-responses/:doc_type",
  requireAccountant,
  safeHandler(async (req: any, res: any) => {
    const guard = await guardForm(req, res);
    if (!guard) return;
    const data = req.body?.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      res.status(400).json({ error: "data_required" });
      return;
    }
    const result = await pool.query(
      `INSERT INTO application_form_responses (application_id, doc_type, data, updated_at)
            VALUES ($1, $2, $3::jsonb, NOW())
            ON CONFLICT (application_id, doc_type)
            DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
         RETURNING id, doc_type, data, submitted_at, created_at, updated_at`,
      [guard.appId, guard.docType, JSON.stringify(data)]
    );
    res.json({ item: result.rows[0] });
  })
);

router.post(
  "/applications/:id/form-responses/:doc_type/submit",
  requireAccountant,
  safeHandler(async (req: any, res: any) => {
    const guard = await guardForm(req, res);
    if (!guard) return;
    const data = req.body?.data;
    const hasData = data && typeof data === "object" && !Array.isArray(data);
    const result = hasData
      ? await pool.query(
          `INSERT INTO application_form_responses (application_id, doc_type, data, submitted_at, updated_at)
                VALUES ($1, $2, $3::jsonb, NOW(), NOW())
                ON CONFLICT (application_id, doc_type)
                DO UPDATE SET data = EXCLUDED.data, submitted_at = NOW(), updated_at = NOW()
             RETURNING id, doc_type, data, submitted_at, created_at, updated_at`,
          [guard.appId, guard.docType, JSON.stringify(data)]
        )
      : await pool.query(
          `UPDATE application_form_responses
              SET submitted_at = NOW(), updated_at = NOW()
            WHERE application_id::text = ($1)::text AND doc_type = $2
            RETURNING id, doc_type, data, submitted_at, created_at, updated_at`,
          [guard.appId, guard.docType]
        );
    if (result.rowCount === 0) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ item: result.rows[0] });
  })
);

export default router;
