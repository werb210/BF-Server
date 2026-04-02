import { Router } from "express";
import { pool, runQuery } from "../../db";

const router = Router();

/**
 * GET /api/client/lenders
 * Public, read-only, ACTIVE lenders only
 */
router.get("/", async (_req, res, next) => {
  try {
    const { rows } = await runQuery(
      `
      SELECT id, name
      FROM lenders
      WHERE active = true
      ORDER BY name ASC
      `
    );

    res["json"]({ ok: true, data: rows });
  } catch (err) {
    next(err);
  }
});

export default router;
