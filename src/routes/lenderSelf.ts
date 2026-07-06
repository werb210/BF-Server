// BF_SERVER_LENDER_SELF_v1 - lender self-service API. Gated to the Lender role and scoped to the
// token's lenderId. Lenders read/edit their own profile and list/create/edit their own products.
// BF_SERVER_LENDER_SELF_V2 - lender_products.description is a phantom column (dropped by
// migration 041, never re-added) and 500ed every GET/POST/PATCH on /products. Removed it,
// added term_min/term_max/rate_period_days (real columns: 110 + v640), and added the
// /uploads pair (lender_documents + Maya ingest), mirroring the staff pipeline in
// portalLenders.ts.
import { Router, type NextFunction, type Request, type Response } from "express";
import fs from "fs";
import path from "path";
import multer from "multer";
import jwt from "jsonwebtoken";
import { ROLES } from "../auth/roles.js";
import { pool } from "../db.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { notifyAllStaff } from "../services/notifications/notifyAllStaff.js"; // BF_SERVER_LENDER_PRODUCT_NOTIFY_v1

const router = Router();

interface LenderRequest extends Request {
  lenderId?: string;
}

function requireLender(req: LenderRequest, res: Response, next: NextFunction): void {
  const token = req.headers.authorization?.split(" ")[1];
  const secret = process.env.JWT_SECRET;
  if (!token || !secret) {
    res.status(401).json({ status: "error", message: "Unauthorized" });
    return;
  }

  try {
    const decoded = jwt.verify(token, secret) as Record<string, unknown>;
    const role = String(decoded.role ?? "");
    const lenderId = decoded.lenderId ?? decoded.lender_id ?? null;

    if (role !== ROLES.LENDER) {
      res.status(403).json({ status: "error", message: "lender_role_required" });
      return;
    }
    if (!lenderId) {
      res.status(403).json({ status: "error", message: "no_lender_binding" });
      return;
    }

    req.lenderId = String(lenderId);
    next();
  } catch {
    res.status(401).json({ status: "error", message: "Unauthorized" });
  }
}

const CATEGORIES = ["LOC", "TERM", "FACTORING", "PO", "EQUIPMENT", "MCA", "MEDIA", "ABL", "SBA", "STARTUP"];
const COUNTRIES = ["CA", "US", "BOTH"];
const RATE_KINDS = ["apr", "monthly", "factor"];
const RATE_TYPES = ["VARIABLE", "FIXED"];

const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const numOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
};

function normalizeRequiredDocuments(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  return JSON.stringify(
    (value as Array<Record<string, unknown>>)
      .filter((doc) => doc && typeof doc === "object" && String(doc.category ?? "").trim() !== "")
      .map((doc) => ({
        category: String(doc.category).trim(),
        required: true,
        description: null,
        stage: Number(doc.stage) === 2 ? 2 : 1,
      }))
  );
}

router.get(
  "/me",
  requireLender,
  safeHandler(async (req: LenderRequest, res: Response) => {
    const result = await pool.query(
      // see BF_SERVER_LENDER_OTP_PHONE_COLUMNS_v2 in auth.ts: staff edits land
      // in primary_contact_phone; show whichever is set.
      `SELECT id, name, phone, website, description, COALESCE(NULLIF(primary_contact_name, ''), contact_name) AS contact_name,
              COALESCE(NULLIF(primary_contact_email, ''), contact_email) AS contact_email,
              COALESCE(NULLIF(primary_contact_phone, ''), contact_phone) AS contact_phone,
              street, city, region, postal_code, country, silo, active,
              application_url, announcement, submission_method, submission_email
         FROM lenders
        WHERE id::text = $1
        LIMIT 1`,
      [req.lenderId]
    );

    if (!result.rows[0]) return res.status(404).json({ status: "error", message: "lender_not_found" });
    return res.json({ status: "ok", data: result.rows[0] });
  })
);

