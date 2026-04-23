import express, { type Request, type Response } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { requireAuth } from "../middleware/auth.js";
import { sha256 } from "../lib/hash.js";
import { ok, fail } from "../middleware/response.js";
import { toStringSafe } from "../utils/toStringSafe.js";
import { runQuery } from "../lib/db.js";

const router = express.Router();

const UPLOAD_ROOT = process.env.UPLOAD_ROOT || path.join(process.cwd(), "uploads");
await fs.mkdir(UPLOAD_ROOT, { recursive: true }).catch(() => {});

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_ROOT),
    filename: (_req, file, cb) => cb(null, `${randomUUID()}${path.extname(file.originalname) || ""}`),
  }),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
});

/**
 * PUBLIC — POST /api/documents/public-upload
 * The BF-client wizard (Step 5) and the Website Capital Readiness flow call this
 * without a portal session. Scoped to an applicationId the client already has.
 * Not authenticated by JWT on purpose: the applicationId is the bearer credential.
 */
router.post("/public-upload", upload.single("file"), async (req: Request, res: Response) => {
  const applicationId = typeof req.body?.applicationId === "string" ? req.body.applicationId.trim() : "";
  const category      = typeof req.body?.category === "string"      ? req.body.category.trim()      : "";
  if (!applicationId || !category) return fail(res, 400, "MISSING_FIELDS");
  const file = (req as Request & { file?: Express.Multer.File }).file;
  if (!file) return fail(res, 400, "NO_FILE");

  const buf = await fs.readFile(file.path);
  const hash = sha256(buf);
  const id = randomUUID();

  try {
    await runQuery(
      `INSERT INTO documents (id, application_id, filename, hash, category, storage_path, size_bytes, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'uploaded', now(), now())`,
      [id, applicationId, file.originalname, hash, category, file.path, file.size]
    );
  } catch (err) {
    // If the documents table schema is older, fall back to the minimum-columns insert
    // so we never silently lose an upload.
    await runQuery(
      `INSERT INTO documents (application_id, filename, hash) VALUES ($1, $2, $3)`,
      [applicationId, file.originalname, hash]
    );
  }

  return ok(res, { id, applicationId, filename: file.originalname, hash, size: file.size, status: "uploaded" });
});

/** Authenticated staff upload (portal) — preserved for backwards compat. */
router.post("/upload", requireAuth, upload.single("file"), async (req: Request, res: Response) => {
  const applicationId = typeof req.body?.applicationId === "string" ? req.body.applicationId.trim() : null;
  const category      = typeof req.body?.category === "string"      ? req.body.category.trim()      : null;
  const file = (req as Request & { file?: Express.Multer.File }).file;
  if (!applicationId || !category || !file) return fail(res, 400, "INVALID_DOCUMENT_UPLOAD_PAYLOAD");

  const buf = await fs.readFile(file.path);
  const hash = sha256(buf);
  const id = randomUUID();

  try {
    await runQuery(
      `INSERT INTO documents (id, application_id, filename, hash, category, storage_path, size_bytes, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'uploaded', now(), now())`,
      [id, applicationId, file.originalname, hash, category, file.path, file.size]
    );
  } catch {
    await runQuery(
      `INSERT INTO documents (application_id, filename, hash) VALUES ($1, $2, $3)`,
      [applicationId, file.originalname, hash]
    );
  }

  return ok(res, { id, applicationId, filename: file.originalname, hash, size: file.size, status: "uploaded" });
});

router.post("/:id/accept", requireAuth, async (req: Request, res: Response) => {
  const id = toStringSafe(req.params.id);
  await runQuery(`UPDATE documents SET status='accepted', updated_at=now() WHERE id=$1`, [id]).catch(() => {});
  return ok(res, { id, status: "accepted" });
});

router.post("/:id/reject", requireAuth, async (req: Request, res: Response) => {
  const id = toStringSafe(req.params.id);
  await runQuery(`UPDATE documents SET status='rejected', updated_at=now() WHERE id=$1`, [id]).catch(() => {});
  return ok(res, { id, status: "rejected" });
});

export default router;
