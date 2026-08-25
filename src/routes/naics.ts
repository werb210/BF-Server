// BF_SERVER_NAICS_v83
// Mirrors bi-server/src/routes/biNaicsRoutes.ts so the two silos behave the same
// way, against BF's own naics_codes table. Public and unauthenticated: it is
// called from the application wizard before any account exists, exactly like
// /public/application/start. It exposes nothing but a public government code list.
import { Router } from "express";
import { pool } from "../db.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { respondOk } from "../utils/respondOk.js";

const router = Router();

router.get("/", safeHandler(async (req: any, res: any) => {
  const q = String(req.query.q ?? "").trim();
  const country = String(req.query.country ?? "US").trim().toUpperCase();
  if (country !== "CA" && country !== "US") {
    respondOk(res, { results: [] });
    return;
  }
  // Two characters is the point where a prefix search stops returning the whole
  // table. Below that, return nothing rather than 25 arbitrary rows.
  if (q.length < 2) {
    respondOk(res, { results: [] });
    return;
  }

  const numeric = /^\d+$/.test(q);
  const { rows } = numeric
    ? await pool.query(
        `SELECT code, country, title
           FROM naics_codes
          WHERE country = $1 AND code LIKE $2
          ORDER BY code
          LIMIT 25`,
        [country, q + "%"],
      )
    : await pool.query(
        `SELECT code, country, title
           FROM naics_codes
          WHERE country = $1 AND title ILIKE $2
          ORDER BY title
          LIMIT 25`,
        [country, "%" + q + "%"],
      );
  respondOk(res, { results: rows });
}));

export default router;