router.patch(
  "/me",
  requireLender,
  safeHandler(async (req: LenderRequest, res: Response) => {
    const body = req.body ?? {};
    const fields: Record<string, string | null> = {
      name: str(body.name),
      phone: str(body.phone),
      website: str(body.website),
      description: str(body.description),
      contact_name: str(body.contact_name),
      contact_email: str(body.contact_email),
      contact_phone: str(body.contact_phone),
      street: str(body.street),
      city: str(body.city),
      region: str(body.region),
      postal_code: str(body.postal_code),
      country: str(body.country),
      // BF_SERVER_LENDER_COMPANY_PARITY_v1 - same field set as the staff lender form
      // (commission-free); lenders can maintain these themselves.
      application_url: str(body.application_url),
      announcement: str(body.announcement),
      submission_method: body.submission_method !== undefined && body.submission_method !== null && String(body.submission_method).trim() !== "" ? String(body.submission_method).trim().toUpperCase() : null,
      submission_email: str(body.submission_email),
    };
    const keys = Object.keys(fields).filter((key) => body[key] !== undefined);

    if (keys.length === 0) return res.status(400).json({ status: "error", message: "no_fields" });

    const sets = keys.map((key, index) => `${key} = $${index + 2}`).join(", ");
    const values = keys.map((key) => fields[key]);
    // BF_SERVER_LENDER_CONTACT_SYNC_v3 - staff forms read/write primary_contact_*
    // while this portal edits contact_*; keep both column families in sync so a
    // change made in either form always shows in the other.
    const SYNC_COLS: Record<string, string> = {
      contact_phone: "primary_contact_phone",
      contact_name: "primary_contact_name",
      contact_email: "primary_contact_email",
    };
    const extraSync = keys
      .filter((key) => SYNC_COLS[key] !== undefined)
      .map((key) => `, ${SYNC_COLS[key]} = $${keys.indexOf(key) + 2}`)
      .join("");
    const result = await pool.query(
      `UPDATE lenders
          SET ${sets}${extraSync}, updated_at = now()
        WHERE id::text = $1
        RETURNING id, name, phone, website, description,
                  COALESCE(NULLIF(primary_contact_name, ''), contact_name) AS contact_name,
                  COALESCE(NULLIF(primary_contact_email, ''), contact_email) AS contact_email,
                  COALESCE(NULLIF(primary_contact_phone, ''), contact_phone) AS contact_phone,
                  street, city, region, postal_code, country, silo, active,
                  application_url, announcement, submission_method, submission_email`,
      [req.lenderId, ...values]
    );

    if (!result.rows[0]) return res.status(404).json({ status: "error", message: "lender_not_found" });
    return res.json({ status: "ok", data: result.rows[0] });
  })
);

router.get(
  "/products",
  requireLender,
  safeHandler(async (req: LenderRequest, res: Response) => {
    const result = await pool.query(
      `SELECT id, name, category, type, country, active,
              amount_min, amount_max, interest_min, interest_max, rate_kind, rate_type,
              rate_period_days, term_min, term_max, min_credit_score, eligibility_notes,
              required_documents
         FROM lender_products
        WHERE lender_id::text = $1 AND silo = 'BF'
        ORDER BY category, name`,
      [req.lenderId]
    );

    return res.json({ status: "ok", data: result.rows });
  })
);

// BF_SERVER_LENDER_PRODUCT_NOTIFY_v1 - fire-and-forget staff notification when a
// lender creates or edits one of their products. contextUrl opens the product
// editor in the staff portal (LendersPage reads ?editProduct=). refId is unique
// per event so every change notifies (the notifications table dedupes on refId).
function notifyStaffOfProductChange(lenderId: string, productId: string, productName: string, verb: "created" | "updated"): void {
  void (async () => {
    const lender = await pool.query<{ name: string | null }>(`SELECT name FROM lenders WHERE id::text = $1 LIMIT 1`, [lenderId]);
    const lenderName = lender.rows[0]?.name ?? "A lender";
    await notifyAllStaff({
      pool,
      notificationType: "lender_product_updated",
      title: "Lender product " + verb,
      body: lenderName + " " + verb + " product \"" + productName + "\" in the lender portal - please review.",
      refTable: "lender_products",
      refId: productId + ":" + Date.now(),
      contextUrl: "/lenders?editProduct=" + encodeURIComponent(productId),
      silo: "BF",
    });
  })().catch((err) => console.error("[lender-self] product notify failed:", err));
}

function validateProduct(body: Record<string, unknown>): { error?: string; value?: Record<string, unknown> } {
  const name = str(body.name);
  const category = (str(body.category) ?? "").toUpperCase();
  const country = (str(body.country) ?? "CA").toUpperCase();
  const rateKind = body.rate_kind ? String(body.rate_kind).toLowerCase() : null;
  const rateType = body.rate_type ? String(body.rate_type).toUpperCase() : null;

  if (!name) return { error: "name_required" };
  if (!CATEGORIES.includes(category)) return { error: `category must be one of ${CATEGORIES.join(", ")}` };
  if (!COUNTRIES.includes(country)) return { error: "country must be CA, US, or BOTH" };
  if (rateKind && !RATE_KINDS.includes(rateKind)) return { error: "rate_kind must be apr, monthly, or factor" };
  if (rateType && !RATE_TYPES.includes(rateType)) return { error: "rate_type must be VARIABLE or FIXED" };

  return {
    value: {
      name,
      category,
      country,
      rate_kind: rateKind,
      rate_type: rateType,
      amount_min: numOrNull(body.amount_min),
      amount_max: numOrNull(body.amount_max),
      interest_min: str(body.interest_min),
      interest_max: str(body.interest_max),
      rate_period_days: numOrNull(body.rate_period_days),
      term_min: numOrNull(body.term_min),
      term_max: numOrNull(body.term_max),
      min_credit_score: numOrNull(body.min_credit_score),
      eligibility_notes: str(body.eligibility_notes),
      // BF_SERVER_LENDER_PRODUCT_PARITY_v1 - active toggle + required documents,
      // same as the staff product form (only commission stays staff-only).
      active: typeof body.active === "boolean" ? body.active : null,
      required_documents: normalizeRequiredDocuments(body.required_documents),
    },
  };
}

