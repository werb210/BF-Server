"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = require("../../db");
const router = (0, express_1.Router)();
/**
 * GET /api/client/lenders
 * Public, read-only, ACTIVE lenders only
 */
router.get("/", async (_req, res, next) => {
    try {
        const { rows } = await (0, db_1.runQuery)(`
      SELECT id, name
      FROM lenders
      WHERE active = true
      ORDER BY name ASC
      `);
        res["json"]({ ok: true, data: rows });
    }
    catch (err) {
        next(err);
    }
});
exports.default = router;
