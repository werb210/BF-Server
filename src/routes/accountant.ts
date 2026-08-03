import { Router } from "express";
import multer from "multer";
import { pool } from "../db.js";
import requireAccountant from "../middleware/requireAccountant.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { persistAndEnqueue } from "./documents.js";
import { computeOutstandingDocs } from "./clientDocumentsNeeded.js"; // BF_SERVER_ACCOUNTANT_SURFACE_v2

const router: Router = Router();

// BF_SERVER_ACCOUNTANT_SURFACE_v2 - the fifteen categories an accountant may
// see when a lender product has asked for them. This is an allow-list on
// purpose: a deny-list means any category added later is exposed to every
// accountant by default, silently.
export const ACCOUNTANT_DOC_CATEGORIES: string[] = [
  "6 months business banking statements",
  "3 years accountant prepared financials",
  "3 years business tax returns",
  "PnL - Interim financials",
  "Balance Sheet - Interim financials",
  "A/R",
  "A/P",
  "VOID cheque or PAD",
  "Corporate structure / org chart",
  "Business plan / projections",
  "Debt stack",
  "Banking connection (Flinks view-only)",
  "CRA view-only access",
  "Equipment collateral",
  "Professional advisors (CPA / lawyer / insurance)",
];

// BF_SERVER_ACCOUNTANT_SURFACE_TRUTH_v3 - these are NO LONGER appended to every
// application. They stay on the allow-list so the upload endpoint accepts them
// if a staff member adds one as a requirement, but an accountant is never asked
// for a personal tax return nobody requested. The list an accountant sees is
// exactly what the file needs.
export const ACCOUNTANT_ALWAYS_AVAILABLE: string[] = [
  "2 years personal tax returns (T1 generals)",
  "Lease agreement",
  "Real estate collateral",
];