router.post(
  "/products",
  requireLender,
  safeHandler(async (req: LenderRequest, res: Response) => {
    const { error, value } = validateProduct(req.body ?? {});
    if (error || !value) return res.status(400).json({ status: "error", message: error });

    const result = await pool.query(
      `INSERT INTO lender_products
         (id, lender_id, name, category, type, country, silo, active,
          amount_min, amount_max, interest_min, interest_max, rate_kind, rate_type,
          rate_period_days, term_min, term_max, min_credit_score, eligibility_notes,
          required_documents)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $3, $4, 'BF', COALESCE($16, true),
          $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
          COALESCE($17::jsonb, '[]'::jsonb))
       RETURNING id, name`,
      [
        req.lenderId,
        value.name,
        value.category,
        value.country,
        value.amount_min,
        value.amount_max,
        value.interest_min,
        value.interest_max,
        value.rate_kind,
        value.rate_type,
        value.rate_period_days,
        value.term_min,
        value.term_max,
        value.min_credit_score,
        value.eligibility_notes,
        value.active,
        value.required_documents,
      ]
    );

    if (result.rows[0]?.id) notifyStaffOfProductChange(req.lenderId as string, String(result.rows[0].id), String(result.rows[0].name ?? value.name), "created");

    return res.status(201).json({ status: "ok", data: { id: result.rows[0]?.id ?? null } });
  })
);

router.patch(
  "/products/:id",
  requireLender,
  safeHandler(async (req: LenderRequest, res: Response) => {
    const { error, value } = validateProduct(req.body ?? {});
    if (error || !value) return res.status(400).json({ status: "error", message: error });

    const result = await pool.query(
      `UPDATE lender_products
          SET name = $3, category = $4, type = $4, country = $5,
              amount_min = $6, amount_max = $7, interest_min = $8, interest_max = $9,
              rate_kind = $10, rate_type = $11, rate_period_days = $12,
              term_min = $13, term_max = $14, min_credit_score = $15, eligibility_notes = $16,
              active = COALESCE($17, active),
              required_documents = COALESCE($18::jsonb, required_documents),
              updated_at = now()
        WHERE id::text = $2 AND lender_id::text = $1 AND silo = 'BF'
        RETURNING id, name`,
      [
        req.lenderId,
        req.params.id,
        value.name,
        value.category,
        value.country,
        value.amount_min,
        value.amount_max,
        value.interest_min,
        value.interest_max,
        value.rate_kind,
        value.rate_type,
        value.rate_period_days,
        value.term_min,
        value.term_max,
        value.min_credit_score,
        value.eligibility_notes,
        value.active,
        value.required_documents,
      ]
    );

    if (!result.rows[0]) return res.status(404).json({ status: "error", message: "product_not_found_or_not_yours" });
    // BF_SERVER_LENDER_PRODUCT_NOTIFY_v1
    notifyStaffOfProductChange(req.lenderId as string, String(result.rows[0].id), String(result.rows[0].name ?? value.name), "updated");
    return res.json({ status: "ok", data: { id: result.rows[0].id } });
  })
);

// BF_SERVER_LENDER_SELF_UPLOADS_v1 / BF_SERVER_LENDER_SELF_V2 - lender uploads (product sheets / marketing -> trains Maya).
// Mirrors the staff pipeline in portalLenders.ts: multer disk file -> lender_documents
// row -> best-effort POST to MAYA_URL /api/knowledge/ingest. uploaded_by is NULL because
// lender tokens carry no users.id (FK references users).
const uploadDir = "/tmp/lender-documents";
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")}`),
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
});

router.get(
  "/uploads",
  requireLender,
  safeHandler(async (req: LenderRequest, res: Response) => {
    const result = await pool.query(
      `SELECT id, filename, mime_type, created_at
         FROM lender_documents
        WHERE lender_id::text = $1
        ORDER BY created_at DESC`,
      [req.lenderId]
    );
    return res.json({ status: "ok", data: result.rows });
  })
);

router.post(
  "/uploads",
  requireLender,
  upload.single("file"),
  safeHandler(async (req: LenderRequest, res: Response) => {
    const file = (req as unknown as { file?: Express.Multer.File }).file;
    if (!file) return res.status(400).json({ status: "error", message: "file_required" });

    const blobUrl = `file://${path.join(uploadDir, file.filename)}`;
    const result = await pool.query(
      `INSERT INTO lender_documents (id, lender_id, filename, mime_type, blob_url, uploaded_by, created_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, NULL, now())
       RETURNING id, filename, mime_type, created_at`,
      [req.lenderId, file.originalname, file.mimetype || "application/octet-stream", blobUrl]
    );

    const mayaUrl = process.env.MAYA_URL;
    if (mayaUrl) {
      await fetch(`${mayaUrl}/api/knowledge/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          lenderId: req.lenderId,
          filename: file.originalname,
          blobUrl,
          mimeType: file.mimetype || "application/octet-stream",
        }),
      }).catch(() => undefined);
    }

    return res.status(201).json({ status: "ok", data: result.rows[0] });
  })
);

export default router;
