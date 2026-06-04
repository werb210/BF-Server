// BF_SERVER_BLOCK_v81_CLIENT_LENDER_PRODUCTS — accept ?category=<X> filter.
// BF_SERVER_BLOCK_v83_LENDER_PRODUCTS_STATUS_FIELD_v1 — also expose active
// as status:'active'|'inactive' so clients that filter by status work.
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
              amount_min, amount_max, required_documents,
              CASE WHEN active THEN 'active' ELSE 'inactive' END AS status,
              active
       FROM lender_products
       WHERE ${where}
       ORDER BY category, name
       LIMIT 500`,
      params
    );
    // BF_SERVER_BLOCK_v722_LENDER_COUNTRY_FILTER — gate by applicant country.
    // Previously this route had NO country filter, so a Canadian applicant was
    // served every active product (US lenders included). Normalize both sides so
    // "Canada"/"CA" and "United States"/"US"/"USA" compare; null or "BOTH"/"ALL"
    // products are treated as available everywhere.
    const norm = (c: unknown): string | null => {
      if (c === null || c === undefined) return null;
      const u = String(c).trim().toUpperCase();
      if (!u) return null;
      if (u === "BOTH" || u === "ALL") return "BOTH";
      if (u.startsWith("US") || u.includes("UNITED STATES")) return "US";
      if (u.startsWith("CA") || u.includes("CANADA")) return "CA";
      return u;
    };
    const wantCountry = norm(req.query.country);
    const filteredRows = wantCountry && wantCountry !== "BOTH"
      ? r.rows.filter((row: any) => {
          const pc = norm(row.country);
          return pc === null || pc === "BOTH" || pc === wantCountry;
        })
      : r.rows;
    return ok(res, filteredRows);
  } catch (err) {
    console.error("[client/lender-products] failed", err);
    return fail(res, 500, "FAILED");
  }
});

export default router;
