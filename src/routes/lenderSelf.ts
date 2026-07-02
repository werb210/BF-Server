// BF_SERVER_LENDER_SELF_v1 - lender self-service API. Gated to the Lender role and scoped to the
// token's lenderId. Lenders read/edit their own profile and list/create/edit their own products.
import { Router, type NextFunction, type Request, type Response } from "express";
import jwt from "jsonwebtoken";
import { ROLES } from "../auth/roles.js";
import { pool } from "../db.js";
import { safeHandler } from "../middleware/safeHandler.js";

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

router.get(
  "/me",
  requireLender,
  safeHandler(async (req: LenderRequest, res: Response) => {
    const result = await pool.query(
      `SELECT id, name, phone, website, description, contact_name, contact_email, contact_phone,
              street, city, region, postal_code, country, silo, active
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
    };
    const keys = Object.keys(fields).filter((key) => body[key] !== undefined);

    if (keys.length === 0) return res.status(400).json({ status: "error", message: "no_fields" });

    const sets = keys.map((key, index) => `${key} = $${index + 2}`).join(", ");
    const values = keys.map((key) => fields[key]);
    const result = await pool.query(
      `UPDATE lenders
          SET ${sets}, updated_at = now()
        WHERE id::text = $1
        RETURNING id, name, phone, website, description, contact_name, contact_email, contact_phone,
                  street, city, region, postal_code, country, silo, active`,
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
      `SELECT id, name, description, category, type, country, active,
              amount_min, amount_max, interest_min, interest_max, rate_kind, rate_type,
              min_credit_score, eligibility_notes
         FROM lender_products
        WHERE lender_id::text = $1 AND silo = 'BF'
        ORDER BY category, name`,
      [req.lenderId]
    );

    return res.json({ status: "ok", data: result.rows });
  })
);

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
      description: str(body.description),
      amount_min: numOrNull(body.amount_min),
      amount_max: numOrNull(body.amount_max),
      interest_min: str(body.interest_min),
      interest_max: str(body.interest_max),
      min_credit_score: numOrNull(body.min_credit_score),
      eligibility_notes: str(body.eligibility_notes),
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
         (id, lender_id, name, description, category, type, country, silo, active,
          amount_min, amount_max, interest_min, interest_max, rate_kind, rate_type,
          min_credit_score, eligibility_notes)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $4, $5, 'BF', true,
          $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id`,
      [
        req.lenderId,
        value.name,
        value.description,
        value.category,
        value.country,
        value.amount_min,
        value.amount_max,
        value.interest_min,
        value.interest_max,
        value.rate_kind,
        value.rate_type,
        value.min_credit_score,
        value.eligibility_notes,
      ]
    );

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
          SET name = $3, description = $4, category = $5, type = $5, country = $6,
              amount_min = $7, amount_max = $8, interest_min = $9, interest_max = $10,
              rate_kind = $11, rate_type = $12, min_credit_score = $13, eligibility_notes = $14,
              updated_at = now()
        WHERE id::text = $2 AND lender_id::text = $1 AND silo = 'BF'
        RETURNING id`,
      [
        req.lenderId,
        req.params.id,
        value.name,
        value.description,
        value.category,
        value.country,
        value.amount_min,
        value.amount_max,
        value.interest_min,
        value.interest_max,
        value.rate_kind,
        value.rate_type,
        value.min_credit_score,
        value.eligibility_notes,
      ]
    );

    if (!result.rows[0]) return res.status(404).json({ status: "error", message: "product_not_found_or_not_yours" });
    return res.json({ status: "ok", data: { id: result.rows[0].id } });
  })
);

export default router;
