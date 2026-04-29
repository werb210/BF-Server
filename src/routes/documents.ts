// BF_AZURE_OCR_TERMSHEET_v44 — replaces multer.diskStorage with multer.memoryStorage
// and routes uploads through the storage abstraction. After a successful row
// insert, enqueue OCR via the existing service function. Banking auto-worker
// picks up the document once OCR completes.
import express, { type Request, type Response } from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { requireAuth } from "../middleware/auth.js";
import { ok, fail } from "../middleware/response.js";
import { toStringSafe } from "../utils/toStringSafe.js";
import { runQuery } from "../lib/db.js";
import { getStorage } from "../lib/storage/index.js";
import { enqueueOcrForDocument } from "../modules/ocr/ocr.service.js";

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

async function persistAndEnqueue(opts: {
  applicationId: string;
  category: string;
  file: Express.Multer.File;
}) {
  const store = getStorage();
  const put = await store.put({
    buffer: opts.file.buffer,
    filename: opts.file.originalname,
    contentType: opts.file.mimetype,
    pathPrefix: `applications/${opts.applicationId}`,
  });
  const id = randomUUID();
  try {
    await runQuery(
      `INSERT INTO documents (id, application_id, filename, hash, category, storage_path, blob_name, blob_url, size_bytes, status, ocr_status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'uploaded', 'pending', now(), now())`,
      [id, opts.applicationId, opts.file.originalname, put.hash, opts.category, put.blobName, put.blobName, put.url, put.sizeBytes]
    );
  } catch {
    await runQuery(
      `INSERT INTO documents (application_id, filename, hash) VALUES ($1, $2, $3)`,
      [opts.applicationId, opts.file.originalname, put.hash]
    );
  }
  try { await enqueueOcrForDocument(id); }
  catch (err) { console.warn("[documents] OCR enqueue failed", { id, err: String(err) }); }
  return { id, hash: put.hash, sizeBytes: put.sizeBytes, blobName: put.blobName };
}

// BF_SERVER_v64_UPLOAD_GUARD — wrap upload handlers so storage failures
// (e.g. Azure ContainerNotFound) return a structured 500 instead of
// surfacing as [UNHANDLED REJECTION] with no response sent.
router.post("/public-upload", upload.single("file"), async (req: Request, res: Response) => {
  const applicationId = typeof req.body?.applicationId === "string" ? req.body.applicationId.trim() : "";
  const category      = typeof req.body?.category === "string"      ? req.body.category.trim()      : "";
  if (!applicationId || !category) return fail(res, 400, "MISSING_FIELDS");
  const file = (req as Request & { file?: Express.Multer.File }).file;
  if (!file) return fail(res, 400, "NO_FILE");
  try {
    const r = await persistAndEnqueue({ applicationId, category, file });
    return ok(res, { id: r.id, applicationId, filename: file.originalname, hash: r.hash, size: r.sizeBytes, status: "uploaded" });
  } catch (err) {
    console.error("[documents] public-upload failed", { applicationId, category, err: String(err) });
    return fail(res, 500, "UPLOAD_FAILED");
  }
});

router.post("/upload", requireAuth, upload.single("file"), async (req: Request, res: Response) => {
  // BF_SERVER_v64_UPLOAD_GUARD
  const applicationId = typeof req.body?.applicationId === "string" ? req.body.applicationId.trim() : null;
  const category      = typeof req.body?.category === "string"      ? req.body.category.trim()      : null;
  const file = (req as Request & { file?: Express.Multer.File }).file;
  if (!applicationId || !category || !file) return fail(res, 400, "INVALID_DOCUMENT_UPLOAD_PAYLOAD");
  try {
    const r = await persistAndEnqueue({ applicationId, category, file });
    return ok(res, { id: r.id, applicationId, filename: file.originalname, hash: r.hash, size: r.sizeBytes, status: "uploaded" });
  } catch (err) {
    console.error("[documents] upload failed", { applicationId, category, err: String(err) });
    return fail(res, 500, "UPLOAD_FAILED");
  }
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
