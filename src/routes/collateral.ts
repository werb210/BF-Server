// v693: collateral attachment library. Admins upload/manage; all staff list/attach.
import { Router } from "express";
import multer from "multer";
import { pool } from "../db.js";
import { requireAuth, requireAuthorization } from "../middleware/auth.js";
import { ROLES } from "../auth/roles.js";
import { safeHandler } from "../middleware/safeHandler.js";
import { getSilo } from "../middleware/silo.js";
import { getStorage } from "../lib/storage/index.js";

const router = Router();
router.use(requireAuth);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

router.get("/", safeHandler(async (req: any, res: any) => {
  const silo = getSilo(res);
  const audience = req.query.audience ? String(req.query.audience) : null;
  const docType = req.query.doc_type ? String(req.query.doc_type) : null;
  const { rows } = await pool.query(
    `SELECT id, name, audience, doc_type, content_type, size_bytes, created_at
       FROM collateral_assets
      WHERE silo IN ('BF', $1)
        AND ($2::text IS NULL OR audience = $2)
        AND ($3::text IS NULL OR doc_type = $3)
      ORDER BY created_at DESC`,
    [silo, audience, docType]
  );
  res.json({ items: rows });
}));

router.post("/", requireAuthorization({ roles: [ROLES.ADMIN] }), upload.single("file"), safeHandler(async (req: any, res: any) => {
  const silo = getSilo(res);
  const userId = req.user?.id ?? req.user?.userId ?? null;
  const file = (req as any).file;
  if (!file) return res.status(400).json({ error: "file required" });
  const name = String(req.body?.name ?? file.originalname ?? "Untitled").slice(0, 200);
  const audience = (String(req.body?.audience ?? "").slice(0, 60)) || null;
  const docType = (String(req.body?.doc_type ?? "").slice(0, 60)) || null;
  const put = await getStorage().put({
    buffer: file.buffer,
    filename: file.originalname || `${name}.pdf`,
    contentType: file.mimetype || "application/pdf",
    pathPrefix: `collateral/${silo}`,
  });
  const { rows } = await pool.query(
    `INSERT INTO collateral_assets (name, audience, doc_type, blob_name, content_type, size_bytes, silo, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id, name, audience, doc_type, content_type, size_bytes, created_at`,
    [name, audience, docType, put.blobName, file.mimetype || "application/pdf", put.sizeBytes, silo, userId]
  );
  res.status(201).json({ item: rows[0] });
}));

router.get("/:id/file", safeHandler(async (req: any, res: any) => {
  const silo = getSilo(res);
  const { rows } = await pool.query(
    `SELECT name, content_type, blob_name FROM collateral_assets WHERE id = $1 AND silo IN ('BF', $2) LIMIT 1`,
    [req.params.id, silo]
  );
  const row = rows[0];
  if (!row) return res.status(404).json({ error: "not_found" });
  const obj = await getStorage().get(row.blob_name);
  if (!obj) return res.status(404).json({ error: "blob_missing" });
  res.setHeader("Content-Type", row.content_type || obj.contentType || "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${String(row.name).replace(/"/g, "")}"`);
  res.send(obj.buffer);
}));

router.delete("/:id", requireAuthorization({ roles: [ROLES.ADMIN] }), safeHandler(async (req: any, res: any) => {
  const silo = getSilo(res);
  const { rows } = await pool.query(`SELECT blob_name FROM collateral_assets WHERE id = $1 AND silo = $2 LIMIT 1`, [req.params.id, silo]);
  if (!rows[0]) return res.status(404).json({ error: "not_found" });
  try { await getStorage().delete(rows[0].blob_name); } catch { /* blob already gone */ }
  await pool.query(`DELETE FROM collateral_assets WHERE id = $1 AND silo = $2`, [req.params.id, silo]);
  res.json({ ok: true });
}));

export default router;
