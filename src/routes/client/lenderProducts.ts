// BF_SERVER_BLOCK_v81_CLIENT_LENDER_PRODUCTS — accept ?category=<X> filter.
// Without this, Step 5 of the wizard fetches every lender product the firm
// has and tries to render document requirements for unrelated categories.
import { Router } from "express";
import { pool } from "../../db.js";
import { ok, fail } from "../../middleware/response.js";

const router = Router();

router.get("/lender-products", async (req, res) => {
  try {
    const category = typeof req.query.category === "string"
      ? req.query.category.trim().toUpperCase()
      : "";
    const params: unknown[] = [];
    let where = "active = true";
    if (category) {
      params.push(category);
      where += ` AND category = $${params.length}`;
    }
    const r = await pool.query(
      `SELECT id, lender_id, name, category, country, rate_type,
              interest_min, interest_max, term_min, term_max, term_unit,
              amount_min, amount_max, required_documents
       FROM lender_products
       WHERE ${where}
       ORDER BY category, name
       LIMIT 500`,
      params
    );
    return ok(res, r.rows);
  } catch (err) {
    console.error("[client/lender-products] failed", err);
    return fail(res, 500, "FAILED");
  }
});

export default router;