// Em dash, en dash and hyphen collapse to one form; case and repeated
// whitespace are dropped. The database stores "PnL - Interim financials" with
// an EM dash and hand-written lists use an en dash, so a literal comparison
// silently drops both interim statements - the two documents this whole
// feature exists to collect.
export function normaliseCategory(value: unknown): string {
  return String(value ?? "")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const ACCOUNTANT_ALLOWED_CATEGORIES = new Set(
  [...ACCOUNTANT_DOC_CATEGORIES, ...ACCOUNTANT_ALWAYS_AVAILABLE].map(normaliseCategory)
);

// Keep applicant-only forms (in particular personal net worth) out of both the
// accountant read surface and its upload front door.
const ACCOUNTANT_HIDDEN_CATEGORY =
  /personal\s*net\s*worth|net\s*worth\s*statement|government\s*id|driver'?s?\s*licen[cs]e|passport/i;

export function isAccountantVisible(category: unknown): boolean {
  const value = String(category ?? "").trim();
  if (!value) return false;
  if (ACCOUNTANT_HIDDEN_CATEGORY.test(value)) return false;
  return ACCOUNTANT_ALLOWED_CATEGORIES.has(normaliseCategory(value));
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

// BF_SERVER_SIGNED_TERM_SHEET_v7 - the client returns their signed copy of the
// lender's term sheet under this category. Not accountant-visible: signing a
// financing agreement is the applicant's act, not their accountant's.
export const SIGNED_TERM_SHEET_CATEGORY = "signed_term_sheet";

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

// BF_SERVER_ACCOUNTANT_SURFACE_v2 - who am I, and which of my client's
// applications am I here for. Scoped by the contact on the token, never by
// anything in the request.
router.get(
  "/me",
  requireAccountant,
  safeHandler(async (req: any, res: any) => {
    const { contactId } = req.accountant;
    const who = await pool.query(
      `SELECT id::text AS id, first_name, last_name, email, phone
         FROM contacts WHERE id::text = ($1)::text LIMIT 1`,
      [contactId]
    );
    if (who.rowCount === 0) {
      res.status(403).json({ error: "accountant_contact_missing" });
      return;
    }
    // BF_SERVER_ACCOUNTANT_INVITE_SCOPE_v1 - join through the invitation.
    // Amount and date come back so two applications for the same business are
    // told apart in the picker.
    const apps = await pool.query(
      `SELECT a.id::text AS id,
              COALESCE(NULLIF(ai.business_name, ''), a.name) AS business_name,
              a.requested_amount,
              a.created_at
         FROM accountant_invites ai
         JOIN applications a ON a.id::text = ai.application_id::text
        WHERE ai.contact_id::text = ($1)::text
        ORDER BY a.created_at DESC`,
      [contactId]
    ).catch(() => ({ rows: [] as any[] }));
    const c: any = who.rows[0];
    res.json({
      status: "ok",
      data: {
        accountant: {
          id: c.id,
          name: [c.first_name, c.last_name].filter(Boolean).join(" ") || null,
          email: c.email ?? null,
          phone: c.phone ?? null,
        },
        applications: apps.rows,
      },
    });
  })
);

// BF_SERVER_ACCOUNTANT_SURFACE_v2 - the filtered document list for one
// application: what a lender asked for, cut down to the allow-list, plus the
// always-available slots and the CMP forms.
router.get(
  "/applications/:id",
  requireAccountant,
  safeHandler(async (req: any, res: any) => {
    const { contactId } = req.accountant;
    const id = String(req.params.id ?? "").trim();
    if (!id) {
      res.status(400).json({ error: "application_id_required" });
      return;
    }
    // BF_SERVER_ACCOUNTANT_INVITE_SCOPE_v1
    const owned = await pool.query(
      `SELECT a.id::text AS id,
              COALESCE(NULLIF(ai.business_name, ''), a.name) AS business_name
         FROM applications a
         JOIN accountant_invites ai ON ai.application_id::text = a.id::text
        WHERE a.id::text = ($1)::text AND ai.contact_id::text = ($2)::text
        LIMIT 1`,
      [id, contactId]
    );
    if (owned.rowCount === 0) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const outstanding = await computeOutstandingDocs(id).catch(() => ({
      stillNeeded: [] as any[],
      rejected: [] as any[],
      required: [] as any[],
    }));

    // Only what this application actually requires. Appending the
    // always-available categories here was padding a one-document request into
    // a four-document chore.
    const requested = (outstanding.required ?? [])
      .map((d: any) => String(d?.document_type ?? ""))
      .filter((d: string) => d && isAccountantVisible(d));

    // BF_SERVER_ACCOUNTANT_FORMS_REQUESTED_v5 - same treatment for forms.
    // computeOutstandingDocs returns every requested item; the form keys are the
    // subset that render as CMP forms rather than uploads.
    const requestedForms = (outstanding.required ?? [])
      .map((d: any) => String(d?.document_type ?? ""))
      .filter((d: string) => d && isAccountantForm(d));

    // "Received" has to mean a file exists, not "no lender happened to ask for
    // this". Rejected documents do not count - the accountant needs to send
    // that one again.
    const held = await pool.query<{ category: string }>(
      `SELECT DISTINCT d.category
         FROM documents d
        WHERE d.application_id::text = ($1)::text
          AND COALESCE(d.status, '') <> 'rejected'`,
      [id]
    ).catch(() => ({ rows: [] as Array<{ category: string }> }));
    const receivedCategories = new Set(held.rows.map((r) => normaliseCategory(r.category)));

    res.json({
      status: "ok",
      data: {
        application: owned.rows[0],
        uploads: requested.map((category) => ({
          category,
          outstanding: !receivedCategories.has(normaliseCategory(category)),
        })),
        // BF_SERVER_ACCOUNTANT_FORMS_REQUESTED_v5 - only forms this application
        // actually requires, intersected with the allow-list.
        forms: requestedForms,
      },
    });
  })
);

// BF_SERVER_ACCOUNTANT_UPLOAD_v1
router.post(
  "/applications/:id/upload",
  requireAccountant,
  // BF_SERVER_ACCOUNTANT_FORMS_REQUESTED_v5 - accept up to twenty files.
  upload.array("files", 20),
  safeHandler(async (req: any, res: any) => {
    const { contactId } = req.accountant;
    const id = String(req.params.id ?? "").trim();
    const category = String(req.body?.category ?? "").trim();
    // Accept both shapes so an older client that posts a single "file" still
    // works while the new one posts "files".
    const files: any[] = Array.isArray(req.files) && req.files.length
      ? req.files
      : (req.file ? [req.file] : []);
    const file = files[0];

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
    // BF_SERVER_ACCOUNTANT_INVITE_SCOPE_v1
    const owned = await pool.query<{ pipeline_state: string | null }>(
      `SELECT a.pipeline_state
         FROM applications a
         JOIN accountant_invites ai ON ai.application_id::text = a.id::text
        WHERE a.id::text = ($1)::text AND ai.contact_id::text = ($2)::text
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

      // BF_SERVER_ACCOUNTANT_FORMS_REQUESTED_v5 - every additional file goes
      // through the same path as the first. A failure on file 3 must not lose
      // files 1 and 2, so each is persisted independently and the outcome is
      // reported per file.
      const extraResults: any[] = [];
      for (const extra of files.slice(1)) {
        if (!isAllowedAccountantMime(extra?.mimetype)) {
          extraResults.push({ name: extra?.originalname ?? null, ok: false, error: "MIME_NOT_PERMITTED" });
          continue;
        }
        try {
          const extraResult = await persistAndEnqueue({
            applicationId: id,
            category,
            file: extra,
            uploadedBy: `accountant:${contactId}`,
          });
          extraResults.push({ name: extra.originalname, ok: true, id: extraResult.id });
        } catch (e: any) {
          extraResults.push({ name: extra?.originalname ?? null, ok: false, error: String(e?.message ?? "upload_failed") });
        }
      }

      res.json({
        status: "ok",
        data: {
          additional: extraResults,
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
  // BF_SERVER_ACCOUNTANT_INVITE_SCOPE_v1
  const r = await pool.query(
    `SELECT 1
       FROM applications a
       JOIN accountant_invites ai ON ai.application_id::text = a.id::text
      WHERE a.id::text = ($1)::text AND ai.contact_id::text = ($2)::text
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
